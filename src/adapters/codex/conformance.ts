/**
 * Synthetic fixture provenance:
 * Every Codex rollout fixture beside this file was hand-authored in the
 * verified JSONL dialect. No record, username, home path, or session content
 * was copied from ~/.codex. Stable synthetic paths and ids make the committed
 * golden snapshot both privacy-safe and machine-independent.
 */

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
  InjectAdapter,
  InjectionResult,
  ParseResult,
} from "../types.ts";
import type { EventInput } from "../../schema/events.ts";
import type {
  ConformanceContext,
  ConformanceDescriptor,
  InjectFixtureSet,
  ObserveFixtureSet,
  ObserveVariant,
  ResumeFixture,
  TruncationFixture,
} from "../../conformance/types.ts";
import type { MemoryRow } from "../../memory/store.ts";
import goldenEvents from "./conformance-golden.json" with { type: "json" };
import {
  CODEX_DIALECT_VERSION,
  CodexAdapter,
} from "./adapter.ts";
import { CodexInjectAdapter } from "./inject.ts";

const ADAPTER_VERSION: string = new CodexAdapter({
  sessionsRoot: import.meta.dir,
}).adapterVersion;
const FIXTURE_ROOT: string = join(import.meta.dir, "conformance-fixtures");
const FIXTURE_DATE = join("2026", "07", "27");
const OPERATION_TIMEOUT_MS = 5_000;
const NORMALIZED_OBSERVED_AT = "<OBSERVED_AT>";

interface VariantArtifact {
  adapter: CodexAdapter;
  artifactPath: string;
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

class BoundedCodexAdapter extends CodexAdapter {
  override async discoverSessions(): Promise<DiscoveredSession[]> {
    return bounded(
      "Codex fixture discovery",
      async (): Promise<DiscoveredSession[]> => super.discoverSessions(),
    );
  }

  override async parseSession(
    session: DiscoveredSession,
    resumeToken: string,
  ): Promise<ParseResult> {
    return bounded(
      `Codex fixture parse for ${JSON.stringify(session.sessionId)}`,
      async (): Promise<ParseResult> =>
        super.parseSession(session, resumeToken),
    );
  }
}

class BoundedCodexInjectAdapter
  extends CodexInjectAdapter
  implements InjectAdapter
{
  override async renderInjection(
    targetRepo: string,
    memories: MemoryRow[],
  ): Promise<InjectionResult> {
    return bounded(
      `Codex fixture injection for ${JSON.stringify(targetRepo)}`,
      async (): Promise<InjectionResult> =>
        super.renderInjection(targetRepo, memories),
    );
  }
}

function requireTempRoot(context: ConformanceContext): string {
  if (
    !isPlainObject(context) ||
    typeof context.tempRoot !== "string" ||
    context.tempRoot.length === 0 ||
    !isAbsolute(context.tempRoot)
  ) {
    throw new Error("Codex conformance context.tempRoot must be absolute");
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

function withoutFixtureTrailingNewline(
  contents: Uint8Array,
  fixtureName: string,
): Uint8Array {
  if (contents.at(-1) !== 10) {
    throw new Error(
      `fixture ${JSON.stringify(fixtureName)} must end in a newline`,
    );
  }
  return contents.subarray(0, contents.length - 1);
}

async function createVariant(
  tempRoot: string,
  variant: string,
  fixtureName: string,
  options: { stripTrailingNewline?: boolean } = {},
): Promise<VariantArtifact> {
  const sessionsRoot: string = join(
    tempRoot,
    `codex-observe-${variant}`,
    "sessions",
  );
  const dateRoot: string = join(sessionsRoot, FIXTURE_DATE);
  const artifactPath: string = join(
    dateRoot,
    `rollout-2026-07-27T12-00-00-${variant}.jsonl`,
  );
  await bounded(
    `${variant} fixture directory creation`,
    async (): Promise<void> => {
      await mkdir(dateRoot, { recursive: true });
    },
  );
  const fixture: Uint8Array = await fixtureBytes(fixtureName);
  const contents: Uint8Array = options.stripTrailingNewline === true
    ? withoutFixtureTrailingNewline(fixture, fixtureName)
    : fixture;
  await bounded(
    `${variant} fixture copy`,
    async (): Promise<void> => writeFile(artifactPath, contents),
  );
  return {
    adapter: new BoundedCodexAdapter({ sessionsRoot }),
    artifactPath,
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
      throw new Error("Codex normalizeEvent expected a plain object");
    }
    if (typeof event.id !== "string" || event.id.length === 0) {
      throw new Error("Codex event.id must be a non-empty string");
    }
    if (
      typeof event.raw_ref !== "string" ||
      !event.raw_ref.startsWith("codex:")
    ) {
      throw new Error(
        `Codex event.raw_ref must be native-session based, got ` +
        JSON.stringify(event.raw_ref),
      );
    }

    /*
     * Unlike the Claude Code adapter, Codex ids and raw refs contain no
     * artifact path, so the golden keeps both verbatim and will catch any
     * regression back to path-dependent identity. Only wall-clock ingestion
     * time is normalized when a caller has supplied it.
     */
    if (Object.prototype.hasOwnProperty.call(event, "observed_at")) {
      return { ...event, observed_at: NORMALIZED_OBSERVED_AT };
    }
    return { ...event };
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
    "unknown",
    "unknown-record.jsonl",
  );
  const corrupted: VariantArtifact = await createVariant(
    tempRoot,
    "corrupted",
    "corrupted.jsonl",
  );
  const resumeArtifact: VariantArtifact = await createVariant(
    tempRoot,
    "resume-prefix",
    "resume-prefix.jsonl",
  );
  const resumeComplete: VariantArtifact = await createVariant(
    tempRoot,
    "resume-complete",
    "resume-complete.jsonl",
  );
  const truncationArtifact: VariantArtifact = await createVariant(
    tempRoot,
    "truncated",
    "truncated.jsonl",
    { stripTrailingNewline: true },
  );

  const unknownRecord: ObserveVariant = {
    adapter: unknown.adapter,
    label: "Codex unknown-record fixture",
  };
  const corruptedVariant: ObserveVariant = {
    adapter: corrupted.adapter,
    label: "Codex corrupted-known-record fixture",
  };

  let resumeCompleted = false;
  const resume: ResumeFixture = {
    adapter: resumeArtifact.adapter,
    async completeArtifact(): Promise<void> {
      if (resumeCompleted) {
        throw new Error("Codex resume fixture was already completed");
      }
      await appendFixture(
        resumeArtifact.artifactPath,
        "resume-remainder.jsonl",
        "resume fixture completion",
      );
      resumeCompleted = true;
    },
    fullAdapter: resumeComplete.adapter,
  };

  let truncationCompleted = false;
  const truncation: TruncationFixture = {
    adapter: truncationArtifact.adapter,
    async completeLine(): Promise<void> {
      if (truncationCompleted) {
        throw new Error("Codex truncation line was already completed");
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
    expectedSessionIdPrefix: "codex:",
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
  const refusalRoot: string = join(tempRoot, "codex-inject-home");
  await bounded(
    "Codex inject refusal-root creation",
    async (): Promise<void> => {
      await mkdir(refusalRoot, { recursive: true });
    },
  );

  const sentinel = "CODEX_CONFORMANCE_MEMORY_SENTINEL";
  const timestamp = "2026-07-27T12:00:00.000Z";
  const memories: MemoryRow[] = [{
    id: "01K14CODEXCONFORMANCE0001",
    claim: `${sentinel}: preserve tracked AGENTS.md content around memory.`,
    kind: "gotcha",
    scope: "repo",
    scope_key: "codex-conformance",
    confidence: 0.98,
    status: "approved",
    evidence: [{
      session_id: "codex:conformance-inject",
      raw_ref: "fixture://codex/inject",
    }],
    source: "manual",
    claim_hash:
      "e5a00f0ab69750d9c77e8731d101293574017ddbdd269b7356e366b636d30ac3",
    created_at: timestamp,
    updated_at: timestamp,
    last_validated_at: timestamp,
  }];

  return {
    adapter: new BoundedCodexInjectAdapter({ homeDir: refusalRoot }),
    memories,
    sentinel,
    managedArtifactPath(repoPath: string): string {
      return join(repoPath, "AGENTS.md");
    },
    foreignContent:
      "# Existing Codex instructions\n\nKeep this tracked guidance intact.\n",
    refusalRoot,
  };
}

/**
 * Golden regeneration: build the observe fixture in a disposable temp root,
 * parse the clean adapter from offset zero, normalize with normalizeEvent,
 * recursively key-sort as the vendor-blind golden check does, and write the
 * resulting array with two-space indentation plus a trailing newline.
 */
export const codexConformanceDescriptor: ConformanceDescriptor = {
  vendor: "codex",
  adapterVersion: ADAPTER_VERSION,
  dialectVersion: CODEX_DIALECT_VERSION,
  claimed: { observe: true, inject: true, gate: false },
  /*
   * Empirical slice-1 evidence for appendOnlyLines=true: while a live rollout
   * grew from 447,787 to 872,232 bytes, its inode stayed 197157734, its first
   * 64 KiB SHA-256 stayed fc44bdf...171868, and every sample ended in byte 10.
   * That is append-in-place, line-terminated growth rather than rewrite.
   */
  storageTraits: { appendOnlyLines: true },
  claimedHookKinds: [],
  forbiddenTargetPatterns: [".claude", ".hyperagent", ".codex"],
  factories: {
    observe: createObserveFixtures,
    inject: createInjectFixtures,
  },
};
