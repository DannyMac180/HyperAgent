import { afterEach, describe, expect, test } from "bun:test";

import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import type { CapabilityMeasurement } from "../workshop/measure.ts";
import { openWorkshopQueue } from "../workshop/queue.ts";
import type { WorkshopProposalRow, WorkshopQueue } from "../workshop/queue.ts";
import type { ReplayEval } from "../workshop/replay.ts";
import type { ProposalStatus } from "../workshop/types.ts";
import {
  computeMetaReview,
  META_REVIEW_VERSION,
} from "./meta-review.ts";
import type { MetaReviewDeps, MetaReviewQueue } from "./meta-review.ts";

const stores: Store[] = [];
const queues: WorkshopQueue[] = [];

function trackedStore(): Store {
  const store = openStore(":memory:");
  stores.push(store);
  return store;
}

function trackedQueue(): WorkshopQueue {
  const queue = openWorkshopQueue({ dbPath: ":memory:" });
  queues.push(queue);
  return queue;
}

afterEach((): void => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  while (queues.length > 0) {
    queues.pop()?.close();
  }
});

interface EvalOptions {
  positivesCaught: number;
  positivesTotal: number;
  falseFlags: number;
  negativeControlsTotal: number;
  errors: number;
}

function replayEval(options: EvalOptions): ReplayEval {
  return {
    proposalType: "memory",
    evalVersion: "1",
    fixtures: [],
    outcomes: [],
    positivesCaught: options.positivesCaught,
    positivesTotal: options.positivesTotal,
    falseFlags: options.falseFlags,
    negativeControlsTotal: options.negativeControlsTotal,
    errors: options.errors,
    passed: options.falseFlags === 0 && options.errors === 0,
    failureReason: null,
    diagnostics: [],
  };
}

interface RowOptions {
  id: string;
  status?: ProposalStatus;
  repo?: string | null;
  agent?: string | null;
  clusterSignature?: string;
  holdout?: string[];
  eval?: ReplayEval | null;
}

function row(options: RowOptions): WorkshopProposalRow {
  const status = options.status ?? "draft";
  return {
    id: options.id,
    type: "memory",
    durability: "ground_truth",
    title: `Proposal ${options.id}`,
    rationale: "Recurring friction observed across sessions",
    body: { type: "memory", content: `content for ${options.id}` },
    evidence: {
      sessionIds: ["session-a"],
      eventIds: ["event-a"],
      clusterSignature: options.clusterSignature ?? `cluster-${options.id}`,
    },
    holdout: options.holdout ?? [],
    contentHash: "a".repeat(64),
    eval: options.eval ?? null,
    status,
    repo: options.repo ?? null,
    agent: options.agent ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    installedAt: status === "installed" ? "2026-01-02T00:00:00.000Z" : null,
    receipt: null,
  };
}

function fakeQueue(rows: WorkshopProposalRow[]): MetaReviewQueue {
  return { list: (): WorkshopProposalRow[] => [...rows] };
}

const FIXED_NOW: MetaReviewDeps["now"] = (): Date =>
  new Date("2026-02-01T00:00:00.000Z");

function measurementFor(
  proposalId: string,
  status: CapabilityMeasurement["status"],
): CapabilityMeasurement {
  return {
    proposalId,
    installedAt: "2026-01-02T00:00:00.000Z",
    scope: { repo: null, agent: null },
    before: { sessionCount: 0, meanScore: null },
    after: { sessionCount: 0, meanScore: null },
    delta: null,
    status,
    reason: "fixture measurement",
    measurementVersion: "1",
  };
}

function assertNoNonFiniteNumbers(review: unknown): void {
  const serialized = JSON.stringify(review);
  expect(serialized).not.toContain("NaN");
  expect(serialized).not.toContain("Infinity");
}

describe("computeMetaReview", () => {
  test("reports honest nulls and no non-finite numbers on an empty queue", () => {
    const review = computeMetaReview(fakeQueue([]), trackedStore(), {
      now: FIXED_NOW,
    });

    expect(review.metaReviewVersion).toBe(META_REVIEW_VERSION);
    expect(review.generatedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(review.proposals).toEqual({ total: 0, byStatus: {}, byType: {} });
    expect(review.acceptance).toEqual({
      decided: 0,
      approved: 0,
      rejected: 0,
      acceptanceRate: null,
      installRate: null,
    });
    expect(review.evalQuality.meanPositivesCaughtRatio).toBeNull();
    expect(review.evalQuality.negativeControlShare).toBeNull();
    expect(review.evalQuality.proposalsWithEval).toBe(0);
    expect(review.specificity.distinctClusters).toBe(0);
    expect(review.specificity.proposalsPerCluster).toBeNull();
    expect(review.measurement).toEqual({ measured: 0, byStatus: {} });
    expect(review.diagnostics).toEqual(["no workshop proposals recorded"]);
    assertNoNonFiniteNumbers(review);
  });

  test("counts installed proposals as approved and hand-computes both rates", () => {
    // 2 approved + 2 installed = 4 approved; 4 rejected; 1 draft is undecided.
    const rows = [
      row({ id: "p1", status: "approved" }),
      row({ id: "p2", status: "approved" }),
      row({ id: "p3", status: "installed" }),
      row({ id: "p4", status: "installed" }),
      row({ id: "p5", status: "rejected" }),
      row({ id: "p6", status: "rejected" }),
      row({ id: "p7", status: "rejected" }),
      row({ id: "p8", status: "rejected" }),
      row({ id: "p9", status: "draft" }),
    ];

    const review = computeMetaReview(fakeQueue(rows), trackedStore(), {
      now: FIXED_NOW,
      measureInstalled: (): CapabilityMeasurement[] => [],
    });

    expect(review.proposals.total).toBe(9);
    expect(review.proposals.byStatus).toEqual({
      approved: 2,
      draft: 1,
      installed: 2,
      rejected: 4,
    });
    expect(review.proposals.byType).toEqual({ memory: 9 });
    expect(review.acceptance.approved).toBe(4);
    expect(review.acceptance.rejected).toBe(4);
    expect(review.acceptance.decided).toBe(8);
    // 4 approved of 8 decided.
    expect(review.acceptance.acceptanceRate).toBe(0.5);
    // 2 installed of 4 approved.
    expect(review.acceptance.installRate).toBe(0.5);
    assertNoNonFiniteNumbers(review);
  });

  test("hand-computes eval quality and excludes zero-positive evals from the mean", () => {
    const rows = [
      row({
        id: "e1",
        holdout: ["session-h"],
        eval: replayEval({
          positivesCaught: 3,
          positivesTotal: 4,
          falseFlags: 1,
          negativeControlsTotal: 2,
          errors: 1,
        }),
      }),
      row({
        id: "e2",
        eval: replayEval({
          positivesCaught: 1,
          positivesTotal: 4,
          falseFlags: 2,
          negativeControlsTotal: 0,
          errors: 0,
        }),
      }),
      row({
        id: "e3",
        eval: replayEval({
          positivesCaught: 0,
          positivesTotal: 0,
          falseFlags: 0,
          negativeControlsTotal: 3,
          errors: 2,
        }),
      }),
      row({
        id: "e4",
        eval: replayEval({
          positivesCaught: 2,
          positivesTotal: 4,
          falseFlags: 0,
          negativeControlsTotal: 0,
          errors: 0,
        }),
      }),
      row({ id: "e5", eval: null }),
    ];

    const review = computeMetaReview(fakeQueue(rows), trackedStore(), {
      now: FIXED_NOW,
    });

    expect(review.evalQuality.proposalsWithEval).toBe(4);
    // (0.75 + 0.25 + 0.5) / 3 — e3 has no positives and is excluded.
    expect(review.evalQuality.meanPositivesCaughtRatio).toBe(0.5);
    expect(review.evalQuality.totalFalseFlags).toBe(3);
    expect(review.evalQuality.evalErrorCount).toBe(3);
    // e1 and e3 carry negative controls; 2 of 4 evals.
    expect(review.evalQuality.withNegativeControls).toBe(2);
    expect(review.evalQuality.negativeControlShare).toBe(0.5);
    expect(review.evalQuality.withHoldout).toBe(1);
    assertNoNonFiniteNumbers(review);
  });

  test("classifies scope with agent taking precedence over repo", () => {
    const rows = [
      row({ id: "s1", agent: "claude-code", repo: "example-repo" }),
      row({ id: "s2", repo: "example-repo" }),
      row({ id: "s3" }),
      row({ id: "s4" }),
    ];

    const review = computeMetaReview(fakeQueue(rows), trackedStore(), {
      now: FIXED_NOW,
    });

    expect(review.specificity.scopeDistribution).toEqual({
      global: 2,
      repo: 1,
      agent: 1,
    });
  });

  test("hand-computes distinct clusters and proposals per cluster", () => {
    const rows = [
      row({ id: "c1", clusterSignature: "signature-a" }),
      row({ id: "c2", clusterSignature: "signature-a" }),
      row({ id: "c3", clusterSignature: "signature-b" }),
      row({ id: "c4", clusterSignature: "signature-b" }),
    ];

    const review = computeMetaReview(fakeQueue(rows), trackedStore(), {
      now: FIXED_NOW,
    });

    expect(review.specificity.distinctClusters).toBe(2);
    // 4 proposals across 2 clusters.
    expect(review.specificity.proposalsPerCluster).toBe(2);
    assertNoNonFiniteNumbers(review);
  });

  test("measures only installed rows and counts measurement statuses", () => {
    const rows = [
      row({ id: "m1", status: "installed" }),
      row({ id: "m2", status: "installed" }),
      row({ id: "m3", status: "installed" }),
      row({ id: "m4", status: "approved" }),
      row({ id: "m5", status: "rejected" }),
    ];
    const seen: string[][] = [];
    const measureInstalled = (
      _store: Store,
      given: WorkshopProposalRow[],
    ): CapabilityMeasurement[] => {
      seen.push(given.map((given_: WorkshopProposalRow): string => given_.id));
      return [
        measurementFor("m1", "improved"),
        measurementFor("m2", "improved"),
        measurementFor("m3", "insufficient_data"),
      ];
    };

    const review = computeMetaReview(fakeQueue(rows), trackedStore(), {
      now: FIXED_NOW,
      measureInstalled,
    });

    expect(seen).toEqual([["m1", "m2", "m3"]]);
    expect(review.measurement.measured).toBe(3);
    expect(review.measurement.byStatus).toEqual({
      improved: 2,
      insufficient_data: 1,
    });
    expect(review.diagnostics).not.toContain(
      "no installed capability could be measured",
    );
  });

  test("does not call the measurement function when nothing is installed", () => {
    let calls = 0;
    const review = computeMetaReview(
      fakeQueue([row({ id: "n1", status: "approved" })]),
      trackedStore(),
      {
        now: FIXED_NOW,
        measureInstalled: (): CapabilityMeasurement[] => {
          calls += 1;
          return [];
        },
      },
    );

    expect(calls).toBe(0);
    expect(review.measurement).toEqual({ measured: 0, byStatus: {} });
    expect(review.diagnostics).toContain(
      "no installed capability could be measured",
    );
  });

  test("reads a real in-memory workshop queue", () => {
    const queue = trackedQueue();
    queue.addDrafts([
      {
        type: "memory",
        durability: "ground_truth",
        title: "Record the build command",
        rationale: "The same command was rediscovered repeatedly",
        body: { type: "memory", content: "The build command is bun run build" },
        evidence: {
          sessionIds: ["session-a"],
          eventIds: ["event-a"],
          clusterSignature: "signature-a",
        },
        holdoutSessionIds: [],
        drafterVersion: "1",
        repo: null,
        agent: null,
      },
    ]);

    const review = computeMetaReview(queue, trackedStore(), {
      now: FIXED_NOW,
    });

    expect(review.proposals.total).toBe(1);
    expect(review.proposals.byStatus).toEqual({ draft: 1 });
    expect(review.specificity.distinctClusters).toBe(1);
    expect(review.specificity.scopeDistribution.global).toBe(1);
    assertNoNonFiniteNumbers(review);
  });

  test("rejects deps that are not a plain object", () => {
    const store = trackedStore();
    expect((): void => {
      computeMetaReview(fakeQueue([]), store, [] as unknown as MetaReviewDeps);
    }).toThrow("meta review deps must be a plain object");
  });

  test("rejects a non-function measureInstalled and a non-function now", () => {
    const store = trackedStore();
    expect((): void => {
      computeMetaReview(fakeQueue([]), store, {
        measureInstalled: "nope",
      } as unknown as MetaReviewDeps);
    }).toThrow("meta review deps measureInstalled must be a function");
    expect((): void => {
      computeMetaReview(fakeQueue([]), store, {
        now: 5,
      } as unknown as MetaReviewDeps);
    }).toThrow("meta review deps now must be a function");
  });

  test("rejects a now() that does not return a valid Date", () => {
    const store = trackedStore();
    expect((): void => {
      computeMetaReview(fakeQueue([]), store, {
        now: (): Date => new Date("not-a-date"),
      });
    }).toThrow("meta review now() must return a valid Date");
  });

  test("rejects a queue without a list function", () => {
    const store = trackedStore();
    expect((): void => {
      computeMetaReview({} as unknown as MetaReviewQueue, store);
    }).toThrow("meta review queue must expose a list() function");
  });
});
