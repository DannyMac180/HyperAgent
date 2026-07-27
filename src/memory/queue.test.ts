import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventInput } from "../schema/events.ts";
import { deterministicEventId } from "../schema/ids.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import { createMemoryQueue } from "./queue.ts";
import { openMemoryStore } from "./store.ts";
import type { MemoryStore } from "./store.ts";

function seedSession(
  store: Store,
  sessionId: string,
  payload: Record<string, unknown>,
): void {
  const ts = "2026-01-01T00:00:00.000Z";
  const rawRef = `${sessionId}.jsonl#0`;
  const event: EventInput = {
    id: deterministicEventId({
      ts,
      sessionId,
      rawRef,
      type: "session_start",
    }),
    ts,
    type: "session_start",
    session_id: sessionId,
    vendor: "claude-code",
    adapter_version: "0.1.0",
    raw_ref: rawRef,
    payload,
  };
  expect(store.append(event)).toBe(1);
}

function openTestMemoryStore(directory: string): MemoryStore {
  return openMemoryStore({
    dbPath: join(directory, "memory.db"),
    memoryDir: join(directory, "memory"),
  });
}

describe("memory extraction queue", (): void => {
  test("rejects suit-owned sessions before invoking the model", async (): Promise<void> => {
    const directory = mkdtempSync(join(tmpdir(), "hyperagent-memory-queue-"));
    const eventStore = openStore(join(directory, "events.db"));
    const memoryStore = openTestMemoryStore(directory);
    let modelCalled = false;
    try {
      const sessionId = "claude-code:suit-owned-memory";
      seedSession(eventStore, sessionId, {
        cwd: join(directory, "modelruns"),
      });
      const queue = createMemoryQueue({
        dataDir: directory,
        store: eventStore,
        memoryStore,
        deps: {
          runModel: async (): Promise<string> => {
            modelCalled = true;
            return "[]";
          },
        },
      });

      expect(queue.enqueue(sessionId)).toBe(false);
      await queue.drain();
      expect(modelCalled).toBe(false);
      expect(memoryStore.listMemories()).toEqual([]);
    } finally {
      memoryStore.close();
      eventStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("contains extraction failures and leaves the memory store untouched", async (): Promise<void> => {
    const directory = mkdtempSync(join(tmpdir(), "hyperagent-memory-queue-"));
    const repoDirectory = mkdtempSync(join(tmpdir(), "hyperagent-memory-repo-"));
    const eventStore = openStore(join(directory, "events.db"));
    const memoryStore = openTestMemoryStore(directory);
    const errors: Array<{ sessionId: string; error: unknown }> = [];
    try {
      const sessionId = "claude-code:failing-memory";
      seedSession(eventStore, sessionId, { repo: repoDirectory });
      const queue = createMemoryQueue({
        dataDir: directory,
        store: eventStore,
        memoryStore,
        deps: {
          runModel: async (): Promise<string> => {
            throw new Error("fixture extraction failure");
          },
        },
        onError: (failedSessionId: string, error: unknown): void => {
          errors.push({ sessionId: failedSessionId, error });
        },
      });

      expect(queue.enqueue(sessionId)).toBe(true);
      await queue.drain();

      expect(errors).toHaveLength(1);
      expect(errors[0]?.sessionId).toBe(sessionId);
      expect(String(errors[0]?.error)).toContain("fixture extraction failure");
      expect(memoryStore.listMemories()).toEqual([]);
    } finally {
      memoryStore.close();
      eventStore.close();
      rmSync(directory, { recursive: true, force: true });
      rmSync(repoDirectory, { recursive: true, force: true });
    }
  });
});
