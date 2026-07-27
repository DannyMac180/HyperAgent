import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore, type Store } from "../store/store";
import { openWorkshopQueue } from "./queue";
import {
  acquireWorkshopRunGuard,
  runWorkshop,
  type WorkshopRunOptions,
} from "./run";

const temporaryDirectories: string[] = [];

async function temporaryDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hyperagent-workshop-run-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fixedClock(iso: string): () => Date {
  return (): Date => new Date(iso);
}

function emptyStore(): Store {
  return openStore(":memory:");
}

function frictionStore(): Store {
  const store = emptyStore();
  let eventIndex = 0;
  // Crockford base32, the ULID alphabet: I, L, O, and U are excluded, so a
  // plain A..Z walk produces ids the store rejects.
  const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const eventId = (): string => {
    const suffix = ULID_ALPHABET[eventIndex % ULID_ALPHABET.length] ?? "0";
    eventIndex += 1;
    return `01ARZ3NDEKTSV4RRFFQ69G5FA${suffix}`;
  };
  for (const sessionId of ["session-one", "session-two"]) {
    store.append([
      {
        id: eventId(),
        ts: "2026-07-27T10:00:00.000Z",
        type: "session_start",
        session_id: sessionId,
        vendor: "test",
        adapter_version: "1.0.0",
        schema_version: "1.0.0",
        payload: { repo: "/repo", agent: "test" },
      },
      {
        id: eventId(),
        ts: "2026-07-27T10:00:01.000Z",
        type: "error",
        session_id: sessionId,
        vendor: "test",
        adapter_version: "1.0.0",
        schema_version: "1.0.0",
        payload: { message_summary: "permission denied while writing cache" },
      },
    ]);
  }
  // Passing sessions in the same repo. Replay refuses to pass any eval that has
  // no negative control, so a store of failures alone can only ever hold
  // proposals at draft.
  for (const sessionId of ["control-one", "control-two"]) {
    store.append([
      {
        id: eventId(),
        ts: "2026-07-27T09:00:00.000Z",
        type: "session_start",
        session_id: sessionId,
        vendor: "test",
        adapter_version: "1.0.0",
        schema_version: "1.0.0",
        payload: { repo: "/repo", agent: "test" },
      },
      {
        id: eventId(),
        ts: "2026-07-27T09:00:01.000Z",
        type: "verification_event",
        session_id: sessionId,
        vendor: "test",
        adapter_version: "1.0.0",
        schema_version: "1.0.0",
        payload: { kind: "test", result: "pass" },
      },
      {
        id: eventId(),
        ts: "2026-07-27T09:00:02.000Z",
        type: "session_end",
        session_id: sessionId,
        vendor: "test",
        adapter_version: "1.0.0",
        schema_version: "1.0.0",
        payload: { outcome: "completed" },
      },
    ]);
  }
  return store;
}

function proposalResponse(predicate: Record<string, unknown>): string {
  return JSON.stringify([
    {
      type: "verification_check",
      durability: "measurement",
      title: "Detect cache permission failures",
      rationale: "Detects the repeated cache permission failure in both stored sessions.",
      body: {
        type: "verification_check",
        description: "Detect cache permission failures in session events.",
        predicate,
      },
    },
  ]);
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      async (directory): Promise<void> => rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("runWorkshop", (): void => {
  test("cluster-only is read-only and needs neither proposer nor queue", async (): Promise<void> => {
    const dataDir = await temporaryDataDir();
    const store = emptyStore();
    try {
      const options: WorkshopRunOptions = {
        dataDir,
        until: "cluster",
        now: fixedClock("2026-07-27T12:00:00.000Z"),
      };
      const withoutPropose = await runWorkshop({ store }, options);
      const withExplodingPropose = await runWorkshop({
        store,
        propose: {
          runAgent: async (): Promise<string> => {
            throw new Error("runner must not be spawned");
          },
        },
      }, options);

      expect(withoutPropose.status).toBe("completed");
      expect(withExplodingPropose.status).toBe("completed");
      expect(withoutPropose.stagesRun).toEqual(["cluster"]);
      expect(existsSync(join(dataDir, "workshop", "queue.db"))).toBe(false);
      expect(
        (await readdir(join(dataDir, "workshop"))).filter(
          (entry): boolean => entry !== "runs.jsonl",
        ),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("full run drafts, evaluates, and promotes passing proposals", async (): Promise<void> => {
    const dataDir = await temporaryDataDir();
    const store = frictionStore();
    try {
      const result = await runWorkshop({
        store,
        propose: {
          runAgent: async (): Promise<string> => proposalResponse({
            type: "event_absent",
            eventType: "error",
            payloadMatch: {
              message_summary: "permission denied while writing cache",
            },
          }),
        },
      }, { dataDir, minSessions: 2 });
      const queue = openWorkshopQueue({
        dataDir,
        dbPath: join(dataDir, "workshop", "queue.db"),
      });
      try {
        expect(result.status).toBe("completed");
        expect(result.stagesRun).toEqual(["cluster", "propose", "eval", "queue"]);
        expect(result.proposalsDrafted).toBe(1);
        expect(result.proposalsPending).toBe(1);
        expect(queue.list({ status: "pending" })).toHaveLength(1);
      } finally {
        queue.close();
      }
    } finally {
      store.close();
    }
  });

  test("eval-failing proposals remain draft", async (): Promise<void> => {
    const dataDir = await temporaryDataDir();
    const store = frictionStore();
    try {
      const result = await runWorkshop({
        store,
        propose: {
          runAgent: async (): Promise<string> => proposalResponse({
            type: "event_present",
            eventType: "error",
            payloadMatch: {
              message_summary: "permission denied while writing cache",
            },
          }),
        },
      }, { dataDir, minSessions: 2 });
      const queue = openWorkshopQueue({
        dataDir,
        dbPath: join(dataDir, "workshop", "queue.db"),
      });
      try {
        expect(result.status).toBe("completed");
        expect(result.proposalsHeldAtDraft).toBe(1);
        expect(result.proposalsPending).toBe(0);
        expect(queue.list({ status: "draft" })).toHaveLength(1);
        expect(queue.list({ status: "pending" })).toHaveLength(0);
      } finally {
        queue.close();
      }
    } finally {
      store.close();
    }
  });

  test("full run never yields approved or installed and stays inside workshop", async (): Promise<void> => {
    const sandbox = await temporaryDataDir();
    const dataDir = join(sandbox, "data");
    await mkdir(dataDir);
    const store = frictionStore();
    try {
      const result = await runWorkshop({
        store,
        propose: {
          runAgent: async (): Promise<string> => proposalResponse({
            type: "event_absent",
            eventType: "error",
            payloadMatch: {
              message_summary: "permission denied while writing cache",
            },
          }),
        },
      }, { dataDir, minSessions: 2 });
      const queue = openWorkshopQueue({
        dataDir,
        dbPath: join(dataDir, "workshop", "queue.db"),
      });
      try {
        expect(result.status).toBe("completed");
        expect(queue.list({ status: "approved" })).toHaveLength(0);
        expect(queue.list({ status: "installed" })).toHaveLength(0);
        expect(await readdir(dataDir)).toEqual(["workshop"]);
        expect(await readdir(sandbox)).toEqual(["data"]);
      } finally {
        queue.close();
      }
    } finally {
      store.close();
    }
  });

  test("ledger records started and completed with an injected clock", async (): Promise<void> => {
    const dataDir = await temporaryDataDir();
    const store = frictionStore();
    try {
      const result = await runWorkshop({ store }, {
        dataDir,
        until: "cluster",
        now: fixedClock("2026-07-27T12:34:56.000Z"),
      });
      const lines = (await readFile(join(dataDir, "workshop", "runs.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line));

      expect(result.startedAt).toBe("2026-07-27T12:34:56.000Z");
      expect(result.completedAt).toBe("2026-07-27T12:34:56.000Z");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ status: "started" });
      expect(lines[1]).toMatchObject({ status: "completed" });
    } finally {
      store.close();
    }
  });

  test("an agent runner failure degrades to a diagnostic, not a failed run", async (): Promise<void> => {
    const dataDir = await temporaryDataDir();
    const store = frictionStore();
    try {
      const result = await runWorkshop({
        store,
        propose: {
          runAgent: async (): Promise<string> => {
            throw new Error("cli exploded");
          },
        },
      }, { dataDir, minSessions: 2 });

      // proposeForCluster deliberately absorbs runner failures so one broken
      // cluster cannot abort the whole nightly run.
      expect(result.status).toBe("completed");
      expect(result.proposalsDrafted).toBe(0);
      expect(result.diagnostics.join("\n")).toContain("cli exploded");
      expect(existsSync(join(dataDir, "workshop", "run.lock"))).toBe(false);
    } finally {
      store.close();
    }
  });

  test("a failing stage writes failed terminal ledger and releases lock", async (): Promise<void> => {
    const dataDir = await temporaryDataDir();
    const store = frictionStore();
    try {
      // A store whose reads throw fails the cluster stage outright, which is a
      // genuine stage exception rather than a per-cluster degradation.
      const explodingStore = {
        ...store,
        getSessions: (): never => {
          throw new Error("stage exploded");
        },
      } as unknown as Store;
      const result = await runWorkshop({
        store: explodingStore,
        propose: {
          runAgent: async (): Promise<string> => "[]",
        },
      }, { dataDir, minSessions: 2 });
      const ledger = await readFile(join(dataDir, "workshop", "runs.jsonl"), "utf8");

      expect(result.status).toBe("failed");
      expect(result.error).toContain("stage exploded");
      expect(ledger).toContain('"status":"failed"');
      expect(existsSync(join(dataDir, "workshop", "run.lock"))).toBe(false);
    } finally {
      store.close();
    }
  });

  test("a concurrent run returns already running without invoking pipeline", async (): Promise<void> => {
    const dataDir = await temporaryDataDir();
    const guard = await acquireWorkshopRunGuard({ dataDir });
    const store = emptyStore();
    let runnerCalls = 0;
    try {
      const result = await runWorkshop({
        store,
        propose: {
          runAgent: async (): Promise<string> => {
            runnerCalls += 1;
            return "{}";
          },
        },
      }, { dataDir });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("already running");
      expect(result.stagesRun).toEqual([]);
      expect(runnerCalls).toBe(0);
    } finally {
      await guard.release();
      store.close();
    }
  });

  test("a stale lock is reclaimed with a diagnostic", async (): Promise<void> => {
    const dataDir = await temporaryDataDir();
    const workshopDir = join(dataDir, "workshop");
    await mkdir(workshopDir, { recursive: true });
    await writeFile(
      join(workshopDir, "run.lock"),
      JSON.stringify({ pid: 2_147_483_647, startedAt: "2000-01-01T00:00:00.000Z" }),
    );
    const guard = await acquireWorkshopRunGuard({
      dataDir,
      now: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    try {
      expect(guard.acquired).toBe(true);
      expect(guard.diagnostics.join("\n")).toContain("reclaimed stale");
    } finally {
      await guard.release();
    }
  });

  test("an externally supplied queue is not closed", async (): Promise<void> => {
    const dataDir = await temporaryDataDir();
    const store = emptyStore();
    const queue = openWorkshopQueue({
      dataDir,
      dbPath: join(dataDir, "workshop", "queue.db"),
    });
    try {
      const result = await runWorkshop({
        store,
        queue,
        propose: { runAgent: async (): Promise<string> => "[]" },
      }, { dataDir });
      expect(result.status).toBe("completed");
      expect(queue.list()).toEqual([]);
    } finally {
      queue.close();
      store.close();
    }
  });
});
