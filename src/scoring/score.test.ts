import { afterEach, describe, expect, test } from "bun:test";

import type { EventInput } from "../schema/events.ts";
import { deterministicEventId } from "../schema/ids.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import {
  compareAdapterVersions,
  getTrends,
  rebuildScores,
  scoreSession,
} from "./score.ts";
import type { SessionScore } from "./score.ts";

interface SeedEvent {
  type: EventInput["type"];
  payload?: Record<string, unknown>;
  rawRef?: string;
  adapterVersion?: string;
  discriminator?: string;
}

interface SeedSessionOptions {
  sessionId: string;
  startedAt?: string;
  agent?: string;
  repo?: string;
  model?: string;
  events?: SeedEvent[];
}

const stores: Store[] = [];

function trackedStore(): Store {
  const store = openStore(":memory:");
  stores.push(store);
  return store;
}

function seedSession(store: Store, options: SeedSessionOptions): void {
  const startedAt = options.startedAt ?? "2026-01-01T00:00:00.000Z";
  const startMilliseconds = Date.parse(startedAt);
  if (Number.isNaN(startMilliseconds)) {
    throw new Error(`invalid fixture start timestamp: ${startedAt}`);
  }

  const startPayload: Record<string, unknown> = {};
  if (options.agent !== undefined) {
    startPayload.agent = options.agent;
  }
  if (options.repo !== undefined) {
    startPayload.repo = options.repo;
  }
  if (options.model !== undefined) {
    startPayload.model = options.model;
  }

  const eventSpecs: SeedEvent[] = [
    { type: "session_start", payload: startPayload },
    ...(options.events ?? []),
  ];
  const events = eventSpecs.map((event, index): EventInput => {
    const ts = new Date(startMilliseconds + index * 1_000).toISOString();
    const rawRef = event.rawRef ?? `${options.sessionId}.jsonl#${index}`;
    return {
      id: deterministicEventId({
        ts,
        sessionId: options.sessionId,
        rawRef,
        type: event.type,
        discriminator: event.discriminator,
      }),
      ts,
      type: event.type,
      session_id: options.sessionId,
      vendor: "codex",
      adapter_version: event.adapterVersion ?? "0.1.0",
      raw_ref: rawRef,
      payload: event.payload ?? {},
    } as EventInput;
  });

  const inserted = store.append(events);
  if (inserted !== events.length) {
    throw new Error(
      `fixture inserted ${inserted} of ${events.length} events for ${options.sessionId}`,
    );
  }
}

afterEach((): void => {
  for (const store of stores.splice(0).reverse()) {
    store.close();
  }
});

describe("session scoring", (): void => {
  test("an empty session has zero counts and unknown derived rates", (): void => {
    const store = trackedStore();
    seedSession(store, { sessionId: "empty" });

    const score = scoreSession(store, "empty");

    expect({
      turn_count: score.turn_count,
      tool_call_count: score.tool_call_count,
      error_count: score.error_count,
      retry_count: score.retry_count,
      verification_total: score.verification_total,
      verification_passed: score.verification_passed,
      verification_failed: score.verification_failed,
      completion_claim_count: score.completion_claim_count,
    }).toEqual({
      turn_count: 0,
      tool_call_count: 0,
      error_count: 0,
      retry_count: 0,
      verification_total: 0,
      verification_passed: 0,
      verification_failed: 0,
      completion_claim_count: 0,
    });
    expect(score.verification_pass_rate).toBeNull();
    expect(score.evidence_backed_completion).toBeNull();
    expect(score.provisional).toBe(1);
  });

  test("no verification events produces a strictly null pass rate", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "unverified",
      events: [
        { type: "turn_start" },
        { type: "tool_call" },
        { type: "completion_claim" },
      ],
    });

    const score = scoreSession(store, "unverified");

    expect(score.turn_count).toBe(1);
    expect(score.tool_call_count).toBe(1);
    expect(score.verification_total).toBe(0);
    expect(score.verification_pass_rate).toBeNull();
  });

  test("sidechain events are excluded from every headline metric", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "sidechains",
      events: [
        { type: "turn_start" },
        { type: "turn_start", payload: { is_sidechain: true } },
        { type: "tool_call" },
        { type: "tool_call", payload: { is_sidechain: true } },
        { type: "error" },
        { type: "error", payload: { is_sidechain: true } },
        { type: "retry" },
        { type: "retry", payload: { is_sidechain: true } },
        { type: "verification_event", payload: { result: "pass" } },
        {
          type: "verification_event",
          payload: { result: "fail", is_sidechain: true },
        },
        { type: "completion_claim" },
        { type: "completion_claim", payload: { is_sidechain: true } },
      ],
    });

    const score = scoreSession(store, "sidechains");

    expect({
      turn_count: score.turn_count,
      tool_call_count: score.tool_call_count,
      error_count: score.error_count,
      retry_count: score.retry_count,
      verification_total: score.verification_total,
      verification_passed: score.verification_passed,
      verification_failed: score.verification_failed,
      verification_pass_rate: score.verification_pass_rate,
      completion_claim_count: score.completion_claim_count,
      evidence_backed_completion: score.evidence_backed_completion,
    }).toEqual({
      turn_count: 1,
      tool_call_count: 1,
      error_count: 1,
      retry_count: 1,
      verification_total: 1,
      verification_passed: 1,
      verification_failed: 0,
      verification_pass_rate: 1,
      completion_claim_count: 1,
      evidence_backed_completion: 1,
    });
  });

  test("evidence-backed completion follows the complete final-state truth table", (): void => {
    const store = trackedStore();
    const cases: Array<{
      sessionId: string;
      events: SeedEvent[];
      expected: number | null;
    }> = [
      {
        sessionId: "pass-then-claim",
        events: [
          { type: "verification_event", payload: { result: "pass" } },
          { type: "completion_claim" },
        ],
        expected: 1,
      },
      {
        sessionId: "claim-then-pass",
        events: [
          { type: "completion_claim" },
          { type: "verification_event", payload: { result: "pass" } },
        ],
        expected: 1,
      },
      {
        sessionId: "pass-fail-claim",
        events: [
          { type: "verification_event", payload: { result: "pass" } },
          { type: "verification_event", payload: { result: "fail" } },
          { type: "completion_claim" },
        ],
        expected: 0,
      },
      {
        sessionId: "fail-pass-claim",
        events: [
          { type: "verification_event", payload: { result: "fail" } },
          { type: "verification_event", payload: { result: "pass" } },
          { type: "completion_claim" },
        ],
        expected: 1,
      },
      {
        sessionId: "claim-without-verification",
        events: [{ type: "completion_claim" }],
        expected: 0,
      },
      {
        sessionId: "verification-without-claim",
        events: [{ type: "verification_event", payload: { result: "pass" } }],
        expected: null,
      },
    ];

    for (const testCase of cases) {
      seedSession(store, testCase);
    }

    const actual = cases.map((testCase): number | null =>
      scoreSession(store, testCase.sessionId).evidence_backed_completion
    );

    expect(actual).toEqual(cases.map((testCase): number | null => testCase.expected));
  });

  test("the highest adapter version wins raw_ref deduplication", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "adapter-dedupe",
      events: [
        {
          type: "verification_event",
          payload: { result: "fail" },
          rawRef: "t.jsonl#12",
          adapterVersion: "0.1.0",
          discriminator: "old",
        },
        {
          type: "verification_event",
          payload: { result: "pass" },
          rawRef: "t.jsonl#12",
          adapterVersion: "0.2.0",
          discriminator: "new",
        },
      ],
    });

    const score = scoreSession(store, "adapter-dedupe");

    expect(score.verification_total).toBe(1);
    expect(score.verification_passed).toBe(1);
    expect(score.verification_failed).toBe(0);
  });

  test("rebuildScores is byte-identical across repeated runs", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "rebuild-a",
      events: [
        { type: "turn_start" },
        { type: "verification_event", payload: { result: "pass" } },
      ],
    });
    seedSession(store, {
      sessionId: "rebuild-b",
      events: [
        { type: "tool_call" },
        { type: "error" },
        { type: "completion_claim" },
      ],
    });
    seedSession(store, {
      sessionId: "rebuild-c",
      events: [{ type: "session_end", payload: { outcome: "completed" } }],
    });

    const firstCount = rebuildScores(store);
    const firstRows = store.db
      .query<SessionScore, []>("SELECT * FROM session_scores ORDER BY session_id")
      .all();
    const firstJson = JSON.stringify(firstRows);

    const secondCount = rebuildScores(store);
    const secondRows = store.db
      .query<SessionScore, []>("SELECT * FROM session_scores ORDER BY session_id")
      .all();
    const secondJson = JSON.stringify(secondRows);

    expect(firstCount).toBe(3);
    expect(secondCount).toBe(3);
    expect(secondJson).toBe(firstJson);
  });

  test("event log triggers remain append-only after scoring", (): void => {
    const store = trackedStore();
    seedSession(store, { sessionId: "append-only" });
    scoreSession(store, "append-only");

    expect(() => store.db.run("UPDATE events SET ts = ts")).toThrow();
    expect(() => store.db.run("DELETE FROM events")).toThrow();
    expect(store.getEvents("append-only")).toHaveLength(1);
  });

  test("session_scores rows are mutable derived state with advancing watermarks", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "mutable-score",
      events: [{ type: "turn_start" }],
    });
    const first = scoreSession(store, "mutable-score");

    const ts = "2026-01-01T00:00:02.000Z";
    const rawRef = "mutable-score.jsonl#2";
    const appended: EventInput = {
      id: deterministicEventId({
        ts,
        sessionId: "mutable-score",
        rawRef,
        type: "tool_call",
      }),
      ts,
      type: "tool_call",
      session_id: "mutable-score",
      vendor: "codex",
      adapter_version: "0.1.0",
      raw_ref: rawRef,
      payload: {},
    };
    expect(store.append(appended)).toBe(1);

    const second = scoreSession(store, "mutable-score");
    const rows = store.db
      .query<SessionScore, []>(
        "SELECT * FROM session_scores WHERE session_id = 'mutable-score'",
      )
      .all();

    expect(rows).toHaveLength(1);
    expect(second.event_watermark).toBeGreaterThan(first.event_watermark);
    expect(second.turn_count).toBe(1);
    expect(second.tool_call_count).toBe(1);
    expect(rows[0]).toEqual(second);
  });
});

describe("adapter version comparison", (): void => {
  test("compares numeric, equal, longer, and non-numeric versions", (): void => {
    expect(compareAdapterVersions("0.2.0", "0.1.0")).toBeGreaterThan(0);
    expect(compareAdapterVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareAdapterVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareAdapterVersions("1.0.1", "1.0")).toBeGreaterThan(0);
    expect(compareAdapterVersions("1.beta", "1.alpha")).toBeGreaterThan(0);
    expect(compareAdapterVersions("1.alpha", "1.beta")).toBeLessThan(0);
  });
});

describe("trends", (): void => {
  test("groups the window and averages only non-null derived metrics", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "trend-a-one",
      startedAt: "2026-02-09T12:00:00.000Z",
      agent: "agent-a",
      repo: "repo-one",
      events: [
        { type: "error" },
        { type: "verification_event", payload: { result: "pass" } },
        { type: "completion_claim" },
      ],
    });
    seedSession(store, {
      sessionId: "trend-a-two",
      startedAt: "2026-02-08T12:00:00.000Z",
      agent: "agent-a",
      repo: "repo-two",
      events: [
        { type: "verification_event", payload: { result: "fail" } },
        { type: "completion_claim" },
      ],
    });
    seedSession(store, {
      sessionId: "trend-b-one",
      startedAt: "2026-02-07T12:00:00.000Z",
      agent: "agent-b",
      repo: "repo-one",
      events: [{ type: "turn_start" }],
    });
    seedSession(store, {
      sessionId: "trend-b-two",
      startedAt: "2026-02-06T12:00:00.000Z",
      agent: "agent-b",
      repo: "repo-two",
      events: [{ type: "completion_claim" }],
    });
    seedSession(store, {
      sessionId: "trend-outside",
      startedAt: "2026-01-01T12:00:00.000Z",
      agent: "agent-a",
      repo: "repo-one",
      events: [
        { type: "error" },
        { type: "error" },
        { type: "verification_event", payload: { result: "pass" } },
        { type: "completion_claim" },
      ],
    });
    expect(rebuildScores(store)).toBe(5);

    const now = Date.parse("2026-02-10T12:00:00.000Z");
    const trends = getTrends(store, {
      days: 7,
      now: (): number => now,
    });

    expect(trends.by_agent).toEqual([
      {
        agent: "agent-a",
        session_count: 2,
        average_verification_pass_rate: 0.5,
        total_errors: 1,
        total_claims: 2,
        evidence_backed_ratio: 0.5,
      },
      {
        agent: "agent-b",
        session_count: 2,
        average_verification_pass_rate: null,
        total_errors: 0,
        total_claims: 1,
        evidence_backed_ratio: 0,
      },
    ]);
    expect(trends.by_repo).toEqual([
      {
        repo: "repo-one",
        session_count: 2,
        average_verification_pass_rate: 1,
        total_errors: 1,
        total_claims: 1,
        evidence_backed_ratio: 1,
      },
      {
        repo: "repo-two",
        session_count: 2,
        average_verification_pass_rate: 0,
        total_errors: 0,
        total_claims: 2,
        evidence_backed_ratio: 0,
      },
    ]);
  });
});
