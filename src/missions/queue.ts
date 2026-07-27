import {
  buildMissionInput,
  generateMission,
  writeMissionRecord,
} from "./generate.ts";
import type { MissionDeps } from "./generate.ts";
import { isSuitOwnSession } from "./runner.ts";
import type { Store } from "../store/store.ts";

export interface MissionQueueOptions {
  deps: MissionDeps;
  dataDir: string;
  store: Store;
  onError?: (sessionId: string, error: unknown) => void;
}

export interface MissionQueue {
  enqueue(sessionId: string): boolean;
  drain(): Promise<void>;
  size(): number;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createMissionQueue(
  options: MissionQueueOptions,
): MissionQueue {
  const pendingSessionIds: string[] = [];
  const activeSessionIds = new Set<string>();
  const spawnedSessionIds = new Set<string>();
  const drainWaiters = new Set<() => void>();
  let processing = false;

  const reportError = (sessionId: string, error: unknown): void => {
    const contextualError = new Error(
      `Mission queue failed for session "${sessionId}": ${errorMessage(error)}`,
      { cause: error },
    );
    if (options.onError === undefined) {
      console.error(contextualError);
      return;
    }
    try {
      options.onError(sessionId, contextualError);
    } catch (callbackError: unknown) {
      console.error(
        new Error(
          `Mission queue error handler failed for session "${sessionId}": ${
            errorMessage(callbackError)
          }`,
          { cause: callbackError },
        ),
      );
    }
  };

  const settleDrainWaiters = (): void => {
    if (processing || pendingSessionIds.length > 0) {
      return;
    }
    for (const resolveWaiter of drainWaiters) {
      resolveWaiter();
    }
    drainWaiters.clear();
  };

  const registerSpawnedSession = (sessionId: string): void => {
    spawnedSessionIds.add(sessionId);
  };

  const runJob = async (sessionId: string): Promise<void> => {
    try {
      // This in-process guard prevents repeat generation during this daemon
      // lifetime. The isSuitOwnSession check is the durable layer because this
      // set does not survive a restart; both layers are required.
      registerSpawnedSession(sessionId);
      const input = buildMissionInput(options.store, sessionId);
      const record = await generateMission(options.deps, input);
      await writeMissionRecord(record, options.dataDir);
    } catch (error: unknown) {
      reportError(sessionId, error);
    } finally {
      activeSessionIds.delete(sessionId);
    }
  };

  const processQueue = async (): Promise<void> => {
    if (processing) {
      return;
    }
    processing = true;
    try {
      while (pendingSessionIds.length > 0) {
        const sessionId = pendingSessionIds.shift();
        if (sessionId === undefined) {
          continue;
        }
        await runJob(sessionId);
      }
    } catch (error: unknown) {
      reportError("<queue>", error);
    } finally {
      processing = false;
      if (pendingSessionIds.length > 0) {
        void processQueue();
      } else {
        settleDrainWaiters();
      }
    }
  };

  const enqueue = (sessionId: string): boolean => {
    if (
      activeSessionIds.has(sessionId) ||
      spawnedSessionIds.has(sessionId)
    ) {
      return false;
    }
    try {
      if (
        isSuitOwnSession(
          options.store.getEvents(sessionId),
          options.dataDir,
        )
      ) {
        return false;
      }
    } catch (error: unknown) {
      reportError(sessionId, error);
      return false;
    }

    activeSessionIds.add(sessionId);
    pendingSessionIds.push(sessionId);
    void processQueue();
    return true;
  };

  const drain = (): Promise<void> => {
    if (!processing && pendingSessionIds.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolvePromise) => {
      drainWaiters.add(resolvePromise);
    });
  };

  const size = (): number => pendingSessionIds.length;

  return { enqueue, drain, size };
}
