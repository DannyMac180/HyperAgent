import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  SCHEMA_VERSION,
  assertValidEnvelope,
  isEventType,
  validateEnvelope,
} from "../schema/events.ts";
import type {
  EventInput,
  HyperEvent,
  Vendor,
} from "../schema/events.ts";

export interface SessionRow {
  session_id: string;
  vendor: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  repo: string | null;
  agent: string | null;
  model: string | null;
}

export interface SessionFilter {
  vendor?: string;
  repo?: string;
  open?: boolean;
  since?: string;
  limit?: number;
}

export interface Store {
  /**
   * Exposed for tests and diagnostics. Events remain append-only because the
   * database triggers reject raw UPDATE and DELETE statements.
   */
  readonly db: Database;
  append(event: EventInput | EventInput[]): number;
  getEvents(sessionId: string): HyperEvent[];
  getSessions(filter?: SessionFilter): SessionRow[];
  rebuildSessions(): number;
  close(): void;
}

interface EventDatabaseRow {
  id: string;
  ts: string;
  observed_at: string;
  type: string;
  session_id: string;
  vendor: string;
  adapter_version: string;
  schema_version: string;
  raw_ref: string | null;
  payload: string;
}

interface SessionIndexEvent {
  ts: string;
  type: "session_start" | "session_end";
  session_id: string;
  vendor: string;
  payload: Record<string, unknown>;
}

interface PreparedEvent {
  id: string;
  ts: string;
  observed_at: string;
  type: EventInput["type"];
  session_id: string;
  vendor: Vendor;
  adapter_version: string;
  schema_version: string;
  raw_ref: string | null;
  serializedPayload: string;
}

const STORE_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;                      -- holds schema_version, created_at

CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,          -- ULID
  ts              TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN (
                    'session_start','session_end','turn_start','turn_end',
                    'tool_call','error','retry','completion_claim','verification_event')),
  session_id      TEXT NOT NULL,
  vendor          TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  raw_ref         TEXT,
  payload         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts, id);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(type, ts);
CREATE INDEX IF NOT EXISTS idx_events_vendor  ON events(vendor, ts);

-- Derived, rebuildable session index (NOT source of truth; the log is).
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  vendor      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  outcome     TEXT,
  repo        TEXT,
  agent       TEXT,
  model       TEXT
) STRICT;

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function majorVersion(version: unknown, label: string): number {
  if (typeof version !== "string") {
    throw new Error(`${label} schema version must be a string, got ${String(version)}`);
  }
  const major = version.split(".")[0];
  if (major === undefined || !/^\d+$/.test(major)) {
    throw new Error(`${label} schema version is unparseable: ${JSON.stringify(version)}`);
  }
  return Number(major);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function parsePayload(payloadText: unknown, eventId: string): Record<string, unknown> {
  if (typeof payloadText !== "string") {
    throw new Error(`event ${eventId} has a non-text stored payload`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText) as unknown;
  } catch (error: unknown) {
    throw new Error(`event ${eventId} has invalid stored payload JSON: ${errorMessage(error)}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`event ${eventId} has a stored payload that is not a JSON object`);
  }
  return parsed;
}

function optionalPayloadString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function validateSessionFilter(filter: SessionFilter): void {
  if (filter.vendor !== undefined && typeof filter.vendor !== "string") {
    throw new Error("session filter vendor must be a string");
  }
  if (filter.repo !== undefined && typeof filter.repo !== "string") {
    throw new Error("session filter repo must be a string");
  }
  if (filter.open !== undefined && typeof filter.open !== "boolean") {
    throw new Error("session filter open must be a boolean");
  }
  if (filter.since !== undefined && typeof filter.since !== "string") {
    throw new Error("session filter since must be a string");
  }
  if (
    filter.limit !== undefined
    && (!Number.isSafeInteger(filter.limit) || filter.limit < 0)
  ) {
    throw new Error("session filter limit must be a non-negative safe integer");
  }
}

export function openStore(storePath?: string): Store {
  const resolvedPath = storePath ?? join(homedir(), ".hyperagent", "hyperagent.db");
  if (resolvedPath !== ":memory:") {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath);
  try {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
    } catch (error: unknown) {
      if (resolvedPath !== ":memory:") {
        throw new Error(`failed to enable SQLite WAL mode: ${errorMessage(error)}`);
      }
      // In-memory SQLite databases cannot use WAL; a failure is harmless here.
    }
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(STORE_DDL);

    const storedVersionRow = db
      .query<{ value: unknown }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
      .get();

    if (storedVersionRow === null) {
      const initializeMetadata = db.transaction((): void => {
        db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
          .run(SCHEMA_VERSION);
        db.query(
          "INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ?)",
        ).run(new Date().toISOString());
      });
      initializeMetadata();
    } else {
      const storedVersion = storedVersionRow.value;
      const storedMajor = majorVersion(storedVersion, "stored");
      const supportedMajor = majorVersion(SCHEMA_VERSION, "supported");
      if (storedMajor > supportedMajor) {
        throw new Error(
          `store schema version ${String(storedVersion)} is newer than supported version ${SCHEMA_VERSION}`,
        );
      }
    }

    const insertEvent = db.query(`
      INSERT OR IGNORE INTO events (
        id, ts, observed_at, type, session_id, vendor, adapter_version,
        schema_version, raw_ref, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const deleteSession = db.query("DELETE FROM sessions WHERE session_id = ?");
    const selectSessionEvents = db.query<
      Pick<EventDatabaseRow, "id" | "ts" | "type" | "session_id" | "vendor" | "payload">,
      [string]
    >(`
      SELECT id, ts, type, session_id, vendor, payload
      FROM events
      WHERE session_id = ? AND type IN ('session_start', 'session_end')
      ORDER BY ts, id
    `);
    const upsertSessionStart = db.query(`
      INSERT INTO sessions (
        session_id, vendor, started_at, repo, agent, model
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        vendor = excluded.vendor,
        started_at = excluded.started_at,
        repo = excluded.repo,
        agent = excluded.agent,
        model = excluded.model
    `);
    const upsertSessionEnd = db.query(`
      INSERT INTO sessions (
        session_id, vendor, started_at, ended_at, outcome
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        ended_at = excluded.ended_at,
        outcome = excluded.outcome
    `);

    function applySessionEvent(event: SessionIndexEvent): void {
      if (event.type === "session_start") {
        upsertSessionStart.run(
          event.session_id,
          event.vendor,
          event.ts,
          optionalPayloadString(event.payload, "repo"),
          optionalPayloadString(event.payload, "agent"),
          optionalPayloadString(event.payload, "model"),
        );
        return;
      }

      // An end without a start uses its timestamp as the placeholder start;
      // rebuildSessions() follows this same rule through this shared helper.
      upsertSessionEnd.run(
        event.session_id,
        event.vendor,
        event.ts,
        event.ts,
        optionalPayloadString(event.payload, "outcome"),
      );
    }

    function indexEventFromRow(
      row: Pick<
        EventDatabaseRow,
        "id" | "ts" | "type" | "session_id" | "vendor" | "payload"
      >,
    ): SessionIndexEvent {
      if (row.type !== "session_start" && row.type !== "session_end") {
        throw new Error(`event ${row.id} has unexpected session index type ${row.type}`);
      }
      return {
        ts: row.ts,
        type: row.type,
        session_id: row.session_id,
        vendor: row.vendor,
        payload: parsePayload(row.payload, row.id),
      };
    }

    function rebuildOneSession(sessionId: string): void {
      deleteSession.run(sessionId);
      const rows = selectSessionEvents.all(sessionId);
      for (const row of rows) {
        applySessionEvent(indexEventFromRow(row));
      }
    }

    function append(eventOrEvents: EventInput | EventInput[]): number {
      const events = Array.isArray(eventOrEvents) ? eventOrEvents : [eventOrEvents];

      for (const [index, event] of events.entries()) {
        const problems = validateEnvelope(event);
        if (problems.length > 0) {
          throw new Error(`invalid event at index ${index}: ${problems.join("; ")}`);
        }
      }

      const observedAt = new Date().toISOString();
      const preparedEvents: PreparedEvent[] = events.map(
        (event: EventInput, index: number): PreparedEvent => {
          const payload = event.payload ?? {};
          let serializedPayload: string | undefined;
          try {
            serializedPayload = JSON.stringify(payload);
          } catch (error: unknown) {
            throw new Error(
              `event at index ${index} has an unserializable payload: ${errorMessage(error)}`,
            );
          }
          if (serializedPayload === undefined) {
            throw new Error(`event at index ${index} has an unserializable payload`);
          }
          return {
            id: event.id,
            ts: event.ts,
            observed_at: event.observed_at ?? observedAt,
            type: event.type,
            session_id: event.session_id,
            vendor: event.vendor,
            adapter_version: event.adapter_version,
            schema_version: event.schema_version ?? SCHEMA_VERSION,
            raw_ref: event.raw_ref ?? null,
            serializedPayload,
          };
        },
      );

      const insertBatch = db.transaction((): number => {
        let insertedCount = 0;
        const impactedSessions = new Set<string>();

        for (const event of preparedEvents) {
          const result = insertEvent.run(
            event.id,
            event.ts,
            event.observed_at,
            event.type,
            event.session_id,
            event.vendor,
            event.adapter_version,
            event.schema_version,
            event.raw_ref,
            event.serializedPayload,
          );
          insertedCount += result.changes;
          if (
            result.changes > 0
            && (event.type === "session_start" || event.type === "session_end")
          ) {
            impactedSessions.add(event.session_id);
          }
        }

        for (const sessionId of impactedSessions) {
          rebuildOneSession(sessionId);
        }
        return insertedCount;
      });

      return insertBatch();
    }

    function getEvents(sessionId: string): HyperEvent[] {
      if (typeof sessionId !== "string") {
        throw new Error("session id must be a string");
      }
      const rows = db.query<EventDatabaseRow, [string]>(`
        SELECT
          id, ts, observed_at, type, session_id, vendor, adapter_version,
          schema_version, raw_ref, payload
        FROM events
        WHERE session_id = ?
        ORDER BY ts, id
      `).all(sessionId);

      return rows.map((row: EventDatabaseRow): HyperEvent => {
        if (!isEventType(row.type)) {
          throw new Error(`event ${row.id} has unknown stored type ${JSON.stringify(row.type)}`);
        }
        const candidate = {
          id: row.id,
          ts: row.ts,
          observed_at: row.observed_at,
          type: row.type,
          session_id: row.session_id,
          vendor: row.vendor,
          adapter_version: row.adapter_version,
          schema_version: row.schema_version,
          raw_ref: row.raw_ref,
          payload: parsePayload(row.payload, row.id),
        };
        try {
          assertValidEnvelope(candidate);
        } catch (error: unknown) {
          throw new Error(`event ${row.id} has an invalid stored envelope: ${errorMessage(error)}`);
        }
        return candidate as HyperEvent;
      });
    }

    function getSessions(filter: SessionFilter = {}): SessionRow[] {
      validateSessionFilter(filter);
      const clauses: string[] = [];
      const parameters: Array<string | number> = [];

      if (filter.vendor !== undefined) {
        clauses.push("vendor = ?");
        parameters.push(filter.vendor);
      }
      if (filter.repo !== undefined) {
        clauses.push("repo = ?");
        parameters.push(filter.repo);
      }
      if (filter.open !== undefined) {
        clauses.push(filter.open ? "ended_at IS NULL" : "ended_at IS NOT NULL");
      }
      if (filter.since !== undefined) {
        clauses.push("started_at >= ?");
        parameters.push(filter.since);
      }

      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      let sql = `
        SELECT session_id, vendor, started_at, ended_at, outcome, repo, agent, model
        FROM sessions${where}
        ORDER BY started_at DESC, session_id DESC
      `;
      if (filter.limit !== undefined) {
        sql += " LIMIT ?";
        parameters.push(filter.limit);
      }

      return db
        .query<SessionRow, Array<string | number>>(sql)
        .all(...parameters);
    }

    function rebuildSessions(): number {
      const rebuild = db.transaction((): number => {
        db.run("DELETE FROM sessions");
        const rows = db.query<
          Pick<
            EventDatabaseRow,
            "id" | "ts" | "type" | "session_id" | "vendor" | "payload"
          >,
          []
        >(`
          SELECT id, ts, type, session_id, vendor, payload
          FROM events
          WHERE type IN ('session_start', 'session_end')
          ORDER BY ts, id
        `).all();
        for (const row of rows) {
          applySessionEvent(indexEventFromRow(row));
        }

        const countRow = db
          .query<{ count: unknown }, []>("SELECT count(*) AS count FROM sessions")
          .get();
        if (
          countRow === null
          || typeof countRow.count !== "number"
          || !Number.isSafeInteger(countRow.count)
          || countRow.count < 0
        ) {
          throw new Error("failed to read rebuilt session count");
        }
        return countRow.count;
      });
      return rebuild();
    }

    let closed = false;
    function close(): void {
      if (closed) {
        return;
      }
      db.close();
      closed = true;
    }

    return { db, append, getEvents, getSessions, rebuildSessions, close };
  } catch (error: unknown) {
    try {
      db.close();
    } catch (closeError: unknown) {
      throw new Error(
        `store open failed (${errorMessage(error)}) and closing it also failed: ${errorMessage(closeError)}`,
      );
    }
    throw error;
  }
}
