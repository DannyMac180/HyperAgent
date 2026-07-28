import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  sep,
} from "node:path";

import type {
  DiscoveredSession,
  ParseResult,
} from "../types.ts";
import type { EventInput } from "../../schema/events.ts";
import type {
  ConformanceContext,
  ConformanceDescriptor,
  GateFixtureSet,
  InjectFixtureSet,
  ObserveFixtureSet,
  ObserveVariant,
  ResumeFixture,
  TruncationFixture,
} from "../../conformance/types.ts";
import type {
  GateDecision,
  GateHookKind,
} from "../../gate/eval.ts";
import type { MemoryRow } from "../../memory/store.ts";
import goldenEvents from "./conformance-golden.json" with { type: "json" };
import { ClaudeCodeAdapter } from "./adapter.ts";
import { ClaudeCodeGateAdapter } from "./gate.ts";
import { ClaudeCodeInjectAdapter } from "./inject.ts";

export const CLAUDE_CODE_DIALECT_VERSION =
  "claude-code-jsonl-2026-07-26-v1";

const ADAPTER_VERSION: string = new ClaudeCodeAdapter({
  projectsRoot: import.meta.dir,
}).adapterVersion;
const FIXTURE_ROOT: string = join(import.meta.dir, "conformance-fixtures");
const PROJECT_DIRECTORY = "-conformance-project";
const SESSION_FILE = "44444444-4444-4444-8444-444444444444.jsonl";
const OPERATION_TIMEOUT_MS = 5_000;
const NORMALIZED_OBSERVED_AT = "<OBSERVED_AT>";

interface VariantArtifact {
  adapter: ClaudeCodeAdapter;
  artifactPath: string;
  projectsRoot: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    return "unknown thrown value";
  }
}

async function bounded<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject): void => {
    timer = setTimeout((): void => {
      reject(new Error(`timed out after ${OPERATION_TIMEOUT_MS}ms`));
    }, OPERATION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operation(), timeout]);
  } catch (error: unknown) {
    throw new Error(`${label} failed: ${errorMessage(error)}`);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * The vendor-blind runner cannot cancel arbitrary adapter I/O. This subclass
 * keeps every real-adapter call bounded while preserving the production
 * ClaudeCodeAdapter implementation under test.
 */
class BoundedClaudeCodeAdapter extends ClaudeCodeAdapter {
  override async discoverSessions(): Promise<DiscoveredSession[]> {
    return bounded(
      "Claude Code fixture discovery",
      async (): Promise<DiscoveredSession[]> => super.discoverSessions(),
    );
  }

  override async parseSession(
    session: DiscoveredSession,
    resumeToken: string,
  ): Promise<ParseResult> {
    return bounded(
      `Claude Code fixture parse for ${JSON.stringify(session.sessionId)}`,
      async (): Promise<ParseResult> =>
        super.parseSession(session, resumeToken),
    );
  }
}

function requireTempRoot(context: ConformanceContext): string {
  if (
    !isPlainObject(context)
    || typeof context.tempRoot !== "string"
    || context.tempRoot.length === 0
    || !isAbsolute(context.tempRoot)
  ) {
    throw new Error(
      "Claude Code conformance context.tempRoot must be an absolute path",
    );
  }
  return context.tempRoot.endsWith(sep) && context.tempRoot !== sep
    ? context.tempRoot.slice(0, -1)
    : context.tempRoot;
}

async function fixtureBytes(name: string): Promise<Uint8Array> {
  return bounded(
    `fixture ${JSON.stringify(name)} read`,
    async (): Promise<Uint8Array> => readFile(join(FIXTURE_ROOT, name)),
  );
}

async function createVariant(
  tempRoot: string,
  variant: string,
  fixtureName: string,
): Promise<VariantArtifact> {
  const projectsRoot: string = join(
    tempRoot,
    `claude-code-observe-${variant}`,
    "projects",
  );
  const projectPath: string = join(projectsRoot, PROJECT_DIRECTORY);
  const artifactPath: string = join(projectPath, SESSION_FILE);
  await bounded(
    `${variant} fixture directory creation`,
    async (): Promise<void> => {
      await mkdir(projectPath, { recursive: true });
    },
  );
  const contents: Uint8Array = await fixtureBytes(fixtureName);
  await bounded(
    `${variant} fixture copy`,
    async (): Promise<void> => writeFile(artifactPath, contents),
  );
  return {
    adapter: new BoundedClaudeCodeAdapter({ projectsRoot }),
    artifactPath,
    projectsRoot,
  };
}

async function appendFixture(
  artifactPath: string,
  fixtureName: string,
  label: string,
): Promise<void> {
  const contents: Uint8Array = await fixtureBytes(fixtureName);
  await bounded(
    label,
    async (): Promise<void> => appendFile(artifactPath, contents),
  );
}

function createNormalizer(): ObserveFixtureSet["normalizeEvent"] {
  return (event: EventInput, _context: ConformanceContext): unknown => {
    if (!isPlainObject(event)) {
      throw new Error("Claude Code normalizeEvent expected a plain object");
    }
    if (typeof event.id !== "string" || event.id.length === 0) {
      throw new Error("Claude Code event.id must be a non-empty string");
    }

    const normalized: Record<string, unknown> = { ...event };

    /*
     * observed_at, when present, is wall-clock ingestion time rather than
     * transcript data. Only that timestamp is replaced; ts remains verbatim.
     */
    if (Object.prototype.hasOwnProperty.call(event, "observed_at")) {
      normalized.observed_at = NORMALIZED_OBSERVED_AT;
    }

    return normalized;
  };
}

async function createObserveFixtures(
  context: ConformanceContext,
): Promise<ObserveFixtureSet> {
  const tempRoot: string = requireTempRoot(context);
  const clean: VariantArtifact = await createVariant(
    tempRoot,
    "clean",
    "clean.jsonl",
  );
  const unknown: VariantArtifact = await createVariant(
    tempRoot,
    "unknown-record",
    "unknown-record.jsonl",
  );
  const corrupted: VariantArtifact = await createVariant(
    tempRoot,
    "corrupted",
    "corrupted.jsonl",
  );
  const resumeArtifact: VariantArtifact = await createVariant(
    tempRoot,
    "resume",
    "resume-prefix.jsonl",
  );
  const truncationArtifact: VariantArtifact = await createVariant(
    tempRoot,
    "truncation",
    "truncated.jsonl",
  );

  const unknownRecord: ObserveVariant = {
    adapter: unknown.adapter,
    label: "Claude Code unknown-record fixture",
  };
  const corruptedVariant: ObserveVariant = {
    adapter: corrupted.adapter,
    label: "Claude Code corrupted-known-record fixture",
  };

  let resumeCompleted = false;
  const resume: ResumeFixture = {
    adapter: resumeArtifact.adapter,
    async completeArtifact(): Promise<void> {
      if (resumeCompleted) {
        throw new Error("Claude Code resume fixture was already completed");
      }
      await appendFixture(
        resumeArtifact.artifactPath,
        "resume-remainder.jsonl",
        "resume fixture completion",
      );
      resumeCompleted = true;
    },
    fullAdapter: new BoundedClaudeCodeAdapter({
      projectsRoot: resumeArtifact.projectsRoot,
    }),
  };

  let truncationCompleted = false;
  const truncation: TruncationFixture = {
    adapter: truncationArtifact.adapter,
    async completeLine(): Promise<void> {
      if (truncationCompleted) {
        throw new Error("Claude Code truncation line was already completed");
      }
      await appendFixture(
        truncationArtifact.artifactPath,
        "truncated-remainder.txt",
        "truncation fixture completion",
      );
      truncationCompleted = true;
    },
  };

  return {
    adapter: clean.adapter,
    expectedSessionIdPrefix: "claude-code:",
    goldenEvents,
    normalizeEvent: createNormalizer(),
    unknownRecord,
    corrupted: corruptedVariant,
    resume,
    truncation,
  };
}

async function createInjectFixtures(
  context: ConformanceContext,
): Promise<InjectFixtureSet> {
  const tempRoot: string = requireTempRoot(context);
  const refusalRoot: string = join(tempRoot, "claude-code-inject-home");
  await mkdir(refusalRoot, { recursive: true });

  const sentinel = "CLAUDE_CODE_CONFORMANCE_MEMORY_SENTINEL";
  const timestamp = "2026-07-27T12:00:00.000Z";
  const memories: MemoryRow[] = [{
    id: "01K14CLAUDECODECONFORMANCE01",
    claim: `${sentinel}: preserve user-authored content around managed memory.`,
    kind: "gotcha",
    scope: "repo",
    scope_key: "claude-code-conformance",
    confidence: 0.98,
    status: "approved",
    evidence: [{
      session_id: "claude-code:conformance-inject",
      raw_ref: "fixture://claude-code/inject",
    }],
    source: "manual",
    claim_hash:
      "8e850bf59fd9ac32aa1844e371c0e7d96b30c91709221145f5f76968da2d93f2",
    created_at: timestamp,
    updated_at: timestamp,
    last_validated_at: timestamp,
  }];

  return {
    adapter: new ClaudeCodeInjectAdapter({ homeDir: refusalRoot }),
    memories,
    sentinel,
    managedArtifactPath(repoPath: string): string {
      return join(repoPath, "CLAUDE.local.md");
    },
    foreignContent:
      "# Local Claude instructions\n\nKeep this user-authored guidance intact.\n",
    refusalRoot,
  };
}

function gateDecision(kind: GateHookKind): GateDecision {
  if (kind === "pre_tool_use") {
    return {
      kind: "deny",
      reason: "Conformance fixture denied this tool call.",
      matchedRules: ["fixture.pre-tool-deny"],
      failedChecks: [],
    };
  }
  if (kind === "stop") {
    return {
      kind: "block",
      reason: "Conformance fixture requires the session to continue.",
      matchedRules: ["fixture.stop-block"],
      failedChecks: [],
    };
  }
  return {
    kind: "allow",
    reason: "Conformance fixture observed a successful tool call.",
    matchedRules: [],
    failedChecks: [],
  };
}

function validateGateHookOutput(
  kind: GateHookKind,
  decision: GateDecision,
  rendered: string,
): string | null {
  if (kind === "post_tool_use") {
    return rendered === ""
      ? null
      : `post_tool_use expected empty output, got ${JSON.stringify(rendered)}`;
  }

  let actual: unknown;
  try {
    actual = JSON.parse(rendered);
  } catch (error: unknown) {
    return `${kind} expected JSON output: ${errorMessage(error)}`;
  }

  const expected: unknown = kind === "pre_tool_use"
    ? {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason ?? "",
      },
    }
    : {
      decision: "block",
      reason: decision.reason ?? "",
    };
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? null
    : `${kind} output mismatch: expected ${JSON.stringify(expected)}, got ${
      JSON.stringify(actual)
    }`;
}

async function createGateFixtures(
  context: ConformanceContext,
): Promise<GateFixtureSet> {
  const tempRoot: string = requireTempRoot(context);
  const homeDir: string = join(tempRoot, "claude-code-gate-home");
  const dataDir: string = join(tempRoot, "claude-code-gate-data");
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
  ]);

  return {
    adapter: new ClaudeCodeGateAdapter({ dataDir, homeDir }),
    managedArtifactPath(repoPath: string): string {
      return join(repoPath, ".claude", "settings.local.json");
    },
    foreignContent: `${JSON.stringify({
      permissions: {
        allow: ["Read(./user-owned/**)"],
      },
    }, null, 2)}\n`,
    hookStdin(kind: GateHookKind): unknown {
      const common = {
        session_id: `conformance-${kind}`,
        cwd: join(tempRoot, "hook-repo"),
      };
      if (kind === "stop") {
        return {
          ...common,
          stop_hook_active: false,
        };
      }
      if (kind === "post_tool_use") {
        return {
          ...common,
          tool_name: "Bash",
          tool_input: { command: "bun test" },
          tool_response: { interrupted: false },
        };
      }
      return {
        ...common,
        tool_name: "Read",
        tool_input: { file_path: join(tempRoot, "hook-repo", "README.md") },
      };
    },
    decisionFor: gateDecision,
    validateHookOutput: validateGateHookOutput,
    malformedHookStdin(): readonly unknown[] {
      return [
        null,
        42,
        "string",
        {},
        { session_id: "" },
        { session_id: "x" },
      ];
    },
  };
}

/**
 * To regenerate conformance-golden.json after a dialect-version bump, run the
 * descriptor's observe factory in a disposable system temp root, discover and
 * parse the clean adapter from an empty resume token, map every emitted event
 * through that fixture set's normalizeEvent with the same context, sort the
 * normalized events by recursively key-sorted JSON, then write the array with
 * two-space indentation and a trailing newline. Delete the one-off temp script
 * and temp root afterward, and verify the snapshot contains no absolute paths.
 * The committed fixture bytes must never be generated through adapter code.
 */
export const claudeCodeConformanceDescriptor: ConformanceDescriptor = {
  vendor: "claude-code",
  adapterVersion: ADAPTER_VERSION,
  dialectVersion: CLAUDE_CODE_DIALECT_VERSION,
  claimed: { observe: true, inject: true, gate: true },
  storageTraits: { appendOnlyLines: true },
  claimedHookKinds: ["pre_tool_use", "post_tool_use", "stop"],
  forbiddenTargetPatterns: [".claude", ".hyperagent"],
  factories: {
    observe: createObserveFixtures,
    inject: createInjectFixtures,
    gate: createGateFixtures,
  },
};
