import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTRACT_SCHEMA_VERSION } from "./contract.ts";
import type { VerificationContract } from "./contract.ts";
import {
  DEFAULT_MAX_BOUNCES,
  runGateEval,
} from "./eval.ts";
import type {
  GateDecision,
  GateHookInput,
} from "./eval.ts";
import {
  bounceCounterPath,
  policyPath,
  rotatedSpoolPath,
  spoolPath,
} from "./paths.ts";
import {
  FLAG_ONLY_BASELINE,
  POLICY_SCHEMA_VERSION,
  loadPolicy,
} from "./policy.ts";
import type {
  PolicyDoc,
  PolicyLoadResult,
  PolicyRule,
} from "./policy.ts";
import { readSpool } from "./spool.ts";
import type { GateOutcome } from "./spool.ts";

const tempDirectories: string[] = [];
const runningAsRoot: boolean = (
  typeof process.geteuid === "function"
  && process.geteuid() === 0
);

afterEach((): void => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const directory: string = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function hookInput(
  cwd: string,
  overrides: Partial<GateHookInput> = {},
): GateHookInput {
  return {
    hook: "pre_tool_use",
    harness: "test-harness",
    sessionId: "test-harness:session-1",
    cwd,
    toolName: "Bash",
    command: "",
    readPaths: [],
    writePaths: [],
    ...overrides,
  };
}

function policyRule(
  overrides: Partial<PolicyRule> = {},
): PolicyRule {
  return {
    id: "flag-command",
    description: "The command needs review.",
    action: "flag",
    enabled: true,
    match: { commandPattern: "review-me" },
    ...overrides,
  };
}

function policy(rules: PolicyRule[]): PolicyDoc {
  return {
    schema_version: POLICY_SCHEMA_VERSION,
    rules,
  };
}

function loadedPolicy(rules: PolicyRule[]): PolicyLoadResult {
  return {
    state: "loaded",
    policy: policy(rules),
    path: "injected-policy.json",
  };
}

function contract(
  requiredChecks: VerificationContract["requiredChecks"] = [
    {
      id: "unit-tests",
      description: "Unit tests pass.",
      commandPattern: "bun test",
    },
  ],
  protectedPaths: string[] = [],
): VerificationContract {
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    requiredChecks,
    protectedPaths,
  };
}

function writeContract(repo: string, value: unknown): void {
  const directory: string = join(repo, ".hyperagent");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "contract.json"), JSON.stringify(value));
}

async function outcomes(dataDir: string): Promise<GateOutcome[]> {
  return (await readSpool(dataDir)).outcomes;
}

function expectFactOnlyReason(reason: string | undefined): void {
  expect(reason).toBeString();
  expect(reason).not.toMatch(
    /you should|please|try running|next time/iu,
  );
}

describe("runGateEval pre_tool_use", () => {
  test("denies enabled block matches, names every rule, and spools one pre outcome", async (): Promise<void> => {
    const root: string = makeTempDir("hyperagent-eval-pre-block-");
    const dataDir: string = join(root, "data");
    const input: GateHookInput = hookInput(root, {
      command: "dangerous operation",
    });
    const decision: GateDecision = await runGateEval({
      dataDir,
      input,
      policyLoad: loadedPolicy([
        policyRule({
          id: "block-danger",
          description: "Dangerous operation matched.",
          action: "block",
          match: { commandPattern: "dangerous" },
        }),
        policyRule({
          id: "block-operation",
          description: "Operation command matched.",
          action: "block",
          match: { commandPattern: "operation" },
        }),
        policyRule({
          id: "flag-danger",
          description: "Danger signal matched.",
          match: { commandPattern: "dangerous" },
        }),
      ]),
    });

    expect(decision.kind).toBe("deny");
    expect(decision.matchedRules).toEqual([
      "block-danger",
      "block-operation",
      "flag-danger",
    ]);
    expect(decision.failedChecks).toEqual([]);
    expect(decision.reason).toContain("block-danger");
    expect(decision.reason).toContain("Dangerous operation matched.");
    expect(decision.reason).toContain("block-operation");
    expect(decision.reason).toContain("Operation command matched.");
    expectFactOnlyReason(decision.reason);
    const spooled: GateOutcome[] = await outcomes(dataDir);
    expect(spooled).toHaveLength(1);
    expect(spooled[0]?.kind).toBe("pre_tool_use");
    expect(spooled[0]?.decision).toBe("deny");
    expect(spooled[0]?.matchedRules).toEqual(decision.matchedRules);
  });

  test("allows flag-only matches and records them", async (): Promise<void> => {
    const root: string = makeTempDir("hyperagent-eval-pre-flag-");
    const dataDir: string = join(root, "data");
    const decision: GateDecision = await runGateEval({
      dataDir,
      input: hookInput(root, { command: "review-me" }),
      policyLoad: loadedPolicy([policyRule()]),
    });

    expect(decision).toEqual({
      kind: "allow",
      matchedRules: ["flag-command"],
      failedChecks: [],
    });
    const spooled: GateOutcome[] = await outcomes(dataDir);
    expect(spooled).toHaveLength(1);
    expect(spooled[0]?.matchedRules).toEqual(["flag-command"]);
  });

  test("allows a shipped block-rule candidate when policy loading failed", async (): Promise<void> => {
    const root: string = makeTempDir("hyperagent-eval-policy-invalid-");
    const dataDir: string = join(root, ".hyperagent");
    mkdirSync(dataDir);
    writeFileSync(policyPath(dataDir), "{");
    const policyLoad: PolicyLoadResult = loadPolicy(policyPath(dataDir));
    expect(policyLoad.state).toBe("invalid");
    expect(policyLoad.policy).toBe(FLAG_ONLY_BASELINE);

    const decision: GateDecision = await runGateEval({
      dataDir,
      input: hookInput(root, { command: "rm -rf /" }),
      policyLoad,
    });

    expect(decision.kind).toBe("allow");
    expect(decision.failedOpen).toBe(true);
    expect(decision.matchedRules).not.toContain(
      "destructive-recursive-delete",
    );
    expect(
      (await outcomes(dataDir)).map(
        (entry: GateOutcome): string => entry.kind,
      ),
    ).toEqual(["gate_error", "pre_tool_use"]);
  });

  test("fails open when the policy path is unreadable", async (): Promise<void> => {
    const root: string = makeTempDir("hyperagent-eval-policy-unreadable-");
    const dataDir: string = join(root, "data");
    mkdirSync(dataDir);
    mkdirSync(policyPath(dataDir));

    const decision: GateDecision = await runGateEval({
      dataDir,
      input: hookInput(root, { command: "rm -rf /" }),
    });

    expect(decision.kind).toBe("allow");
    expect(decision.failedOpen).toBe(true);
    expect(
      (await outcomes(dataDir)).some(
        (entry: GateOutcome): boolean => entry.kind === "gate_error",
      ),
    ).toBe(true);
  });

  test("fails open and spools gate_error when policy matching throws", async (): Promise<void> => {
    const root: string = makeTempDir("hyperagent-eval-policy-throw-");
    const dataDir: string = join(root, "data");
    const malformedPolicyLoad = {
      state: "loaded",
      policy: {
        schema_version: POLICY_SCHEMA_VERSION,
      },
      path: "malformed-policy.json",
    } as unknown as PolicyLoadResult;

    const decision: GateDecision = await runGateEval({
      dataDir,
      input: hookInput(root, { command: "dangerous" }),
      policyLoad: malformedPolicyLoad,
    });

    expect(decision).toEqual({
      kind: "allow",
      matchedRules: [],
      failedChecks: [],
      failedOpen: true,
    });
    const spooled: GateOutcome[] = await outcomes(dataDir);
    expect(spooled).toHaveLength(1);
    expect(spooled[0]?.kind).toBe("gate_error");
  });

  test.skipIf(runningAsRoot)(
    "fails open when the spool directory is unwritable",
    async (): Promise<void> => {
      const root: string = makeTempDir("hyperagent-eval-unwritable-");
      const dataDir: string = join(root, "data");
      const gateDir: string = join(dataDir, "gate");
      mkdirSync(gateDir, { recursive: true });
      chmodSync(gateDir, 0o500);
      try {
        const decision: GateDecision = await runGateEval({
          dataDir,
          input: hookInput(root, { command: "dangerous" }),
          policyLoad: loadedPolicy([
            policyRule({
              id: "would-block",
              action: "block",
              match: { commandPattern: "dangerous" },
            }),
          ]),
        });

        expect(decision.kind).toBe("allow");
        expect(decision.failedOpen).toBe(true);
      } finally {
        chmodSync(gateDir, 0o700);
      }
    },
  );

  test("fails open when a deliberately tiny deadline expires", async (): Promise<void> => {
    const root: string = makeTempDir("hyperagent-eval-timeout-");
    const decision: GateDecision = await runGateEval({
      dataDir: join(root, "data"),
      input: hookInput(root, { command: "dangerous" }),
      policyLoad: loadedPolicy([
        policyRule({
          id: "would-block",
          action: "block",
          match: { commandPattern: "dangerous" },
        }),
      ]),
      timeoutMs: 0,
    });

    expect(decision).toEqual({
      kind: "allow",
      matchedRules: [],
      failedChecks: [],
      failedOpen: true,
    });
  });
});

describe("runGateEval post_tool_use", () => {
  test("always allows, matches policy, and spools redacted command and tool result", async (): Promise<void> => {
    const root: string = makeTempDir("hyperagent-eval-post-");
    const dataDir: string = join(root, "data");
    const touched: string[] = [join(root, "src", "changed.ts")];
    const command = "dangerous token=secret-value";
    const policyLoad: PolicyLoadResult = loadedPolicy([
      policyRule({
        id: "post-block-match",
        description: "Post-hoc block match.",
        action: "block",
        match: { commandPattern: "dangerous" },
      }),
    ]);

    const known: GateDecision = await runGateEval({
      dataDir,
      input: hookInput(root, {
        hook: "post_tool_use",
        command,
        writePaths: touched,
        toolPassed: true,
      }),
      policyLoad,
    });
    const unknown: GateDecision = await runGateEval({
      dataDir,
      input: hookInput(root, {
        hook: "post_tool_use",
        sessionId: "test-harness:session-2",
        command,
        writePaths: touched,
      }),
      policyLoad,
    });

    expect(known.kind).toBe("allow");
    expect(known.matchedRules).toEqual(["post-block-match"]);
    expect(unknown.kind).toBe("allow");
    const spooled: GateOutcome[] = await outcomes(dataDir);
    expect(spooled).toHaveLength(2);
    expect(spooled[0]?.kind).toBe("post_tool_use");
    expect(spooled[0]?.command).toBe("dangerous token=[redacted]");
    expect(spooled[0]?.passed).toBe(true);
    expect(spooled[0]?.touchedFiles).toEqual(touched);
    expect(spooled[0]?.matchedRules).toEqual(["post-block-match"]);
    expect(spooled[1]?.passed).toBeUndefined();
  });
});

describe("runGateEval stop", () => {
  test("allows and records an active stop hook even when the contract is unmet", async (): Promise<void> => {
    const repo: string = makeTempDir("hyperagent-eval-stop-active-");
    const dataDir: string = join(repo, "data");
    writeContract(repo, contract());

    const decision: GateDecision = await runGateEval({
      dataDir,
      input: hookInput(repo, {
        hook: "stop",
        stopHookActive: true,
      }),
    });

    expect(decision.kind).toBe("allow");
    const spooled: GateOutcome[] = await outcomes(dataDir);
    expect(spooled).toHaveLength(1);
    expect(spooled[0]?.kind).toBe("stop");
    expect(spooled[0]?.decision).toBe("allow");
  });

  test("allows and records stop when the contract is absent", async (): Promise<void> => {
    const repo: string = makeTempDir("hyperagent-eval-stop-absent-");
    const dataDir: string = join(repo, "data");

    const decision: GateDecision = await runGateEval({
      dataDir,
      input: hookInput(repo, { hook: "stop" }),
    });

    expect(decision.kind).toBe("allow");
    expect((await outcomes(dataDir))[0]?.kind).toBe("stop");
  });

  test("fails open and spools gate_error for an invalid contract", async (): Promise<void> => {
    const repo: string = makeTempDir("hyperagent-eval-stop-invalid-");
    const dataDir: string = join(repo, "data");
    writeContract(repo, {
      schema_version: CONTRACT_SCHEMA_VERSION,
      requiredChecks: "invalid",
      protectedPaths: [],
    });

    const decision: GateDecision = await runGateEval({
      dataDir,
      input: hookInput(repo, { hook: "stop" }),
    });

    expect(decision.kind).toBe("allow");
    expect(decision.failedOpen).toBe(true);
    const spooled: GateOutcome[] = await outcomes(dataDir);
    expect(spooled).toHaveLength(1);
    expect(spooled[0]?.kind).toBe("gate_error");
    expect(spooled[0]?.error).toContain(
      "CONTRACT_REQUIRED_CHECKS_TYPE_ERROR",
    );
  });

  test("allows when every contract check passed after the last mutation", async (): Promise<void> => {
    const repo: string = makeTempDir("hyperagent-eval-stop-pass-");
    const dataDir: string = join(repo, "data");
    const sessionId = "test-harness:passing-session";
    writeContract(repo, contract());
    await runGateEval({
      dataDir,
      input: hookInput(repo, {
        hook: "post_tool_use",
        sessionId,
        command: "edit source",
        writePaths: ["src/changed.ts"],
        toolPassed: true,
      }),
      policyLoad: loadedPolicy([]),
    });
    await runGateEval({
      dataDir,
      input: hookInput(repo, {
        hook: "post_tool_use",
        sessionId,
        command: "bun test",
        toolPassed: true,
      }),
      policyLoad: loadedPolicy([]),
    });

    const decision: GateDecision = await runGateEval({
      dataDir,
      input: hookInput(repo, { hook: "stop", sessionId }),
    });

    expect(decision.kind).toBe("allow");
    expect(decision.failedChecks).toEqual([]);
    const spooled: GateOutcome[] = await outcomes(dataDir);
    expect(spooled.at(-1)?.kind).toBe("stop");
    expect(spooled.at(-1)?.decision).toBe("allow");
  });

  test("blocks twice, then gives up on the third failure and records gate_gave_up", async (): Promise<void> => {
    const repo: string = makeTempDir("hyperagent-eval-bounce-");
    const dataDir: string = join(repo, "data");
    const input: GateHookInput = hookInput(repo, {
      hook: "stop",
      sessionId: "test-harness:bounce-session",
    });
    writeContract(
      repo,
      contract([
        {
          id: "unit-tests",
          description: "Unit tests pass.",
          commandPattern: "bun test",
        },
        {
          id: "typecheck",
          description: "Typecheck passes.",
          commandPattern: "bunx tsc",
        },
      ]),
    );

    // Required checks only bind once the session has actually mutated
    // something, so the session must record a write before Stop can fail.
    await runGateEval({
      dataDir,
      input: {
        ...hookInput(repo, {
          hook: "post_tool_use",
          sessionId: "test-harness:bounce-session",
        }),
        toolName: "Write",
        writePaths: [join(repo, "src", "changed.ts")],
      },
    });

    const first: GateDecision = await runGateEval({ dataDir, input });
    const second: GateDecision = await runGateEval({ dataDir, input });
    const third: GateDecision = await runGateEval({ dataDir, input });

    for (const blocked of [first, second]) {
      expect(blocked.kind).toBe("block");
      expect(blocked.failedChecks).toEqual(["unit-tests", "typecheck"]);
      expect(blocked.reason).toContain("unit-tests");
      expect(blocked.reason).toContain("typecheck");
      expectFactOnlyReason(blocked.reason);
    }
    expect(DEFAULT_MAX_BOUNCES).toBe(2);
    expect(third.kind).toBe("allow");
    expect(third.gaveUp).toBe(true);
    expect(third.failedChecks).toEqual(["unit-tests", "typecheck"]);
    const spooled: GateOutcome[] = await outcomes(dataDir);
    expect(
      spooled.some(
        (entry: GateOutcome): boolean =>
          entry.kind === "gate_gave_up"
          && entry.failedChecks.join(",") === "unit-tests,typecheck",
      ),
    ).toBe(true);
  });

  test("reports protected-path contract failures as factual blocks", async (): Promise<void> => {
    const repo: string = makeTempDir("hyperagent-eval-protected-");
    const dataDir: string = join(repo, "data");
    const sessionId = "test-harness:protected-session";
    writeContract(repo, contract([], ["src/protected/**"]));
    await runGateEval({
      dataDir,
      input: hookInput(repo, {
        hook: "post_tool_use",
        sessionId,
        command: "edit source",
        writePaths: ["src/protected/file.ts"],
        toolPassed: true,
      }),
      policyLoad: loadedPolicy([]),
    });

    const decision: GateDecision = await runGateEval({
      dataDir,
      input: hookInput(repo, { hook: "stop", sessionId }),
    });

    expect(decision.kind).toBe("block");
    expect(decision.failedChecks).toEqual(["protected-path"]);
    expect(decision.reason).toContain("protected-path");
    expectFactOnlyReason(decision.reason);
  });
});

describe("runGateEval runtime-path exemption", () => {
  test("drops only spool, bounce, and database runtime paths before matching", async (): Promise<void> => {
    const repo: string = makeTempDir("hyperagent-eval-runtime-paths-");
    const dataDir: string = join(repo, ".hyperagent");
    const catchAll: PolicyLoadResult = loadedPolicy([
      policyRule({
        id: "all-paths",
        description: "Any path access.",
        match: { pathPattern: "**", pathAccess: "any" },
      }),
    ]);
    const runtimePaths: Array<{
      access: "read" | "write";
      path: string;
    }> = [
      { access: "read", path: spoolPath(dataDir) },
      { access: "write", path: rotatedSpoolPath(dataDir) },
      {
        access: "write",
        path: bounceCounterPath(dataDir, "test-harness:runtime"),
      },
      { access: "write", path: join(dataDir, "hyperagent.db") },
      { access: "write", path: join(dataDir, "hyperagent.db-wal") },
      { access: "write", path: join(dataDir, "hyperagent.db-shm") },
    ];

    for (const runtimePath of runtimePaths) {
      const decision: GateDecision = await runGateEval({
        dataDir,
        input: hookInput(repo, {
          readPaths: runtimePath.access === "read"
            ? [runtimePath.path]
            : [],
          writePaths: runtimePath.access === "write"
            ? [runtimePath.path]
            : [],
        }),
        policyLoad: catchAll,
      });
      expect(decision.kind).toBe("allow");
      expect(decision.matchedRules).toEqual([]);
    }
  });

  test("does not exempt policy, contract, or local harness settings writes", async (): Promise<void> => {
    const repo: string = makeTempDir("hyperagent-eval-config-paths-");
    const dataDir: string = join(repo, ".hyperagent");
    const cases: Array<{ path: string; ruleId: string }> = [
      {
        path: policyPath(dataDir),
        ruleId: "permission-config-edit.policy",
      },
      {
        path: join(repo, ".hyperagent", "contract.json"),
        ruleId: "permission-config-edit.contract",
      },
      {
        path: join(repo, ".claude", "settings.local.json"),
        ruleId: "permission-config-edit.claude-settings-local",
      },
    ];

    for (const candidate of cases) {
      const decision: GateDecision = await runGateEval({
        dataDir,
        input: hookInput(repo, { writePaths: [candidate.path] }),
      });
      expect(decision.kind).toBe("allow");
      expect(decision.matchedRules).toContain(candidate.ruleId);
    }
  });
});
