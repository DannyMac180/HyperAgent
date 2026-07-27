import { isAbsolute, resolve } from "node:path";

import type { HyperEvent, ToolCallPayload } from "../schema/events.ts";
import type { Store } from "../store/store.ts";
import { matchPolicy } from "./policy.ts";
import type { PolicyCandidate, PolicyDoc, PolicyMatch } from "./policy.ts";

export const DETECTOR_VERSION = "1";

export interface PolicyViolation {
  session_id: string;
  rule_id: string;
  event_id: string;
  detector_version: string;
  detected_at: string;
  action: string;
  evidence: string;
}

export interface ViolationFilter {
  sessionId?: string;
  days?: number;
  now?: () => number;
}

interface SessionIdDatabaseRow {
  session_id: unknown;
}

interface SessionRepoDatabaseRow {
  session_id: unknown;
  repo: unknown;
}

interface ViolationDatabaseRow {
  session_id: unknown;
  rule_id: unknown;
  event_id: unknown;
  detector_version: unknown;
  detected_at: unknown;
  action: unknown;
  evidence: unknown;
}

const POLICY_VIOLATIONS_DDL = `
CREATE TABLE IF NOT EXISTS policy_violations (
  session_id       TEXT NOT NULL,
  rule_id          TEXT NOT NULL,
  event_id         TEXT NOT NULL,
  detector_version TEXT NOT NULL,
  detected_at      TEXT NOT NULL,
  action           TEXT NOT NULL CHECK (action IN ('block', 'flag')),
  evidence         TEXT NOT NULL,
  PRIMARY KEY (session_id, rule_id, event_id, detector_version)
) STRICT;
`;

const UPSERT_POLICY_VIOLATION_SQL = `
INSERT INTO policy_violations (
  session_id,
  rule_id,
  event_id,
  detector_version,
  detected_at,
  action,
  evidence
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id, rule_id, event_id, detector_version) DO UPDATE SET
  detected_at = excluded.detected_at,
  action = excluded.action,
  evidence = excluded.evidence
`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function policyAction(value: unknown, label: string): "block" | "flag" {
  if (value !== "block" && value !== "flag") {
    throw new Error(`${label} must be "block" or "flag"`);
  }
  return value;
}

function clockTimestamp(
  now: (() => number) | undefined,
  label: string,
): string {
  let milliseconds: number;
  try {
    milliseconds = (now ?? Date.now)();
  } catch (error: unknown) {
    throw new Error(`${label} clock failed: ${errorMessage(error)}`);
  }
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} clock must return a finite number`);
  }
  try {
    return new Date(milliseconds).toISOString();
  } catch (error: unknown) {
    throw new Error(`${label} clock returned an unsupported time: ${errorMessage(error)}`);
  }
}

function ensurePolicyViolationsTable(store: Store): void {
  try {
    store.db.exec(POLICY_VIOLATIONS_DDL);
  } catch (error: unknown) {
    throw new Error(`failed to initialize policy_violations: ${errorMessage(error)}`);
  }
}

function sessionRepoFromEvents(
  events: HyperEvent[],
  sessionId: string,
): string | null {
  let repo: string | null = null;
  for (const event of events) {
    if (event.type !== "session_start" || event.payload.repo === undefined) {
      continue;
    }
    repo = requiredNonEmptyString(
      event.payload.repo,
      `session ${sessionId} start event ${event.id} repo`,
    );
  }
  return repo;
}

function readSessionRepo(
  store: Store,
  sessionId: string,
  events: HyperEvent[],
): string | null {
  const row = store.db.query<SessionRepoDatabaseRow, [string]>(`
    SELECT session_id, repo
    FROM sessions
    WHERE session_id = ?
  `).get(sessionId);
  if (row === null) {
    return sessionRepoFromEvents(events, sessionId);
  }

  const storedSessionId = requiredNonEmptyString(
    row.session_id,
    `stored violation metadata session_id for ${sessionId}`,
  );
  if (storedSessionId !== sessionId) {
    throw new Error(
      `stored violation metadata id ${JSON.stringify(storedSessionId)} does not match ${JSON.stringify(sessionId)}`,
    );
  }
  const storedRepo = nullableString(row.repo, `session ${sessionId} repo`);
  return storedRepo === null || storedRepo.length === 0
    ? sessionRepoFromEvents(events, sessionId)
    : storedRepo;
}

function optionalPayloadString(
  payload: ToolCallPayload,
  key: "name" | "input_summary",
  eventId: string,
): string {
  const value = payload[key];
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error(`tool_call event ${eventId} payload.${key} must be a string`);
  }
  return value;
}

function filesTouched(payload: ToolCallPayload, eventId: string): string[] {
  const value = payload.files_touched;
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`tool_call event ${eventId} payload.files_touched must be an array`);
  }
  return value.map((path: unknown, index: number): string => {
    if (typeof path !== "string") {
      throw new Error(
        `tool_call event ${eventId} payload.files_touched[${index}] must be a string`,
      );
    }
    return path;
  });
}

function resolveWritePaths(
  payload: ToolCallPayload,
  eventId: string,
  repo: string | null,
): string[] {
  return filesTouched(payload, eventId).map((path: string): string => {
    if (isAbsolute(path) || repo === null) {
      return path;
    }
    return resolve(repo, path);
  });
}

function policyCandidate(
  event: Extract<HyperEvent, { type: "tool_call" }>,
  repo: string | null,
): PolicyCandidate {
  return {
    toolName: optionalPayloadString(event.payload, "name", event.id),
    command: optionalPayloadString(event.payload, "input_summary", event.id),
    // Canonical tool_call events do not distinguish read paths today.
    readPaths: [],
    writePaths: resolveWritePaths(event.payload, event.id, repo),
    // Post-hoc must reach the same verdict as the real-time hook, so it
    // matches user-authored relative patterns on the same dual basis.
    ...(repo === null ? {} : { repoRoot: repo }),
  };
}

function computeViolations(
  store: Store,
  sessionId: string,
  policy: PolicyDoc,
  detectedAt: string,
): PolicyViolation[] {
  const events = store.getEvents(sessionId);
  const repo = readSessionRepo(store, sessionId, events);
  const violations: PolicyViolation[] = [];

  for (const event of events) {
    if (event.type !== "tool_call") {
      continue;
    }
    const matches = matchPolicy(
      policy,
      policyCandidate(event, repo),
      { includeDisabled: true },
    );
    for (const match of matches) {
      violations.push({
        session_id: sessionId,
        rule_id: match.ruleId,
        event_id: event.id,
        detector_version: DETECTOR_VERSION,
        detected_at: detectedAt,
        action: match.action,
        evidence: match.evidence,
      });
    }
  }
  return violations;
}

function persistViolation(store: Store, violation: PolicyViolation): void {
  try {
    store.db.query(UPSERT_POLICY_VIOLATION_SQL).run(
      violation.session_id,
      violation.rule_id,
      violation.event_id,
      violation.detector_version,
      violation.detected_at,
      violation.action,
      violation.evidence,
    );
  } catch (error: unknown) {
    throw new Error(
      `failed to persist violation ${violation.rule_id} for event ${violation.event_id}: ${errorMessage(error)}`,
    );
  }
}

function persistViolations(store: Store, violations: PolicyViolation[]): void {
  for (const violation of violations) {
    persistViolation(store, violation);
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

function validatedViolation(
  row: ViolationDatabaseRow,
  index: number,
): PolicyViolation {
  return {
    session_id: requiredNonEmptyString(
      row.session_id,
      `policy violation row ${index} session_id`,
    ),
    rule_id: requiredNonEmptyString(
      row.rule_id,
      `policy violation row ${index} rule_id`,
    ),
    event_id: requiredNonEmptyString(
      row.event_id,
      `policy violation row ${index} event_id`,
    ),
    detector_version: requiredNonEmptyString(
      row.detector_version,
      `policy violation row ${index} detector_version`,
    ),
    detected_at: requiredNonEmptyString(
      row.detected_at,
      `policy violation row ${index} detected_at`,
    ),
    action: policyAction(row.action, `policy violation row ${index} action`),
    evidence: requiredNonEmptyString(
      row.evidence,
      `policy violation row ${index} evidence`,
    ),
  };
}

export function detectViolations(
  store: Store,
  sessionId: string,
  policy: PolicyDoc,
  options: { now?: () => number } = {},
): PolicyViolation[] {
  requiredNonEmptyString(sessionId, "session id");
  ensurePolicyViolationsTable(store);
  try {
    const detectAndPersist = store.db.transaction((): PolicyViolation[] => {
      const detectedAt = clockTimestamp(options.now, "violation detector");
      const violations = computeViolations(store, sessionId, policy, detectedAt);
      persistViolations(store, violations);
      return violations;
    });
    return detectAndPersist();
  } catch (error: unknown) {
    throw new Error(
      `failed to detect violations for session ${sessionId}: ${errorMessage(error)}`,
    );
  }
}

export function rebuildViolations(
  store: Store,
  policy: PolicyDoc,
  options: { now?: () => number } = {},
): number {
  ensurePolicyViolationsTable(store);
  try {
    const rebuild = store.db.transaction((): number => {
      const detectedAt = clockTimestamp(options.now, "violation rebuild");
      const sessionIds = readSessionIds(store);
      store.db.query(
        "DELETE FROM policy_violations WHERE detector_version = ?",
      ).run(DETECTOR_VERSION);
      for (const sessionId of sessionIds) {
        persistViolations(
          store,
          computeViolations(store, sessionId, policy, detectedAt),
        );
      }
      return sessionIds.length;
    });
    return rebuild();
  } catch (error: unknown) {
    throw new Error(`failed to rebuild policy violations: ${errorMessage(error)}`);
  }
}

export function listViolations(
  store: Store,
  filter: ViolationFilter = {},
): PolicyViolation[] {
  try {
    ensurePolicyViolationsTable(store);
    const clauses: string[] = [];
    const parameters: string[] = [];

    if (filter.sessionId !== undefined) {
      clauses.push("session_id = ?");
      parameters.push(requiredNonEmptyString(filter.sessionId, "violation filter sessionId"));
    }
    if (filter.days !== undefined) {
      if (!Number.isFinite(filter.days) || filter.days <= 0) {
        throw new Error("violation filter days must be a positive finite number");
      }
      const windowEnd = clockTimestamp(filter.now, "violation filter");
      const windowStartMilliseconds =
        Date.parse(windowEnd) - filter.days * 24 * 60 * 60 * 1000;
      if (!Number.isFinite(windowStartMilliseconds)) {
        throw new Error("violation filter window start is outside the supported range");
      }
      let windowStart: string;
      try {
        windowStart = new Date(windowStartMilliseconds).toISOString();
      } catch (error: unknown) {
        throw new Error(
          `violation filter window start is outside the supported range: ${errorMessage(error)}`,
        );
      }
      clauses.push("detected_at >= ?", "detected_at <= ?");
      parameters.push(windowStart, windowEnd);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = store.db.query<ViolationDatabaseRow, string[]>(`
      SELECT
        session_id,
        rule_id,
        event_id,
        detector_version,
        detected_at,
        action,
        evidence
      FROM policy_violations${where}
      ORDER BY session_id, rule_id, event_id, detector_version
    `).all(...parameters);
    return rows.map(validatedViolation);
  } catch (error: unknown) {
    throw new Error(`failed to list policy violations: ${errorMessage(error)}`);
  }
}
