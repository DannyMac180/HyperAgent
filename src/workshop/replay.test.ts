import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  claimHash,
  type MemoryRow,
} from "../memory/store.ts";
import type { EventInput } from "../schema/events.ts";
import { deterministicEventId } from "../schema/ids.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import type { DraftedProposal } from "./propose.ts";
import {
  buildFixtures,
  evaluateMemoryProposal,
  evaluateProposal,
  evaluateVerificationCheckProposal,
  gateProposal,
  MEMORY_REPLAY_SELECTION_LIMITATION,
  type ReplayFixture,
} from "./replay.ts";

interface SeedEvent {
  type: EventInput["type"];
  payload?: Record<string, unknown>;
}

interface SeedSessionOptions {
  sessionId: string;
  startedAt?: string;
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

async function trackedTempDirectory(): Promise<string> {
  const directory = await mkdtemp(`${tmpdir()}/hyperagent-replay-test-`);
  tempDirectories.push(directory);
  return directory;
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

function seedSession(
  store: Store,
  options: SeedSessionOptions,
): EventInput[] {
  const specs: SeedEvent[] = [
    {
      type: "session_start",
      payload: options.repo === undefined ? {} : { repo: options.repo },
    },
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

function seedFailingAndPassingSessions(store: Store): void {
  seedSession(store, {
    sessionId: "failing",
    repo: "/workspace/hyperagent",
    events: [{
      type: "error",
      payload: { message_summary: "typecheck failed in replay.ts" },
    }],
  });
  seedSession(store, {
    sessionId: "passing",
    startedAt: "2026-01-02T00:00:00.000Z",
    repo: "/workspace/hyperagent",
    events: [{
      type: "verification_event",
      payload: {
        kind: "test",
        result: "pass",
        command_summary: "bun test",
      },
    }],
  });
}

function verificationProposal(
  predicate: Record<string, unknown>,
  sessionIds: string[] = ["failing"],
  holdoutSessionIds: string[] = [],
): DraftedProposal {
  return {
    type: "verification_check",
    body: {
      type: "verification_check",
      predicate,
    },
    evidence: { sessionIds },
    holdoutSessionIds,
  } as unknown as DraftedProposal;
}

function memoryProposal(
  content = "Run the replay test before declaring the workshop complete.",
): DraftedProposal {
  return {
    type: "memory",
    body: { type: "memory", content },
    evidence: { sessionIds: ["failing"] },
    holdoutSessionIds: [],
  } as unknown as DraftedProposal;
}

function fixturesFor(store: Store): ReplayFixture[] {
  return buildFixtures(store, {
    failingSessionIds: ["failing"],
  }).fixtures;
}

function memoryRow(
  id: string,
  createdAt: string,
  scope: MemoryRow["scope"] = "repo",
  scopeKey: string | null = "/workspace/hyperagent",
): MemoryRow {
  const claim = `memory ${id}`;
  return {
    id,
    claim,
    kind: "behavior",
    scope,
    scope_key: scopeKey,
    confidence: 1,
    status: "approved",
    evidence: [{ session_id: "source", raw_ref: null }],
    source: "manual",
    claim_hash: claimHash(claim),
    created_at: createdAt,
    updated_at: createdAt,
    last_validated_at: null,
  };
}

afterEach(async (): Promise<void> => {
  for (const store of stores.splice(0).reverse()) {
    store.close();
  }
  for (const directory of tempDirectories.splice(0).reverse()) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("buildFixtures", (): void => {
  test("builds fixtures exclusively from stored session rows and event provenance", (): void => {
    type FixtureOptions = Parameters<typeof buildFixtures>[1];
    type ProposalLikeKeys = Extract<
      keyof FixtureOptions,
      "proposal" | "claim" | "text"
    >;
    const signatureRejectsProposalInputs:
      ProposalLikeKeys extends never ? true : false = true;

    const store = trackedStore();
    const failingEvents = seedSession(store, {
      sessionId: "failing",
      repo: "/workspace/hyperagent",
      events: [{
        type: "error",
        payload: { message_summary: "proposal-shaped words stay in the event" },
      }],
    });
    const passingEvents = seedSession(store, {
      sessionId: "passing",
      startedAt: "2026-01-02T00:00:00.000Z",
      repo: "/workspace/hyperagent",
      events: [{
        type: "verification_event",
        payload: { kind: "test", result: "pass" },
      }],
    });

    const result = buildFixtures(store, {
      failingSessionIds: ["failing"],
    });

    expect(signatureRejectsProposalInputs).toBe(true);
    expect(buildFixtures).toHaveLength(2);
    expect(result.diagnostics).toEqual([]);
    expect(result.fixtures).toHaveLength(2);
    for (const fixture of result.fixtures) {
      const storedSession = store.getSessions().find(
        (session): boolean => session.session_id === fixture.sessionId,
      );
      expect(storedSession).toBeDefined();
      if (storedSession === undefined) {
        throw new Error(`missing stored session ${fixture.sessionId}`);
      }
      expect(fixture.repo).toBe(storedSession.repo);
      expect(fixture.vendor).toBe(storedSession.vendor);
      expect(fixture.ts).toBe(storedSession.started_at);
      expect(fixture.eventIds).toEqual(
        store.getEvents(fixture.sessionId).map((event): string => event.id),
      );
    }
    expect(result.fixtures[0]?.eventIds).toEqual(
      failingEvents.map((event): string => event.id),
    );
    expect(result.fixtures[1]?.eventIds).toEqual(
      passingEvents.map((event): string => event.id),
    );
  });

  test("prefers holdout sessions as positive fixtures", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "cluster-failure",
      repo: "/workspace/hyperagent",
    });
    seedSession(store, {
      sessionId: "holdout-failure",
      startedAt: "2026-01-02T00:00:00.000Z",
      repo: "/workspace/hyperagent",
    });
    seedSession(store, {
      sessionId: "passing",
      startedAt: "2026-01-03T00:00:00.000Z",
      repo: "/workspace/hyperagent",
      events: [{
        type: "verification_event",
        payload: { kind: "test", result: "pass" },
      }],
    });

    const result = buildFixtures(store, {
      failingSessionIds: ["cluster-failure"],
      holdoutSessionIds: ["holdout-failure"],
    });

    expect(
      result.fixtures
        .filter((fixture): boolean => fixture.role === "positive")
        .map((fixture): string => fixture.sessionId),
    ).toEqual(["holdout-failure"]);
    expect(
      result.fixtures.some(
        (fixture): boolean => fixture.sessionId === "cluster-failure",
      ),
    ).toBe(false);
  });
});

describe("verification_check replay", (): void => {
  test("does not pass an evaluation with zero negative controls", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "failing",
      repo: "/workspace/hyperagent",
    });

    const evaluation = evaluateProposal(
      store,
      verificationProposal({
        type: "event_present",
        eventType: "verification_event",
      }),
      { negativeControlLimit: 0 },
    );

    expect(evaluation.positivesTotal).toBe(1);
    expect(evaluation.negativeControlsTotal).toBe(0);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failureReason).toBe("no_fixtures");
  });

  test("catches a historical failure while leaving a passing control clean", async (): Promise<void> => {
    const store = trackedStore();
    seedFailingAndPassingSessions(store);
    const repoRoot = await trackedTempDirectory();

    const evaluation = evaluateVerificationCheckProposal(
      store,
      verificationProposal({
        type: "event_present",
        eventType: "verification_event",
      }),
      fixturesFor(store),
      { repoRoot },
    );

    expect(evaluation.outcomes).toEqual([
      expect.objectContaining({
        sessionId: "failing",
        role: "positive",
        verdict: "would_have_caught",
      }),
      expect.objectContaining({
        sessionId: "passing",
        role: "negative_control",
        verdict: "no_effect",
      }),
    ]);
    expect(evaluation.passed).toBe(true);
    expect(evaluation.failureReason).toBeNull();
  });

  test("reports a false flag when the predicate also fails on a passing control", (): void => {
    const store = trackedStore();
    seedFailingAndPassingSessions(store);

    const evaluation = evaluateVerificationCheckProposal(
      store,
      verificationProposal({
        type: "event_present",
        eventType: "session_end",
      }),
      fixturesFor(store),
    );

    expect(evaluation.positivesCaught).toBe(1);
    expect(evaluation.falseFlags).toBe(1);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failureReason).toBe("false_flag");
    expect(gateProposal(evaluation)).toEqual({
      status: "draft",
      reason: "false_flag",
    });
  });

  test("gates zero catches, false flags, and clean evaluations", (): void => {
    const store = trackedStore();
    seedFailingAndPassingSessions(store);
    const fixtures = fixturesFor(store);

    const zeroCaught = evaluateVerificationCheckProposal(
      store,
      verificationProposal({
        type: "event_present",
        eventType: "session_start",
      }),
      fixtures,
    );
    const falseFlag = evaluateVerificationCheckProposal(
      store,
      verificationProposal({
        type: "event_present",
        eventType: "session_end",
      }),
      fixtures,
    );
    const clean = evaluateVerificationCheckProposal(
      store,
      verificationProposal({
        type: "event_present",
        eventType: "verification_event",
      }),
      fixtures,
    );

    expect(zeroCaught.positivesCaught).toBe(0);
    expect(gateProposal(zeroCaught)).toEqual({
      status: "draft",
      reason: "eval_failed",
    });
    expect(gateProposal(falseFlag)).toEqual({
      status: "draft",
      reason: "false_flag",
    });
    expect(gateProposal(clean)).toEqual({ status: "pending" });
  });
});

describe("memory replay", (): void => {
  test("uses real selector membership and excludes memories created after the fixture", (): void => {
    const store = trackedStore();
    seedFailingAndPassingSessions(store);
    const fixtures = fixturesFor(store);
    const futureMemory = memoryRow(
      "future-memory",
      "2026-02-01T00:00:00.000Z",
    );

    const selected = evaluateMemoryProposal(
      store,
      [futureMemory],
      memoryProposal(),
      fixtures,
    );
    const wrongRepo = evaluateMemoryProposal(
      store,
      [],
      memoryProposal(),
      fixtures,
      { scope: "repo", scopeKey: "/workspace/another-repo" },
    );

    expect(selected.outcomes).toEqual([
      expect.objectContaining({
        sessionId: "failing",
        verdict: "would_have_caught",
      }),
      expect.objectContaining({
        sessionId: "passing",
        verdict: "no_effect",
      }),
    ]);
    expect(selected.passed).toBe(true);
    expect(
      selected.diagnostics.some(
        (diagnostic): boolean =>
          diagnostic.includes(
            "memory future-memory post-dates fixture failing and was excluded",
          ),
      ),
    ).toBe(true);
    expect(wrongRepo.positivesCaught).toBe(0);
    expect(wrongRepo.outcomes[0]?.reason).toContain(
      "absent from the real historical injection selection",
    );
  });

  test("does not score unconditional global selection as a catch", (): void => {
    const store = trackedStore();
    seedFailingAndPassingSessions(store);

    const evaluation = evaluateMemoryProposal(
      store,
      [],
      memoryProposal(),
      fixturesFor(store),
      { scope: "global" },
    );

    expect(evaluation.positivesCaught).toBe(0);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.diagnostics).toContain(
      MEMORY_REPLAY_SELECTION_LIMITATION,
    );
    expect(evaluation.outcomes[0]).toEqual(expect.objectContaining({
      verdict: "no_effect",
      reason:
        "The candidate was selected only by unconditional global-scope admission; membership does not show it would have helped.",
    }));
  });
});

describe("unsupported and corrupt replay inputs", (): void => {
  test("fails instruction_edit and skill proposals as unsupported", (): void => {
    const store = trackedStore();
    for (const type of ["instruction_edit", "skill"] as const) {
      const proposal = {
        type,
        body: { type },
        evidence: { sessionIds: [] },
        holdoutSessionIds: [],
      } as unknown as DraftedProposal;

      const evaluation = evaluateProposal(store, proposal);

      expect(evaluation.proposalType).toBe(type);
      expect(evaluation.passed).toBe(false);
      expect(evaluation.failureReason).toBe("unsupported");
    }
  });

  test("turns malformed and missing provenance into error verdicts without throwing", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "failing",
      repo: "/workspace/hyperagent",
    });
    const valid = buildFixtures(store, {
      failingSessionIds: ["failing"],
      negativeControlLimit: 0,
    }).fixtures[0];
    if (valid === undefined) {
      throw new Error("expected a positive replay fixture");
    }
    const missingId = deterministicEventId({
      ts: "2026-01-01T00:00:09.000Z",
      sessionId: "failing",
      rawRef: "failing.jsonl#missing",
      type: "error",
    });
    const malformed = { ...valid, eventIds: [] };
    const missing = { ...valid, eventIds: [missingId] };

    let evaluation:
      ReturnType<typeof evaluateVerificationCheckProposal> | undefined;
    expect((): void => {
      evaluation = evaluateVerificationCheckProposal(
        store,
        verificationProposal({
          type: "event_present",
          eventType: "verification_event",
        }),
        [malformed, missing],
      );
    }).not.toThrow();

    expect(evaluation?.outcomes.map((outcome) => outcome.verdict)).toEqual([
      "error",
      "error",
    ]);
    expect(evaluation?.errors).toBe(2);
    expect(evaluation?.diagnostics).toHaveLength(2);
    expect(evaluation?.diagnostics[0]).toContain(
      "invalid or empty provenance",
    );
    expect(evaluation?.diagnostics[1]).toContain(
      "references missing stored event",
    );
  });
});
