import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTRACT_SCHEMA_VERSION,
  evaluateContract,
  loadContract,
} from "./contract.ts";
import type {
  ContractFailure,
  ContractLoadResult,
  SessionGateContext,
  VerificationContract,
} from "./contract.ts";

const tempDirectories: string[] = [];

afterEach((): void => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function validContract(): VerificationContract {
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    requiredChecks: [
      {
        id: "unit-tests",
        description: "Unit tests pass",
        commandPattern: "bun test",
      },
    ],
    protectedPaths: [],
  };
}

function writeContract(repo: string, value: unknown): string {
  const directory = join(repo, ".hyperagent");
  const path = join(directory, "contract.json");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function expectInvalidContract(
  result: ContractLoadResult,
  errorText: string,
): string {
  expect(result.state).toBe("invalid");
  expect(result.contract).toBeNull();
  expect(result.error).toBeString();
  expect(result.error?.length).toBeGreaterThan(0);
  expect(result.error).toMatch(/^[A-Z][A-Z0-9_]+:/u);
  expect(result.error).toContain(errorText);
  return result.error ?? "";
}

function expectNoInstructionText(failures: ContractFailure[]): void {
  for (const failure of failures) {
    expect(failure.reason).not.toMatch(
      /you should|please|try running|next time/iu,
    );
  }
}

describe("loadContract", () => {
  test("returns absent when the repository contract is missing", (): void => {
    const repo = makeTempDir("hyperagent-contract-absent-");

    const result = loadContract(repo);

    expect(result.state).toBe("absent");
    expect(result.contract).toBeNull();
    expect(result.path).toBe(join(repo, ".hyperagent", "contract.json"));
  });

  test("rejects every invalid contract with a distinct named error", (): void => {
    const cases: Array<{
      name: string;
      value: unknown;
      errorText: string;
      raw?: boolean;
    }> = [
      {
        name: "invalid-json",
        value: "{",
        errorText: "CONTRACT_JSON_ERROR",
        raw: true,
      },
      {
        name: "non-object",
        value: [],
        errorText: "CONTRACT_DOCUMENT_TYPE_ERROR",
      },
      {
        name: "schema-version",
        value: { ...validContract(), schema_version: "99.0.0" },
        errorText: "CONTRACT_SCHEMA_VERSION_ERROR",
      },
      {
        name: "checks-type",
        value: { ...validContract(), requiredChecks: {} },
        errorText: "CONTRACT_REQUIRED_CHECKS_TYPE_ERROR",
      },
      {
        name: "check-missing-id",
        value: {
          ...validContract(),
          requiredChecks: [
            {
              description: "Unit tests pass",
              commandPattern: "bun test",
            },
          ],
        },
        errorText: "requiredChecks[0].id",
      },
      {
        name: "check-missing-description",
        value: {
          ...validContract(),
          requiredChecks: [
            {
              id: "unit-tests",
              commandPattern: "bun test",
            },
          ],
        },
        errorText: "requiredChecks[0].description",
      },
      {
        name: "check-missing-pattern",
        value: {
          ...validContract(),
          requiredChecks: [
            {
              id: "unit-tests",
              description: "Unit tests pass",
            },
          ],
        },
        errorText: "requiredChecks[0].commandPattern",
      },
      {
        name: "invalid-pattern",
        value: {
          ...validContract(),
          requiredChecks: [
            {
              id: "unit-tests",
              description: "Unit tests pass",
              commandPattern: "(",
            },
          ],
        },
        errorText: "CONTRACT_REGEX_ERROR",
      },
      {
        name: "duplicate-id",
        value: {
          ...validContract(),
          requiredChecks: [
            {
              id: "duplicate",
              description: "First check",
              commandPattern: "first",
            },
            {
              id: "duplicate",
              description: "Second check",
              commandPattern: "second",
            },
          ],
        },
        errorText: "CONTRACT_DUPLICATE_CHECK_ID_ERROR",
      },
      {
        name: "protected-paths-type",
        value: { ...validContract(), protectedPaths: {} },
        errorText: "CONTRACT_PROTECTED_PATHS_TYPE_ERROR",
      },
    ];
    const errors: string[] = [];

    for (const invalidCase of cases) {
      const repo = makeTempDir(
        `hyperagent-contract-${invalidCase.name}-`,
      );
      const path = writeContract(repo, invalidCase.value);
      if (invalidCase.raw === true) {
        writeFileSync(path, String(invalidCase.value));
      }
      errors.push(
        expectInvalidContract(
          loadContract(repo),
          invalidCase.errorText,
        ),
      );
    }

    expect(new Set(errors).size).toBe(cases.length);
  });

  test("loads a valid contract unchanged", (): void => {
    const repo = makeTempDir("hyperagent-contract-loaded-");
    const contract = validContract();
    writeContract(repo, contract);

    const result = loadContract(repo);

    expect(result.state).toBe("loaded");
    expect(result.contract).toEqual(contract);
  });
});

describe("evaluateContract required checks", () => {
  test("passes when a required check passed after the last mutation", (): void => {
    const context: SessionGateContext = {
      touchedFiles: [
        { path: "src/first.ts", sequence: 2 },
        { path: "src/last.ts", sequence: 7 },
      ],
      commands: [
        { command: "bun test", passed: true, sequence: 8 },
      ],
    };

    expect(evaluateContract(validContract(), context)).toEqual([]);
  });

  test("fails when the matching command did not pass", (): void => {
    const failures = evaluateContract(validContract(), {
      touchedFiles: [{ path: "src/file.ts", sequence: 1 }],
      commands: [{ command: "bun test", passed: false, sequence: 2 }],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.checkId).toBe("unit-tests");
    expect(failures[0]?.reason).toContain("unit-tests");
    expectNoInstructionText(failures);
  });

  test("fails when a passing check ran before the last mutation", (): void => {
    const failures = evaluateContract(validContract(), {
      touchedFiles: [{ path: "src/file.ts", sequence: 10 }],
      commands: [{ command: "bun test", passed: true, sequence: 9 }],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.checkId).toBe("unit-tests");
    expect(failures[0]?.reason).toContain("unit-tests");
    expectNoInstructionText(failures);
  });

  test("fails when no command matches the required pattern", (): void => {
    const failures = evaluateContract(validContract(), {
      touchedFiles: [{ path: "src/file.ts", sequence: 1 }],
      commands: [
        { command: "bunx tsc --noEmit", passed: true, sequence: 2 },
      ],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.checkId).toBe("unit-tests");
    expect(failures[0]?.reason).toContain("unit-tests");
    expectNoInstructionText(failures);
  });

  test("passes at any sequence when no files were touched", (): void => {
    const context: SessionGateContext = {
      touchedFiles: [],
      commands: [
        {
          command: "bun test",
          passed: true,
          sequence: Number.MIN_SAFE_INTEGER,
        },
      ],
    };

    expect(evaluateContract(validContract(), context)).toEqual([]);
  });
});

describe("evaluateContract protected paths", () => {
  test("reports protected files from the session-touched set", (): void => {
    const contract: VerificationContract = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      requiredChecks: [],
      protectedPaths: ["config/**"],
    };
    const protectedPath = "config/production.json";

    const failures = evaluateContract(contract, {
      touchedFiles: [{ path: protectedPath, sequence: 1 }],
      commands: [],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.checkId).toBe("protected-path");
    expect(failures[0]?.reason).toContain(protectedPath);
    expectNoInstructionText(failures);
  });

  test("ignores matching paths that are not in the touched set", (): void => {
    const contract: VerificationContract = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      requiredChecks: [],
      protectedPaths: ["config/**"],
    };

    const failures = evaluateContract(contract, {
      touchedFiles: [{ path: "src/index.ts", sequence: 1 }],
      commands: [
        {
          command: "git diff -- config/production.json",
          passed: true,
          sequence: 2,
        },
      ],
    });

    expect(failures).toEqual([]);
  });

  test("reports all simultaneous check and protected-path failures", (): void => {
    const contract: VerificationContract = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      requiredChecks: [
        {
          id: "tests",
          description: "Tests pass",
          commandPattern: "bun test",
        },
        {
          id: "types",
          description: "Types pass",
          commandPattern: "tsc",
        },
      ],
      protectedPaths: ["protected/**"],
    };
    const protectedPath = "protected/settings.json";

    const failures = evaluateContract(contract, {
      touchedFiles: [{ path: protectedPath, sequence: 3 }],
      commands: [
        { command: "bun test", passed: false, sequence: 4 },
        { command: "bunx tsc --noEmit", passed: true, sequence: 2 },
      ],
    });

    expect(
      failures.map((failure): string => failure.checkId),
    ).toEqual(["tests", "types", "protected-path"]);
    expect(failures[0]?.reason).toContain("tests");
    expect(failures[1]?.reason).toContain("types");
    expect(failures[2]?.reason).toContain(protectedPath);
    expectNoInstructionText(failures);
  });
});

describe("evaluateContract read-only sessions", (): void => {
  test("a session that mutated nothing satisfies required checks vacuously", (): void => {
    const contract: VerificationContract = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      requiredChecks: [{
        id: "tests",
        description: "the repo test suite must pass",
        commandPattern: "bun\\s+test",
      }],
      protectedPaths: [],
    };

    // No touched files at all: the agent answered a question and changed
    // nothing, so demanding a test run would bounce it for no reason.
    expect(evaluateContract(contract, { commands: [], touchedFiles: [] }))
      .toEqual([]);
  });

  test("a required check is still enforced once the session mutates a file", (): void => {
    const contract: VerificationContract = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      requiredChecks: [{
        id: "tests",
        description: "the repo test suite must pass",
        commandPattern: "bun\\s+test",
      }],
      protectedPaths: [],
    };

    const failures = evaluateContract(contract, {
      commands: [],
      touchedFiles: [{ path: "/repo/src/a.ts", sequence: 1 }],
    });
    expect(failures.length).toBe(1);
    expect(failures[0]?.checkId).toBe("tests");
  });
});

describe("evaluateContract repo-relative protected paths", (): void => {
  const protectedContract: VerificationContract = {
    schema_version: CONTRACT_SCHEMA_VERSION,
    requiredChecks: [],
    protectedPaths: ["secrets/**"],
  };

  test("a repo-relative protectedPath matches an absolute touched path", (): void => {
    // Regression: touched paths arrive absolute from the harness while humans
    // write protectedPaths repo-relative. Matching only the absolute form made
    // every relative pattern silently dead.
    const failures = evaluateContract(
      protectedContract,
      {
        commands: [],
        touchedFiles: [{ path: "/abs/repo/secrets/key.pem", sequence: 1 }],
      },
      { repoRoot: "/abs/repo" },
    );

    expect(failures.length).toBe(1);
    expect(failures[0]?.checkId).toBe("protected-path");
    expect(failures[0]?.reason).toContain("secrets/key.pem");
  });

  test("an absolute protectedPath still matches without a repo root", (): void => {
    const failures = evaluateContract(
      {
        schema_version: CONTRACT_SCHEMA_VERSION,
        requiredChecks: [],
        protectedPaths: ["**/secrets/**"],
      },
      {
        commands: [],
        touchedFiles: [{ path: "/abs/repo/secrets/key.pem", sequence: 1 }],
      },
    );

    expect(failures.length).toBe(1);
  });

  test("a path outside the repo root does not match a relative pattern", (): void => {
    // Only the absolute form is comparable outside the repo, so a relative
    // pattern must not reach across into an unrelated directory.
    const failures = evaluateContract(
      protectedContract,
      {
        commands: [],
        touchedFiles: [{ path: "/elsewhere/secrets/key.pem", sequence: 1 }],
      },
      { repoRoot: "/abs/repo" },
    );

    expect(failures).toEqual([]);
  });

  test("a sibling directory sharing the root's name prefix is not treated as inside it", (): void => {
    const failures = evaluateContract(
      protectedContract,
      {
        commands: [],
        touchedFiles: [{ path: "/abs/repo-other/secrets/key.pem", sequence: 1 }],
      },
      { repoRoot: "/abs/repo" },
    );

    expect(failures).toEqual([]);
  });
});
