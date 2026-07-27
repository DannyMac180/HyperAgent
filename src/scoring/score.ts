import type { HyperEvent } from "../schema/events.ts";
import type { Store } from "../store/store.ts";

export const SCORER_VERSION = "1";

export interface SessionScore {
  session_id: string;
  scorer_version: string;
  event_watermark: number;
  turn_count: number;
  tool_call_count: number;
  error_count: number;
  retry_count: number;
  verification_total: number;
  verification_passed: number;
  verification_failed: number;
  verification_pass_rate: number | null;
  completion_claim_count: number;
  evidence_backed_completion: number | null;
  intervention_count: number | null;
  vendor: string | null;
  agent: string | null;
  model: string | null;
  repo: string | null;
  started_at: string | null;
  ended_at: string | null;
  outcome: string | null;
  provisional: number;
}

export interface TrendSummary {
  session_count: number;
  average_verification_pass_rate: number | null;
  total_errors: number;
  total_claims: number;
  evidence_backed_ratio: number | null;
}

export interface AgentTrend extends TrendSummary {
  agent: string | null;
}

export interface RepoTrend extends TrendSummary {
  repo: string | null;
}

export interface Trends {
  by_agent: AgentTrend[];
  by_repo: RepoTrend[];
}

export interface TrendsOptions {
  days: number;
  now?: () => number;
}

interface SessionMetadata {
  vendor: string | null;
  agent: string | null;
  model: string | null;
  repo: string | null;
  started_at: string | null;
  ended_at: string | null;
  outcome: string | null;
}

interface SessionDatabaseRow {
  session_id: unknown;
  vendor: unknown;
  started_at: unknown;
  ended_at: unknown;
  outcome: unknown;
  repo: unknown;
  agent: unknown;
  model: unknown;
}

interface WatermarkDatabaseRow {
  event_watermark: unknown;
}

interface SessionIdDatabaseRow {
  session_id: unknown;
}

interface TrendDatabaseRow {
  group_value: unknown;
  session_count: unknown;
  average_verification_pass_rate: unknown;
  total_errors: unknown;
  total_claims: unknown;
  evidence_backed_ratio: unknown;
}

const SESSION_SCORES_DDL = `
CREATE TABLE IF NOT EXISTS session_scores (
  session_id                    TEXT PRIMARY KEY,
  scorer_version                TEXT NOT NULL,
  event_watermark               INTEGER NOT NULL CHECK (event_watermark >= 0),
  turn_count                    INTEGER NOT NULL CHECK (turn_count >= 0),
  tool_call_count               INTEGER NOT NULL CHECK (tool_call_count >= 0),
  error_count                   INTEGER NOT NULL CHECK (error_count >= 0),
  retry_count                   INTEGER NOT NULL CHECK (retry_count >= 0),
  verification_total            INTEGER NOT NULL CHECK (verification_total >= 0),
  verification_passed           INTEGER NOT NULL CHECK (verification_passed >= 0),
  verification_failed           INTEGER NOT NULL CHECK (verification_failed >= 0),
  verification_pass_rate        REAL,
  completion_claim_count        INTEGER NOT NULL CHECK (completion_claim_count >= 0),
  evidence_backed_completion    INTEGER CHECK (evidence_backed_completion IN (0, 1)),
  intervention_count            INTEGER CHECK (intervention_count >= 0),
  vendor                        TEXT,
  agent                         TEXT,
  model                         TEXT,
  repo                          TEXT,
  started_at                    TEXT,
  ended_at                      TEXT,
  outcome                       TEXT,
  provisional                   INTEGER NOT NULL CHECK (provisional IN (0, 1))
) STRICT;
`;

const UPSERT_SESSION_SCORE_SQL = `
INSERT INTO session_scores (
  session_id,
  scorer_version,
  event_watermark,
  turn_count,
  tool_call_count,
  error_count,
  retry_count,
  verification_total,
  verification_passed,
  verification_failed,
  verification_pass_rate,
  completion_claim_count,
  evidence_backed_completion,
  intervention_count,
  vendor,
  agent,
  model,
  repo,
  started_at,
  ended_at,
  outcome,
  provisional
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  scorer_version = excluded.scorer_version,
  event_watermark = excluded.event_watermark,
  turn_count = excluded.turn_count,
  tool_call_count = excluded.tool_call_count,
  error_count = excluded.error_count,
  retry_count = excluded.retry_count,
  verification_total = excluded.verification_total,
  verification_passed = excluded.verification_passed,
  verification_failed = excluded.verification_failed,
  verification_pass_rate = excluded.verification_pass_rate,
  completion_claim_count = excluded.completion_claim_count,
  evidence_backed_completion = excluded.evidence_backed_completion,
  intervention_count = excluded.intervention_count,
  vendor = excluded.vendor,
  agent = excluded.agent,
  model = excluded.model,
  repo = excluded.repo,
  started_at = excluded.started_at,
  ended_at = excluded.ended_at,
  outcome = excluded.outcome,
  provisional = excluded.provisional
`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareNumericSegments(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+/, "") || "0";
  const normalizedRight = right.replace(/^0+/, "") || "0";
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  if (normalizedLeft === normalizedRight) {
    return 0;
  }
  return normalizedLeft < normalizedRight ? -1 : 1;
}

/**
 * Compares dotted adapter versions numerically segment by segment. A longer
 * version wins when all shared numeric segments tie. If either segment is not
 * numeric, that segment is compared lexicographically instead.
 */
export function compareAdapterVersions(left: string, right: string): number {
  const leftSegments = left.split(".");
  const rightSegments = right.split(".");
  const sharedLength = Math.min(leftSegments.length, rightSegments.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const leftSegment = leftSegments[index];
    const rightSegment = rightSegments[index];
    if (leftSegment === undefined || rightSegment === undefined) {
      throw new Error(`adapter version segment ${index} is unexpectedly absent`);
    }
    if (leftSegment === rightSegment) {
      continue;
    }

    const bothNumeric = /^\d+$/.test(leftSegment) && /^\d+$/.test(rightSegment);
    if (bothNumeric) {
      const comparison = compareNumericSegments(leftSegment, rightSegment);
      if (comparison !== 0) {
        return comparison;
      }
      continue;
    }
    return leftSegment < rightSegment ? -1 : 1;
  }

  if (leftSegments.length === rightSegments.length) {
    return 0;
  }
  return leftSegments.length < rightSegments.length ? -1 : 1;
}

function isHeuristicEvent(event: HyperEvent): boolean {
  return (
    event.type === "completion_claim"
    || event.type === "verification_event"
    || event.type === "error"
    || event.type === "retry"
  );
}

function dedupeHeuristicEvents(events: HyperEvent[]): HyperEvent[] {
  const highestVersionByRawRef = new Map<string, string>();
  for (const event of events) {
    if (!isHeuristicEvent(event) || event.raw_ref === null) {
      continue;
    }
    const highestVersion = highestVersionByRawRef.get(event.raw_ref);
    if (
      highestVersion === undefined
      || compareAdapterVersions(event.adapter_version, highestVersion) > 0
    ) {
      highestVersionByRawRef.set(event.raw_ref, event.adapter_version);
    }
  }

  return events.filter((event: HyperEvent): boolean => {
    if (!isHeuristicEvent(event) || event.raw_ref === null) {
      return true;
    }
    const highestVersion = highestVersionByRawRef.get(event.raw_ref);
    if (highestVersion === undefined) {
      throw new Error(`no adapter version found for raw reference ${event.raw_ref}`);
    }
    return compareAdapterVersions(event.adapter_version, highestVersion) === 0;
  });
}

function isSidechainEvent(event: HyperEvent): boolean {
  return event.payload.is_sidechain === true;
}

function optionalPayloadString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function requiredNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string or null`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function nullableFiniteNumber(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number or null`);
  }
  return value;
}

function metadataFromEvents(events: HyperEvent[]): SessionMetadata {
  const firstEvent = events[0];
  if (firstEvent === undefined) {
    return {
      vendor: null,
      agent: null,
      model: null,
      repo: null,
      started_at: null,
      ended_at: null,
      outcome: null,
    };
  }

  const metadata: SessionMetadata = {
    vendor: firstEvent.vendor,
    agent: null,
    model: null,
    repo: null,
    started_at: firstEvent.ts,
    ended_at: null,
    outcome: null,
  };
  for (const event of events) {
    if (event.type === "session_start") {
      metadata.vendor = event.vendor;
      metadata.agent = optionalPayloadString(event.payload, "agent");
      metadata.model = optionalPayloadString(event.payload, "model");
      metadata.repo = optionalPayloadString(event.payload, "repo");
      metadata.started_at = event.ts;
      continue;
    }
    if (event.type === "session_end") {
      metadata.ended_at = event.ts;
      metadata.outcome = optionalPayloadString(event.payload, "outcome");
    }
  }
  return metadata;
}

function readSessionMetadata(
  store: Store,
  sessionId: string,
  events: HyperEvent[],
): SessionMetadata {
  const row = store.db.query<SessionDatabaseRow, [string]>(`
    SELECT session_id, vendor, started_at, ended_at, outcome, repo, agent, model
    FROM sessions
    WHERE session_id = ?
  `).get(sessionId);
  if (row === null) {
    return metadataFromEvents(events);
  }

  const storedSessionId = requiredNonEmptyString(
    row.session_id,
    "stored session score metadata session_id",
  );
  if (storedSessionId !== sessionId) {
    throw new Error(
      `stored session metadata id ${JSON.stringify(storedSessionId)} does not match ${JSON.stringify(sessionId)}`,
    );
  }
  return {
    vendor: requiredNonEmptyString(row.vendor, `session ${sessionId} vendor`),
    agent: nullableString(row.agent, `session ${sessionId} agent`),
    model: nullableString(row.model, `session ${sessionId} model`),
    repo: nullableString(row.repo, `session ${sessionId} repo`),
    started_at: requiredNonEmptyString(
      row.started_at,
      `session ${sessionId} started_at`,
    ),
    ended_at: nullableString(row.ended_at, `session ${sessionId} ended_at`),
    outcome: nullableString(row.outcome, `session ${sessionId} outcome`),
  };
}

function readEventWatermark(store: Store, sessionId: string): number {
  const row = store.db.query<WatermarkDatabaseRow, [string]>(`
    SELECT max(rowid) AS event_watermark
    FROM events
    WHERE session_id = ?
  `).get(sessionId);
  if (row === null) {
    throw new Error(`event watermark query returned no row for session ${sessionId}`);
  }
  if (row.event_watermark === null) {
    return 0;
  }
  return nonNegativeInteger(
    row.event_watermark,
    `session ${sessionId} event watermark`,
  );
}

function computeSessionScore(store: Store, sessionId: string): SessionScore {
  const events = store.getEvents(sessionId);
  const dedupedEvents = dedupeHeuristicEvents(events);
  const headlineEvents = dedupedEvents.filter(
    (event: HyperEvent): boolean => !isSidechainEvent(event),
  );
  const metadata = readSessionMetadata(store, sessionId, events);

  let turnCount = 0;
  let toolCallCount = 0;
  let errorCount = 0;
  let retryCount = 0;
  let verificationTotal = 0;
  let verificationPassed = 0;
  let verificationFailed = 0;
  let completionClaimCount = 0;
  let lastPassingVerificationIndex = -1;
  let lastFailingVerificationIndex = -1;

  for (const [index, event] of headlineEvents.entries()) {
    if (event.type === "turn_start") {
      turnCount += 1;
      continue;
    }
    if (event.type === "tool_call") {
      toolCallCount += 1;
      continue;
    }
    if (event.type === "error") {
      errorCount += 1;
      continue;
    }
    if (event.type === "retry") {
      retryCount += 1;
      continue;
    }
    if (event.type === "completion_claim") {
      completionClaimCount += 1;
      continue;
    }
    if (event.type === "verification_event") {
      verificationTotal += 1;
      if (event.payload.result === "pass") {
        verificationPassed += 1;
        lastPassingVerificationIndex = index;
      } else if (event.payload.result === "fail") {
        verificationFailed += 1;
        lastFailingVerificationIndex = index;
      }
    }
  }

  const verificationPassRate = verificationTotal === 0
    ? null
    : verificationPassed / verificationTotal;
  const evidenceBackedCompletion = completionClaimCount === 0
    ? null
    : (
      lastPassingVerificationIndex >= 0
      && lastFailingVerificationIndex <= lastPassingVerificationIndex
        ? 1
        : 0
    );

  return {
    session_id: sessionId,
    scorer_version: SCORER_VERSION,
    event_watermark: readEventWatermark(store, sessionId),
    turn_count: turnCount,
    tool_call_count: toolCallCount,
    error_count: errorCount,
    retry_count: retryCount,
    verification_total: verificationTotal,
    verification_passed: verificationPassed,
    verification_failed: verificationFailed,
    verification_pass_rate: verificationPassRate,
    completion_claim_count: completionClaimCount,
    evidence_backed_completion: evidenceBackedCompletion,
    // Current adapters emit is_correction as null. Reporting zero would claim
    // the adapter observed no interventions, so the honest value is unknown.
    intervention_count: null,
    vendor: metadata.vendor,
    agent: metadata.agent,
    model: metadata.model,
    repo: metadata.repo,
    started_at: metadata.started_at,
    ended_at: metadata.ended_at,
    outcome: metadata.outcome,
    provisional: dedupedEvents.some(
      (event: HyperEvent): boolean => event.type === "session_end",
    ) ? 0 : 1,
  };
}

function ensureSessionScoresTable(store: Store): void {
  try {
    store.db.exec(SESSION_SCORES_DDL);
  } catch (error: unknown) {
    throw new Error(`failed to initialize session_scores: ${errorMessage(error)}`);
  }
}

function persistSessionScore(store: Store, score: SessionScore): void {
  try {
    store.db.query(UPSERT_SESSION_SCORE_SQL).run(
      score.session_id,
      score.scorer_version,
      score.event_watermark,
      score.turn_count,
      score.tool_call_count,
      score.error_count,
      score.retry_count,
      score.verification_total,
      score.verification_passed,
      score.verification_failed,
      score.verification_pass_rate,
      score.completion_claim_count,
      score.evidence_backed_completion,
      score.intervention_count,
      score.vendor,
      score.agent,
      score.model,
      score.repo,
      score.started_at,
      score.ended_at,
      score.outcome,
      score.provisional,
    );
  } catch (error: unknown) {
    throw new Error(
      `failed to persist score for session ${score.session_id}: ${errorMessage(error)}`,
    );
  }
}

export function scoreSession(store: Store, sessionId: string): SessionScore {
  requiredNonEmptyString(sessionId, "session id");
  ensureSessionScoresTable(store);
  try {
    const scoreAndPersist = store.db.transaction((): SessionScore => {
      const score = computeSessionScore(store, sessionId);
      persistSessionScore(store, score);
      return score;
    });
    return scoreAndPersist();
  } catch (error: unknown) {
    throw new Error(`failed to score session ${sessionId}: ${errorMessage(error)}`);
  }
}

function readSessionIds(store: Store): string[] {
  const rows = store.db.query<SessionIdDatabaseRow, []>(`
    SELECT DISTINCT session_id
    FROM events
    ORDER BY session_id
  `).all();
  return rows.map((row: SessionIdDatabaseRow, index: number): string =>
    requiredNonEmptyString(row.session_id, `event session id at row ${index}`)
  );
}

export function rebuildScores(store: Store): number {
  ensureSessionScoresTable(store);
  try {
    const sessionIds = readSessionIds(store);
    const rebuild = store.db.transaction((): number => {
      store.db.run("DELETE FROM session_scores");
      for (const sessionId of sessionIds) {
        persistSessionScore(store, computeSessionScore(store, sessionId));
      }
      return sessionIds.length;
    });
    return rebuild();
  } catch (error: unknown) {
    throw new Error(`failed to rebuild session scores: ${errorMessage(error)}`);
  }
}

function readTrendRows(
  store: Store,
  dimension: "agent" | "repo",
  windowStart: string,
  windowEnd: string,
): TrendDatabaseRow[] {
  const column = dimension === "agent" ? "agent" : "repo";
  return store.db.query<TrendDatabaseRow, [string, string, string]>(`
    SELECT
      ${column} AS group_value,
      count(*) AS session_count,
      avg(verification_pass_rate) AS average_verification_pass_rate,
      coalesce(sum(error_count), 0) AS total_errors,
      coalesce(sum(completion_claim_count), 0) AS total_claims,
      CASE
        WHEN count(evidence_backed_completion) = 0 THEN NULL
        ELSE (
          1.0 * sum(CASE WHEN evidence_backed_completion = 1 THEN 1 ELSE 0 END)
          / count(evidence_backed_completion)
        )
      END AS evidence_backed_ratio
    FROM session_scores
    WHERE scorer_version = ?
      AND started_at >= ?
      AND started_at <= ?
    GROUP BY ${column}
    ORDER BY ${column}
  `).all(SCORER_VERSION, windowStart, windowEnd);
}

function validatedTrendSummary(
  row: TrendDatabaseRow,
  label: string,
): TrendSummary {
  return {
    session_count: nonNegativeInteger(
      row.session_count,
      `${label} session_count`,
    ),
    average_verification_pass_rate: nullableFiniteNumber(
      row.average_verification_pass_rate,
      `${label} average_verification_pass_rate`,
    ),
    total_errors: nonNegativeInteger(row.total_errors, `${label} total_errors`),
    total_claims: nonNegativeInteger(row.total_claims, `${label} total_claims`),
    evidence_backed_ratio: nullableFiniteNumber(
      row.evidence_backed_ratio,
      `${label} evidence_backed_ratio`,
    ),
  };
}

function readNow(options: TrendsOptions): number {
  const now = options.now ?? Date.now;
  let value: number;
  try {
    value = now();
  } catch (error: unknown) {
    throw new Error(`trends clock failed: ${errorMessage(error)}`);
  }
  if (!Number.isFinite(value)) {
    throw new Error("trends clock must return a finite number");
  }
  return value;
}

export function getTrends(store: Store, options: TrendsOptions): Trends {
  try {
    if (!Number.isFinite(options.days) || options.days <= 0) {
      throw new Error("trends days must be a positive finite number");
    }
    const now = readNow(options);
    const windowStartMilliseconds = now - options.days * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(windowStartMilliseconds)) {
      throw new Error("trends window start is outside the supported range");
    }
    const windowStart = new Date(windowStartMilliseconds).toISOString();
    const windowEnd = new Date(now).toISOString();
    ensureSessionScoresTable(store);

    const byAgent = readTrendRows(store, "agent", windowStart, windowEnd).map(
      (row: TrendDatabaseRow, index: number): AgentTrend => ({
        agent: nullableString(row.group_value, `agent trend group ${index}`),
        ...validatedTrendSummary(row, `agent trend group ${index}`),
      }),
    );
    const byRepo = readTrendRows(store, "repo", windowStart, windowEnd).map(
      (row: TrendDatabaseRow, index: number): RepoTrend => ({
        repo: nullableString(row.group_value, `repo trend group ${index}`),
        ...validatedTrendSummary(row, `repo trend group ${index}`),
      }),
    );
    return { by_agent: byAgent, by_repo: byRepo };
  } catch (error: unknown) {
    throw new Error(`failed to get trends: ${errorMessage(error)}`);
  }
}
