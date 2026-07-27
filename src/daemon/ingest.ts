import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AdapterHealthStatus,
  ObserveAdapter,
} from "../adapters/types.ts";
import {
  createMissionQueue,
  type MissionQueue,
} from "../missions/queue.ts";
import {
  createMemoryQueue,
  type MemoryQueue,
} from "../memory/queue.ts";
import {
  openMemoryStore,
  type MemoryStore,
} from "../memory/store.ts";
import { spawnAgentRunner } from "../missions/runner.ts";
import { deterministicEventId } from "../schema/ids.ts";
import type { EventInput } from "../schema/events.ts";
import {
  SCORER_VERSION,
  scoreSession,
} from "../scoring/score.ts";
import {
  detectViolations,
} from "../gate/detect.ts";
import {
  policyPath,
} from "../gate/paths.ts";
import {
  loadPolicy,
} from "../gate/policy.ts";
import { openStore } from "../store/store.ts";
import {
  ingestGateSpool,
} from "./gate-ingest.ts";

export interface IngestOptions {
  dataDir?: string;
  adapters: ObserveAdapter[];
  quiesceMs?: number;
  now?: () => number;
  scoring?: boolean;
  gate?: boolean;
  missions?: boolean;
  missionQueue?: MissionQueue;
  memory?: boolean;
  memoryQueue?: MemoryQueue;
}

export interface AdapterRunStats {
  vendor: string;
  adapterVersion: string;
  status: AdapterHealthStatus;
  harnessVersion: string | null;
  detail: string;
  sessionsDiscovered: number;
  sessionsParsed: number;
  sessionsSkippedUnchanged: number;
  eventsAppended: number;
  skippedUnknown: number;
  parseFailures: number;
  linesParsed: number;
  sessionsClosed: number;
}

export interface IngestRunResult {
  startedAt: string;
  finishedAt: string;
  adapters: AdapterRunStats[];
  sessionsScored: number;
  gateEventsAppended: number;
  sessionsDetected: number;
  missionsEnqueued: number;
  memoryExtractionsEnqueued: number;
}

export interface IngestState {
  v: 1;
  sessions: Record<string, SessionState>;
  lastRun?: IngestRunResult;
}

export interface SessionState {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  resumeToken: string;
  vendor: string;
  closed: boolean;
  firstTs?: string;
  lastTs?: string;
  turnCount: number;
  toolCallCount: number;
}

const emptyState = (): IngestState => ({ v: 1, sessions: {} });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSessionState = (value: unknown): value is SessionState => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.path === "string" &&
    typeof value.mtimeMs === "number" &&
    typeof value.sizeBytes === "number" &&
    typeof value.resumeToken === "string" &&
    typeof value.vendor === "string" &&
    typeof value.closed === "boolean" &&
    (value.firstTs === undefined || typeof value.firstTs === "string") &&
    (value.lastTs === undefined || typeof value.lastTs === "string") &&
    typeof value.turnCount === "number" &&
    typeof value.toolCallCount === "number"
  );
};

export function readIngestState(dataDir: string): IngestState {
  try {
    return parseIngestState(
      JSON.parse(
        readFileSync(join(dataDir, "ingest-state.json"), "utf8"),
      ) as unknown,
    );
  } catch {
    return emptyState();
  }
}

function parseIngestState(parsed: unknown): IngestState {
  if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.sessions)) {
    return emptyState();
  }
  const sessions: Record<string, SessionState> = {};
  for (const [sessionId, value] of Object.entries(parsed.sessions)) {
    if (!isSessionState(value)) {
      return emptyState();
    }
    sessions[sessionId] = value;
  }
  const state: IngestState = { v: 1, sessions };
  if (parsed.lastRun !== undefined) {
    if (!isIngestRunResult(parsed.lastRun)) {
      return emptyState();
    }
    state.lastRun = parsed.lastRun;
  }
  return state;
}

function isAdapterRunStats(value: unknown): value is AdapterRunStats {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.vendor === "string" &&
    typeof value.adapterVersion === "string" &&
    (value.status === "ok" ||
      value.status === "needs_update" ||
      value.status === "unavailable") &&
    (value.harnessVersion === null ||
      typeof value.harnessVersion === "string") &&
    typeof value.detail === "string" &&
    typeof value.sessionsDiscovered === "number" &&
    typeof value.sessionsParsed === "number" &&
    typeof value.sessionsSkippedUnchanged === "number" &&
    typeof value.eventsAppended === "number" &&
    typeof value.skippedUnknown === "number" &&
    typeof value.parseFailures === "number" &&
    typeof value.linesParsed === "number" &&
    typeof value.sessionsClosed === "number"
  );
}

function isIngestRunResult(value: unknown): value is IngestRunResult {
  return (
    isRecord(value) &&
    typeof value.startedAt === "string" &&
    typeof value.finishedAt === "string" &&
    Array.isArray(value.adapters) &&
    value.adapters.every(isAdapterRunStats) &&
    (value.sessionsScored === undefined ||
      typeof value.sessionsScored === "number") &&
    (value.gateEventsAppended === undefined ||
      typeof value.gateEventsAppended === "number") &&
    (value.sessionsDetected === undefined ||
      typeof value.sessionsDetected === "number") &&
    (value.missionsEnqueued === undefined ||
      typeof value.missionsEnqueued === "number") &&
    (value.memoryExtractionsEnqueued === undefined ||
      typeof value.memoryExtractionsEnqueued === "number")
  );
}

interface SessionWatermarkRow {
  session_id: unknown;
}

interface CurrentScoreRow {
  current_watermark: unknown;
  scorer_version: unknown;
  event_watermark: unknown;
}

function eventExists(
  store: ReturnType<typeof openStore>,
  eventId: string,
): boolean {
  const row = store.db
    .query<{ present: unknown }, [string]>(
      "SELECT 1 AS present FROM events WHERE id = ?",
    )
    .get(eventId);
  return row !== null;
}

function grownScoredSessions(store: ReturnType<typeof openStore>): string[] {
  try {
    const rows = store.db.query<SessionWatermarkRow, []>(`
      SELECT scores.session_id
      FROM session_scores AS scores
      INNER JOIN (
        SELECT session_id, MAX(rowid) AS current_watermark
        FROM events
        GROUP BY session_id
      ) AS current
        ON current.session_id = scores.session_id
      WHERE current.current_watermark > scores.event_watermark
    `).all();
    return rows.flatMap((row: SessionWatermarkRow): string[] =>
      typeof row.session_id === "string" ? [row.session_id] : []
    );
  } catch (error: unknown) {
    // Scoring may never have run, so session_scores may not exist yet.
    if (!errorMessage(error).includes("no such table: session_scores")) {
      console.error(
        `Failed to identify grown scored sessions: ${errorMessage(error)}`,
      );
    }
    return [];
  }
}

function scoreIsCurrent(
  store: ReturnType<typeof openStore>,
  sessionId: string,
): boolean {
  try {
    const row = store.db.query<CurrentScoreRow, [string]>(`
      SELECT
        MAX(events.rowid) AS current_watermark,
        scores.scorer_version,
        scores.event_watermark
      FROM events
      LEFT JOIN session_scores AS scores
        ON scores.session_id = events.session_id
      WHERE events.session_id = ?
    `).get(sessionId);
    return (
      row !== null &&
      typeof row.current_watermark === "number" &&
      row.scorer_version === SCORER_VERSION &&
      row.event_watermark === row.current_watermark
    );
  } catch (error: unknown) {
    // A missing session_scores table means this session cannot be current.
    if (!errorMessage(error).includes("no such table: session_scores")) {
      console.error(
        `Failed to check score watermark for session "${sessionId}": ${
          errorMessage(error)
        }`,
      );
    }
    return false;
  }
}

async function loadIngestState(dataDir: string): Promise<IngestState> {
  try {
    return parseIngestState(
      JSON.parse(
        await readFile(join(dataDir, "ingest-state.json"), "utf8"),
      ) as unknown,
    );
  } catch {
    return emptyState();
  }
}

async function persistState(dataDir: string, state: IngestState): Promise<void> {
  const path = join(dataDir, "ingest-state.json");
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function minTimestamp(current: string | undefined, candidate: string): string {
  return current === undefined || candidate < current ? candidate : current;
}

function maxTimestamp(current: string | undefined, candidate: string): string {
  return current === undefined || candidate > current ? candidate : current;
}

function zeroStats(
  adapter: ObserveAdapter,
  status: AdapterHealthStatus,
  harnessVersion: string | null,
  detail: string,
): AdapterRunStats {
  return {
    vendor: adapter.vendor,
    adapterVersion: adapter.adapterVersion,
    status,
    harnessVersion,
    detail,
    sessionsDiscovered: 0,
    sessionsParsed: 0,
    sessionsSkippedUnchanged: 0,
    eventsAppended: 0,
    skippedUnknown: 0,
    parseFailures: 0,
    linesParsed: 0,
    sessionsClosed: 0,
  };
}

export async function runIngestOnce(
  options: IngestOptions,
): Promise<IngestRunResult> {
  const dataDir = options.dataDir ?? join(homedir(), ".hyperagent");
  const quiesceMs = options.quiesceMs ?? 30 * 60 * 1000;
  const now = options.now ?? Date.now;
  await mkdir(dataDir, { recursive: true });
  const state = await loadIngestState(dataDir);
  const store = openStore(join(dataDir, "hyperagent.db"));
  const startedAt = new Date(now()).toISOString();
  const statsByVendor = new Map<string, AdapterRunStats>();
  const adapterByVendor = new Map<string, ObserveAdapter>();
  const adapterStats: AdapterRunStats[] = [];
  const closedThisPass = new Set<string>();
  let internallyCreatedMissionQueue: MissionQueue | undefined;
  let internallyCreatedMemoryQueue: MemoryQueue | undefined;
  let internallyCreatedMemoryStore: MemoryStore | undefined;

  try {
    for (const adapter of options.adapters) {
      adapterByVendor.set(adapter.vendor, adapter);
      let stats: AdapterRunStats;
      try {
        const health = await adapter.detect();
        stats = zeroStats(
          adapter,
          health.status,
          health.harnessVersion,
          health.detail,
        );
        adapterStats.push(stats);
        statsByVendor.set(adapter.vendor, stats);
        if (health.status === "unavailable") {
          state.lastRun = {
            startedAt,
            finishedAt: new Date(now()).toISOString(),
            adapters: adapterStats,
            sessionsScored: 0,
            gateEventsAppended: 0,
            sessionsDetected: 0,
            missionsEnqueued: 0,
            memoryExtractionsEnqueued: 0,
          };
          await persistState(dataDir, state);
          continue;
        }

        const sessions = await adapter.discoverSessions();
        stats.sessionsDiscovered = sessions.length;
        const failuresByPath = new Map<string, number>();

        for (const session of sessions) {
          const prior = state.sessions[session.sessionId];
          if (
            prior !== undefined &&
            prior.mtimeMs === session.mtimeMs &&
            prior.sizeBytes === session.sizeBytes
          ) {
            stats.sessionsSkippedUnchanged += 1;
            continue;
          }

          try {
            const result = await adapter.parseSession(
              session,
              prior?.resumeToken ?? "",
            );
            // Which session_end events are genuinely new must be decided BEFORE
            // the append, because ids are deterministic and the store dedupes
            // with INSERT OR IGNORE: after the fact a re-ingested duplicate is
            // indistinguishable from a fresh close. Appending per-event to read
            // each insert count individually would cost one transaction per
            // event, so the batch append is kept and novelty is pre-computed.
            for (const event of result.events) {
              if (
                event.type === "session_end" &&
                !eventExists(store, event.id)
              ) {
                closedThisPass.add(event.session_id);
              }
            }
            const inserted = store.append(result.events);
            stats.sessionsParsed += 1;
            stats.eventsAppended += inserted;
            stats.skippedUnknown += result.skippedUnknown;
            stats.parseFailures += result.parseFailures;
            // The contract exposes no physical line count. This is the available
            // proxy: skipped records + failed records + events inserted this run.
            stats.linesParsed +=
              result.skippedUnknown + result.parseFailures + inserted;
            if (result.parseFailures > 0) {
              failuresByPath.set(session.path, result.parseFailures);
            }

            let firstTs = prior?.firstTs;
            let lastTs = prior?.lastTs;
            let turnCount = prior?.turnCount ?? 0;
            let toolCallCount = prior?.toolCallCount ?? 0;
            for (const event of result.events) {
              firstTs = minTimestamp(firstTs, event.ts);
              lastTs = maxTimestamp(lastTs, event.ts);
              if (event.type === "turn_start") {
                turnCount += 1;
              } else if (event.type === "tool_call") {
                toolCallCount += 1;
              }
            }
            state.sessions[session.sessionId] = {
              path: session.path,
              mtimeMs: session.mtimeMs,
              sizeBytes: session.sizeBytes,
              resumeToken: result.resumeToken,
              vendor: adapter.vendor,
              closed: false,
              ...(firstTs === undefined ? {} : { firstTs }),
              ...(lastTs === undefined ? {} : { lastTs }),
              turnCount,
              toolCallCount,
            };
          } catch (error: unknown) {
            stats.parseFailures += 1;
            stats.linesParsed += 1;
            failuresByPath.set(
              session.path,
              (failuresByPath.get(session.path) ?? 0) + 1,
            );
            stats.detail = `Parse error for ${session.path}: ${errorMessage(error)}`;
          }
        }

        if (
          stats.parseFailures > 0 &&
          stats.parseFailures >= 0.05 * stats.linesParsed
        ) {
          let worstPath = "";
          let worstCount = 0;
          for (const [path, count] of failuresByPath) {
            if (count > worstCount) {
              worstPath = path;
              worstCount = count;
            }
          }
          stats.status = "needs_update";
          stats.detail = `${worstPath}: ${worstCount} parse failure${
            worstCount === 1 ? "" : "s"
          }`;
        }
      } catch (error: unknown) {
        const existing = statsByVendor.get(adapter.vendor);
        if (existing === undefined) {
          stats = zeroStats(
            adapter,
            "unavailable",
            null,
            errorMessage(error),
          );
          adapterStats.push(stats);
          statsByVendor.set(adapter.vendor, stats);
        } else {
          existing.status = "unavailable";
          existing.detail = errorMessage(error);
        }
      }

      state.lastRun = {
        startedAt,
        finishedAt: new Date(now()).toISOString(),
        adapters: adapterStats,
        sessionsScored: 0,
        gateEventsAppended: 0,
        sessionsDetected: 0,
        missionsEnqueued: 0,
        memoryExtractionsEnqueued: 0,
      };
      await persistState(dataDir, state);
    }

    const quiesceBefore = now() - quiesceMs;
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      if (session.closed || session.mtimeMs >= quiesceBefore) {
        continue;
      }
      const adapter = adapterByVendor.get(session.vendor);
      if (adapter === undefined) {
        continue;
      }
      const ts = new Date(
        session.lastTs ?? session.mtimeMs,
      ).toISOString();
      const rawRef = `${session.path}#quiesce`;
      const durationMs =
        session.firstTs !== undefined && session.lastTs !== undefined
          ? new Date(session.lastTs).getTime() -
            new Date(session.firstTs).getTime()
          : undefined;
      const event: EventInput = {
        id: deterministicEventId({
          ts,
          sessionId,
          rawRef,
          type: "session_end",
        }),
        ts,
        type: "session_end",
        session_id: sessionId,
        vendor: adapter.vendor,
        adapter_version: adapter.adapterVersion,
        raw_ref: rawRef,
        payload: {
          outcome: "unknown",
          ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
          turn_count: session.turnCount,
          tool_call_count: session.toolCallCount,
        },
      };
      const inserted = store.append(event);
      session.closed = true;
      if (inserted > 0) {
        closedThisPass.add(sessionId);
      }
      const stats = statsByVendor.get(session.vendor);
      if (stats !== undefined) {
        stats.eventsAppended += inserted;
        stats.sessionsClosed += inserted > 0 ? 1 : 0;
      }
    }

    let sessionsScored = 0;
    if (options.scoring !== false) {
      const sessionsToScore = new Set<string>(closedThisPass);
      for (const sessionId of grownScoredSessions(store)) {
        sessionsToScore.add(sessionId);
      }
      for (const sessionId of sessionsToScore) {
        try {
          if (!scoreIsCurrent(store, sessionId)) {
            scoreSession(store, sessionId);
            sessionsScored += 1;
          }
        } catch (error: unknown) {
          console.error(
            `Failed to score ingested session "${sessionId}": ${errorMessage(error)}`,
          );
        }
      }
    }

    let gateEventsAppended = 0;
    let sessionsDetected = 0;
    if (options.gate !== false) {
      try {
        const policy = loadPolicy(policyPath(dataDir)).policy;
        const gateIngest = await ingestGateSpool({ store, dataDir });
        gateEventsAppended = gateIngest.eventsAppended;
        for (const sessionId of closedThisPass) {
          try {
            detectViolations(store, sessionId, policy);
            sessionsDetected += 1;
          } catch (error: unknown) {
            console.error(
              `Failed to detect policy violations for ingested session "${sessionId}": ${
                errorMessage(error)
              }`,
            );
          }
        }
      } catch (error: unknown) {
        console.error(
          `Failed to process gate outcomes after ingest: ${errorMessage(error)}`,
        );
      }
    }

    let missionsEnqueued = 0;
    if (options.missions === true && closedThisPass.size > 0) {
      let missionQueue = options.missionQueue;
      try {
        if (missionQueue === undefined) {
          missionQueue = createMissionQueue({
            deps: { runModel: spawnAgentRunner({ dataDir }) },
            dataDir,
            store,
            onError: (sessionId: string, error: unknown): void => {
              console.error(
                `Failed to generate mission for ingested session "${sessionId}": ${
                  errorMessage(error)
                }`,
              );
            },
          });
          internallyCreatedMissionQueue = missionQueue;
        }
        for (const sessionId of closedThisPass) {
          // A newly inserted session_end is a new close boundary, so refresh the
          // mission even when a prior mission record already exists.
          if (missionQueue.enqueue(sessionId)) {
            missionsEnqueued += 1;
          }
        }
      } catch (error: unknown) {
        console.error(
          `Failed to enqueue missions after ingest: ${errorMessage(error)}`,
        );
      }
    }

    let memoryExtractionsEnqueued = 0;
    if (options.memory === true && closedThisPass.size > 0) {
      let memoryQueue = options.memoryQueue;
      try {
        if (memoryQueue === undefined) {
          const memoryStore = openMemoryStore({
            dbPath: join(dataDir, "hyperagent.db"),
            memoryDir: join(dataDir, "memory"),
          });
          try {
            memoryQueue = createMemoryQueue({
              dataDir,
              store,
              memoryStore,
              onError: (sessionId: string, error: unknown): void => {
                console.error(
                  `Failed to extract memory for ingested session "${sessionId}": ${
                    errorMessage(error)
                  }`,
                );
              },
            });
          } catch (error: unknown) {
            memoryStore.close();
            throw error;
          }
          internallyCreatedMemoryStore = memoryStore;
          internallyCreatedMemoryQueue = memoryQueue;
        }
        for (const sessionId of closedThisPass) {
          // Injection is deliberately not automatic here. Context changes only
          // after an explicit status transition or `memory sync`.
          if (memoryQueue.enqueue(sessionId)) {
            memoryExtractionsEnqueued += 1;
          }
        }
      } catch (error: unknown) {
        console.error(
          `Failed to enqueue memory extractions after ingest: ${
            errorMessage(error)
          }`,
        );
      }
    }

    const result: IngestRunResult = {
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      adapters: adapterStats,
      sessionsScored,
      gateEventsAppended,
      sessionsDetected,
      missionsEnqueued,
      memoryExtractionsEnqueued,
    };
    state.lastRun = result;
    await persistState(dataDir, state);
    return result;
  } finally {
    const drains: Promise<void>[] = [];
    if (internallyCreatedMissionQueue !== undefined) {
      drains.push(internallyCreatedMissionQueue.drain());
    }
    if (internallyCreatedMemoryQueue !== undefined) {
      drains.push(internallyCreatedMemoryQueue.drain());
    }
    try {
      await Promise.all(drains);
    } finally {
      internallyCreatedMemoryStore?.close();
      store.close();
    }
  }
}
