import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  bounceCounterPath,
  isSuitRuntimeWritePath,
  rotatedSpoolPath,
  spoolPath,
} from "./paths.ts";
import {
  DEFAULT_POLICY,
  FLAG_ONLY_BASELINE,
  POLICY_SCHEMA_VERSION,
  globMatches,
  loadPolicy,
  matchPolicy,
  pathMatchesGlob,
} from "./policy.ts";
import type {
  PolicyCandidate,
  PolicyDoc,
  PolicyLoadResult,
  PolicyRule,
} from "./policy.ts";

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

function policyCandidate(
  overrides: Partial<PolicyCandidate> = {},
): PolicyCandidate {
  return {
    toolName: "Bash",
    command: "",
    readPaths: [],
    writePaths: [],
    ...overrides,
  };
}

function validRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: "custom-rule",
    description: "A custom rule.",
    action: "flag",
    enabled: true,
    match: { commandPattern: "custom" },
    ...overrides,
  };
}

function validPolicy(rules: PolicyRule[] = [validRule()]): PolicyDoc {
  return {
    schema_version: POLICY_SCHEMA_VERSION,
    rules,
  };
}

function writePolicy(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

function expectNamedError(result: PolicyLoadResult): string {
  expect(result.error).toBeString();
  expect(result.error?.length).toBeGreaterThan(0);
  expect(result.error).toMatch(/^[A-Z][A-Z0-9_]+:/u);
  return result.error ?? "";
}

function expectInvalidFailClosed(
  result: PolicyLoadResult,
  errorText: string,
): string {
  expect(result.state).toBe("invalid");
  expect(result.policy).toBe(FLAG_ONLY_BASELINE);
  const error = expectNamedError(result);
  expect(error).toContain(errorText);

  const matches = matchPolicy(
    result.policy,
    policyCandidate({ command: "rm -rf /" }),
  );
  expect(matches.some((match): boolean => match.action === "block")).toBe(
    false,
  );
  return error;
}

describe("loadPolicy", () => {
  test("uses DEFAULT_POLICY when the policy file is missing", (): void => {
    const root = makeTempDir("hyperagent-policy-missing-");
    const path = join(root, "policy.json");

    const result = loadPolicy(path);

    expect(result.state).toBe("default");
    expect(result.policy).toBe(DEFAULT_POLICY);
    expect(result.path).toBe(path);
  });

  test("fails closed to the flag-only baseline for a directory path", (): void => {
    const path = makeTempDir("hyperagent-policy-directory-");

    const result = loadPolicy(path);

    expectInvalidFailClosed(result, "POLICY_PATH_TYPE_ERROR");
  });

  test("fails closed to the flag-only baseline for invalid JSON", (): void => {
    const root = makeTempDir("hyperagent-policy-json-");
    const path = join(root, "policy.json");
    writeFileSync(path, "{");

    const result = loadPolicy(path);

    expectInvalidFailClosed(result, "POLICY_JSON_ERROR");
  });

  test("rejects array, number, and null documents", (): void => {
    const root = makeTempDir("hyperagent-policy-document-types-");
    const cases: Array<{ name: string; value: unknown }> = [
      { name: "array", value: [] },
      { name: "number", value: 42 },
      { name: "null", value: null },
    ];

    for (const invalidCase of cases) {
      const path = join(root, `${invalidCase.name}.json`);
      writePolicy(path, invalidCase.value);
      expectInvalidFailClosed(
        loadPolicy(path),
        "POLICY_DOCUMENT_TYPE_ERROR",
      );
    }
  });

  test("rejects every malformed policy shape with a distinct named error", (): void => {
    const root = makeTempDir("hyperagent-policy-validation-");
    const rule = validRule();
    const cases: Array<{
      name: string;
      value: unknown;
      errorText: string;
    }> = [
      {
        name: "schema-version",
        value: { ...validPolicy(), schema_version: "99.0.0" },
        errorText: "POLICY_SCHEMA_VERSION_ERROR",
      },
      {
        name: "rules-type",
        value: { schema_version: POLICY_SCHEMA_VERSION, rules: {} },
        errorText: "POLICY_RULES_TYPE_ERROR",
      },
      {
        name: "rule-type",
        value: { schema_version: POLICY_SCHEMA_VERSION, rules: ["rule"] },
        errorText: "POLICY_RULE_TYPE_ERROR",
      },
      {
        name: "missing-id",
        value: {
          ...validPolicy(),
          rules: [{ ...rule, id: undefined }],
        },
        errorText: "rules[0].id",
      },
      {
        name: "missing-description",
        value: {
          ...validPolicy(),
          rules: [{ ...rule, description: undefined }],
        },
        errorText: "rules[0].description",
      },
      {
        name: "missing-action",
        value: {
          ...validPolicy(),
          rules: [{ ...rule, action: undefined }],
        },
        errorText: "rules[0].action",
      },
      {
        name: "missing-enabled",
        value: {
          ...validPolicy(),
          rules: [{ ...rule, enabled: undefined }],
        },
        errorText: "rules[0].enabled",
      },
      {
        name: "empty-matcher",
        value: validPolicy([validRule({ match: {} })]),
        errorText: "POLICY_MATCHER_EMPTY_ERROR",
      },
      {
        name: "invalid-regex",
        value: validPolicy([
          validRule({ match: { commandPattern: "(" } }),
        ]),
        errorText: "POLICY_REGEX_ERROR",
      },
      {
        name: "duplicate-id",
        value: validPolicy([
          validRule({ id: "duplicate" }),
          validRule({ id: "duplicate" }),
        ]),
        errorText: "POLICY_DUPLICATE_RULE_ID_ERROR",
      },
    ];
    const errors: string[] = [];

    for (const invalidCase of cases) {
      const path = join(root, `${invalidCase.name}.json`);
      writePolicy(path, invalidCase.value);
      errors.push(
        expectInvalidFailClosed(
          loadPolicy(path),
          invalidCase.errorText,
        ),
      );
    }

    expect(new Set(errors).size).toBe(cases.length);
  });

  test("loads a well-formed custom policy unchanged", (): void => {
    const root = makeTempDir("hyperagent-policy-loaded-");
    const path = join(root, "policy.json");
    const policy = validPolicy([
      validRule({
        id: "custom-write",
        description: "Flag custom writes.",
        match: { pathPattern: "**/*.custom", pathAccess: "write" },
      }),
    ]);
    writePolicy(path, policy);

    const result = loadPolicy(path);

    expect(result.state).toBe("loaded");
    expect(result.policy).toEqual(policy);
  });
});

describe("DEFAULT_POLICY", () => {
  test("ships blocking rules disabled", (): void => {
    const blockRules = DEFAULT_POLICY.rules.filter(
      (rule): boolean => rule.action === "block",
    );

    expect(blockRules.length).toBeGreaterThan(0);
    expect(blockRules.every((rule): boolean => rule.enabled === false)).toBe(
      true,
    );
  });

  test("flags writes to environment secrets files", (): void => {
    const matches = matchPolicy(
      DEFAULT_POLICY,
      policyCandidate({ writePaths: ["/repo/.env"] }),
    );

    expect(
      matches.some((match): boolean => match.ruleId.includes("secrets")),
    ).toBe(true);
  });

  test("flags writes to local permission configuration", (): void => {
    const matches = matchPolicy(
      DEFAULT_POLICY,
      policyCandidate({
        writePaths: ["/repo/.claude/settings.local.json"],
      }),
    );

    expect(
      matches.some(
        (match): boolean =>
          match.ruleId === "permission-config-edit.claude-settings-local",
      ),
    ).toBe(true);
  });

  test("flags writes to the HyperAgent policy", (): void => {
    const matches = matchPolicy(
      DEFAULT_POLICY,
      policyCandidate({
        writePaths: ["/home/u/.hyperagent/policy.json"],
      }),
    );

    expect(
      matches.some(
        (match): boolean =>
          match.ruleId === "permission-config-edit.policy",
      ),
    ).toBe(true);
  });

  test("flags external publish commands", (): void => {
    const matches = matchPolicy(
      DEFAULT_POLICY,
      policyCandidate({ command: "git push origin main" }),
    );

    expect(
      matches.some(
        (match): boolean => match.ruleId === "external-publish-command",
      ),
    ).toBe(true);
  });
});

describe("matchPolicy", () => {
  test("skips disabled rules by default and includes them when requested", (): void => {
    const policy = validPolicy([
      validRule({
        id: "disabled",
        enabled: false,
        match: { commandPattern: "match-me" },
      }),
    ]);

    expect(
      matchPolicy(policy, policyCandidate({ command: "match-me" })),
    ).toEqual([]);
    expect(
      matchPolicy(
        policy,
        policyCandidate({ command: "match-me" }),
        { includeDisabled: true },
      ).map((match): string => match.ruleId),
    ).toEqual(["disabled"]);
  });

  test("orders blocks before flags and rule ids within each action", (): void => {
    const policy = validPolicy([
      validRule({ id: "z-flag", action: "flag" }),
      validRule({ id: "z-block", action: "block" }),
      validRule({ id: "a-flag", action: "flag" }),
      validRule({ id: "a-block", action: "block" }),
    ]);

    const matches = matchPolicy(
      policy,
      policyCandidate({ command: "custom" }),
    );

    expect(
      matches.map((match): string => `${match.action}:${match.ruleId}`),
    ).toEqual([
      "block:a-block",
      "block:z-block",
      "flag:a-flag",
      "flag:z-flag",
    ]);
  });

  test("distinguishes read, write, and any path access", (): void => {
    const policy = validPolicy([
      validRule({
        id: "read",
        match: { pathPattern: "**/target.txt", pathAccess: "read" },
      }),
      validRule({
        id: "write",
        match: { pathPattern: "**/target.txt", pathAccess: "write" },
      }),
      validRule({
        id: "any",
        match: { pathPattern: "**/target.txt", pathAccess: "any" },
      }),
    ]);

    const readMatches = matchPolicy(
      policy,
      policyCandidate({ readPaths: ["/repo/target.txt"] }),
    );
    const writeMatches = matchPolicy(
      policy,
      policyCandidate({ writePaths: ["/repo/target.txt"] }),
    );

    expect(readMatches.map((match): string => match.ruleId)).toEqual([
      "any",
      "read",
    ]);
    expect(writeMatches.map((match): string => match.ruleId)).toEqual([
      "any",
      "write",
    ]);
  });

  test("redacts secrets from match evidence", (): void => {
    const policy = validPolicy([
      validRule({ match: { commandPattern: "token=" } }),
    ]);
    const rawSecret = "abcdef123456";

    const matches = matchPolicy(
      policy,
      policyCandidate({ command: `deploy token=${rawSecret}` }),
    );
    const firstMatch = matches[0];

    expect(firstMatch).toBeDefined();
    expect(firstMatch?.evidence).not.toContain(rawSecret);
  });
});

describe("globMatches", () => {
  test("* does not cross a path separator", (): void => {
    expect(globMatches("/repo/*/file.txt", "/repo/one/file.txt")).toBe(true);
    expect(globMatches("/repo/*/file.txt", "/repo/one/two/file.txt")).toBe(
      false,
    );
  });

  test("** crosses path separators", (): void => {
    expect(globMatches("/repo/**/file.txt", "/repo/one/two/file.txt")).toBe(
      true,
    );
  });

  test("? matches exactly one non-separator character", (): void => {
    expect(globMatches("/repo/file?.txt", "/repo/file1.txt")).toBe(true);
    expect(globMatches("/repo/file?.txt", "/repo/file.txt")).toBe(false);
    expect(globMatches("/repo/file?.txt", "/repo/file/1.txt")).toBe(false);
  });

  test("treats regular-expression metacharacters literally", (): void => {
    const glob = "**/a+b(c).txt";

    expect(globMatches(glob, "/repo/a+b(c).txt")).toBe(true);
    expect(globMatches(glob, "/repo/aab(c).txt")).toBe(false);
  });
});

describe("gate paths", () => {
  test("bounceCounterPath creates collision-resistant sanitized files", (): void => {
    const dataDir = makeTempDir("hyperagent-bounce-path-");
    const first = bounceCounterPath(dataDir, "session/one:two");
    const second = bounceCounterPath(dataDir, "session:one/two");

    expect(dirname(first)).toBe(join(dataDir, "gate", "sessions"));
    expect(basename(first)).toMatch(
      /^session_one_two-[a-f0-9]{12}\.bounce$/u,
    );
    expect(basename(first)).not.toMatch(/[/:]/u);
    expect(first).not.toBe(second);
  });

  test("exempts only narrow Suit runtime write paths", (): void => {
    const dataDir = makeTempDir("hyperagent-runtime-path-");
    const repo = join(dataDir, "repo");
    const bounce = bounceCounterPath(dataDir, "session-1");

    expect(isSuitRuntimeWritePath(spoolPath(dataDir), dataDir)).toBe(true);
    expect(isSuitRuntimeWritePath(rotatedSpoolPath(dataDir), dataDir)).toBe(
      true,
    );
    expect(isSuitRuntimeWritePath(bounce, dataDir)).toBe(true);
    expect(
      isSuitRuntimeWritePath(join(dataDir, "hyperagent.db"), dataDir),
    ).toBe(true);
    expect(isSuitRuntimeWritePath(join(dataDir, "policy.json"), dataDir)).toBe(
      false,
    );
    expect(
      isSuitRuntimeWritePath(
        join(repo, ".hyperagent", "contract.json"),
        dataDir,
      ),
    ).toBe(false);
    expect(
      isSuitRuntimeWritePath(
        join(repo, ".claude", "settings.local.json"),
        dataDir,
      ),
    ).toBe(false);
  });
});

describe("pathMatchesGlob dual-basis matching", (): void => {
  test("a user-authored relative rule matches an absolute runtime path", (): void => {
    // Same defect class as contract protectedPaths: a hand-written policy rule
    // like "secrets/**" would otherwise never fire against the absolute paths
    // harnesses actually report.
    const policy: PolicyDoc = {
      schema_version: POLICY_SCHEMA_VERSION,
      rules: [{
        id: "user-secrets",
        description: "Write under the repo secrets directory.",
        action: "flag",
        enabled: true,
        match: { pathPattern: "secrets/**", pathAccess: "write" },
      }],
    };

    const matched = matchPolicy(policy, {
      toolName: "Write",
      command: "",
      readPaths: [],
      writePaths: ["/abs/repo/secrets/key.pem"],
      repoRoot: "/abs/repo",
    });
    expect(matched.map((match): string => match.ruleId)).toEqual([
      "user-secrets",
    ]);

    // Without a repo root only the absolute form is comparable.
    expect(matchPolicy(policy, {
      toolName: "Write",
      command: "",
      readPaths: [],
      writePaths: ["/abs/repo/secrets/key.pem"],
    })).toEqual([]);
  });

  test("matches the absolute form, the relative form, and nothing outside the root", (): void => {
    expect(pathMatchesGlob("**/*.pem", "/abs/repo/secrets/key.pem")).toBe(true);
    expect(pathMatchesGlob("secrets/**", "/abs/repo/secrets/key.pem", "/abs/repo")).toBe(true);
    expect(pathMatchesGlob("secrets/**", "secrets/key.pem")).toBe(true);
    expect(pathMatchesGlob("secrets/**", "/elsewhere/secrets/key.pem", "/abs/repo")).toBe(false);
    expect(pathMatchesGlob("secrets/**", "/abs/repo-other/secrets/key.pem", "/abs/repo")).toBe(false);
    // A trailing separator on the root must not break the prefix comparison.
    expect(pathMatchesGlob("secrets/**", "/abs/repo/secrets/key.pem", "/abs/repo/")).toBe(true);
  });
});
