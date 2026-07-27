import type { HyperEvent } from "../schema/events.ts";
import {
  spawnAgentRunner,
} from "../missions/runner.ts";
import type {
  AgentRunnerConfig,
} from "../missions/runner.ts";
import type { Store } from "../store/store.ts";
import {
  claimHash,
} from "./store.ts";
import type {
  MemoryKind,
  MemoryRow,
  MemoryStore,
} from "./store.ts";

export interface ExtractDeps {
  runModel: (prompt: string) => Promise<string>;
  onFailure?: (reason: string) => void;
}

export interface MemoryCandidate {
  claim: string;
  kind: MemoryKind;
  confidence: number;
  raw_ref: string | null;
}

export interface ExtractionUserTurn {
  turnIndex: number | null;
  textDigest: string | null;
}

export interface ExtractionToolUsage {
  count: number;
  statuses: Record<string, number>;
}

export interface ExtractionVerification {
  kind: string | null;
  commandSummary: string | null;
  result: string | null;
  stats: Record<string, unknown> | null;
}

export interface ExtractionCompletionClaim {
  claimText: string | null;
  claimKind: string | null;
}

export interface ExtractionError {
  source: string | null;
  messageSummary: string | null;
}

export interface ExtractionInput {
  sessionId: string;
  repo: string | null;
  vendor: string | null;
  agent: string | null;
  userTurns: ExtractionUserTurn[];
  toolUsage: Record<string, ExtractionToolUsage>;
  errors: ExtractionError[];
  verifications: ExtractionVerification[];
  completionClaims: ExtractionCompletionClaim[];
}

export interface StoreCandidatesOptions {
  memoryStore: MemoryStore;
  sessionId: string;
  repo: string | null;
}

export interface StoreCandidatesResult {
  stored: MemoryRow[];
  storedCount: number;
  droppedAsDuplicateCount: number;
}

interface CandidateParseResult {
  candidates: MemoryCandidate[];
  parsedArray: boolean;
}

export function createExtractDeps(
  config: AgentRunnerConfig = {},
): ExtractDeps {
  return { runModel: spawnAgentRunner(config) };
}

const MEMORY_KINDS: ReadonlySet<string> = new Set([
  "factual",
  "gotcha",
  "preference",
  "behavior",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function payloadString(event: HyperEvent, key: string): string | null {
  const value = event.payload[key];
  return typeof value === "string" ? value : null;
}

function payloadNumber(event: HyperEvent, key: string): number | null {
  const value = event.payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function payloadRecord(
  event: HyperEvent,
  key: string,
): Record<string, unknown> | null {
  const value = event.payload[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isMainThreadEvent(event: HyperEvent): boolean {
  return event.payload.is_sidechain !== true;
}

function sortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    ),
  );
}

export function buildExtractionInput(
  store: Store,
  sessionId: string,
): ExtractionInput {
  const events = store.getEvents(sessionId).filter(isMainThreadEvent);
  const sessionStart = events.find((event) => event.type === "session_start");
  const firstEvent = events[0];
  const userTurns: ExtractionUserTurn[] = [];
  const toolUsage = new Map<string, ExtractionToolUsage>();
  const errors: ExtractionError[] = [];
  const verifications: ExtractionVerification[] = [];
  const completionClaims: ExtractionCompletionClaim[] = [];

  for (const event of events) {
    if (event.type === "turn_start") {
      userTurns.push({
        turnIndex: payloadNumber(event, "turn_index"),
        textDigest: payloadString(event, "text_digest"),
      });
      continue;
    }
    if (event.type === "tool_call") {
      const name = payloadString(event, "name") ?? "unknown";
      const status = payloadString(event, "status") ?? "unknown";
      const usage = toolUsage.get(name) ?? { count: 0, statuses: {} };
      usage.count += 1;
      usage.statuses[status] = (usage.statuses[status] ?? 0) + 1;
      toolUsage.set(name, usage);
      continue;
    }
    if (event.type === "error") {
      errors.push({
        source: payloadString(event, "source"),
        messageSummary: payloadString(event, "message_summary"),
      });
      continue;
    }
    if (event.type === "verification_event") {
      verifications.push({
        kind: payloadString(event, "kind"),
        commandSummary: payloadString(event, "command_summary"),
        result: payloadString(event, "result"),
        stats: payloadRecord(event, "stats"),
      });
      continue;
    }
    if (event.type === "completion_claim") {
      completionClaims.push({
        claimText: payloadString(event, "claim_text"),
        claimKind: payloadString(event, "claim_kind"),
      });
    }
  }

  const normalizedToolUsage = sortedRecord(
    [...toolUsage.entries()].map(([name, usage]) => [
      name,
      {
        count: usage.count,
        statuses: sortedRecord(Object.entries(usage.statuses)),
      },
    ]),
  );

  return {
    sessionId,
    repo: sessionStart === undefined
      ? null
      : payloadString(sessionStart, "repo"),
    vendor: sessionStart?.vendor ?? firstEvent?.vendor ?? null,
    agent: sessionStart === undefined
      ? null
      : payloadString(sessionStart, "agent"),
    userTurns,
    toolUsage: normalizedToolUsage,
    errors,
    verifications,
    completionClaims,
  };
}

function stableValue(value: unknown, seen: WeakSet<object>): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      result[key] = stableValue(record[key], seen);
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value, new WeakSet<object>()));
}

export function buildExtractionPrompt(input: ExtractionInput): string {
  return `Extract only durable memory candidates from this closed session.
Durable means ground truth about this repository, tools, or environment; reusable gotchas; stable user preferences; or behavioral corrections.
Exclude ephemeral session chatter, transient task status, and unsupported inference.
Redact secrets and personally identifiable information.
Return STRICT JSON only: an array of at most 5 objects shaped exactly as {"claim":string,"kind":"factual"|"gotcha"|"preference"|"behavior","confidence":number,"raw_ref":string|null}.
confidence must be within [0,1]. The model MUST NOT emit session_id; the pipeline stamps session_id after validation.

Structured session facts:
${stableJson(input)}`;
}

function stripCodeFence(output: string): string {
  const trimmed = output.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function parsedValue(output: string): { value: unknown; parsed: boolean } {
  const stripped = stripCodeFence(output);
  try {
    return { value: JSON.parse(stripped) as unknown, parsed: true };
  } catch (directError: unknown) {
    const start = stripped.indexOf("[");
    const end = stripped.lastIndexOf("]");
    if (start < 0 || end < start) {
      return { value: errorMessage(directError), parsed: false };
    }
    try {
      return {
        value: JSON.parse(stripped.slice(start, end + 1)) as unknown,
        parsed: true,
      };
    } catch (arrayError: unknown) {
      return {
        value: `${errorMessage(directError)}; ${errorMessage(arrayError)}`,
        parsed: false,
      };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareCandidates(
  left: MemoryCandidate,
  right: MemoryCandidate,
): number {
  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }
  const claimOrder = left.claim.localeCompare(right.claim);
  if (claimOrder !== 0) {
    return claimOrder;
  }
  const kindOrder = left.kind.localeCompare(right.kind);
  if (kindOrder !== 0) {
    return kindOrder;
  }
  return (left.raw_ref ?? "").localeCompare(right.raw_ref ?? "");
}

function parseCandidateResult(output: string): CandidateParseResult {
  const parsed = parsedValue(output);
  if (!parsed.parsed || !Array.isArray(parsed.value)) {
    return { candidates: [], parsedArray: false };
  }

  const candidates: MemoryCandidate[] = [];
  for (const entry of parsed.value) {
    if (!isRecord(entry)) {
      continue;
    }
    const claim = typeof entry.claim === "string" ? entry.claim.trim() : "";
    if (claim.length === 0) {
      continue;
    }
    if (typeof entry.kind !== "string" || !MEMORY_KINDS.has(entry.kind)) {
      continue;
    }
    if (
      typeof entry.confidence !== "number"
      || !Number.isFinite(entry.confidence)
      || entry.confidence < 0
      || entry.confidence > 1
    ) {
      continue;
    }
    candidates.push({
      claim,
      kind: entry.kind as MemoryKind,
      confidence: entry.confidence,
      raw_ref: typeof entry.raw_ref === "string" ? entry.raw_ref : null,
    });
  }

  return {
    candidates: candidates.sort(compareCandidates).slice(0, 5),
    parsedArray: true,
  };
}

export function parseCandidates(output: string): MemoryCandidate[] {
  try {
    return parseCandidateResult(output).candidates;
  } catch {
    // Total parser contract: even exotic inputs and runtime parser failures are junk.
    return [];
  }
}

function reportFailure(deps: ExtractDeps, reason: string): void {
  try {
    deps.onFailure?.(reason);
  } catch {
    // Failure reporting is advisory and must never take down the daemon.
  }
}

export async function extractMemories(
  deps: ExtractDeps,
  input: ExtractionInput,
): Promise<MemoryCandidate[]> {
  try {
    // runModel is expected to be spawnAgentRunner, which enforces its own timeout.
    const output = await deps.runModel(buildExtractionPrompt(input));
    if (output.trim().length === 0) {
      reportFailure(deps, "model returned empty output");
      return [];
    }
    const result = parseCandidateResult(output);
    if (!result.parsedArray) {
      reportFailure(deps, "model returned invalid candidate JSON");
      return [];
    }
    return result.candidates;
  } catch (error: unknown) {
    reportFailure(deps, `model invocation failed: ${errorMessage(error)}`);
    return [];
  }
}

export function storeCandidates(
  candidates: MemoryCandidate[],
  options: StoreCandidatesOptions,
): StoreCandidatesResult {
  const existingHashes = new Set(
    options.memoryStore
      .listMemories()
      // Retired memories may intentionally be re-learned; rejected memories
      // remain in the set as tombstones so a human "no" cannot resurface.
      .filter((memory) => memory.status !== "retired")
      .map((memory) => memory.claim_hash),
  );
  const incomingHashes = new Set<string>();
  const stored: MemoryRow[] = [];
  let droppedAsDuplicateCount = 0;
  const repo = typeof options.repo === "string" && options.repo.trim().length > 0
    ? options.repo
    : null;

  for (const candidate of candidates) {
    const hash = claimHash(candidate.claim);
    if (existingHashes.has(hash) || incomingHashes.has(hash)) {
      droppedAsDuplicateCount += 1;
      continue;
    }
    incomingHashes.add(hash);
    stored.push(options.memoryStore.addCandidate({
      claim: candidate.claim,
      kind: candidate.kind,
      scope: repo === null ? "global" : "repo",
      scope_key: repo,
      confidence: candidate.confidence,
      evidence: [{
        session_id: options.sessionId,
        raw_ref: candidate.raw_ref,
      }],
      source: "extraction",
    }));
  }

  return {
    stored,
    storedCount: stored.length,
    droppedAsDuplicateCount,
  };
}
