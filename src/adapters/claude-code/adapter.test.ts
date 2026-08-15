import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
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
// Fixture transcripts name directories that don't exist on the test machine,
// so git-root resolution is stubbed: the fixture project IS a git root. This
// exercises the attribution path (repo = git root of the evidence) while
// keeping parses byte-deterministic on any machine.
const stubGitRootResolver = (dir: string): string | null =>
  dir === "/home/user/project" || dir.startsWith("/home/user/project/")
    ? "/home/user/project"
    : null;
const adapter = new ClaudeCodeAdapter({
  projectsRoot: PROJECTS_ROOT,
  gitRootResolver: stubGitRootResolver,
});
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

describe("ClaudeCodeAdapter repo attribution (DAN-225)", (): void => {
  const HOME = "/home/user";
  const TOOL_REPO = "/home/user/dev/tool";
  const attributionAdapter = (projectsRoot: string): ClaudeCodeAdapter =>
    new ClaudeCodeAdapter({
      projectsRoot,
      gitRootResolver: (dir: string): string | null =>
        dir === TOOL_REPO || dir.startsWith(`${TOOL_REPO}/`)
          ? TOOL_REPO
          : null,
    });

  const UUID = "66666666-6666-4666-8666-666666666666";

  function transcriptLine(
    index: number,
    body: Record<string, unknown>,
  ): string {
    return JSON.stringify({
      uuid: `60000000-0000-4000-8000-00000000000${index}`,
      parentUuid: null,
      sessionId: UUID,
      timestamp: `2026-08-15T12:00:0${index}.000Z`,
      cwd: HOME,
      gitBranch: "main",
      version: "1.0.42",
      isSidechain: false,
      ...body,
    });
  }

  function writeSession(lines: string[]): DiscoveredSession {
    const directory = mkdtempSync(join(tmpdir(), "claude-attribution-"));
    tempDirectories.push(directory);
    const projectsRoot = join(directory, "projects");
    const projectPath = join(projectsRoot, "-home-user");
    mkdirSync(projectPath, { recursive: true });
    const path = join(projectPath, `${UUID}.jsonl`);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    const metadata = statSync(path);
    return {
      sessionId: `claude-code:${UUID}`,
      path,
      mtimeMs: metadata.mtimeMs,
      sizeBytes: metadata.size,
    };
  }

  const editLine = (index: number, filePath: string): string =>
    transcriptLine(index, {
      type: "assistant",
      message: {
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: `toolu_attr_${index}`,
            name: "Edit",
            input: { file_path: filePath, old_string: "a", new_string: "b" },
          },
        ],
        stop_reason: null,
      },
    });

  test("home-launched session attributes to the dominant mutation root", async (): Promise<void> => {
    const session = writeSession([
      transcriptLine(1, {
        type: "user",
        message: { role: "user", content: "upgrade the tool" },
      }),
      editLine(2, `${TOOL_REPO}/src/a.ts`),
      editLine(3, `${TOOL_REPO}/src/b.ts`),
    ]);
    const adapter = attributionAdapter(
      join(session.path, "..", "..", ".."),
    );
    const result = await adapter.parseSession(session, "");
    expect(result.sessionRepo).toBe(TOOL_REPO);
    const start = result.events.find(
      (event): boolean => event.type === "session_start",
    );
    expect(start).toBeDefined();
    expect(payloadOf(start!).repo).toBe(TOOL_REPO);
    expect(payloadOf(start!).cwd).toBe(HOME);
  });

  test("session with no derivable repo omits repo and reports null", async (): Promise<void> => {
    const session = writeSession([
      transcriptLine(1, {
        type: "user",
        message: { role: "user", content: "just a chat" },
      }),
    ]);
    const adapter = attributionAdapter(
      join(session.path, "..", "..", ".."),
    );
    const result = await adapter.parseSession(session, "");
    expect(result.sessionRepo).toBeNull();
    const start = result.events.find(
      (event): boolean => event.type === "session_start",
    );
    expect(start).toBeDefined();
    expect("repo" in payloadOf(start!)).toBe(false);
    expect(payloadOf(start!).cwd).toBe(HOME);
  });

  test("two-chunk incremental parse derives the same repo as one chunk", async (): Promise<void> => {
    const firstChunk = [
      transcriptLine(1, {
        type: "user",
        message: { role: "user", content: "upgrade the tool" },
      }),
    ];
    const laterLines = [
      editLine(2, `${TOOL_REPO}/src/a.ts`),
      editLine(3, `${TOOL_REPO}/src/b.ts`),
    ];
    const session = writeSession(firstChunk);
    const adapter = attributionAdapter(
      join(session.path, "..", "..", ".."),
    );

    const first = await adapter.parseSession(session, "");
    // Evidence so far is the home cwd alone — honestly nothing.
    expect(first.sessionRepo).toBeNull();

    appendFileSync(session.path, `${laterLines.join("\n")}\n`);
    const metadata = statSync(session.path);
    const grown: DiscoveredSession = {
      ...session,
      mtimeMs: metadata.mtimeMs,
      sizeBytes: metadata.size,
    };
    const second = await adapter.parseSession(grown, first.resumeToken);
    // The prefix re-scan makes the incremental result equal the full parse.
    expect(second.sessionRepo).toBe(TOOL_REPO);

    const full = await adapter.parseSession(grown, "");
    expect(full.sessionRepo).toBe(TOOL_REPO);
  });
});
