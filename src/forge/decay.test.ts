import { afterEach, describe, expect, test } from "bun:test";

import type { EventInput } from "../schema/events.ts";
import { deterministicEventId } from "../schema/ids.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import type { FrictionSignal } from "../workshop/friction.ts";
import {
  DECAY_EVIDENCE_LIMITATION,
  DEFAULT_MIN_POST_INSTALL_SESSIONS,
  runDecayAudit,
} from "./decay.ts";
import type { DecayVerdict } from "./decay.ts";
import type {
  CapabilityRecord,
  CapabilityRegistry,
} from "./registry.ts";

const stores: Store[] = [];

function trackedStore(): Store {
  const store = openStore(":memory:");
  stores.push(store);
  return store;
}

afterEach((): void => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

const INSTALL_TS = "2026-01-10T00:00:00.000Z";

interface SessionSeed {
  sessionId: string;
  vendor: string;
  startedAt: string;
  model?: string;
  repo?: string;
  gateFailedCheckIds?: string[];
}

function sessionEvents(seed: SessionSeed): EventInput[] {
  const payload: Record<string, unknown> = {};
  if (seed.model !== undefined) {
    payload.model = seed.model;
  }
  if (seed.repo !== undefined) {
    payload.repo = seed.repo;
  }
  const events: EventInput[] = [];
  const startRef = `${seed.sessionId}#0`;
  events.push({
    id: deterministicEventId({
      ts: seed.startedAt,
      sessionId: seed.sessionId,
      rawRef: startRef,
      type: "session_start",
    }),
    ts: seed.startedAt,
    type: "session_start",
    session_id: seed.sessionId,
    vendor: seed.vendor,
    adapter_version: "0.1.0",
    raw_ref: startRef,
    payload,
  } as EventInput);
  if (seed.gateFailedCheckIds !== undefined) {
    const ts = new Date(Date.parse(seed.startedAt) + 1_000).toISOString();
    const rawRef = `${seed.sessionId}#1`;
    events.push({
      id: deterministicEventId({
        ts,
        sessionId: seed.sessionId,
        rawRef,
        type: "verification_event",
      }),
      ts,
      type: "verification_event",
      session_id: seed.sessionId,
      vendor: seed.vendor,
      adapter_version: "0.1.0",
      raw_ref: rawRef,
      payload: {
        kind: "gate",
        result: "fail",
        command_summary: "gate outcome fixture",
        stats: { failed_check_ids: seed.gateFailedCheckIds },
      },
    } as EventInput);
  }
  return events;
}

function seedSessions(store: Store, seeds: SessionSeed[]): void {
  for (const seed of seeds) {
    expect(store.append(sessionEvents(seed))).toBeGreaterThan(0);
  }
}

/** N post-install sessions for one vendor, one per hour, same model. */
function bulkSessions(
  vendor: string,
  count: number,
  model: string | undefined,
  prefix: string,
): SessionSeed[] {
  return Array.from({ length: count }, (_, index): SessionSeed => ({
    sessionId: `${prefix}-${index}`,
    vendor,
    startedAt: new Date(
      Date.parse(INSTALL_TS) + (index + 1) * 3_600_000,
    ).toISOString(),
    ...(model === undefined ? {} : { model }),
  }));
}

interface RecordOverrides {
  id?: string;
  scope?: CapabilityRecord["scope"];
  originSignature?: string | null;
  checkId?: string | null;
  repoRoot?: string | null;
  memoryId?: string | null;
  installedAt?: string | null;
  source?: CapabilityRecord["source"];
  type?: CapabilityRecord["type"];
}

function record(overrides: RecordOverrides = {}): CapabilityRecord {
  return {
    id: overrides.id ?? "workshop:prop-1",
    type: overrides.type ?? "memory",
    source: overrides.source ?? "workshop",
    title: "test capability",
    scope: overrides.scope ?? { level: "global", key: null },
    installedAt: overrides.installedAt === undefined
      ? INSTALL_TS
      : overrides.installedAt,
    originSignature: overrides.originSignature === undefined
      ? "sig:friction"
      : overrides.originSignature,
    originSessionIds: ["s-old"],
    proposalId: "prop-1",
    memoryId: overrides.memoryId ?? "mem-1",
    checkId: overrides.checkId ?? null,
    repoRoot: overrides.repoRoot ?? null,
  };
}

function registryOf(...records: CapabilityRecord[]): CapabilityRegistry {
  return { registryVersion: "1", records, diagnostics: [] };
}

function signalFor(
  sessionId: string,
  signature: string,
  ts: string,
): FrictionSignal {
  return {
    kind: "error",
    sessionId,
    eventId: `${sessionId}-signal`,
    ts,
    repo: null,
    agent: null,
    vendor: "claude-code",
    rawSignature: signature,
    signature,
    detail: "fixture signal",
  } as FrictionSignal;
}

function verdictFor(
  verdicts: DecayVerdict[],
  capabilityId: string,
  vendor: string,
): DecayVerdict {
  const found = verdicts.find(
    (candidate): boolean =>
      candidate.capabilityId === capabilityId && candidate.vendor === vendor,
  );
  if (found === undefined) {
    throw new Error(`no verdict for ${capabilityId} [${vendor}]`);
  }
  return found;
}

describe("runDecayAudit", (): void => {
  test("same capability splits per vendor: still_needed vs retirement_candidate", (): void => {
    const store = trackedStore();
    seedSessions(store, [
      // Pre-install model baseline for both vendors.
      {
        sessionId: "pre-a",
        vendor: "claude-code",
        startedAt: "2026-01-05T00:00:00.000Z",
        model: "claude-old",
      },
      {
        sessionId: "pre-b",
        vendor: "openclaw",
        startedAt: "2026-01-05T00:00:00.000Z",
        model: "claw-old",
      },
      ...bulkSessions("claude-code", 12, "claude-new", "cc"),
      ...bulkSessions("openclaw", 12, "claw-new", "oc"),
    ]);
    const report = runDecayAudit(
      store,
      registryOf(record()),
      undefined,
      {
        // Friction recurs only in claude-code sessions.
        extractSignals: (_store, sessionId): FrictionSignal[] =>
          sessionId.startsWith("cc-")
            ? [signalFor(sessionId, "sig:friction", "2026-01-11T00:00:00.000Z")]
            : [],
        now: (): Date => new Date("2026-02-01T00:00:00.000Z"),
      },
    );
    expect(report.limitation).toBe(DECAY_EVIDENCE_LIMITATION);
    const claude = verdictFor(report.verdicts, "workshop:prop-1", "claude-code");
    expect(claude.status).toBe("still_needed");
    expect(claude.evidence?.recurrenceCount).toBe(12);
    const claw = verdictFor(report.verdicts, "workshop:prop-1", "openclaw");
    expect(claw.status).toBe("retirement_candidate");
    expect(claw.evidence?.modelChanged).toBe(true);
    expect(claw.retirementAction).toBe("hyperagentd memory retire mem-1");
  });

  test("no recurrence but same model stays still_needed", (): void => {
    const store = trackedStore();
    seedSessions(store, [
      {
        sessionId: "pre",
        vendor: "claude-code",
        startedAt: "2026-01-05T00:00:00.000Z",
        model: "claude-same",
      },
      ...bulkSessions("claude-code", 12, "claude-same", "cc"),
    ]);
    const report = runDecayAudit(store, registryOf(record()), undefined, {
      extractSignals: (): FrictionSignal[] => [],
    });
    const only = verdictFor(report.verdicts, "workshop:prop-1", "claude-code");
    expect(only.status).toBe("still_needed");
    expect(only.reason).toContain("model has not changed");
    expect(only.evidence?.modelChanged).toBe(false);
  });

  test("missing model metadata makes outgrowth unverifiable, not claimable", (): void => {
    const store = trackedStore();
    seedSessions(store, [
      ...bulkSessions("codex", 12, undefined, "cx"),
    ]);
    const report = runDecayAudit(store, registryOf(record()), undefined, {
      extractSignals: (): FrictionSignal[] => [],
    });
    const only = verdictFor(report.verdicts, "workshop:prop-1", "codex");
    expect(only.status).toBe("still_needed");
    expect(only.evidence?.modelChanged).toBeNull();
    expect(only.reason).toContain("unverifiable");
  });

  test("below the session minimum is insufficient_data with counts named", (): void => {
    const store = trackedStore();
    seedSessions(store, bulkSessions("claude-code", 3, "claude-new", "cc"));
    const report = runDecayAudit(store, registryOf(record()), undefined, {
      extractSignals: (): FrictionSignal[] => [],
    });
    const only = verdictFor(report.verdicts, "workshop:prop-1", "claude-code");
    expect(only.status).toBe("insufficient_data");
    expect(only.reason).toContain("3 post-install");
    expect(only.reason).toContain(String(DEFAULT_MIN_POST_INSTALL_SESSIONS));
  });

  test("manual memory without a signature is unauditable", (): void => {
    const store = trackedStore();
    seedSessions(store, bulkSessions("claude-code", 12, "m", "cc"));
    const report = runDecayAudit(
      store,
      registryOf(
        record({
          id: "memory:mem-manual",
          source: "memory_store",
          originSignature: null,
        }),
      ),
      undefined,
      { extractSignals: (): FrictionSignal[] => [] },
    );
    const only = verdictFor(report.verdicts, "memory:mem-manual", "claude-code");
    expect(only.status).toBe("unauditable");
    expect(only.retirementAction).toBeNull();
  });

  test("agent-scoped capability is unauditable for other vendors", (): void => {
    const store = trackedStore();
    seedSessions(store, [
      ...bulkSessions("claude-code", 12, "m", "cc"),
      ...bulkSessions("codex", 12, "m", "cx"),
    ]);
    const report = runDecayAudit(
      store,
      registryOf(record({ scope: { level: "agent", key: "codex" } })),
      undefined,
      { extractSignals: (): FrictionSignal[] => [] },
    );
    const foreign = verdictFor(report.verdicts, "workshop:prop-1", "claude-code");
    expect(foreign.status).toBe("unauditable");
    expect(foreign.reason).toContain("not applicable");
    const home = verdictFor(report.verdicts, "workshop:prop-1", "codex");
    expect(home.status).not.toBe("unauditable");
  });

  test("gate check that still fails post-install is still_needed", (): void => {
    const store = trackedStore();
    const seeds = bulkSessions("claude-code", 12, "m", "cc");
    seeds[0] = { ...seeds[0]!, gateFailedCheckIds: ["unit-tests"] };
    seedSessions(store, seeds);
    const report = runDecayAudit(
      store,
      registryOf(
        record({
          id: "contract:repo-a#unit-tests",
          type: "contract_check",
          source: "contract",
          originSignature: null,
          checkId: "unit-tests",
          repoRoot: "repo-a",
          memoryId: null,
          installedAt: null,
        }),
      ),
      undefined,
      { extractSignals: (): FrictionSignal[] => [] },
    );
    const only = verdictFor(
      report.verdicts,
      "contract:repo-a#unit-tests",
      "claude-code",
    );
    expect(only.status).toBe("still_needed");
    expect(only.evidence?.gateFailureCount).toBe(1);
  });

  test("quiet contract check cannot claim outgrowth without an install date", (): void => {
    const store = trackedStore();
    seedSessions(store, bulkSessions("claude-code", 12, "m", "cc"));
    const report = runDecayAudit(
      store,
      registryOf(
        record({
          id: "contract:repo-a#unit-tests",
          type: "contract_check",
          source: "contract",
          originSignature: null,
          checkId: "unit-tests",
          repoRoot: "repo-a",
          memoryId: null,
          installedAt: null,
        }),
      ),
      undefined,
      { extractSignals: (): FrictionSignal[] => [] },
    );
    const only = verdictFor(
      report.verdicts,
      "contract:repo-a#unit-tests",
      "claude-code",
    );
    expect(only.status).toBe("still_needed");
    expect(only.reason).toContain("no install date");
  });

  test("scan cap is honest: capped flag plus diagnostic", (): void => {
    const store = trackedStore();
    seedSessions(store, [
      {
        sessionId: "pre",
        vendor: "claude-code",
        startedAt: "2026-01-05T00:00:00.000Z",
        model: "old",
      },
      ...bulkSessions("claude-code", 15, "new", "cc"),
    ]);
    const report = runDecayAudit(
      store,
      registryOf(record()),
      { minPostInstallSessions: 10, maxSessionsScanned: 12 },
      { extractSignals: (): FrictionSignal[] => [] },
    );
    const only = verdictFor(report.verdicts, "workshop:prop-1", "claude-code");
    expect(only.evidence?.scanCapped).toBe(true);
    expect(only.evidence?.scannedSessionCount).toBe(12);
    expect(only.evidence?.postInstallSessionCount).toBe(15);
    expect(
      report.diagnostics.some((line): boolean => line.includes("scan capped")),
    ).toBe(true);
  });

  test("audit is read-only over the event store", (): void => {
    const store = trackedStore();
    seedSessions(store, bulkSessions("claude-code", 12, "m", "cc"));
    const before = store.getSessions().length;
    runDecayAudit(store, registryOf(record()), undefined, {
      extractSignals: (): FrictionSignal[] => [],
    });
    expect(store.getSessions().length).toBe(before);
  });

  test("empty registry yields an empty, well-formed report", (): void => {
    const store = trackedStore();
    seedSessions(store, bulkSessions("claude-code", 2, "m", "cc"));
    const report = runDecayAudit(store, registryOf(), undefined, {
      now: (): Date => new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(report.verdicts).toHaveLength(0);
    expect(report.recordCount).toBe(0);
    expect(report.generatedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(JSON.stringify(report)).not.toContain("NaN");
  });

  test("rejects invalid options and deps", (): void => {
    const store = trackedStore();
    expect((): void => {
      runDecayAudit(store, registryOf(), { minPostInstallSessions: 0 });
    }).toThrow("positive integer");
    expect((): void => {
      runDecayAudit(
        store,
        registryOf(),
        undefined,
        [] as unknown as Record<string, never>,
      );
    }).toThrow("plain object");
  });
});
