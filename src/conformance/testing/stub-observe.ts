import {
  appendFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createHash,
} from "node:crypto";
import {
  isAbsolute,
  join,
} from "node:path";

import type {
  AdapterHealth,
  DiscoveredSession,
  ObserveAdapter,
  ParseResult,
} from "../../adapters/types.ts";
import {
  EVENT_TYPES,
  SCHEMA_VERSION,
} from "../../schema/events.ts";
import type {
  EventInput,
} from "../../schema/events.ts";
import type {
  ConformanceContext,
  ConformanceDescriptor,
  ObserveFixtureSet,
  ObserveVariant,
  ResumeFixture,
  TruncationFixture,
} from "../types.ts";

export type ObserveMutation =
  | "none"
  | "discover"
  | "schema"
  | "golden"
  | "determinism"
  | "resume"
  | "unknown-record"
  | "truncation"
  | "breakage-signal"
  | "envelope";

type StubEventType = EventInput["type"];

interface StubKnownRecord {
  kind: "event";
  payload: Record<string, unknown>;
  ts: string;
  type: StubEventType;
}

interface StubUnknownRecord {
  kind: "future-record";
  value: string;
}

interface StubAdapterOptions {
  artifactPath: string;
  eventSessionId: string;
  mutation: ObserveMutation;
  reportedSessionId?: string;
}

const STUB_VENDOR = "stub";
const STUB_ADAPTER_VERSION = "1.0.0";
const STUB_DIALECT_VERSION = "stub-jsonl-1";
const NORMALIZED_PATH = "<temp-root-path>";
const NORMALIZED_ID = "<event-id>";
const NORMALIZED_VENDOR = "<descriptor-vendor>";
const NORMALIZED_ADAPTER_VERSION = "<descriptor-adapter-version>";
const KNOWN_EVENT_TYPES = new Set<string>(EVENT_TYPES);
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const OBSERVE_MUTATIONS: readonly ObserveMutation[] = [
  "none",
  "discover",
  "schema",
  "golden",
  "determinism",
  "resume",
  "unknown-record",
  "truncation",
  "breakage-signal",
  "envelope",
];

const MAIN_RECORDS: readonly StubKnownRecord[] = [
  {
    kind: "event",
    payload: { phase: "start" },
    ts: "2026-01-01T00:00:00.000Z",
    type: "session_start",
  },
  {
    kind: "event",
    payload: { name: "stub-tool" },
    ts: "2026-01-01T00:00:01.000Z",
    type: "tool_call",
  },
  {
    kind: "event",
    payload: { phase: "complete" },
    ts: "2026-01-01T00:00:02.000Z",
    type: "session_end",
  },
];

const UNKNOWN_RECORD: StubUnknownRecord = {
  kind: "future-record",
  value: "ignored-by-current-dialect",
};

/**
 * The snapshot intentionally excludes fields owned by dedicated checks. This
 * keeps each negative control attributable to one check instead of coupling
 * golden comparison to determinism or descriptor-envelope validation.
 */
export const STUB_GOLDEN_EVENTS: readonly unknown[] = [
  {
    adapter_version: NORMALIZED_ADAPTER_VERSION,
    id: NORMALIZED_ID,
    payload: { phase: "start" },
    raw_ref: NORMALIZED_PATH,
    schema_version: SCHEMA_VERSION,
    session_id: "stub:main",
    ts: "2026-01-01T00:00:00.000Z",
    type: "session_start",
    vendor: NORMALIZED_VENDOR,
  },
  {
    adapter_version: NORMALIZED_ADAPTER_VERSION,
    id: NORMALIZED_ID,
    payload: { name: "stub-tool" },
    raw_ref: NORMALIZED_PATH,
    schema_version: SCHEMA_VERSION,
    session_id: "stub:main",
    ts: "2026-01-01T00:00:01.000Z",
    type: "tool_call",
    vendor: NORMALIZED_VENDOR,
  },
  {
    adapter_version: NORMALIZED_ADAPTER_VERSION,
    id: NORMALIZED_ID,
    payload: { phase: "complete" },
    raw_ref: NORMALIZED_PATH,
    schema_version: SCHEMA_VERSION,
    session_id: "stub:main",
    ts: "2026-01-01T00:00:02.000Z",
    type: "session_end",
    vendor: NORMALIZED_VENDOR,
  },
];

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

function requireTempRoot(context: ConformanceContext): string {
  if (
    typeof context.tempRoot !== "string"
    || context.tempRoot.length === 0
    || !isAbsolute(context.tempRoot)
  ) {
    throw new Error("stub observe context.tempRoot must be an absolute path");
  }
  return context.tempRoot;
}

function encodeRecords(records: readonly unknown[]): string {
  return records.map((record: unknown): string => JSON.stringify(record))
    .join("\n") + "\n";
}

async function writeArtifact(
  artifactPath: string,
  contents: string,
  label: string,
): Promise<void> {
  try {
    await writeFile(artifactPath, contents, "utf8");
  } catch (error: unknown) {
    throw new Error(`${label} write failed: ${errorMessage(error)}`);
  }
}

async function appendArtifact(
  artifactPath: string,
  contents: string,
  label: string,
): Promise<void> {
  try {
    await appendFile(artifactPath, contents, "utf8");
  } catch (error: unknown) {
    throw new Error(`${label} append failed: ${errorMessage(error)}`);
  }
}

function parseResumeToken(resumeToken: string): number {
  if (resumeToken === "") {
    return 0;
  }
  if (!/^(0|[1-9]\d*)$/.test(resumeToken)) {
    throw new Error(
      `resume token must be empty or a decimal line offset, got `
      + JSON.stringify(resumeToken),
    );
  }
  const offset: number = Number(resumeToken);
  if (!Number.isSafeInteger(offset)) {
    throw new Error(`resume line offset is not a safe integer: ${resumeToken}`);
  }
  return offset;
}

function deterministicUlid(seed: string): string {
  const digest: Buffer = createHash("sha256").update(seed).digest();
  let value = 0n;
  for (const byte of digest.subarray(0, 16)) {
    value = (value << 8n) | BigInt(byte);
  }
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD_BASE32[Number(value & 31n)]! + encoded;
    value >>= 5n;
  }
  return encoded;
}

function requireKnownRecord(
  value: Record<string, unknown>,
): StubKnownRecord | undefined {
  if (value.kind !== "event") {
    return undefined;
  }
  if (
    typeof value.ts !== "string"
    || typeof value.type !== "string"
    || !KNOWN_EVENT_TYPES.has(value.type)
    || !isPlainObject(value.payload)
  ) {
    throw new Error("known event record has an invalid structure");
  }
  return {
    kind: "event",
    payload: value.payload,
    ts: value.ts,
    type: value.type as StubEventType,
  };
}

class StubObserveAdapter implements ObserveAdapter {
  readonly vendor = STUB_VENDOR;
  readonly adapterVersion = STUB_ADAPTER_VERSION;

  private parseInvocation = 0;

  constructor(private readonly options: StubAdapterOptions) {}

  async detect(): Promise<AdapterHealth> {
    return {
      status: "ok",
      harnessVersion: STUB_DIALECT_VERSION,
      detail: "bounded local JSONL stub fixture",
    };
  }

  async discoverSessions(): Promise<DiscoveredSession[]> {
    let metadata;
    try {
      metadata = await stat(this.options.artifactPath);
    } catch (error: unknown) {
      throw new Error(
        `stub discovery could not stat ${JSON.stringify(
          this.options.artifactPath,
        )}: ${errorMessage(error)}`,
      );
    }
    return [{
      sessionId: this.options.reportedSessionId
        ?? this.options.eventSessionId,
      path: this.options.artifactPath,
      mtimeMs: metadata.mtimeMs,
      sizeBytes: metadata.size,
    }];
  }

  /**
   * File reads are bounded by the finite fixture artifact. The adapter accepts
   * only the exact discovered path and a validated line-offset token, so it
   * cannot escape the caller-provided temporary root.
   */
  async parseSession(
    session: DiscoveredSession,
    resumeToken: string,
  ): Promise<ParseResult> {
    const reportedSessionId: string = this.options.reportedSessionId
      ?? this.options.eventSessionId;
    if (
      session.path !== this.options.artifactPath
      || session.sessionId !== reportedSessionId
    ) {
      throw new Error("stub parseSession received an unknown session");
    }
    const requestedOffset: number = parseResumeToken(resumeToken);

    let contents: string;
    try {
      contents = await readFile(this.options.artifactPath, "utf8");
    } catch (error: unknown) {
      throw new Error(
        `stub parse could not read ${JSON.stringify(
          this.options.artifactPath,
        )}: ${errorMessage(error)}`,
      );
    }

    const hasTrailingFragment: boolean = (
      contents.length > 0 && !contents.endsWith("\n")
    );
    const lines: string[] = contents.split("\n");
    if (!hasTrailingFragment) {
      lines.pop();
    }
    const completeLines: string[] = hasTrailingFragment
      ? lines.slice(0, -1)
      : lines;
    if (requestedOffset > completeLines.length) {
      throw new Error(
        `resume line offset ${requestedOffset} exceeds `
        + `${completeLines.length} complete line(s)`,
      );
    }

    this.parseInvocation += 1;
    const startOffset: number = this.options.mutation === "resume"
      ? 0
      : requestedOffset;
    const events: EventInput[] = [];
    let skippedUnknown = 0;
    let parseFailures = 0;

    for (
      let recordIndex = startOffset;
      recordIndex < completeLines.length;
      recordIndex += 1
    ) {
      const line: string = completeLines[recordIndex]!;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        parseFailures += 1;
        continue;
      }
      if (!isPlainObject(parsed)) {
        parseFailures += 1;
        continue;
      }

      let knownRecord: StubKnownRecord | undefined;
      try {
        knownRecord = requireKnownRecord(parsed);
      } catch {
        if (this.options.mutation !== "breakage-signal") {
          parseFailures += 1;
        }
        continue;
      }
      if (knownRecord === undefined) {
        if (this.options.mutation === "unknown-record") {
          parseFailures += 1;
        } else {
          skippedUnknown += 1;
        }
        continue;
      }
      events.push(this.eventFromRecord(knownRecord, recordIndex));
    }

    if (
      hasTrailingFragment
      && this.options.mutation === "truncation"
    ) {
      parseFailures += 1;
    }

    return {
      events,
      resumeToken: String(completeLines.length),
      skippedUnknown,
      parseFailures,
    };
  }

  private eventFromRecord(
    record: StubKnownRecord,
    recordIndex: number,
  ): EventInput {
    const idSeed: string = this.options.mutation === "determinism"
      ? `${recordIndex}:${this.parseInvocation}`
      : String(recordIndex);
    const payload: Record<string, unknown> = {
      ...record.payload,
      artifact_path: this.options.artifactPath,
    };
    if (this.options.mutation === "golden" && recordIndex === 1) {
      payload.unexpected = true;
    }

    const event: Record<string, unknown> = {
      id: deterministicUlid(`${this.options.eventSessionId}:${idSeed}`),
      ts: record.ts,
      type: record.type,
      session_id: this.options.eventSessionId,
      vendor: this.options.mutation === "envelope"
        ? "stub-envelope-mutant"
        : STUB_VENDOR,
      adapter_version: STUB_ADAPTER_VERSION,
      schema_version: SCHEMA_VERSION,
      raw_ref: this.options.artifactPath,
      payload,
    };
    if (this.options.mutation === "schema" && recordIndex === 1) {
      // The cast below is the negative control: raw_ref deliberately violates
      // EventInput while parseFailures remains zero.
      event.raw_ref = 42;
    }
    return event as unknown as EventInput;
  }
}

function normalizeEvent(
  event: EventInput,
  context: ConformanceContext,
): unknown {
  requireTempRoot(context);
  if (!isPlainObject(event)) {
    throw new Error("stub normalizeEvent expected a plain event object");
  }

  const normalized: Record<string, unknown> = { ...event };
  // Event ids are canonicalized because observe.determinism owns their exact
  // stability and the golden check should remain independent of that mutant.
  normalized.id = NORMALIZED_ID;
  // Vendor and adapter version are canonicalized because observe.envelope owns
  // their descriptor agreement.
  normalized.vendor = NORMALIZED_VENDOR;
  normalized.adapter_version = NORMALIZED_ADAPTER_VERSION;
  // raw_ref contains the absolute artifact path under context.tempRoot, which
  // varies from run to run. It is replaced rather than retained.
  normalized.raw_ref = NORMALIZED_PATH;

  if (isPlainObject(event.payload)) {
    const payload: Record<string, unknown> = { ...event.payload };
    // artifact_path is a second absolute context.tempRoot-derived value and is
    // omitted so the committed golden snapshot is machine-independent.
    delete payload.artifact_path;
    normalized.payload = payload;
  }
  return normalized;
}

async function createObserveFixtures(
  context: ConformanceContext,
  mutation: ObserveMutation,
  appendOnlyLines: boolean,
): Promise<ObserveFixtureSet> {
  const tempRoot: string = requireTempRoot(context);
  const fixtureRoot: string = join(tempRoot, "stub-observe");
  try {
    await mkdir(fixtureRoot, { recursive: true });
  } catch (error: unknown) {
    throw new Error(
      `stub fixture directory creation failed: ${errorMessage(error)}`,
    );
  }

  const mainPath: string = join(fixtureRoot, "main.jsonl");
  await writeArtifact(mainPath, encodeRecords(MAIN_RECORDS), "main fixture");
  const mainMutation: ObserveMutation = [
    "discover",
    "schema",
    "golden",
    "determinism",
    "envelope",
  ].includes(mutation)
    ? mutation
    : "none";
  const mainAdapter = new StubObserveAdapter({
    artifactPath: mainPath,
    eventSessionId: "stub:main",
    mutation: mainMutation,
    reportedSessionId: mutation === "discover" ? "main" : undefined,
  });

  const unknownPath: string = join(fixtureRoot, "unknown.jsonl");
  await writeArtifact(
    unknownPath,
    encodeRecords([MAIN_RECORDS[0], UNKNOWN_RECORD]),
    "unknown-record fixture",
  );
  const unknownRecord: ObserveVariant = {
    adapter: new StubObserveAdapter({
      artifactPath: unknownPath,
      eventSessionId: "stub:unknown",
      mutation: mutation === "unknown-record" ? mutation : "none",
    }),
    label: "stub unknown-record fixture",
  };

  const corruptedPath: string = join(fixtureRoot, "corrupted.jsonl");
  await writeArtifact(
    corruptedPath,
    `${JSON.stringify({ kind: "event", payload: "corrupted" })}\n`,
    "corrupted fixture",
  );
  const corrupted: ObserveVariant = {
    adapter: new StubObserveAdapter({
      artifactPath: corruptedPath,
      eventSessionId: "stub:corrupted",
      mutation: mutation === "breakage-signal" ? mutation : "none",
    }),
    label: "stub corrupted-known-record fixture",
  };

  const resumePrefixPath: string = join(fixtureRoot, "resume-prefix.jsonl");
  await writeArtifact(
    resumePrefixPath,
    encodeRecords(MAIN_RECORDS.slice(0, 1)),
    "resume prefix fixture",
  );
  const resumeFullPath: string = join(fixtureRoot, "resume-full.jsonl");
  await writeArtifact(
    resumeFullPath,
    encodeRecords(MAIN_RECORDS),
    "resume full fixture",
  );
  const resumeMutation: ObserveMutation = mutation === "resume"
    ? mutation
    : "none";
  let resumeCompleted = false;
  const resume: ResumeFixture = {
    adapter: new StubObserveAdapter({
      artifactPath: resumePrefixPath,
      eventSessionId: "stub:resume",
      mutation: resumeMutation,
    }),
    async completeArtifact(): Promise<void> {
      if (resumeCompleted) {
        throw new Error("resume fixture artifact was already completed");
      }
      await appendArtifact(
        resumePrefixPath,
        encodeRecords(MAIN_RECORDS.slice(1)),
        "resume fixture completion",
      );
      resumeCompleted = true;
    },
    fullAdapter: new StubObserveAdapter({
      artifactPath: resumeFullPath,
      eventSessionId: "stub:resume",
      mutation: "none",
    }),
  };

  const base: ObserveFixtureSet = {
    adapter: mainAdapter,
    expectedSessionIdPrefix: "stub:",
    goldenEvents: STUB_GOLDEN_EVENTS,
    normalizeEvent,
    unknownRecord,
    corrupted,
    resume,
  };
  if (!appendOnlyLines) {
    // The fixture is intentionally absent because the descriptor explicitly
    // declares that append-only line truncation does not apply.
    return base;
  }

  const truncationPath: string = join(fixtureRoot, "truncation.jsonl");
  const completedLine: string = JSON.stringify(MAIN_RECORDS[1]);
  const splitAt: number = Math.floor(completedLine.length / 2);
  await writeArtifact(
    truncationPath,
    encodeRecords(MAIN_RECORDS.slice(0, 1))
      + completedLine.slice(0, splitAt),
    "truncation fixture",
  );
  let truncationCompleted = false;
  const truncation: TruncationFixture = {
    adapter: new StubObserveAdapter({
      artifactPath: truncationPath,
      eventSessionId: "stub:truncation",
      mutation: mutation === "truncation" ? mutation : "none",
    }),
    async completeLine(): Promise<void> {
      if (truncationCompleted) {
        throw new Error("truncation fixture line was already completed");
      }
      await appendArtifact(
        truncationPath,
        completedLine.slice(splitAt) + "\n",
        "truncation fixture completion",
      );
      truncationCompleted = true;
    },
  };
  return { ...base, truncation };
}

function createDescriptor(
  mutation: ObserveMutation,
  appendOnlyLines: boolean,
): ConformanceDescriptor {
  if (!OBSERVE_MUTATIONS.includes(mutation)) {
    throw new Error(`unsupported observe mutation: ${String(mutation)}`);
  }
  return {
    vendor: STUB_VENDOR,
    adapterVersion: STUB_ADAPTER_VERSION,
    dialectVersion: STUB_DIALECT_VERSION,
    claimed: {
      observe: true,
      inject: false,
      gate: false,
    },
    storageTraits: { appendOnlyLines },
    claimedHookKinds: [],
    forbiddenTargetPatterns: [],
    factories: {
      async observe(context: ConformanceContext): Promise<ObserveFixtureSet> {
        return createObserveFixtures(context, mutation, appendOnlyLines);
      },
    },
  };
}

export function createStubObserveDescriptor(
  mutation: ObserveMutation,
): ConformanceDescriptor {
  return createDescriptor(mutation, true);
}

export function createStubObserveDescriptorWithoutAppendOnlyLines(
): ConformanceDescriptor {
  return createDescriptor("none", false);
}
