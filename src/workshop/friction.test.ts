import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventInput } from "../schema/events.ts";
import { deterministicEventId } from "../schema/ids.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import {
  analyzeFriction,
  normalizeSignature,
  type FrictionAnalysis,
} from "./friction.ts";

interface SeedEvent {
  type: EventInput["type"];
  payload?: Record<string, unknown>;
}

interface SeedSessionOptions {
  sessionId: string;
  startedAt?: string;
  agent?: string;
  repo?: string;
  events?: SeedEvent[];
}

const stores: Store[] = [];
const tempDirectories: string[] = [];

function trackedStore(): Store {
  const store = openStore(":memory:");
  stores.push(store);
  return store;
}

function makeEvent(
  sessionId: string,
  type: EventInput["type"],
  index: number,
  payload: Record<string, unknown> = {},
  startedAt = "2026-01-01T00:00:00.000Z",
): EventInput {
  const startedMilliseconds = Date.parse(startedAt);
  if (Number.isNaN(startedMilliseconds)) {
    throw new Error(`invalid fixture start timestamp: ${startedAt}`);
  }
  const ts = new Date(startedMilliseconds + index * 1_000).toISOString();
  const rawRef = `${sessionId}.jsonl#${index}`;
  return {
    id: deterministicEventId({
      ts,
      sessionId,
      rawRef,
      type,
    }),
    ts,
    type,
    session_id: sessionId,
    vendor: "codex",
    adapter_version: "0.1.0",
    raw_ref: rawRef,
    payload,
  } as EventInput;
}

function seedSession(store: Store, options: SeedSessionOptions): EventInput[] {
  const startPayload: Record<string, unknown> = {};
  if (options.agent !== undefined) {
    startPayload.agent = options.agent;
  }
  if (options.repo !== undefined) {
    startPayload.repo = options.repo;
  }
  const specs: SeedEvent[] = [
    { type: "session_start", payload: startPayload },
    ...(options.events ?? []),
  ];
  const events = specs.map((event, index): EventInput =>
    makeEvent(
      options.sessionId,
      event.type,
      index,
      event.payload,
      options.startedAt,
    )
  );
  const inserted = store.append(events);
  if (inserted !== events.length) {
    throw new Error(
      `fixture inserted ${inserted} of ${events.length} events for ${options.sessionId}`,
    );
  }
  return events;
}

function only<T>(items: T[]): T {
  expect(items).toHaveLength(1);
  const item = items[0];
  if (item === undefined) {
    throw new Error("expected exactly one item");
  }
  return item;
}

function clusterOf(
  analysis: FrictionAnalysis,
  kind: FrictionAnalysis["allClusters"][number]["kind"],
  signature: string,
): FrictionAnalysis["allClusters"][number] {
  const cluster = analysis.allClusters.find(
    (candidate): boolean =>
      candidate.kind === kind && candidate.signature === signature,
  );
  if (cluster === undefined) {
    throw new Error(`missing ${kind} cluster ${signature}`);
  }
  return cluster;
}

afterEach(async (): Promise<void> => {
  for (const store of stores.splice(0).reverse()) {
    store.close();
  }
  for (const directory of tempDirectories.splice(0).reverse()) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("normalizeSignature", (): void => {
  test("reduces plain, quoted, and located absolute paths to basenames", (): void => {
    expect(normalizeSignature("Read /Users/dan/dev/HyperAgent/src/index.ts")).toBe(
      "read index.ts",
    );
    expect(
      normalizeSignature('Read "/Users/dan/My Project/src/index.ts"'),
    ).toBe('read "index.ts"');
    expect(
      normalizeSignature("Failed at /opt/build/HyperAgent/src/index.ts:84:19"),
    ).toBe("failed at index.ts:<line>");
  });

  test("replaces ISO-8601 timestamps and clock times", (): void => {
    expect(
      normalizeSignature(
        "Started 2026-07-27T14:15:16.123Z and stopped at 18:19:20",
      ),
    ).toBe("started <ts> and stopped at <ts>");
  });

  test("replaces hexadecimal runs of at least eight characters", (): void => {
    expect(normalizeSignature("commit deadbeef failed after abc123")).toBe(
      "commit <hash> failed after abc123",
    );
  });

  test("replaces a UUID before the generic hexadecimal rule can consume it", (): void => {
    expect(
      normalizeSignature(
        "Request 123e4567-e89b-12d3-a456-426614174000 failed",
      ),
    ).toBe("request <uuid> failed");
  });

  test("replaces spaced and equals-delimited process ids", (): void => {
    expect(normalizeSignature("worker pid 1234 stopped; PID=5678 hung")).toBe(
      "worker <pid> stopped; <pid> hung",
    );
  });

  test("replaces trailing line-column and line locations", (): void => {
    expect(
      normalizeSignature("index.ts:83:19 and README.md:42, failed"),
    ).toBe("index.ts:<line> and readme.md:<line>, failed");
  });

  test("replaces all standalone integer runs, including single digits", (): void => {
    expect(normalizeSignature("attempt 12 of 345, x9 and v1")).toBe(
      "attempt <n> of <n>, x9 and v1",
    );
    // Regression for the live-probe fragmentation defect: v6.24.0 and v6.3.0
    // must produce the same signature.
    expect(normalizeSignature("re-read v6.24.0.md")).toBe(
      normalizeSignature("re-read v6.3.0.md"),
    );
  });

  test("collapses whitespace, trims, and lowercases", (): void => {
    expect(normalizeSignature("  Build\tFAILED \n In   Worker  ")).toBe(
      "build failed in worker",
    );
  });

  test("is idempotent", (): void => {
    const raw =
      " PID=4512 failed /Users/dan/dev/src/index.ts:98 at 2026-07-27T10:11:12.000Z deadbeef ";
    const normalized = normalizeSignature(raw);
    expect(normalizeSignature(normalized)).toBe(normalized);
  });
});

describe("analyzeFriction", (): void => {
  test("clusters real-world variants into one identical normalized signature", (): void => {
    const store = trackedStore();
    const firstRaw =
      "Build failed at /Users/dan/dev/HyperAgent/src/workshop/friction.ts:42 at 2026-07-27T10:11:12.000Z commit deadbeef";
    const secondRaw =
      "Build failed at /opt/ci/checkout/src/workshop/friction.ts:987 at 2026-07-28T20:21:22.555Z commit cafebabe";
    seedSession(store, {
      sessionId: "headline-a",
      events: [{ type: "error", payload: { message_summary: firstRaw } }],
    });
    seedSession(store, {
      sessionId: "headline-b",
      startedAt: "2026-01-02T00:00:00.000Z",
      events: [{ type: "error", payload: { message_summary: secondRaw } }],
    });

    expect(normalizeSignature(firstRaw)).toBe(normalizeSignature(secondRaw));
    const analysis = analyzeFriction(store);
    const errorClusters = analysis.clusters.filter(
      (cluster): boolean => cluster.kind === "error",
    );

    expect(errorClusters).toHaveLength(1);
    expect(only(errorClusters).count).toBe(2);
    expect(only(errorClusters).sessionIds).toEqual(["headline-a", "headline-b"]);
  });

  test("emits every supported friction kind from valid event envelopes", (): void => {
    const store = trackedStore();
    const sessionId = "all-kinds-a";
    const start = makeEvent(sessionId, "session_start", 0, {
      repo: "/workspace/hyperagent",
      agent: "forge",
    });
    const error = makeEvent(sessionId, "error", 1, {
      message_summary: "Compiler crashed in /workspace/src/compiler.ts:72",
      code: "E_COMPILE",
    });
    const retry = makeEvent(sessionId, "retry", 2, {
      of_event_id: error.id,
      attempt: 2,
    });
    const gate = makeEvent(sessionId, "verification_event", 3, {
      kind: "gate",
      result: "fail",
      command_summary: "release policy gate",
      stats: {
        outcome_kind: "gate_gave_up",
        failed_check_ids: ["contract-api"],
        matched_rule_ids: ["policy-no-secrets"],
      },
    });
    const read = makeEvent(sessionId, "tool_call", 4, {
      name: "read_file",
      files_touched: ["/workspace/src/config.ts"],
    });
    expect(store.append([start, error, retry, gate, read])).toBe(5);
    seedSession(store, {
      sessionId: "all-kinds-b",
      startedAt: "2026-01-02T00:00:00.000Z",
      events: [{
        type: "tool_call",
        payload: {
          name: "view",
          files_touched: ["/different/checkout/src/config.ts"],
        },
      }],
    });

    const analysis = analyzeFriction(store, { minSessions: 1 });
    const kinds = [...new Set(analysis.signals.map((signal) => signal.kind))].sort();

    expect(kinds).toEqual([
      "bounce_loop",
      "contract_check_failed",
      "error",
      "gate_block",
      "low_score",
      "policy_violation",
      "repeated_rediscovery",
      "retry",
    ]);
  });

  test("keeps one-session signatures in allClusters until minSessions is one", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "one-session",
      events: [{
        type: "error",
        payload: { message_summary: "isolated compiler failure" },
      }],
    });

    const defaultAnalysis = analyzeFriction(store);
    const inclusiveAnalysis = analyzeFriction(store, { minSessions: 1 });

    expect(defaultAnalysis.allClusters).toHaveLength(1);
    expect(defaultAnalysis.clusters).toEqual([]);
    expect(inclusiveAnalysis.allClusters).toHaveLength(1);
    expect(inclusiveAnalysis.clusters).toEqual(inclusiveAnalysis.allClusters);
  });

  test("excludes suit-owned sessions and reports their ids", async (): Promise<void> => {
    const store = trackedStore();
    const dataDir = await mkdtemp(join(tmpdir(), "hyperagent-friction-"));
    tempDirectories.push(dataDir);
    seedSession(store, {
      sessionId: "suit-owned",
      repo: join(dataDir, "workshop"),
      events: [{
        type: "error",
        payload: { message_summary: "internal suit failure" },
      }],
    });
    seedSession(store, {
      sessionId: "user-session",
      startedAt: "2026-01-02T00:00:00.000Z",
      repo: "/workspace/user-project",
      events: [{
        type: "error",
        payload: { message_summary: "user project failure" },
      }],
    });

    const analysis = analyzeFriction(store, { dataDir, minSessions: 1 });

    expect(analysis.excludedSessionIds).toEqual(["suit-owned"]);
    expect(analysis.signals.map((signal) => signal.sessionId)).toEqual([
      "user-session",
    ]);
  });

  test("clusters carry distinct sorted session and event evidence", (): void => {
    const store = trackedStore();
    const first = seedSession(store, {
      sessionId: "evidence-b",
      startedAt: "2026-01-02T00:00:00.000Z",
      events: [
        { type: "error", payload: { message_summary: "shared failure" } },
        { type: "error", payload: { message_summary: "shared failure" } },
      ],
    });
    const second = seedSession(store, {
      sessionId: "evidence-a",
      events: [{
        type: "error",
        payload: { message_summary: "shared failure" },
      }],
    });
    const expectedEventIds = [...first.slice(1), ...second.slice(1)]
      .map((event) => event.id)
      .sort();

    const cluster = clusterOf(
      analyzeFriction(store),
      "error",
      "shared failure",
    );

    expect(cluster.count).toBe(3);
    expect(cluster.sessionIds).toEqual(["evidence-a", "evidence-b"]);
    expect(cluster.eventIds).toEqual(expectedEventIds);
  });

  test("is deterministic across repeated analysis runs", (): void => {
    const store = trackedStore();
    for (const [index, sessionId] of ["deterministic-b", "deterministic-a"].entries()) {
      seedSession(store, {
        sessionId,
        startedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
        repo: "/workspace/repo",
        events: [{
          type: "error",
          payload: { message_summary: "deterministic failure" },
        }],
      });
    }

    const first = analyzeFriction(store);
    const second = analyzeFriction(store);

    expect(second).toEqual(first);
  });

  test("reports hand-computed fragmentation counts", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "fragment-a",
      events: [
        { type: "error", payload: { message_summary: "alpha" } },
        { type: "error", payload: { message_summary: "alpha" } },
        { type: "error", payload: { message_summary: "beta" } },
      ],
    });
    seedSession(store, {
      sessionId: "fragment-b",
      startedAt: "2026-01-02T00:00:00.000Z",
      events: [{ type: "error", payload: { message_summary: "beta" } }],
    });
    seedSession(store, {
      sessionId: "fragment-c",
      startedAt: "2026-01-03T00:00:00.000Z",
      events: [{ type: "error", payload: { message_summary: "gamma" } }],
    });

    expect(analyzeFriction(store).fragmentation).toEqual({
      totalSignals: 5,
      totalSignatures: 3,
      singletonSignatures: 1,
      singleSessionSignatures: 2,
      forwardedClusters: 1,
      distribution: [
        { sessionSpan: 1, signatureCount: 2 },
        { sessionSpan: 2, signatureCount: 1 },
      ],
    });
  });

  test("requires two distinct sessions for repeated rediscovery", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "reader-a",
      events: [
        {
          type: "tool_call",
          payload: { name: "read", files_touched: ["/repo/src/config.ts"] },
        },
        {
          type: "tool_call",
          payload: { name: "inspect", files_touched: ["/repo/src/config.ts"] },
        },
      ],
    });

    expect(
      analyzeFriction(store, { minSessions: 1 }).signals.filter(
        (signal) => signal.kind === "repeated_rediscovery",
      ),
    ).toEqual([]);

    seedSession(store, {
      sessionId: "reader-b",
      startedAt: "2026-01-02T00:00:00.000Z",
      events: [{
        type: "tool_call",
        payload: { name: "view", files_touched: ["/checkout/src/config.ts"] },
      }],
    });
    const rediscovery = analyzeFriction(store).signals.filter(
      (signal) => signal.kind === "repeated_rediscovery",
    );

    expect(rediscovery).toHaveLength(3);
    expect(new Set(rediscovery.map((signal) => signal.sessionId))).toEqual(
      new Set(["reader-a", "reader-b"]),
    );
    expect(only(
      analyzeFriction(store).clusters.filter(
        (cluster) => cluster.kind === "repeated_rediscovery",
      ),
    ).count).toBe(3);
  });

  test("degrades malformed optional payloads into diagnostics without throwing", (): void => {
    const store = trackedStore();
    const sessionId = "malformed";
    const start = makeEvent(sessionId, "session_start", 0, {
      repo: 17,
      agent: ["forge"],
    });
    const error = makeEvent(sessionId, "error", 1, {
      message_summary: 99,
    });
    const retry = makeEvent(sessionId, "retry", 2, {
      of_event_id: 42,
    });
    const gate = makeEvent(sessionId, "verification_event", 3, {
      kind: "gate",
      result: "unknown",
      stats: "not-an-object",
      command_summary: 88,
    });
    const read = makeEvent(sessionId, "tool_call", 4, {
      name: "read",
      files_touched: [123, "/repo/src/valid.ts"],
      input_summary: false,
    });
    expect(store.append([start, error, retry, gate, read])).toBe(5);

    const analysis = analyzeFriction(store, { minSessions: 1 });

    expect(analysis.diagnostics).toEqual(expect.arrayContaining([
      `event ${start.id}.repo must be a string when present`,
      `event ${start.id}.agent must be a string when present`,
      `error event ${error.id}.message_summary must be a string when present`,
      `error event ${error.id} has no message_summary, message_digest, or code`,
      `retry event ${retry.id}.of_event_id must be a string when present`,
      `retry event ${retry.id} has no of_event_id`,
      `gate verification event ${gate.id}.stats must be an object`,
      `gate verification event ${gate.id}.result is missing or invalid`,
      `tool_call event ${read.id}.files_touched[0] must be a string`,
      `tool_call event ${read.id}.input_summary must be a string when present`,
    ]));
    expect(analysis.signals.some((signal) => signal.kind === "retry")).toBe(true);
  });

  test("rejects invalid analysis options with clear messages", (): void => {
    const store = trackedStore();

    expect(() => analyzeFriction(store, { limit: -1 })).toThrow(
      "friction limit must be a non-negative safe integer",
    );
    expect(() => analyzeFriction(store, { minSessions: 0 })).toThrow(
      "friction minSessions must be a positive safe integer",
    );
    expect(() => analyzeFriction(store, { lowScoreThreshold: 101 })).toThrow(
      "friction lowScoreThreshold must be between 0 and 100",
    );
    expect(() => analyzeFriction(store, { since: "not-a-date" })).toThrow(
      "friction since must be a valid ISO timestamp",
    );
    expect(() =>
      analyzeFriction(store, {
        sessionIds: "not-an-array" as unknown as string[],
      })
    ).toThrow("friction sessionIds must be an array");
    expect(() =>
      analyzeFriction(store, {
        sessionIds: ["valid", ""],
      })
    ).toThrow("friction sessionIds[1] must be a non-empty string");
  });
});
