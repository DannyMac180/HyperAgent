import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { validateEnvelope } from "../../schema/events.ts";
import type { EventInput } from "../../schema/events.ts";
import { openStore } from "../../store/store.ts";
import type { DiscoveredSession, ParseResult } from "../types.ts";
import {
  CODEX_DIALECT_VERSION,
  CodexAdapter,
} from "./adapter.ts";

const SESSION_ID = "019fa5f0-6957-78d0-9868-36288b2274cb";
const LEGACY_SESSION_ID = "019c0a57-c4dc-7e03-ab01-5f285cdb818a";
const tempDirectories: string[] = [];

function line(
  timestamp: string,
  type: string,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({ timestamp, type, payload });
}

function sessionMeta(
  nativeSessionId = SESSION_ID,
  cliVersion = "0.144.2",
  options?: { legacyIdOnly?: boolean; baseInstructions?: string },
): string {
  return line("2026-07-27T20:00:00.000Z", "session_meta", {
    ...(options?.legacyIdOnly
      ? { id: nativeSessionId }
      : { session_id: nativeSessionId, id: nativeSessionId }),
    timestamp: "2026-07-27T20:00:00.000Z",
    cwd: "/work/project",
    originator: "Codex Desktop",
    cli_version: cliVersion,
    source: "vscode",
    thread_source: "user",
    model_provider: "openai",
    git: { branch: "feature/codex-observe" },
    base_instructions: {
      text: options?.baseInstructions ?? "PRIVATE-BASE-INSTRUCTIONS",
    },
  });
}

function basicRollout(): string {
  return [
    sessionMeta(),
    line("2026-07-27T20:00:00.100Z", "event_msg", {
      type: "task_started",
      turn_id: "turn-1",
      model_context_window: 200_000,
    }),
    line("2026-07-27T20:00:00.200Z", "event_msg", {
      type: "user_message",
      message: "Fix the parser",
      images: [],
      local_images: [],
      text_elements: [],
    }),
    line("2026-07-27T20:00:01.000Z", "response_item", {
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: "bun test",
        workdir: "/work/project",
      }),
      call_id: "call-function",
    }),
    line("2026-07-27T20:00:03.500Z", "response_item", {
      type: "function_call_output",
      call_id: "call-function",
      output:
        "Process exited with code 1\nBearer secret-value\npassword=hunter2",
    }),
    line("2026-07-27T20:00:04.000Z", "response_item", {
      type: "custom_tool_call",
      status: "completed",
      call_id: "call-custom",
      name: "apply_patch",
      input:
        "*** Begin Patch\n*** Update File: /work/project/src/parser.ts\n*** End Patch\n",
    }),
    line("2026-07-27T20:00:04.250Z", "response_item", {
      type: "custom_tool_call_output",
      call_id: "call-custom",
      output: "Exit code: 0\nSuccess.",
    }),
    line("2026-07-27T20:00:05.000Z", "response_item", {
      type: "tool_search_call",
      call_id: "call-search",
      status: "completed",
      execution: "client",
      arguments: { query: "calendar events", limit: 5 },
    }),
    line("2026-07-27T20:00:05.100Z", "response_item", {
      type: "tool_search_output",
      call_id: "call-search",
      status: "completed",
      execution: "client",
      tools: [{ type: "function", name: "search_events" }],
    }),
    line("2026-07-27T20:00:06.000Z", "event_msg", {
      type: "agent_message",
      message: "Fixed the parser. All tests pass now.",
      phase: "final_answer",
    }),
    line("2026-07-27T20:00:06.100Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 10, output_tokens: 20 } },
      rate_limits: null,
    }),
    line("2026-07-27T20:00:06.200Z", "event_msg", {
      type: "task_complete",
      turn_id: "turn-1",
      last_agent_message: "Fixed the parser. All tests pass now.",
    }),
    line("2026-07-27T20:00:06.300Z", "event_msg", {
      type: "thread_settings_applied",
      thread_settings: { model: "gpt-5" },
    }),
    line("2026-07-27T20:00:06.400Z", "turn_context", {
      turn_id: "turn-1",
      cwd: "/work/project",
      model: "gpt-5",
    }),
    line("2026-07-27T20:00:06.500Z", "world_state", {
      full: true,
      state: {},
    }),
    line("2026-07-27T20:00:06.600Z", "response_item", {
      type: "reasoning",
      summary: [],
      encrypted_content: "opaque",
    }),
    line("2026-07-27T20:00:06.700Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "duplicate" }],
    }),
  ].join("\n") + "\n";
}

function makeTempDirectory(prefix = "codex-adapter-"): string {
  const directory: string = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function writeRollout(
  root: string,
  nativeSessionId: string,
  contents: string,
  date = "2026/07/27",
): string {
  const path: string = join(
    root,
    date,
    `rollout-2026-07-27T16-00-00-${nativeSessionId}.jsonl`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
  return path;
}

function discoveredFor(
  path: string,
  nativeSessionId = SESSION_ID,
): DiscoveredSession {
  const metadata = statSync(path);
  return {
    sessionId: `codex:${nativeSessionId}`,
    path,
    mtimeMs: metadata.mtimeMs,
    sizeBytes: metadata.size,
  };
}

function payloadOf(event: EventInput): Record<string, unknown> {
  return event.payload ?? {};
}

async function basicFixture(): Promise<{
  adapter: CodexAdapter;
  session: DiscoveredSession;
  result: ParseResult;
  root: string;
}> {
  const root: string = makeTempDirectory();
  const path: string = writeRollout(root, SESSION_ID, basicRollout());
  // The fixture cwd doesn't exist on the test machine; stub it as a git root
  // so the attribution path runs deterministically (see adapters/attribution.ts).
  const adapter = new CodexAdapter({
    sessionsRoot: root,
    gitRootResolver: (dir: string): string | null =>
      dir === "/work/project" || dir.startsWith("/work/project/")
        ? "/work/project"
        : null,
  });
  const sessions: DiscoveredSession[] = await adapter.discoverSessions();
  expect(sessions).toHaveLength(1);
  const session: DiscoveredSession | undefined = sessions[0];
  if (session === undefined) {
    throw new Error("basic fixture was not discovered");
  }
  return {
    adapter,
    session,
    result: await adapter.parseSession(session, ""),
    root,
  };
}

afterAll((): void => {
  for (const directory of tempDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CodexAdapter discovery and health", (): void => {
  test("detects the root and reports the newest rollout cli version", async (): Promise<void> => {
    const root: string = makeTempDirectory();
    const legacyPath: string = writeRollout(
      root,
      LEGACY_SESSION_ID,
      `${sessionMeta(LEGACY_SESSION_ID, "0.89.0", {
        legacyIdOnly: true,
      })}\n`,
      "2026/01/29",
    );
    const currentPath: string = writeRollout(
      root,
      SESSION_ID,
      `${sessionMeta()}\n`,
    );
    utimesSync(legacyPath, new Date(1_000), new Date(1_000));
    utimesSync(currentPath, new Date(2_000), new Date(2_000));

    const adapter = new CodexAdapter({ sessionsRoot: root });
    const health = await adapter.detect();
    expect(health).toMatchObject({
      status: "ok",
      harnessVersion: "0.144.2",
    });
    expect(health.detail).toContain("2 session rollouts");
    expect(health.detail).toContain("skipped 0");
  });

  test("returns unavailable for an absent sessions root", async (): Promise<void> => {
    const root: string = join(makeTempDirectory(), "absent");
    const adapter = new CodexAdapter({ sessionsRoot: root });
    const health = await adapter.detect();
    expect(health.status).toBe("unavailable");
    expect(health.harnessVersion).toBeNull();
    expect(health.detail).toContain(root);
    expect(await adapter.discoverSessions()).toEqual([]);
  });

  test("reports an existing empty root as available with no harness version", async (): Promise<void> => {
    const root: string = makeTempDirectory();
    const health = await new CodexAdapter({ sessionsRoot: root }).detect();
    expect(health).toMatchObject({
      status: "ok",
      harnessVersion: null,
    });
    expect(health.detail).toContain("0 session rollouts");
  });

  test("discovers native ids from session_meta and skips malformed first lines", async (): Promise<void> => {
    const root: string = makeTempDirectory();
    writeRollout(root, SESSION_ID, `${sessionMeta()}\n`);
    writeRollout(
      root,
      LEGACY_SESSION_ID,
      `${sessionMeta(LEGACY_SESSION_ID, "0.89.0", {
        legacyIdOnly: true,
      })}\n`,
      "2026/01/29",
    );
    writeRollout(
      root,
      "malformed",
      '{"timestamp":"2026-07-27T20:00:00.000Z","type":"session_meta"',
    );

    const adapter = new CodexAdapter({ sessionsRoot: root });
    const sessions: DiscoveredSession[] = await adapter.discoverSessions();
    expect(sessions.map((session): string => session.sessionId)).toEqual([
      `codex:${LEGACY_SESSION_ID}`,
      `codex:${SESSION_ID}`,
    ]);
    for (const session of sessions) {
      expect(session.path.startsWith(root)).toBe(true);
      expect(session.sizeBytes).toBeGreaterThan(0);
    }
    const health = await adapter.detect();
    expect(health.detail).toContain("1 malformed");
  });
});

describe("CodexAdapter canonical parsing", (): void => {
  test("maps session, turns, all tool families, claims, errors, and verification", async (): Promise<void> => {
    const { result } = await basicFixture();
    expect(result.parseFailures).toBe(0);
    expect(result.events.map((event): string => event.type).sort()).toEqual([
      "completion_claim",
      "completion_claim",
      "error",
      "session_start",
      "tool_call",
      "tool_call",
      "tool_call",
      "turn_end",
      "turn_start",
      "verification_event",
    ]);

    const start: EventInput | undefined = result.events.find(
      (event: EventInput): boolean => event.type === "session_start",
    );
    expect(start).toBeDefined();
    expect(payloadOf(start!)).toMatchObject({
      agent: "codex",
      harness_version: "0.144.2",
      repo: "/work/project",
      cwd: "/work/project",
      git_branch: "feature/codex-observe",
      originator: "Codex Desktop",
      source: "vscode",
      thread_source: "user",
      model_provider: "openai",
      dialect: CODEX_DIALECT_VERSION,
    });
    // Attribution (DAN-225): the stubbed resolver marks /work/project as a
    // git root, so the derived session repo matches — and rides ParseResult.
    expect(result.sessionRepo).toBe("/work/project");

    const turnStart: EventInput | undefined = result.events.find(
      (event: EventInput): boolean => event.type === "turn_start",
    );
    const turnEnd: EventInput | undefined = result.events.find(
      (event: EventInput): boolean => event.type === "turn_end",
    );
    expect(payloadOf(turnStart!)).toMatchObject({
      turn_index: 0,
      role: "user",
      text_chars: 14,
    });
    expect(payloadOf(turnEnd!)).toMatchObject({
      turn_index: 0,
      role: "agent",
      stop_reason: "final_answer",
    });

    const claims = result.events
      .filter((event: EventInput): boolean => event.type === "completion_claim")
      .map(payloadOf);
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim_text: "Fixed the parser.",
          claim_kind: "fixed",
        }),
        expect.objectContaining({
          claim_text: "All tests pass now.",
          claim_kind: "tests_pass",
        }),
      ]),
    );
  });

  test("pairs outputs with the correct tool types and captures redacted output", async (): Promise<void> => {
    const { result } = await basicFixture();
    const tools: EventInput[] = result.events.filter(
      (event: EventInput): boolean => event.type === "tool_call",
    );
    expect(tools).toHaveLength(3);

    const command: EventInput | undefined = tools.find(
      (event: EventInput): boolean =>
        payloadOf(event).name === "exec_command",
    );
    const patch: EventInput | undefined = tools.find(
      (event: EventInput): boolean => payloadOf(event).name === "apply_patch",
    );
    const search: EventInput | undefined = tools.find(
      (event: EventInput): boolean => payloadOf(event).name === "tool_search",
    );
    expect(payloadOf(command!)).toMatchObject({
      status: "error",
      duration_ms: 2500,
    });
    expect(payloadOf(command!).output_digest).toBeString();
    expect(payloadOf(command!).output_summary).toContain("Bearer [redacted]");
    expect(payloadOf(command!).output_summary).toContain("password=[redacted]");
    expect(payloadOf(patch!)).toMatchObject({
      status: "ok",
      duration_ms: 250,
      files_touched: ["src/parser.ts"],
    });
    expect(payloadOf(search!)).toMatchObject({
      status: "ok",
      duration_ms: 100,
    });

    const error: EventInput | undefined = result.events.find(
      (event: EventInput): boolean => event.type === "error",
    );
    expect(payloadOf(error!)).toMatchObject({
      source: "tool",
      tool_call_id: command!.id,
    });
    const verification: EventInput | undefined = result.events.find(
      (event: EventInput): boolean => event.type === "verification_event",
    );
    expect(payloadOf(verification!)).toMatchObject({
      kind: "test",
      result: "fail",
      initiated_by: "agent",
    });
  });

  test("never stores base_instructions and emits valid path-independent envelopes", async (): Promise<void> => {
    const { result, root } = await basicFixture();
    const serialized: string = JSON.stringify(result.events);
    expect(serialized).not.toContain("PRIVATE-BASE-INSTRUCTIONS");
    expect(serialized).not.toContain(root);
    for (const event of result.events) {
      expect(validateEnvelope(event)).toEqual([]);
      expect(event.vendor).toBe("codex");
      expect(event.adapter_version).toBe("0.2.0");
      expect(event.raw_ref).toMatch(
        new RegExp(`^codex:${SESSION_ID}#L\\d+$`),
      );
      expect(payloadOf(event).dialect).toBe(CODEX_DIALECT_VERSION);
    }
  });

  test("round-trips emitted events through the idempotent store", async (): Promise<void> => {
    const { result } = await basicFixture();
    const store = openStore(":memory:");
    try {
      expect(store.append(result.events)).toBe(result.events.length);
      expect(store.append(result.events)).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("CodexAdapter robustness and replay", (): void => {
  test("counts unknown records separately from malformed known records", async (): Promise<void> => {
    const root: string = makeTempDirectory();
    const contents: string = [
      sessionMeta(),
      line("2026-07-27T20:00:01.000Z", "future_outer", {}),
      line("2026-07-27T20:00:02.000Z", "event_msg", {
        type: "future_event",
      }),
      '{"timestamp":"2026-07-27T20:00:03.000Z","type":"event_msg","payload":',
      line("2026-07-27T20:00:04.000Z", "event_msg", {
        type: "user_message",
        message_missing: true,
      }),
      line("2026-07-27T20:00:05.000Z", "response_item", {
        type: "function_call",
        name: "exec_command",
        arguments: "{not-json",
        call_id: "bad-call",
      }),
    ].join("\n") + "\n";
    const path: string = writeRollout(root, SESSION_ID, contents);
    const adapter = new CodexAdapter({ sessionsRoot: root });
    const result: ParseResult = await adapter.parseSession(
      discoveredFor(path),
      "",
    );
    expect(result.skippedUnknown).toBe(2);
    expect(result.parseFailures).toBe(3);
    expect(result.events.map((event): string => event.type)).toEqual([
      "session_start",
    ]);
  });

  test("deliberately counts schema-less context, usage, and task boundaries as skipped", async (): Promise<void> => {
    const { result } = await basicFixture();
    expect(result.skippedUnknown).toBe(7);
    expect(result.parseFailures).toBe(0);
  });

  test("accepts verified legacy null usage and reasoning fields as skipped records", async (): Promise<void> => {
    const root: string = makeTempDirectory();
    const contents: string = [
      sessionMeta(LEGACY_SESSION_ID, "0.89.0", { legacyIdOnly: true }),
      line("2026-01-29T15:20:51.000Z", "event_msg", {
        type: "token_count",
        info: null,
        rate_limits: { primary: null },
      }),
      line("2026-01-29T15:20:52.000Z", "response_item", {
        type: "reasoning",
        summary: [],
        content: null,
        encrypted_content: "opaque",
      }),
      line("2026-01-29T15:20:53.000Z", "event_msg", {
        type: "task_complete",
        turn_id: "turn-empty",
        last_agent_message: null,
      }),
      line("2026-01-29T15:20:54.000Z", "event_msg", {
        type: "task_complete",
        turn_id: "turn-no-claim",
        last_agent_message: "No claim language here",
      }),
    ].join("\n") + "\n";
    const path: string = writeRollout(
      root,
      LEGACY_SESSION_ID,
      contents,
      "2026/01/29",
    );
    const result: ParseResult = await new CodexAdapter({
      sessionsRoot: root,
    }).parseSession(discoveredFor(path, LEGACY_SESSION_ID), "");
    expect(result.parseFailures).toBe(0);
    expect(result.skippedUnknown).toBe(4);
    expect(result.events.map((event): string => event.type)).toEqual([
      "session_start",
    ]);
  });

  test("maps web search completion, turn abortion, and harness errors", async (): Promise<void> => {
    const root: string = makeTempDirectory();
    const contents: string = [
      sessionMeta(),
      line("2026-07-27T20:00:01.000Z", "event_msg", {
        type: "user_message",
        message: "Search the web",
      }),
      line("2026-07-27T20:00:02.000Z", "response_item", {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "adapter formats" },
      }),
      line("2026-07-27T20:00:03.000Z", "event_msg", {
        type: "web_search_end",
        call_id: "web-search-1",
        query: "adapter formats",
        action: { type: "search", query: "adapter formats" },
        results: [{ title: "Result", url: "https://example.test" }],
      }),
      line("2026-07-27T20:00:04.000Z", "event_msg", {
        type: "turn_aborted",
        turn_id: "turn-search",
        reason: "interrupted",
      }),
      line("2026-07-27T20:00:05.000Z", "event_msg", {
        type: "error",
        message: "Model stream failed",
        codex_error_info: "transport_error",
      }),
    ].join("\n") + "\n";
    const path: string = writeRollout(root, SESSION_ID, contents);
    const result: ParseResult = await new CodexAdapter({
      sessionsRoot: root,
    }).parseSession(discoveredFor(path), "");
    expect(result.parseFailures).toBe(0);
    expect(result.skippedUnknown).toBe(1);
    expect(result.events.map((event): string => event.type).sort()).toEqual([
      "error",
      "session_start",
      "tool_call",
      "turn_end",
      "turn_start",
    ]);
    const search: EventInput | undefined = result.events.find(
      (event: EventInput): boolean =>
        event.type === "tool_call" &&
        payloadOf(event).name === "web_search",
    );
    expect(payloadOf(search!)).toMatchObject({
      status: "ok",
      turn_index: 0,
    });
    const aborted: EventInput | undefined = result.events.find(
      (event: EventInput): boolean =>
        event.type === "turn_end" &&
        payloadOf(event).stop_reason === "interrupted",
    );
    expect(payloadOf(aborted!)).toMatchObject({
      text_chars: 0,
      turn_index: 0,
    });
    const error: EventInput | undefined = result.events.find(
      (event: EventInput): boolean => event.type === "error",
    );
    expect(payloadOf(error!)).toMatchObject({
      source: "harness",
      message_summary: "Model stream failed",
      tool_call_id: null,
    });
  });

  test("counts duplicate lifecycle summaries and schema-less state deliberately", async (): Promise<void> => {
    const root: string = makeTempDirectory();
    const contents: string = [
      sessionMeta(),
      line("2026-07-27T20:00:01.000Z", "event_msg", {
        type: "exec_command_end",
        call_id: "exec-1",
      }),
      line("2026-07-27T20:00:02.000Z", "event_msg", {
        type: "patch_apply_end",
        call_id: "patch-1",
      }),
      line("2026-07-27T20:00:03.000Z", "event_msg", {
        type: "mcp_tool_call_end",
        call_id: "mcp-1",
      }),
      line("2026-07-27T20:00:04.000Z", "event_msg", {
        type: "agent_reasoning",
        text: "private reasoning summary",
      }),
      line("2026-07-27T20:00:05.000Z", "event_msg", {
        type: "context_compacted",
      }),
      line("2026-07-27T20:00:06.000Z", "event_msg", {
        type: "thread_goal_updated",
        goal: { objective: "test" },
      }),
      line("2026-07-27T20:00:07.000Z", "response_item", {
        type: "message",
        role: "developer",
        content: [{
          type: "input_text",
          text: "Synthetic developer instruction with no canonical turn.",
        }],
      }),
    ].join("\n") + "\n";
    const path: string = writeRollout(root, SESSION_ID, contents);
    const result: ParseResult = await new CodexAdapter({
      sessionsRoot: root,
    }).parseSession(discoveredFor(path), "");
    expect(result.parseFailures).toBe(0);
    expect(result.skippedUnknown).toBe(7);
    expect(result.events.map((event): string => event.type)).toEqual([
      "session_start",
    ]);
  });

  test("leaves a truncated trailing line for the next pass", async (): Promise<void> => {
    const root: string = makeTempDirectory();
    const completePrefix: string = [
      sessionMeta(),
      line("2026-07-27T20:00:01.000Z", "event_msg", {
        type: "user_message",
        message: "Continue",
      }),
    ].join("\n") + "\n";
    const partial: string =
      '{"timestamp":"2026-07-27T20:00:02.000Z","type":"event_msg","payload":{"type":"agent_message","message":"Done."';
    const path: string = writeRollout(
      root,
      SESSION_ID,
      completePrefix + partial,
    );
    const adapter = new CodexAdapter({ sessionsRoot: root });
    const session: DiscoveredSession = discoveredFor(path);
    const first: ParseResult = await adapter.parseSession(session, "");
    expect(first.parseFailures).toBe(0);
    expect(first.events.map((event): string => event.type)).toEqual([
      "session_start",
      "turn_start",
    ]);
    expect(first.resumeToken).toBe(String(Buffer.byteLength(completePrefix)));

    appendFileSync(path, ',"phase":"final_answer"}}\n');
    const second: ParseResult = await adapter.parseSession(
      discoveredFor(path),
      first.resumeToken,
    );
    expect(second.parseFailures).toBe(0);
    expect(second.events.map((event): string => event.type)).toEqual([
      "turn_end",
    ]);
  });

  test("rewinds an unpaired tool call and emits it only after output arrives", async (): Promise<void> => {
    const root: string = makeTempDirectory();
    const prefix: string = [
      sessionMeta(),
      line("2026-07-27T20:00:01.000Z", "event_msg", {
        type: "user_message",
        message: "Run tests",
      }),
      line("2026-07-27T20:00:02.000Z", "response_item", {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "bun test" }),
        call_id: "pending-call",
      }),
    ].join("\n") + "\n";
    const path: string = writeRollout(root, SESSION_ID, prefix);
    const adapter = new CodexAdapter({ sessionsRoot: root });
    const first: ParseResult = await adapter.parseSession(
      discoveredFor(path),
      "",
    );
    expect(first.events.map((event): string => event.type)).toEqual([
      "session_start",
      "turn_start",
    ]);
    expect(Number(first.resumeToken)).toBeLessThan(Buffer.byteLength(prefix));

    appendFileSync(
      path,
      `${line("2026-07-27T20:00:03.000Z", "response_item", {
        type: "function_call_output",
        call_id: "pending-call",
        output: "Process exited with code 0",
      })}\n`,
    );
    const second: ParseResult = await adapter.parseSession(
      discoveredFor(path),
      first.resumeToken,
    );
    expect(second.parseFailures).toBe(0);
    expect(second.events.map((event): string => event.type).sort()).toEqual([
      "tool_call",
      "verification_event",
    ]);
  });

  test("an appended second pass emits only new events", async (): Promise<void> => {
    const root: string = makeTempDirectory();
    const prefix: string = [
      sessionMeta(),
      line("2026-07-27T20:00:01.000Z", "event_msg", {
        type: "user_message",
        message: "First",
      }),
      line("2026-07-27T20:00:02.000Z", "event_msg", {
        type: "agent_message",
        message: "Response",
        phase: "final_answer",
      }),
    ].join("\n") + "\n";
    const path: string = writeRollout(root, SESSION_ID, prefix);
    const adapter = new CodexAdapter({ sessionsRoot: root });
    const first: ParseResult = await adapter.parseSession(
      discoveredFor(path),
      "",
    );
    appendFileSync(
      path,
      `${line("2026-07-27T20:00:03.000Z", "event_msg", {
        type: "user_message",
        message: "Second",
      })}\n`,
    );
    const second: ParseResult = await adapter.parseSession(
      discoveredFor(path),
      first.resumeToken,
    );
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.type).toBe("turn_start");
    expect(payloadOf(second.events[0]!).turn_index).toBe(1);
  });

  test("full replay produces byte-identical event ids", async (): Promise<void> => {
    const { adapter, session } = await basicFixture();
    const first: ParseResult = await adapter.parseSession(session, "");
    const second: ParseResult = await adapter.parseSession(session, "");
    expect(first.events.map((event): string => event.id)).toEqual(
      second.events.map((event): string => event.id),
    );
  });

  test("moving an identical fixture between absolute paths preserves event ids", async (): Promise<void> => {
    const firstRoot: string = makeTempDirectory("codex-path-a-");
    const secondRoot: string = makeTempDirectory("codex-path-b-");
    const firstPath: string = writeRollout(
      firstRoot,
      SESSION_ID,
      basicRollout(),
    );
    const secondPath: string = join(
      secondRoot,
      "different",
      "absolute",
      "rollout-copy.jsonl",
    );
    mkdirSync(dirname(secondPath), { recursive: true });
    copyFileSync(firstPath, secondPath);

    const firstAdapter = new CodexAdapter({ sessionsRoot: firstRoot });
    const secondAdapter = new CodexAdapter({ sessionsRoot: secondRoot });
    const first: ParseResult = await firstAdapter.parseSession(
      discoveredFor(firstPath),
      "",
    );
    const second: ParseResult = await secondAdapter.parseSession(
      discoveredFor(secondPath),
      "",
    );
    expect(first.events.map((event): string => event.id).sort()).toEqual(
      second.events.map((event): string => event.id).sort(),
    );
  });

  test("counts a mismatched discovered session id instead of trusting it", async (): Promise<void> => {
    const root: string = makeTempDirectory();
    const path: string = writeRollout(root, SESSION_ID, `${sessionMeta()}\n`);
    const result: ParseResult = await new CodexAdapter({
      sessionsRoot: root,
    }).parseSession(
      {
        ...discoveredFor(path),
        sessionId: "codex:different-native-id",
      },
      "",
    );
    expect(result.events).toEqual([]);
    expect(result.parseFailures).toBe(1);
    expect(result.resumeToken).toBe("0");
  });

  test("counts mismatched tool call and output families as a parse failure", async (): Promise<void> => {
    const root: string = makeTempDirectory();
    const contents: string = [
      sessionMeta(),
      line("2026-07-27T20:00:01.000Z", "response_item", {
        type: "function_call",
        name: "exec_command",
        arguments: "{}",
        call_id: "mixed-call",
      }),
      line("2026-07-27T20:00:02.000Z", "response_item", {
        type: "custom_tool_call_output",
        call_id: "mixed-call",
        output: "Exit code: 0",
      }),
    ].join("\n") + "\n";
    const path: string = writeRollout(root, SESSION_ID, contents);
    const result: ParseResult = await new CodexAdapter({
      sessionsRoot: root,
    }).parseSession(discoveredFor(path), "");
    expect(result.parseFailures).toBe(1);
    expect(result.events.map((event): string => event.type)).toEqual([
      "session_start",
    ]);
  });
});
