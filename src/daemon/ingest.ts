import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AdapterHealthStatus,
  ObserveAdapter,
} from "../adapters/types.ts";
import { deterministicEventId } from "../schema/ids.ts";
import type { EventInput } from "../schema/events.ts";
import { openStore } from "../store/store.ts";

export interface IngestOptions {
  dataDir?: string;
  adapters: ObserveAdapter[];
  quiesceMs?: number;
  now?: () => number;
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
    value.adapters.every(isAdapterRunStats)
  );
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
      const stats = statsByVendor.get(session.vendor);
      if (stats !== undefined) {
        stats.eventsAppended += inserted;
        stats.sessionsClosed += 1;
      }
    }

    const result: IngestRunResult = {
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      adapters: adapterStats,
    };
    state.lastRun = result;
    await persistState(dataDir, state);
    return result;
  } finally {
    store.close();
  }
}
