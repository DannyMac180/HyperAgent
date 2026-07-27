import { homedir } from "node:os";
import { basename, join } from "node:path";

import { isSuitOwnSession } from "../missions/runner.ts";
import type { HyperEvent } from "../schema/events.ts";
import {
  SCORER_VERSION,
  scoreSession,
  type SessionScore,
} from "../scoring/score.ts";
import type { SessionRow, Store } from "../store/store.ts";

export const FRICTION_EXTRACTOR_VERSION = "1";

export type FrictionKind =
  | "error"
  | "retry"
  | "gate_block"
  | "contract_check_failed"
  | "policy_violation"
  | "low_score"
  | "bounce_loop"
  | "repeated_rediscovery";

export interface FrictionSignal {
  kind: FrictionKind;
  sessionId: string;
  eventId: string;
  ts: string;
  repo: string | null;
  agent: string | null;
  vendor: string;
  rawSignature: string;
  signature: string;
  detail: string;
}

export interface FrictionCluster {
  signature: string;
  kind: FrictionKind;
  count: number;
  sessionIds: string[];
  eventIds: string[];
  repos: string[];
  agents: string[];
  firstSeen: string;
  lastSeen: string;
  exemplars: string[];
}

export interface FragmentationReport {
  totalSignals: number;
  totalSignatures: number;
  singletonSignatures: number;
  singleSessionSignatures: number;
  forwardedClusters: number;
  distribution: Array<{ sessionSpan: number; signatureCount: number }>;
}

export interface FrictionAnalysis {
  clusters: FrictionCluster[];
  allClusters: FrictionCluster[];
  signals: FrictionSignal[];
  fragmentation: FragmentationReport;
  diagnostics: string[];
  excludedSessionIds: string[];
  extractorVersion: string;
}

export interface FrictionOptions {
  dataDir?: string;
  repo?: string;
  sessionIds?: string[];
  since?: string;
  limit?: number;
  minSessions?: number;
  lowScoreThreshold?: number;
}

interface ResolvedFrictionOptions {
  dataDir: string;
  repo: string | undefined;
  sessionIds: string[] | undefined;
  since: string | undefined;
  limit: number | undefined;
  minSessions: number;
  lowScoreThreshold: number;
}

interface SessionMetadata {
  repo: string | null;
  agent: string | null;
}

interface SessionExtraction {
  signals: FrictionSignal[];
  diagnostics: string[];
}

interface SessionInput {
  sessionId: string;
  events: HyperEvent[];
}

interface NamedNormalizationStep {
  name: string;
  apply: (value: string) => string;
}

interface GateShape {
  outcomeKind: string | null;
  matchedRuleIds: string[];
  failedCheckIds: string[];
  summary: string | null;
}

const DEFAULT_MIN_SESSIONS = 2;
// SessionScore has no aggregate `total`. Its only normalized quality scalar
// is verification_pass_rate (0..1), so the public 60 default is a percentage.
const DEFAULT_LOW_SCORE_THRESHOLD = 60;
const READ_TOOL_NAME = /(?:^|[_\s-])(cat|find|glob|grep|head|inspect|open|read|search|tail|view)(?:$|[_\s-])/iu;
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const HEX_PATTERN = /\b[0-9a-f]{8,}\b/giu;
const ISO_TIMESTAMP_PATTERN =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/gu;
const CLOCK_TIME_PATTERN = /\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/gu;
const PID_PATTERN = /\bpid\s*(?:=|:)?\s*\d+\b/giu;
const LINE_COLUMN_PATTERN = /:\d+:\d+(?=$|[\s"'`,;)\]}])/gu;
const LINE_PATTERN = /:\d+(?=$|[\s"'`,;)\]}])/gu;
// All standalone integer runs, including single digits: live-probe data showed
// `v6.24.0` and `v6.3.0` fragmenting into separate clusters because only the
// two-digit component normalized. Fragmentation silently under-counts friction;
// an over-merged cluster is still splittable by a human via its evidence links.
const INTEGER_PATTERN = /\b\d+\b/gu;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function basenameWithLocation(value: string): string {
  const location = value.match(/^(.*?)(:\d+(?::\d+)?)$/u);
  const path = location?.[1] ?? value;
  const suffix = location?.[2] ?? "";
  return `${basename(path)}${suffix}`;
}

function replaceAbsolutePaths(value: string): string {
  const quoted = value.replace(
    /(["'])(\/[^"']+)\1/gu,
    (_match: string, quote: string, path: string): string =>
      `${quote}${basenameWithLocation(path)}${quote}`,
  );
  return quoted.replace(
    /\/(?:[^\s"'`<>:]+\/)*[^\s"'`<>:,;)\]}]+(?::\d+(?::\d+)?)?/gu,
    (path: string): string => basenameWithLocation(path),
  );
}

/**
 * The list is intentionally ordered. In particular, UUID replacement must
 * precede generic hex replacement, and path reduction must preserve locations
 * until the later line/column step.
 */
const SIGNATURE_NORMALIZATION_STEPS: readonly NamedNormalizationStep[] = [
  { name: "absolute-posix-path", apply: replaceAbsolutePaths },
  {
    name: "timestamp",
    apply: (value: string): string =>
      value
        .replace(ISO_TIMESTAMP_PATTERN, "<TS>")
        .replace(CLOCK_TIME_PATTERN, "<TS>"),
  },
  {
    name: "uuid",
    apply: (value: string): string => value.replace(UUID_PATTERN, "<UUID>"),
  },
  {
    name: "hex-run",
    apply: (value: string): string => value.replace(HEX_PATTERN, "<HASH>"),
  },
  {
    name: "process-id",
    apply: (value: string): string => value.replace(PID_PATTERN, "<PID>"),
  },
  {
    name: "line-location",
    apply: (value: string): string =>
      value
        .replace(LINE_COLUMN_PATTERN, ":<LINE>")
        .replace(LINE_PATTERN, ":<LINE>"),
  },
  {
    name: "integer",
    apply: (value: string): string => value.replace(INTEGER_PATTERN, "<N>"),
  },
  {
    name: "whitespace-and-case",
    apply: (value: string): string =>
      value.replace(/\s+/gu, " ").trim().toLowerCase(),
  },
];

export function normalizeSignature(raw: string): string {
  if (typeof raw !== "string") {
    throw new Error("friction signature must be a string");
  }
  return SIGNATURE_NORMALIZATION_STEPS.reduce(
    (value: string, step: NamedNormalizationStep): string => step.apply(value),
    raw,
  );
}

function optionalString(
  payload: Record<string, unknown>,
  key: string,
  label: string,
  diagnostics: string[],
): string | null {
  const value = payload[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    diagnostics.push(`${label}.${key} must be a string when present`);
    return null;
  }
  return value;
}

function optionalStringArray(
  payload: Record<string, unknown>,
  key: string,
  label: string,
  diagnostics: string[],
): string[] {
  const value = payload[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    diagnostics.push(`${label}.${key} must be an array when present`);
    return [];
  }
  const strings: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      diagnostics.push(`${label}.${key}[${index}] must be a string`);
      continue;
    }
    strings.push(entry);
  }
  return strings;
}

function resolveOptions(
  suppliedOptions: FrictionOptions = {},
): ResolvedFrictionOptions {
  if (!isPlainObject(suppliedOptions)) {
    throw new Error("friction options must be a plain object");
  }
  // isPlainObject narrows its argument to Record<string, unknown>, which would
  // erase the declared property types; read fields through the typed alias.
  const options: FrictionOptions = suppliedOptions;
  if (
    options.dataDir !== undefined
    && (typeof options.dataDir !== "string" || options.dataDir.length === 0)
  ) {
    throw new Error("friction dataDir must be a non-empty string");
  }
  if (
    options.repo !== undefined
    && (typeof options.repo !== "string" || options.repo.length === 0)
  ) {
    throw new Error("friction repo must be a non-empty string");
  }
  if (options.sessionIds !== undefined && !Array.isArray(options.sessionIds)) {
    throw new Error("friction sessionIds must be an array");
  }
  const sessionIds = options.sessionIds?.map(
    (sessionId: unknown, index: number): string => {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error(`friction sessionIds[${index}] must be a non-empty string`);
      }
      return sessionId;
    },
  );
  if (options.since !== undefined) {
    if (
      typeof options.since !== "string"
      || options.since.length === 0
      || Number.isNaN(Date.parse(options.since))
    ) {
      throw new Error("friction since must be a valid ISO timestamp");
    }
  }
  // Each numeric option is captured into a local before validation: the
  // Number.isSafeInteger/isFinite type guards narrow their argument, so testing
  // the negation directly against the optional property strips it to a
  // non-numeric type and breaks the subsequent range comparison.
  const limit: number | undefined = options.limit;
  if (
    limit !== undefined
    && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0)
  ) {
    throw new Error("friction limit must be a non-negative safe integer");
  }
  const minSessions: number | undefined = options.minSessions;
  if (
    minSessions !== undefined
    && (
      typeof minSessions !== "number"
      || !Number.isSafeInteger(minSessions)
      || minSessions < 1
    )
  ) {
    throw new Error("friction minSessions must be a positive safe integer");
  }
  const lowScoreThreshold: number | undefined = options.lowScoreThreshold;
  if (
    lowScoreThreshold !== undefined
    && (
      typeof lowScoreThreshold !== "number"
      || !Number.isFinite(lowScoreThreshold)
      || lowScoreThreshold < 0
      || lowScoreThreshold > 100
    )
  ) {
    throw new Error("friction lowScoreThreshold must be between 0 and 100");
  }
  return {
    dataDir: options.dataDir ?? join(homedir(), ".hyperagent"),
    repo: options.repo,
    sessionIds: sessionIds === undefined
      ? undefined
      : [...new Set(sessionIds)].sort(),
    since: options.since,
    limit,
    minSessions: minSessions ?? DEFAULT_MIN_SESSIONS,
    lowScoreThreshold: lowScoreThreshold ?? DEFAULT_LOW_SCORE_THRESHOLD,
  };
}

function metadataFromEvents(
  events: HyperEvent[],
  diagnostics: string[],
): SessionMetadata {
  const metadata: SessionMetadata = { repo: null, agent: null };
  for (const event of events) {
    if (event.type !== "session_start") {
      continue;
    }
    metadata.repo = optionalString(
      event.payload,
      "repo",
      `event ${event.id}`,
      diagnostics,
    );
    metadata.agent = optionalString(
      event.payload,
      "agent",
      `event ${event.id}`,
      diagnostics,
    );
  }
  return metadata;
}

function makeSignal(
  kind: FrictionKind,
  event: HyperEvent,
  metadata: SessionMetadata,
  rawSignature: string,
  detail: string,
): FrictionSignal {
  return {
    kind,
    sessionId: event.session_id,
    eventId: event.id,
    ts: event.ts,
    repo: metadata.repo,
    agent: metadata.agent,
    vendor: event.vendor,
    rawSignature,
    signature: normalizeSignature(rawSignature),
    detail,
  };
}

function errorSignature(
  event: HyperEvent,
  diagnostics: string[],
): string | null {
  const message = optionalString(
    event.payload,
    "message_summary",
    `error event ${event.id}`,
    diagnostics,
  ) ?? optionalString(
    event.payload,
    "message_digest",
    `error event ${event.id}`,
    diagnostics,
  );
  const code = optionalString(
    event.payload,
    "code",
    `error event ${event.id}`,
    diagnostics,
  );
  if (message === null && code === null) {
    diagnostics.push(
      `error event ${event.id} has no message_summary, message_digest, or code`,
    );
    return null;
  }
  if (message === null) {
    return `error ${code}`;
  }
  return code === null ? message : `${code}: ${message}`;
}

function sourceSignature(
  event: HyperEvent,
  diagnostics: string[],
): string | null {
  if (event.type === "error") {
    return errorSignature(event, diagnostics);
  }
  if (event.type === "tool_call") {
    const name = optionalString(
      event.payload,
      "name",
      `tool_call event ${event.id}`,
      diagnostics,
    );
    const summary = optionalString(
      event.payload,
      "input_summary",
      `tool_call event ${event.id}`,
      diagnostics,
    );
    if (name !== null && summary !== null) {
      return `${name}: ${summary}`;
    }
    return name ?? summary;
  }
  return event.type;
}

function retrySignature(
  event: HyperEvent,
  eventsById: ReadonlyMap<string, HyperEvent>,
  diagnostics: string[],
): string {
  const reference = optionalString(
    event.payload,
    "of_event_id",
    `retry event ${event.id}`,
    diagnostics,
  );
  if (reference === null) {
    diagnostics.push(`retry event ${event.id} has no of_event_id`);
    return "retry target unavailable";
  }
  const source = eventsById.get(reference);
  if (source === undefined) {
    diagnostics.push(
      `retry event ${event.id} references missing event ${reference}`,
    );
    return "retry target unavailable";
  }
  const signature = sourceSignature(source, diagnostics);
  if (signature === null) {
    diagnostics.push(
      `retry event ${event.id} references event ${reference} without a usable signature`,
    );
    return `retry of ${source.type}`;
  }
  return `retry of ${signature}`;
}

function gateShape(
  event: HyperEvent,
  diagnostics: string[],
): GateShape | null {
  if (event.payload.kind !== "gate") {
    return null;
  }
  const stats = event.payload.stats;
  if (!isPlainObject(stats)) {
    diagnostics.push(`gate verification event ${event.id}.stats must be an object`);
    return {
      outcomeKind: null,
      matchedRuleIds: [],
      failedCheckIds: [],
      summary: optionalString(
        event.payload,
        "command_summary",
        `gate verification event ${event.id}`,
        diagnostics,
      ),
    };
  }
  return {
    outcomeKind: optionalString(
      stats,
      "outcome_kind",
      `gate verification event ${event.id}.stats`,
      diagnostics,
    ),
    matchedRuleIds: optionalStringArray(
      stats,
      "matched_rule_ids",
      `gate verification event ${event.id}.stats`,
      diagnostics,
    ).sort(),
    failedCheckIds: optionalStringArray(
      stats,
      "failed_check_ids",
      `gate verification event ${event.id}.stats`,
      diagnostics,
    ).sort(),
    summary: optionalString(
      event.payload,
      "command_summary",
      `gate verification event ${event.id}`,
      diagnostics,
    ),
  };
}

function gateSignals(
  event: HyperEvent,
  metadata: SessionMetadata,
  diagnostics: string[],
): FrictionSignal[] {
  const shape = gateShape(event, diagnostics);
  if (shape === null) {
    return [];
  }
  const result = event.payload.result;
  if (result !== "pass" && result !== "fail" && result !== "error") {
    diagnostics.push(
      `gate verification event ${event.id}.result is missing or invalid`,
    );
    return [];
  }
  const signals: FrictionSignal[] = [];
  const summary = shape.summary ?? "gate verification";
  if (result === "fail" || result === "error") {
    signals.push(makeSignal(
      "gate_block",
      event,
      metadata,
      summary,
      `Gate ${result}: ${summary}`,
    ));
  }
  if (
    (result === "fail" || result === "error")
    && shape.failedCheckIds.length > 0
  ) {
    const raw = `contract checks failed: ${shape.failedCheckIds.join(", ")}`;
    signals.push(makeSignal(
      "contract_check_failed",
      event,
      metadata,
      raw,
      raw,
    ));
  }
  if (
    (result === "fail" || result === "error")
    && shape.matchedRuleIds.length > 0
  ) {
    const raw = `policy rules matched: ${shape.matchedRuleIds.join(", ")}`;
    signals.push(makeSignal(
      "policy_violation",
      event,
      metadata,
      raw,
      raw,
    ));
  }
  if (shape.outcomeKind === "gate_gave_up") {
    const failed = shape.failedCheckIds.length === 0
      ? summary
      : shape.failedCheckIds.join(", ");
    const raw = `gate gave up after bounce loop: ${failed}`;
    signals.push(makeSignal("bounce_loop", event, metadata, raw, raw));
  }
  return signals;
}

function scorePercentage(
  score: SessionScore,
  sessionId: string,
  diagnostics: string[],
): number | null {
  if (
    score.scorer_version !== SCORER_VERSION
    || score.session_id !== sessionId
  ) {
    diagnostics.push(`session ${sessionId} returned mismatched scorer metadata`);
    return null;
  }
  const rate = score.verification_pass_rate;
  if (rate === null) {
    diagnostics.push(
      `session ${sessionId} has no verification_pass_rate; low_score was not evaluated`,
    );
    return null;
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    diagnostics.push(
      `session ${sessionId} has invalid verification_pass_rate ${String(rate)}`,
    );
    return null;
  }
  return rate * 100;
}

function lowScoreSignal(
  store: Store,
  sessionId: string,
  events: HyperEvent[],
  metadata: SessionMetadata,
  threshold: number,
  diagnostics: string[],
): FrictionSignal | null {
  if (events.length === 0) {
    diagnostics.push(`session ${sessionId} has zero events; low_score was not emitted`);
    return null;
  }
  let score: SessionScore;
  try {
    score = scoreSession(store, sessionId);
  } catch (error: unknown) {
    diagnostics.push(
      `session ${sessionId} could not be scored: ${errorMessage(error)}`,
    );
    return null;
  }
  const percentage = scorePercentage(score, sessionId, diagnostics);
  if (percentage === null || percentage >= threshold) {
    return null;
  }
  const anchor = [...events].reverse().find(
    (event: HyperEvent): boolean => event.type === "session_end",
  ) ?? events.find(
    (event: HyperEvent): boolean => event.type === "session_start",
  ) ?? events.at(-1);
  if (anchor === undefined) {
    diagnostics.push(`session ${sessionId} has no event available for low_score`);
    return null;
  }
  const raw = `verification score ${percentage.toFixed(2)} below ${threshold}`;
  return makeSignal(
    "low_score",
    anchor,
    metadata,
    raw,
    `Verification pass score ${percentage.toFixed(2)} is below ${threshold}`,
  );
}

function extractSessionSignals(
  store: Store,
  sessionId: string,
  events: HyperEvent[],
  threshold: number,
): SessionExtraction {
  const diagnostics: string[] = [];
  const signals: FrictionSignal[] = [];
  const metadata = metadataFromEvents(events, diagnostics);
  const eventsById = new Map<string, HyperEvent>(
    events.map((event: HyperEvent): [string, HyperEvent] => [event.id, event]),
  );

  for (const event of events) {
    if (event.type === "error") {
      const raw = errorSignature(event, diagnostics);
      if (raw !== null) {
        signals.push(makeSignal("error", event, metadata, raw, raw));
      }
      continue;
    }
    if (event.type === "retry") {
      const raw = retrySignature(event, eventsById, diagnostics);
      signals.push(makeSignal("retry", event, metadata, raw, raw));
      continue;
    }
    if (event.type === "verification_event") {
      signals.push(...gateSignals(event, metadata, diagnostics));
    }
  }

  const lowScore = lowScoreSignal(
    store,
    sessionId,
    events,
    metadata,
    threshold,
    diagnostics,
  );
  if (lowScore !== null) {
    signals.push(lowScore);
  }
  return { signals, diagnostics };
}

/**
 * Extracts friction that can be established from one session. Repeated
 * rediscovery inherently requires cross-session evidence and is therefore
 * produced only by analyzeFriction().
 *
 * This convenience boundary cannot return diagnostics; malformed optional
 * payloads are omitted here and are surfaced by analyzeFriction().
 */
export function extractFrictionSignals(
  store: Store,
  sessionId: string,
  options: FrictionOptions = {},
): FrictionSignal[] {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("friction sessionId must be a non-empty string");
  }
  const resolved = resolveOptions(options);
  const events = store.getEvents(sessionId);
  return extractSessionSignals(
    store,
    sessionId,
    events,
    resolved.lowScoreThreshold,
  ).signals;
}

function validateSessionRow(
  row: SessionRow,
  index: number,
): string | null {
  if (!isPlainObject(row)) {
    return `session row ${index} must be a plain object`;
  }
  if (typeof row.session_id !== "string" || row.session_id.length === 0) {
    return `session row ${index}.session_id must be a non-empty string`;
  }
  if (typeof row.started_at !== "string" || Number.isNaN(Date.parse(row.started_at))) {
    return `session row ${index}.started_at must be a valid timestamp`;
  }
  if (typeof row.vendor !== "string" || row.vendor.length === 0) {
    return `session row ${index}.vendor must be a non-empty string`;
  }
  if (row.repo !== null && typeof row.repo !== "string") {
    return `session row ${index}.repo must be a string or null`;
  }
  if (row.agent !== null && typeof row.agent !== "string") {
    return `session row ${index}.agent must be a string or null`;
  }
  return null;
}

function selectedSessionIds(
  store: Store,
  options: ResolvedFrictionOptions,
  diagnostics: string[],
): string[] {
  if (options.sessionIds !== undefined) {
    return options.limit === undefined
      ? options.sessionIds
      : options.sessionIds.slice(0, options.limit);
  }
  const rows = store.getSessions({
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  const sessionIds: string[] = [];
  for (const [index, row] of rows.entries()) {
    const diagnostic = validateSessionRow(row, index);
    if (diagnostic !== null) {
      diagnostics.push(diagnostic);
      continue;
    }
    sessionIds.push(row.session_id);
  }
  return sessionIds;
}

function eventSessionMatchesOptions(
  events: HyperEvent[],
  options: ResolvedFrictionOptions,
  diagnostics: string[],
): boolean {
  if (options.repo === undefined && options.since === undefined) {
    return true;
  }
  const metadata = metadataFromEvents(events, diagnostics);
  if (options.repo !== undefined && metadata.repo !== options.repo) {
    return false;
  }
  if (options.since !== undefined) {
    const startedAt = events.find(
      (event: HyperEvent): boolean => event.type === "session_start",
    )?.ts ?? events[0]?.ts;
    if (startedAt === undefined || startedAt < options.since) {
      return false;
    }
  }
  return true;
}

function targetsFromSummary(summary: string): string[] {
  const candidates = summary.match(
    /(?:\/|(?:^|[\s"'`=([{]))[^\s"'`=()[\]{},;]+(?:\.[a-z0-9_-]+)(?::\d+(?::\d+)?)?/giu,
  ) ?? [];
  return candidates.map((candidate: string): string =>
    candidate.replace(/^[\s"'`=([{]+/u, "")
  );
}

function readTargets(
  event: HyperEvent,
  diagnostics: string[],
): string[] {
  const name = optionalString(
    event.payload,
    "name",
    `tool_call event ${event.id}`,
    diagnostics,
  );
  if (name === null || !READ_TOOL_NAME.test(name)) {
    return [];
  }
  const files = optionalStringArray(
    event.payload,
    "files_touched",
    `tool_call event ${event.id}`,
    diagnostics,
  );
  const summary = optionalString(
    event.payload,
    "input_summary",
    `tool_call event ${event.id}`,
    diagnostics,
  );
  const targets = files.length > 0
    ? files
    : summary === null
    ? []
    : targetsFromSummary(summary);
  return [...new Set(targets.map((target: string): string => {
    const withoutLocation = target.replace(/:\d+(?::\d+)?$/u, "");
    return normalizeSignature(basename(withoutLocation));
  }).filter((target: string): boolean => target.length > 0))].sort();
}

function repeatedRediscoverySignals(
  inputs: SessionInput[],
  diagnostics: string[],
): FrictionSignal[] {
  const occurrences = new Map<
    string,
    Array<{ event: HyperEvent; metadata: SessionMetadata }>
  >();
  for (const input of inputs) {
    const metadata = metadataFromEvents(input.events, diagnostics);
    for (const event of input.events) {
      if (event.type !== "tool_call") {
        continue;
      }
      for (const target of readTargets(event, diagnostics)) {
        const existing = occurrences.get(target) ?? [];
        existing.push({ event, metadata });
        occurrences.set(target, existing);
      }
    }
  }

  const signals: FrictionSignal[] = [];
  for (const target of [...occurrences.keys()].sort()) {
    const targetOccurrences = occurrences.get(target);
    if (targetOccurrences === undefined) {
      diagnostics.push(`rediscovery target ${target} lost its occurrence list`);
      continue;
    }
    const sessionIds = new Set(
      targetOccurrences.map(
        (occurrence): string => occurrence.event.session_id,
      ),
    );
    if (sessionIds.size < 2) {
      continue;
    }
    for (const occurrence of targetOccurrences) {
      const raw = `re-read ${target}`;
      signals.push(makeSignal(
        "repeated_rediscovery",
        occurrence.event,
        occurrence.metadata,
        raw,
        `Read or inspected ${target} in ${sessionIds.size} sessions`,
      ));
    }
  }
  return signals;
}

function compareSignals(left: FrictionSignal, right: FrictionSignal): number {
  return left.ts.localeCompare(right.ts)
    || left.eventId.localeCompare(right.eventId)
    || left.kind.localeCompare(right.kind)
    || left.signature.localeCompare(right.signature);
}

function clusterSignals(signals: FrictionSignal[]): FrictionCluster[] {
  const grouped = new Map<string, FrictionSignal[]>();
  for (const signal of signals) {
    const key = `${signal.kind}::${signal.signature}`;
    const group = grouped.get(key) ?? [];
    group.push(signal);
    grouped.set(key, group);
  }
  const clusters: FrictionCluster[] = [];
  for (const group of grouped.values()) {
    const ordered = [...group].sort(compareSignals);
    const first = ordered[0];
    const last = ordered.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error("friction cluster unexpectedly has no signals");
    }
    clusters.push({
      signature: first.signature,
      kind: first.kind,
      count: ordered.length,
      sessionIds: [...new Set(ordered.map(
        (signal: FrictionSignal): string => signal.sessionId,
      ))].sort(),
      eventIds: [...new Set(ordered.map(
        (signal: FrictionSignal): string => signal.eventId,
      ))].sort(),
      repos: [...new Set(ordered.flatMap(
        (signal: FrictionSignal): string[] =>
          signal.repo === null ? [] : [signal.repo],
      ))].sort(),
      agents: [...new Set(ordered.flatMap(
        (signal: FrictionSignal): string[] =>
          signal.agent === null ? [] : [signal.agent],
      ))].sort(),
      firstSeen: first.ts,
      lastSeen: last.ts,
      exemplars: [...new Set(ordered.map(
        (signal: FrictionSignal): string => signal.rawSignature,
      ))].sort().slice(0, 3),
    });
  }
  return clusters.sort(
    (left: FrictionCluster, right: FrictionCluster): number =>
      right.count - left.count
      || left.signature.localeCompare(right.signature)
      || left.kind.localeCompare(right.kind),
  );
}

function fragmentationReport(
  allClusters: FrictionCluster[],
  forwardedClusters: number,
  totalSignals: number,
): FragmentationReport {
  const bySessionSpan = new Map<number, number>();
  for (const cluster of allClusters) {
    const span = cluster.sessionIds.length;
    bySessionSpan.set(span, (bySessionSpan.get(span) ?? 0) + 1);
  }
  return {
    totalSignals,
    totalSignatures: allClusters.length,
    singletonSignatures: allClusters.filter(
      (cluster: FrictionCluster): boolean => cluster.count === 1,
    ).length,
    singleSessionSignatures: allClusters.filter(
      (cluster: FrictionCluster): boolean => cluster.sessionIds.length === 1,
    ).length,
    forwardedClusters,
    distribution: [...bySessionSpan.entries()]
      .sort(([left]: [number, number], [right]: [number, number]): number =>
        left - right
      )
      .map(([sessionSpan, signatureCount]: [number, number]) => ({
        sessionSpan,
        signatureCount,
      })),
  };
}

export function analyzeFriction(
  store: Store,
  options: FrictionOptions = {},
): FrictionAnalysis {
  const resolved = resolveOptions(options);
  const diagnostics: string[] = [];
  const excludedSessionIds: string[] = [];
  const inputs: SessionInput[] = [];
  const signals: FrictionSignal[] = [];
  const sessionIds = selectedSessionIds(store, resolved, diagnostics);

  for (const sessionId of sessionIds) {
    let events: HyperEvent[];
    try {
      events = store.getEvents(sessionId);
    } catch (error: unknown) {
      diagnostics.push(
        `session ${sessionId} events could not be read: ${errorMessage(error)}`,
      );
      continue;
    }
    if (
      resolved.sessionIds !== undefined
      && !eventSessionMatchesOptions(events, resolved, diagnostics)
    ) {
      continue;
    }
    if (isSuitOwnSession(events, resolved.dataDir)) {
      excludedSessionIds.push(sessionId);
      continue;
    }
    inputs.push({ sessionId, events });
    const extraction = extractSessionSignals(
      store,
      sessionId,
      events,
      resolved.lowScoreThreshold,
    );
    signals.push(...extraction.signals);
    diagnostics.push(...extraction.diagnostics);
  }

  signals.push(...repeatedRediscoverySignals(inputs, diagnostics));
  signals.sort(compareSignals);
  const allClusters = clusterSignals(signals);
  const clusters = allClusters.filter(
    (cluster: FrictionCluster): boolean =>
      cluster.sessionIds.length >= resolved.minSessions,
  );
  return {
    clusters,
    allClusters,
    signals,
    fragmentation: fragmentationReport(
      allClusters,
      clusters.length,
      signals.length,
    ),
    diagnostics: [...new Set(diagnostics)].sort(),
    excludedSessionIds: [...new Set(excludedSessionIds)].sort(),
    extractorVersion: FRICTION_EXTRACTOR_VERSION,
  };
}
