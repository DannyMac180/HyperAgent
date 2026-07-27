import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  appendOutcome,
  GATE_OUTCOME_VERSION,
} from "../gate/spool.ts";
import type { GateOutcome } from "../gate/spool.ts";
import {
  gateDir,
  policyPath,
  rotatedSpoolPath,
  spoolPath,
} from "../gate/paths.ts";
import type {
  EventInput,
  VerificationEvent,
} from "../schema/events.ts";
import { deterministicEventId } from "../schema/ids.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import {
  GATE_ADAPTER_VERSION,
  ingestGateSpool,
  readGateHealth,
} from "./gate-ingest.ts";

const tempDirectories: string[] = [];
const stores: Store[] = [];

function makeTempDir(prefix: string): string {
  const directory: string = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function trackedStore(): Store {
  const store: Store = openStore(":memory:");
  stores.push(store);
  return store;
}

afterEach((): void => {
  for (const store of stores.splice(0).reverse()) {
    store.close();
  }
  for (const directory of tempDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function outcome(overrides: Partial<GateOutcome> = {}): GateOutcome {
  return {
    v: GATE_OUTCOME_VERSION,
    kind: "post_tool_use",
    ts: "2026-07-27T12:34:56.789Z",
    harness: "claude-code",
    sessionId: "claude-code:session-1",
    cwd: "/repo",
    decision: "allow",
    summary: "bun test passed",
    matchedRules: [],
    failedChecks: [],
    command: "bun test",
    passed: true,
    touchedFiles: ["/repo/src/index.ts"],
    ...overrides,
  };
}

function seedSession(
  store: Store,
  sessionId: string,
  ts = "2026-07-27T12:00:00.000Z",
): void {
  const rawRef = `fixture://${sessionId}`;
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
    vendor: sessionId.split(":")[0] ?? "unknown",
    adapter_version: "test",
    raw_ref: rawRef,
    payload: {},
  };
  expect(store.append(event)).toBe(1);
}

function verificationEvents(
  store: Store,
  sessionId: string,
): VerificationEvent[] {
  return store.getEvents(sessionId).flatMap(
    (event): VerificationEvent[] =>
      event.type === "verification_event" ? [event] : [],
  );
}

describe("ingestGateSpool", (): void => {
  test("maps allow, deny, and block outcomes to canonical gate verification events", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-gate-ingest-map-");
    const store: Store = trackedStore();
    const sessionId = "claude-code:mapping";
    seedSession(store, sessionId);
    const sharedTs = "2026-07-27T12:34:56.789Z";
    const allow: GateOutcome = outcome({
      sessionId,
      ts: sharedTs,
      summary: "allow summary",
      decision: "allow",
      kind: "pre_tool_use",
      matchedRules: ["flag-secrets"],
    });
    const deny: GateOutcome = outcome({
      sessionId,
      ts: sharedTs,
      summary: "deny summary",
      decision: "deny",
      kind: "pre_tool_use",
      matchedRules: ["deny-publish"],
    });
    const block: GateOutcome = outcome({
      sessionId,
      ts: "2026-07-27T12:34:57.789Z",
      summary: "block summary",
      decision: "block",
      kind: "stop",
      failedChecks: ["bun test", "bunx tsc --noEmit"],
    });
    expect(await appendOutcome(dataDir, allow)).toBe(true);
    expect(await appendOutcome(dataDir, deny)).toBe(true);
    expect(await appendOutcome(dataDir, block)).toBe(true);

    const result = await ingestGateSpool({ store, dataDir });
    const events: VerificationEvent[] = verificationEvents(store, sessionId);
    const bySummary = new Map(
      events.map(
        (event: VerificationEvent): [unknown, VerificationEvent] => [
          event.payload.command_summary,
          event,
        ],
      ),
    );

    expect(result).toEqual({
      outcomesRead: 3,
      eventsAppended: 3,
      parkedUnknownSession: 0,
      malformedLines: 0,
    });
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event: VerificationEvent): string => event.id)).size)
      .toBe(3);
    expect(bySummary.get("allow summary")?.payload.result).toBe("pass");
    expect(bySummary.get("deny summary")?.payload.result).toBe("fail");
    expect(bySummary.get("block summary")?.payload.result).toBe("fail");

    const allowEvent = bySummary.get("allow summary");
    if (allowEvent === undefined) {
      throw new Error("Expected mapped allow event");
    }
    expect(allowEvent).toMatchObject({
      ts: sharedTs,
      type: "verification_event",
      session_id: sessionId,
      vendor: "claude-code",
      adapter_version: GATE_ADAPTER_VERSION,
      payload: {
        kind: "gate",
        command_digest: createHash("sha256")
          .update("allow summary")
          .digest("hex"),
        command_summary: "allow summary",
        result: "pass",
        stats: {
          outcome_kind: "pre_tool_use",
          matched_rule_ids: ["flag-secrets"],
          failed_check_ids: [],
        },
        initiated_by: "suit",
      },
    });
    expect(allowEvent.raw_ref).toStartWith(`${spoolPath(dataDir)}#`);
    expect(allowEvent.raw_ref?.split("#").at(-1)).toMatch(/^[a-f0-9]{64}$/);

    expect((): void => {
      store.db.run("UPDATE events SET ts = ts");
    }).toThrow("events is append-only");
    expect((): void => {
      store.db.run("DELETE FROM events");
    }).toThrow("events is append-only");
  });

  test("deduplicates a re-spooled outcome with a deterministic event id", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-gate-ingest-idempotent-");
    const store: Store = trackedStore();
    const sessionId = "claude-code:idempotent";
    const repeated: GateOutcome = outcome({ sessionId });
    seedSession(store, sessionId);
    expect(await appendOutcome(dataDir, repeated)).toBe(true);

    const first = await ingestGateSpool({ store, dataDir });
    expect(await appendOutcome(dataDir, repeated)).toBe(true);
    const second = await ingestGateSpool({ store, dataDir });

    expect(first.eventsAppended).toBe(1);
    expect(second.outcomesRead).toBe(1);
    expect(second.eventsAppended).toBe(0);
    expect(verificationEvents(store, sessionId)).toHaveLength(1);
  });

  test("parks unknown sessions, removes ingested lines, and retries after observer evidence arrives", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-gate-ingest-park-");
    const store: Store = trackedStore();
    const knownSession = "claude-code:known";
    const unknownSession = "claude-code:unknown";
    seedSession(store, knownSession);
    const known: GateOutcome = outcome({
      sessionId: knownSession,
      summary: "known outcome",
    });
    const parked: GateOutcome = outcome({
      sessionId: unknownSession,
      summary: "parked outcome",
    });
    expect(await appendOutcome(dataDir, known)).toBe(true);
    expect(await appendOutcome(dataDir, parked)).toBe(true);

    const first = await ingestGateSpool({ store, dataDir });
    const remainingAfterFirst: string = readFileSync(
      spoolPath(dataDir),
      "utf8",
    );

    expect(first).toEqual({
      outcomesRead: 2,
      eventsAppended: 1,
      parkedUnknownSession: 1,
      malformedLines: 0,
    });
    expect(remainingAfterFirst).toBe(`${JSON.stringify(parked)}\n`);
    expect(remainingAfterFirst).not.toContain("known outcome");
    expect(verificationEvents(store, unknownSession)).toHaveLength(0);

    seedSession(store, unknownSession);
    const second = await ingestGateSpool({ store, dataDir });

    expect(second).toEqual({
      outcomesRead: 1,
      eventsAppended: 1,
      parkedUnknownSession: 0,
      malformedLines: 0,
    });
    expect(verificationEvents(store, unknownSession)).toHaveLength(1);
    expect(readFileSync(spoolPath(dataDir), "utf8")).toBe("");
  });

  test("ingests a pre-existing rotated generation and discards it afterward", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-gate-ingest-rotated-");
    const store: Store = trackedStore();
    const sessionId = "claude-code:rotated";
    const rotated: GateOutcome = outcome({
      sessionId,
      summary: "from rotated generation",
    });
    seedSession(store, sessionId);
    mkdirSync(gateDir(dataDir), { recursive: true });
    writeFileSync(
      rotatedSpoolPath(dataDir),
      `${JSON.stringify(rotated)}\n`,
      "utf8",
    );

    const result = await ingestGateSpool({ store, dataDir });

    expect(result.eventsAppended).toBe(1);
    expect(verificationEvents(store, sessionId)).toHaveLength(1);
    expect(existsSync(rotatedSpoolPath(dataDir))).toBe(false);
  });

  test("counts malformed lines without blocking valid outcomes in the same spool", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-gate-ingest-malformed-");
    const store: Store = trackedStore();
    const sessionId = "claude-code:malformed";
    const valid: GateOutcome = outcome({
      sessionId,
      summary: "valid after malformed",
    });
    seedSession(store, sessionId);
    mkdirSync(gateDir(dataDir), { recursive: true });
    writeFileSync(
      spoolPath(dataDir),
      `{not json}\n${JSON.stringify(valid)}\n`,
      "utf8",
    );

    const result = await ingestGateSpool({ store, dataDir });

    expect(result).toEqual({
      outcomesRead: 1,
      eventsAppended: 1,
      parkedUnknownSession: 0,
      malformedLines: 1,
    });
    expect(verificationEvents(store, sessionId)).toHaveLength(1);
  });
});

describe("readGateHealth", (): void => {
  test("reports default and invalid policy states, backlog bytes, and repo status", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-gate-health-data-");
    const repo: string = makeTempDir("hyperagent-gate-health-repo-");
    expect(await appendOutcome(dataDir, outcome())).toBe(true);

    const defaultHealth = await readGateHealth({
      dataDir,
      repos: [repo],
    });

    expect(defaultHealth.policyState).toBe("default");
    expect(defaultHealth.policyError).toBeUndefined();
    expect(defaultHealth.spoolBacklogBytes).toBeGreaterThan(0);
    expect(defaultHealth.repos).toHaveLength(1);
    expect(defaultHealth.repos[0]).toMatchObject({
      repo,
      state: "not-installed",
    });
    expect(defaultHealth.repos[0]?.detail.length).toBeGreaterThan(0);

    writeFileSync(policyPath(dataDir), "{not json", "utf8");
    const invalidHealth = await readGateHealth({
      dataDir,
      repos: [repo],
    });

    expect(invalidHealth.policyState).toBe("invalid");
    expect(invalidHealth.policyError).toContain("POLICY_JSON_ERROR");
    expect(invalidHealth.spoolBacklogBytes).toBeGreaterThan(0);
    expect(invalidHealth.repos[0]?.state).toBe("not-installed");
  });
});

describe("daemon gate authority boundary", (): void => {
  test("daemon source cannot install or uninstall persistent hooks", (): void => {
    // ISC-22: hook installation is a human-review authority boundary. This
    // source-text guard prevents a future daemon refactor from crossing it.
    const ingestSource: string = readFileSync(
      new URL("./ingest.ts", import.meta.url),
      "utf8",
    );
    const gateIngestSource: string = readFileSync(
      new URL("./gate-ingest.ts", import.meta.url),
      "utf8",
    );

    for (const source of [ingestSource, gateIngestSource]) {
      expect(source).not.toContain(".install(");
      expect(source).not.toContain(".uninstall(");
    }
  });
});
