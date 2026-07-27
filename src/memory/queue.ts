import {
  isSuitOwnSession,
  spawnAgentRunner,
} from "../missions/runner.ts";
import type { Store } from "../store/store.ts";
import {
  buildExtractionInput,
  extractMemories,
  storeCandidates,
} from "./extract.ts";
import type { ExtractDeps } from "./extract.ts";
import {
  readPromotionConfig,
  shouldAutoPromote,
} from "./promote.ts";
import type { PromotionConfig } from "./promote.ts";
import type { MemoryStore } from "./store.ts";

export interface MemoryQueueOptions {
  dataDir: string;
  store: Store;
  memoryStore: MemoryStore;
  deps?: ExtractDeps;
  promotionConfig?: PromotionConfig;
  configPath?: string;
  onError?: (sessionId: string, error: unknown) => void;
}

export interface MemoryQueue {
  enqueue(sessionId: string): boolean;
  drain(): Promise<void>;
  size(): number;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createMemoryQueue(
  options: MemoryQueueOptions,
): MemoryQueue {
  const pendingSessionIds: string[] = [];
  const activeSessionIds = new Set<string>();
  const spawnedSessionIds = new Set<string>();
  const drainWaiters = new Set<() => void>();
  const deps = options.deps ?? {
    runModel: spawnAgentRunner({ dataDir: options.dataDir }),
  };
  let processing = false;

  const reportError = (sessionId: string, error: unknown): void => {
    const contextualError = new Error(
      `Memory extraction queue failed for session "${sessionId}": ${
        errorMessage(error)
      }`,
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
          `Memory extraction queue error handler failed for session "${sessionId}": ${
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

  const runJob = async (sessionId: string): Promise<void> => {
    try {
      spawnedSessionIds.add(sessionId);
      const input = buildExtractionInput(options.store, sessionId);
      let extractionFailure: string | undefined;
      const candidates = await extractMemories(
        {
          runModel: deps.runModel,
          onFailure: (reason: string): void => {
            extractionFailure = reason;
            try {
              deps.onFailure?.(reason);
            } catch {
              // The queue reports the extraction failure through onError below.
            }
          },
        },
        input,
      );
      if (extractionFailure !== undefined) {
        throw new Error(extractionFailure);
      }

      const stored = storeCandidates(candidates, {
        memoryStore: options.memoryStore,
        sessionId,
        repo: input.repo,
      });
      const promotionConfig = options.promotionConfig
        ?? readPromotionConfig(options.configPath);
      for (const candidate of stored.stored) {
        if (shouldAutoPromote(candidate, promotionConfig)) {
          options.memoryStore.approve(candidate.id);
        }
      }
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
      activeSessionIds.has(sessionId)
      || spawnedSessionIds.has(sessionId)
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
