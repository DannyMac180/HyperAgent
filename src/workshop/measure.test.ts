import { afterEach, describe, expect, test } from "bun:test";

import type { EventInput } from "../schema/events.ts";
import { deterministicEventId } from "../schema/ids.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import type { WorkshopProposalRow } from "./queue.ts";
import {
  DEFAULT_MIN_SESSIONS_PER_SIDE,
  MEAN_SCORE_EPSILON,
  measureInstalled,
  measureProposal,
} from "./measure.ts";

interface ProposalOptions {
  id?: string;
  installedAt?: string | null;
  repo?: string | null;
  agent?: string | null;
}

interface RatedSessionOptions {
  sessionId: string;
  startedAt: string;
  passed: number;
  failed: number;
  repo?: string;
  agent?: string;
}

const stores: Store[] = [];

function trackedStore(): Store {
  const store = openStore(":memory:");
  stores.push(store);
  return store;
}

function proposal(options: ProposalOptions = {}): WorkshopProposalRow {
  return {
    id: options.id ?? "proposal-a",
    type: "verification_check",
    durability: "measurement",
    title: "Measure capability",
    rationale: "Measure before and after installation",
    body: {},
    evidence: {},
    holdout: [],
    contentHash: "a".repeat(64),
    eval: null,
    status: options.installedAt === null ? "approved" : "installed",
    repo: options.repo ?? null,
    agent: options.agent ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-10T00:00:00.000Z",
    installedAt: options.installedAt === undefined
      ? "2026-01-10T00:00:00.000Z"
      : options.installedAt,
    receipt: null,
  } as unknown as WorkshopProposalRow;
}

function makeEvent(
  sessionId: string,
  type: EventInput["type"],
  index: number,
  startedAt: string,
  payload: Record<string, unknown>,
): EventInput {
  const startedMilliseconds = Date.parse(startedAt);
  if (Number.isNaN(startedMilliseconds)) {
    throw new Error(`invalid fixture timestamp ${startedAt}`);
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

function seedRatedSession(
  store: Store,
  options: RatedSessionOptions,
): void {
  const startPayload: Record<string, unknown> = {};
  if (options.repo !== undefined) {
    startPayload.repo = options.repo;
  }
  if (options.agent !== undefined) {
    startPayload.agent = options.agent;
  }
  const events: EventInput[] = [
    makeEvent(
      options.sessionId,
      "session_start",
      0,
      options.startedAt,
      startPayload,
    ),
  ];
  const results = [
    ...Array.from({ length: options.passed }, (): "pass" => "pass"),
    ...Array.from({ length: options.failed }, (): "fail" => "fail"),
  ];
  for (const [index, result] of results.entries()) {
    events.push(
      makeEvent(
        options.sessionId,
        "verification_event",
        index + 1,
        options.startedAt,
        {
          kind: "gate",
          result,
          command_summary: `measurement fixture ${index + 1}`,
        },
      ),
    );
  }
  expect(store.append(events)).toBe(events.length);
}

function seedMany(
  store: Store,
  prefix: string,
  count: number,
  startedAt: string,
  passed: number,
  failed: number,
  repo?: string,
): void {
  const baseMilliseconds = Date.parse(startedAt);
  if (Number.isNaN(baseMilliseconds)) {
    throw new Error(`invalid fixture timestamp ${startedAt}`);
  }
  for (let index = 0; index < count; index += 1) {
    seedRatedSession(store, {
      sessionId: `${prefix}-${index}`,
      startedAt: new Date(baseMilliseconds + index * 60_000).toISOString(),
      passed,
      failed,
      repo,
    });
  }
}

afterEach((): void => {
  for (const store of stores.splice(0).reverse()) {
    store.close();
  }
});

describe("measureProposal", (): void => {
  test("returns insufficient data without a fabricated delta when not installed", (): void => {
    const result = measureProposal(
      trackedStore(),
      proposal({ installedAt: null }),
    );

    expect(result.status).toBe("insufficient_data");
    expect(result.delta).toBeNull();
    expect(result.reason).toContain("not installed");
  });

  test("names a shortage on the before side", (): void => {
    const store = trackedStore();
    seedMany(store, "before", 4, "2026-01-01T00:00:00.000Z", 1, 0);
    seedMany(store, "after", 5, "2026-01-11T00:00:00.000Z", 1, 0);

    const result = measureProposal(store, proposal());

    expect(result.status).toBe("insufficient_data");
    expect(result.delta).toBeNull();
    expect(result.reason).toContain("before side is short by 1 session");
  });

  test("names a shortage on the after side", (): void => {
    const store = trackedStore();
    seedMany(store, "before", 5, "2026-01-01T00:00:00.000Z", 1, 0);
    seedMany(store, "after", 4, "2026-01-11T00:00:00.000Z", 1, 0);

    const result = measureProposal(store, proposal());

    expect(result.status).toBe("insufficient_data");
    expect(result.delta).toBeNull();
    expect(result.reason).toContain("after side is short by 1 session");
  });

  test("measures when both sides are exactly at the inclusive minimum", (): void => {
    const store = trackedStore();
    seedMany(
      store,
      "before",
      DEFAULT_MIN_SESSIONS_PER_SIDE,
      "2026-01-01T00:00:00.000Z",
      1,
      0,
    );
    seedMany(
      store,
      "after",
      DEFAULT_MIN_SESSIONS_PER_SIDE,
      "2026-01-11T00:00:00.000Z",
      1,
      0,
    );

    const result = measureProposal(store, proposal());

    expect(result.status).toBe("no_movement");
    expect(result.before.sessionCount).toBe(DEFAULT_MIN_SESSIONS_PER_SIDE);
    expect(result.after.sessionCount).toBe(DEFAULT_MIN_SESSIONS_PER_SIDE);
    expect(result.delta).toBe(0);
  });

  test("classifies clear improvement and clear regression", (): void => {
    const improvingStore = trackedStore();
    seedMany(improvingStore, "low-before", 5, "2026-01-01T00:00:00.000Z", 0, 1);
    seedMany(improvingStore, "high-after", 5, "2026-01-11T00:00:00.000Z", 1, 0);

    const regressingStore = trackedStore();
    seedMany(regressingStore, "high-before", 5, "2026-01-01T00:00:00.000Z", 1, 0);
    seedMany(regressingStore, "low-after", 5, "2026-01-11T00:00:00.000Z", 0, 1);

    const improvement = measureProposal(improvingStore, proposal());
    const regression = measureProposal(regressingStore, proposal());

    expect(improvement.status).toBe("improved");
    expect(improvement.delta).toBeGreaterThan(0);
    expect(regression.status).toBe("regressed");
    expect(regression.delta).toBeLessThan(0);
  });

  test("uses no movement within epsilon as the retirement signal", (): void => {
    const store = trackedStore();
    seedMany(store, "before", 5, "2026-01-01T00:00:00.000Z", 1, 1);
    seedMany(store, "after", 4, "2026-01-11T00:00:00.000Z", 1, 1);
    seedRatedSession(store, {
      sessionId: "after-near-equal",
      startedAt: "2026-01-12T00:00:00.000Z",
      passed: 51,
      failed: 49,
    });

    const result = measureProposal(store, proposal());

    expect(result.delta).not.toBeNull();
    expect(Math.abs(result.delta ?? Infinity)).toBeLessThan(
      MEAN_SCORE_EPSILON,
    );
    expect(result.status).toBe("no_movement");
    expect(result.reason).toContain("retirement signal");
  });

  test("excludes sessions from a different repo", (): void => {
    const store = trackedStore();
    seedRatedSession(store, {
      sessionId: "target-before",
      startedAt: "2026-01-01T00:00:00.000Z",
      passed: 0,
      failed: 1,
      repo: "/target",
    });
    seedRatedSession(store, {
      sessionId: "target-after",
      startedAt: "2026-01-11T00:00:00.000Z",
      passed: 1,
      failed: 0,
      repo: "/target",
    });
    seedMany(
      store,
      "other-before",
      3,
      "2026-01-01T00:00:00.000Z",
      1,
      0,
      "/other",
    );
    seedMany(
      store,
      "other-after",
      3,
      "2026-01-11T00:00:00.000Z",
      0,
      1,
      "/other",
    );

    const result = measureProposal(
      store,
      proposal({ repo: "/target" }),
      { minSessionsPerSide: 1 },
    );

    expect(result.before.sessionCount).toBe(1);
    expect(result.after.sessionCount).toBe(1);
    expect(result.status).toBe("improved");
  });

  test("partitions exact installed_at timestamps into the after side", (): void => {
    const store = trackedStore();
    seedRatedSession(store, {
      sessionId: "strictly-before",
      startedAt: "2026-01-09T23:59:59.999Z",
      passed: 0,
      failed: 1,
    });
    seedRatedSession(store, {
      sessionId: "exactly-installed",
      startedAt: "2026-01-10T00:00:00.000Z",
      passed: 1,
      failed: 0,
    });

    const result = measureProposal(
      store,
      proposal(),
      { minSessionsPerSide: 1 },
    );

    expect(result.before.sessionCount).toBe(1);
    expect(result.before.meanScore).toBe(0);
    expect(result.after.sessionCount).toBe(1);
    expect(result.after.meanScore).toBe(1);
  });

  test("skips unscoreable sessions instead of counting them as zero", (): void => {
    const store = trackedStore();
    seedRatedSession(store, {
      sessionId: "before-scoreable",
      startedAt: "2026-01-01T00:00:00.000Z",
      passed: 1,
      failed: 0,
    });
    seedRatedSession(store, {
      sessionId: "after-unscoreable",
      startedAt: "2026-01-11T00:00:00.000Z",
      passed: 0,
      failed: 0,
    });
    seedRatedSession(store, {
      sessionId: "after-scoreable",
      startedAt: "2026-01-12T00:00:00.000Z",
      passed: 0,
      failed: 1,
    });

    const result = measureProposal(
      store,
      proposal(),
      { minSessionsPerSide: 1 },
    );

    expect(result.after.sessionCount).toBe(1);
    expect(result.after.meanScore).toBe(0);
    expect(result.status).toBe("regressed");
    expect(result.reason).toContain("skipped 1 unscoreable");
  });
});

describe("measureInstalled", (): void => {
  test("is deterministic across repeated runs", (): void => {
    const store = trackedStore();
    seedMany(store, "before", 2, "2026-01-01T00:00:00.000Z", 0, 1);
    seedMany(store, "after", 2, "2026-01-11T00:00:00.000Z", 1, 0);
    const rows = [
      proposal({ id: "proposal-b" }),
      proposal({ id: "proposal-a" }),
    ];

    const first = measureInstalled(store, rows, { minSessionsPerSide: 2 });
    const second = measureInstalled(store, [...rows].reverse(), {
      minSessionsPerSide: 2,
    });

    expect(second).toEqual(first);
    expect(first.map((measurement): string => measurement.proposalId)).toEqual([
      "proposal-a",
      "proposal-b",
    ]);
  });
});
