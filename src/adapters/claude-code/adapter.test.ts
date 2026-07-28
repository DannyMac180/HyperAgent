import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateEnvelope } from "../../schema/events.ts";
import type { EventInput } from "../../schema/events.ts";
import { openStore } from "../../store/store.ts";
import type { DiscoveredSession, ParseResult } from "../types.ts";
import { ClaudeCodeAdapter } from "./adapter.ts";

const BASIC_UUID = "11111111-1111-4111-8111-111111111111";
const SIDECHAIN_UUID = "22222222-2222-4222-8222-222222222222";
const MALFORMED_UUID = "33333333-3333-4333-8333-333333333333";
const TRUNCATED_UUID = "44444444-4444-4444-8444-444444444444";
const FALLBACK_UUID = "55555555-5555-4555-8555-555555555555";
const FIXTURE_UUIDS = [
  BASIC_UUID,
  SIDECHAIN_UUID,
  MALFORMED_UUID,
  TRUNCATED_UUID,
] as const;
const PROJECTS_ROOT = join(import.meta.dir, "fixtures", "projects");
const PROJECT_ROOT = join(PROJECTS_ROOT, "-home-user-project");
const adapter = new ClaudeCodeAdapter({ projectsRoot: PROJECTS_ROOT });
const tempDirectories: string[] = [];

function payloadOf(event: EventInput): Record<string, unknown> {
  return event.payload ?? {};
}

async function fixtureSession(uuid: string): Promise<DiscoveredSession> {
  const session = (await adapter.discoverSessions()).find(
    (candidate: DiscoveredSession): boolean =>
      candidate.sessionId === `claude-code:${uuid}`,
  );
  expect(session).toBeDefined();
  if (session === undefined) {
    throw new Error(`fixture session ${uuid} was not discovered`);
  }
  return session;
}

async function parseFixture(uuid: string): Promise<ParseResult> {
  return adapter.parseSession(await fixtureSession(uuid), "");
}

afterAll((): void => {
  for (const directory of tempDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ClaudeCodeAdapter", (): void => {
  test("discoverSessions returns sorted fixture metadata", async (): Promise<void> => {
    const sessions = await adapter.discoverSessions();
    const expectedPaths = FIXTURE_UUIDS.map(
      (uuid: string): string => join(PROJECT_ROOT, `${uuid}.jsonl`),
    ).sort();

    expect(sessions.map((session): string => session.sessionId)).toEqual(
      FIXTURE_UUIDS.map((uuid: string): string => `claude-code:${uuid}`),
    );
    expect(sessions.map((session): string => session.path)).toEqual(
      expectedPaths,
    );
    expect(sessions.map((session): string => session.path)).toEqual(
      sessions.map((session): string => session.path).sort(),
    );
    for (const session of sessions) {
      expect(session.mtimeMs).toBeGreaterThan(0);
      expect(session.sizeBytes).toBeGreaterThan(0);
    }
  });

  test("fully parses the basic session into the expected sorted events", async (): Promise<void> => {
    const { events } = await parseFixture(BASIC_UUID);
    const expectedTypes = [
      "completion_claim",
      "completion_claim",
      "error",
      "error",
      "session_start",
      "tool_call",
      "tool_call",
      "turn_end",
      "turn_start",
      "verification_event",
    ];

    expect(events).toHaveLength(10);
    expect(events.map((event): string => event.type).sort()).toEqual(
      expectedTypes,
    );
    expect(events.map((event): string => event.id)).toEqual(
      [...events]
        .sort(
          (left, right): number =>
            left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id),
        )
        .map((event): string => event.id),
    );

    const start = events.find((event): boolean => event.type === "session_start");
    expect(start).toBeDefined();
    if (start === undefined) {
      throw new Error("basic session has no session_start");
    }
    expect(payloadOf(start)).toMatchObject({
      agent: "claude-code",
      model: "claude-opus-4",
      harness_version: "1.0.42",
      repo: "/home/user/project",
      cwd: "/home/user/project",
      git_branch: "main",
      parent_session_id: null,
    });
  });

  test("pairs tool calls with results, durations, files, and tool errors", async (): Promise<void> => {
    const { events } = await parseFixture(BASIC_UUID);
    const readCall = events.find(
      (event): boolean =>
        event.type === "tool_call" && payloadOf(event).name === "Read",
    );
    const bashCall = events.find(
      (event): boolean =>
        event.type === "tool_call" && payloadOf(event).name === "Bash",
    );
    expect(readCall).toBeDefined();
    expect(bashCall).toBeDefined();
    if (readCall === undefined || bashCall === undefined) {
      throw new Error("expected paired Read and Bash tool calls");
    }

    expect(payloadOf(readCall)).toMatchObject({
      status: "ok",
      duration_ms: 2500,
      files_touched: ["src/index.ts"],
    });
    expect(payloadOf(bashCall).status).toBe("error");

    const toolError = events.find(
      (event): boolean =>
        event.type === "error" &&
        payloadOf(event).source === "tool" &&
        payloadOf(event).tool_call_id === bashCall.id,
    );
    expect(toolError).toBeDefined();
    expect(payloadOf(toolError!).tool_call_id).toBe(bashCall.id);
  });

  test("emits one failed test verification event", async (): Promise<void> => {
    const { events } = await parseFixture(BASIC_UUID);
    const verificationEvents = events.filter(
      (event): boolean => event.type === "verification_event",
    );
    expect(verificationEvents).toHaveLength(1);
    expect(payloadOf(verificationEvents[0]!)).toMatchObject({
      kind: "test",
      result: "fail",
      initiated_by: "agent",
    });
  });

  test("extracts both completion claims with their claim kinds", async (): Promise<void> => {
    const { events } = await parseFixture(BASIC_UUID);
    const claims = events
      .filter((event): boolean => event.type === "completion_claim")
      .map((event): Record<string, unknown> => payloadOf(event));

    expect(claims).toHaveLength(2);
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim_text: "All tests pass now.",
          claim_kind: "tests_pass",
        }),
        expect.objectContaining({
          claim_text: "Fixed the parser.",
          claim_kind: "fixed",
        }),
      ]),
    );
  });

  test("skips noise line types but emits system harness errors", async (): Promise<void> => {
    const { events, skippedUnknown } = await parseFixture(BASIC_UUID);
    const noiseLineNumbers = new Set(["4", "5", "6", "7"]);

    expect(skippedUnknown).toBeGreaterThanOrEqual(4);
    expect(
      events.some((event): boolean => {
        const line = event.raw_ref?.match(/#L(\d+)$/)?.[1];
        return line !== undefined && noiseLineNumbers.has(line);
      }),
    ).toBe(false);
    const harnessError = events.find(
      (event): boolean =>
        event.type === "error" && payloadOf(event).source === "harness",
    );
    expect(harnessError).toBeDefined();
    expect(payloadOf(harnessError!).tool_call_id).toBeNull();
  });

  test("counts malformed known lines without throwing", async (): Promise<void> => {
    const result = await parseFixture(MALFORMED_UUID);
    expect(result.parseFailures).toBeGreaterThanOrEqual(1);
    expect(result.events.some((event): boolean => event.type === "session_start"))
      .toBe(true);
  });

  test("leaves a truncated line for a resumed parse", async (): Promise<void> => {
    const source = await fixtureSession(TRUNCATED_UUID);
    const directory = mkdtempSync(join(tmpdir(), "claude-adapter-"));
    tempDirectories.push(directory);
    const path = join(directory, `${TRUNCATED_UUID}.jsonl`);
    copyFileSync(source.path, path);
    const metadata = statSync(path);
    const copiedSession: DiscoveredSession = {
      ...source,
      path,
      mtimeMs: metadata.mtimeMs,
      sizeBytes: metadata.size,
    };

    const initial = await adapter.parseSession(copiedSession, "");
    expect(
      initial.events.some(
        (event): boolean => event.ts === "2026-07-26T15:00:02.000Z",
      ),
    ).toBe(false);

    appendFileSync(path, "}\n");
    const resumed = await adapter.parseSession(
      copiedSession,
      initial.resumeToken,
    );
    expect(resumed.events.map((event): string => event.type).sort()).toEqual([
      "completion_claim",
      "turn_end",
    ]);
    expect(
      resumed.events.every(
        (event): boolean => event.ts === "2026-07-26T15:00:02.000Z",
      ),
    ).toBe(true);
  });

  test("generates deterministic ids across complete re-parses", async (): Promise<void> => {
    const session = await fixtureSession(BASIC_UUID);
    const first = await adapter.parseSession(session, "");
    const second = await adapter.parseSession(session, "");
    expect(first.events.map((event): string => event.id)).toEqual(
      second.events.map((event): string => event.id),
    );
  });

  test("prefers content session ids for raw refs without changing session_id", async (): Promise<void> => {
    // All local fixture I/O is bounded by Bun's per-test timeout.
    const source: DiscoveredSession = await fixtureSession(BASIC_UUID);
    const directory: string = mkdtempSync(join(tmpdir(), "claude-adapter-id-"));
    tempDirectories.push(directory);
    const path: string = join(directory, `${FALLBACK_UUID}.jsonl`);
    copyFileSync(source.path, path);
    const metadata = statSync(path);
    const session: DiscoveredSession = {
      sessionId: `claude-code:${FALLBACK_UUID}`,
      path,
      mtimeMs: metadata.mtimeMs,
      sizeBytes: metadata.size,
    };

    const { events } = await adapter.parseSession(session, "");
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.every(
        (event): boolean =>
          typeof event.raw_ref === "string"
          && event.raw_ref.startsWith(`claude-code:${BASIC_UUID}#L`),
      ),
    ).toBe(true);
    expect(
      events.every(
        (event): boolean =>
          event.session_id === `claude-code:${FALLBACK_UUID}`,
      ),
    ).toBe(true);
  });

  test("prefers content sessionId over content leafUuid for raw refs", async (): Promise<void> => {
    const directory: string = mkdtempSync(
      join(tmpdir(), "claude-adapter-leaf-"),
    );
    tempDirectories.push(directory);
    const path: string = join(directory, `${FALLBACK_UUID}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "user",
        leafUuid: BASIC_UUID,
        sessionId: SIDECHAIN_UUID,
        timestamp: "2026-07-26T12:00:00.000Z",
        message: {
          role: "user",
          content: "fixture request",
        },
      })}\n`,
      "utf8",
    );
    const metadata = statSync(path);
    const session: DiscoveredSession = {
      sessionId: `claude-code:${FALLBACK_UUID}`,
      path,
      mtimeMs: metadata.mtimeMs,
      sizeBytes: metadata.size,
    };

    // Local fixture parsing is bounded by Bun's per-test timeout.
    const { events } = await adapter.parseSession(session, "");
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.every(
        (event): boolean =>
          event.raw_ref === `claude-code:${SIDECHAIN_UUID}#L1`,
      ),
    ).toBe(true);
  });

  test("uses content leafUuid when content sessionId is absent", async (): Promise<void> => {
    const directory: string = mkdtempSync(
      join(tmpdir(), "claude-adapter-leaf-only-"),
    );
    tempDirectories.push(directory);
    const path: string = join(directory, `${FALLBACK_UUID}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "user",
        leafUuid: BASIC_UUID,
        timestamp: "2026-07-26T12:00:00.000Z",
        message: {
          role: "user",
          content: "fixture request",
        },
      })}\n`,
      "utf8",
    );
    const metadata = statSync(path);
    const session: DiscoveredSession = {
      sessionId: `claude-code:${FALLBACK_UUID}`,
      path,
      mtimeMs: metadata.mtimeMs,
      sizeBytes: metadata.size,
    };

    // Local fixture parsing is bounded by Bun's per-test timeout.
    const { events } = await adapter.parseSession(session, "");
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.every(
        (event): boolean =>
          event.raw_ref === `claude-code:${BASIC_UUID}#L1`,
      ),
    ).toBe(true);
  });

  test("falls back to the filename session id when content has no uuid", async (): Promise<void> => {
    const directory: string = mkdtempSync(
      join(tmpdir(), "claude-adapter-fallback-"),
    );
    tempDirectories.push(directory);
    const path: string = join(directory, `${FALLBACK_UUID}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "system",
        subtype: "error",
        timestamp: "2026-07-26T12:00:00.000Z",
        message: "fixture error",
      })}\n`,
      "utf8",
    );
    const metadata = statSync(path);
    const session: DiscoveredSession = {
      sessionId: `claude-code:${FALLBACK_UUID}`,
      path,
      mtimeMs: metadata.mtimeMs,
      sizeBytes: metadata.size,
    };

    // Local fixture parsing is bounded by Bun's per-test timeout.
    const { events } = await adapter.parseSession(session, "");
    expect(events).toHaveLength(1);
    expect(events[0]?.raw_ref).toBe(`claude-code:${FALLBACK_UUID}#L1`);
  });

  test("round-trips adapter events through the idempotent store", async (): Promise<void> => {
    const { events } = await parseFixture(BASIC_UUID);
    const store = openStore(":memory:");
    try {
      expect(store.append(events)).toBe(events.length);
      expect(store.append(events)).toBe(0);
    } finally {
      store.close();
    }
  });

  test("marks every non-start sidechain event", async (): Promise<void> => {
    const { events } = await parseFixture(SIDECHAIN_UUID);
    const nonStartEvents = events.filter(
      (event): boolean => event.type !== "session_start",
    );
    expect(nonStartEvents.length).toBeGreaterThan(0);
    for (const event of nonStartEvents) {
      expect(payloadOf(event).is_sidechain).toBe(true);
    }
  });

  test("emits only schema-valid envelopes", async (): Promise<void> => {
    const results = await Promise.all(
      FIXTURE_UUIDS.map((uuid: string): Promise<ParseResult> =>
        parseFixture(uuid),
      ),
    );
    const events = results.flatMap((result): EventInput[] => result.events);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(validateEnvelope(event)).toEqual([]);
    }
  });
});
