import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { EventInput } from "../schema/events.ts";
import { deterministicEventId } from "../schema/ids.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import {
  buildFallbackRecord,
  generateMission,
  missionRecordPath,
  writeMissionRecord,
} from "./generate.ts";
import type {
  MissionRecord,
  MissionSessionInput,
} from "./generate.ts";
import { createMissionQueue } from "./queue.ts";
import {
  isSuitOwnSession,
  resolveClaudeCliPath,
  sanitizeChildEnv,
} from "./runner.ts";

interface SeedEvent {
  type: EventInput["type"];
  payload?: Record<string, unknown>;
}

function missionInput(sessionId = "claude-code:session/example"): MissionSessionInput {
  return {
    sessionId,
    vendor: "claude-code",
    agent: "claude",
    model: "sonnet",
    repo: "/tmp/example-repo",
    gitBranch: "feature/missions",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    outcome: "completed",
    durationMs: 60_000,
    turnCount: 1,
    userTurns: [{ turnIndex: 0, textDigest: "Add mission generation tests" }],
    toolUsage: { shell: { count: 1, statuses: { ok: 1 } } },
    verifications: [{
      kind: "test",
      commandSummary: "bun test src/missions",
      result: "pass",
      stats: { passed: 12, failed: 0 },
    }],
    completionClaims: [{
      claimText: "All mission-generation checks passed",
      claimKind: "tests_pass",
    }],
    errors: [],
  };
}

function seedSession(
  store: Store,
  sessionId: string,
  startPayload: Record<string, unknown> = { repo: "/tmp/example-repo" },
  extraEvents: SeedEvent[] = [],
): void {
  const eventSpecs: SeedEvent[] = [
    { type: "session_start", payload: startPayload },
    ...extraEvents,
  ];
  const events = eventSpecs.map((event, index): EventInput => {
    const ts = new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000)
      .toISOString();
    const rawRef = `${sessionId}.jsonl#${index}`;
    return {
      id: deterministicEventId({
        ts,
        sessionId,
        rawRef,
        type: event.type,
        discriminator: String(index),
      }),
      ts,
      type: event.type,
      session_id: sessionId,
      vendor: "claude-code",
      adapter_version: "0.1.0",
      raw_ref: rawRef,
      payload: event.payload ?? {},
    } as EventInput;
  });

  expect(store.append(events)).toBe(events.length);
}

const acceptedModelOutput = `
# Mission outcome

The requested mission-generation behavior was verified with concrete session evidence.
`;

describe("generateMission", (): void => {
  test("returns trimmed model markdown and passes session evidence to the prompt", async (): Promise<void> => {
    const input = missionInput();
    let capturedPrompt = "";
    const output = `  ${acceptedModelOutput}  \n`;

    const record = await generateMission({
      runModel: async (prompt): Promise<string> => {
        capturedPrompt = prompt;
        return output;
      },
    }, input);

    expect(record.generatedBy).toBe("model");
    expect(record.markdown).toBe(output.trim());
    expect(record.reason).toBeUndefined();
    expect(capturedPrompt).toContain(input.sessionId);
    expect(capturedPrompt).toContain("bun test src/missions");
    expect(capturedPrompt).toContain("All mission-generation checks passed");
  });

  const fallbackCases: Array<{
    name: string;
    runModel: () => Promise<string>;
  }> = [
    {
      name: "missing CLI",
      runModel: async (): Promise<string> => {
        throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      },
    },
    {
      name: "model timeout",
      runModel: async (): Promise<string> => {
        throw new Error("model invocation timed out");
      },
    },
    { name: "empty output", runModel: async (): Promise<string> => "" },
    { name: "whitespace output", runModel: async (): Promise<string> => "   \n  " },
    { name: "too-short output", runModel: async (): Promise<string> => "ok" },
  ];

  for (const fallbackCase of fallbackCases) {
    test(`resolves with a factual fallback for ${fallbackCase.name}`, async (): Promise<void> => {
      const input = missionInput();

      const record = await generateMission({
        runModel: fallbackCase.runModel,
      }, input);

      expect(record.generatedBy).toBe("fallback");
      expect(record.reason?.length).toBeGreaterThan(0);
      expect(record.markdown.startsWith("> Generated without model —")).toBe(true);
      expect(record.markdown).toContain(`# Mission ${input.sessionId}`);
      expect(record.markdown).toContain("bun test src/missions");
      expect(record.markdown).toContain("All mission-generation checks passed");
    });
  }

  test("buildFallbackRecord is byte-deterministic", (): void => {
    const input = missionInput();
    const reason = "model invocation failed: deterministic fixture";

    const first = buildFallbackRecord(input, reason);
    const second = buildFallbackRecord(input, reason);

    expect(first).toBe(second);
  });
});

describe("mission runner boundaries", (): void => {
  test("sanitizeChildEnv removes recursion markers without removing auth or mutating input", (): void => {
    const input: NodeJS.ProcessEnv = {
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      ANTHROPIC_API_KEY: "secret",
      ANTHROPIC_BASE_URL: "https://x",
      PATH: "/usr/bin",
    };
    const original = { ...input };

    const sanitized = sanitizeChildEnv(input);

    expect(sanitized.CLAUDECODE).toBeUndefined();
    expect(sanitized.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(sanitized.ANTHROPIC_API_KEY).toBe("secret");
    expect(sanitized.ANTHROPIC_BASE_URL).toBe("https://x");
    expect(sanitized.PATH).toBe("/usr/bin");
    expect(input).toEqual(original);
  });

  test("resolveClaudeCliPath finds an executable on PATH", (): void => {
    const directory = mkdtempSync(join(tmpdir(), "hyperagent-missions-"));
    try {
      const cliPath = join(directory, "claude");
      writeFileSync(cliPath, "#!/bin/sh\nprintf 'fixture\\n'\n", "utf8");
      chmodSync(cliPath, 0o755);

      expect(resolveClaudeCliPath({ PATH: directory })).toBe(cliPath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("resolveClaudeCliPath uses the absolute local fallback when PATH has no match", (): void => {
    const resolved = resolveClaudeCliPath({ PATH: "" });

    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(".local/bin/claude")).toBe(true);
  });

  test("isSuitOwnSession matches only the data directory and its descendants", (): void => {
    const store = openStore(":memory:");
    try {
      const dataDir = "/tmp/x/.hyperagent";
      seedSession(store, "cwd-own", { cwd: `${dataDir}/modelruns` });
      seedSession(store, "repo-own", { repo: `${dataDir}/evidence` });
      seedSession(store, "unrelated", { cwd: "/tmp/other/project" });
      seedSession(store, "sibling-prefix", {
        cwd: "/tmp/x/.hyperagent-other",
      });

      expect(isSuitOwnSession(store.getEvents("cwd-own"), dataDir)).toBe(true);
      expect(isSuitOwnSession(store.getEvents("repo-own"), dataDir)).toBe(true);
      expect(isSuitOwnSession(store.getEvents("unrelated"), dataDir)).toBe(false);
      expect(isSuitOwnSession(store.getEvents("sibling-prefix"), dataDir)).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("mission queue", (): void => {
  test("refuses suit-owned sessions before model invocation or file creation", async (): Promise<void> => {
    const store = openStore(":memory:");
    const dataDir = mkdtempSync(join(tmpdir(), "hyperagent-missions-"));
    let modelCalled = false;
    try {
      const sessionId = "claude-code:suit-owned";
      seedSession(store, sessionId, { cwd: join(dataDir, "modelruns") });
      const queue = createMissionQueue({
        dataDir,
        store,
        deps: {
          runModel: async (): Promise<string> => {
            modelCalled = true;
            return acceptedModelOutput;
          },
        },
      });

      expect(queue.enqueue(sessionId)).toBe(false);
      await queue.drain();

      expect(modelCalled).toBe(false);
      expect(existsSync(join(dataDir, "missions"))).toBe(false);
    } finally {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("dedupes in-flight sessions and runs distinct sessions at concurrency one", async (): Promise<void> => {
    const store = openStore(":memory:");
    const dataDir = mkdtempSync(join(tmpdir(), "hyperagent-missions-"));
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    try {
      const sessionIds = [
        "claude-code:queue-one",
        "claude-code:queue-two",
        "claude-code:queue-three",
      ];
      for (const sessionId of sessionIds) {
        seedSession(store, sessionId);
      }
      const queue = createMissionQueue({
        dataDir,
        store,
        deps: {
          runModel: async (): Promise<string> => {
            calls += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return acceptedModelOutput;
          },
        },
      });

      expect(queue.enqueue(sessionIds[0]!)).toBe(true);
      expect(queue.enqueue(sessionIds[0]!)).toBe(false);
      expect(queue.enqueue(sessionIds[1]!)).toBe(true);
      expect(queue.enqueue(sessionIds[2]!)).toBe(true);
      await queue.drain();

      expect(calls).toBe(sessionIds.length);
      expect(maxActive).toBe(1);
      expect(active).toBe(0);
      for (const sessionId of sessionIds) {
        expect(existsSync(missionRecordPath(sessionId, dataDir))).toBe(true);
      }
    } finally {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("isolates a model failure and drains later sessions", async (): Promise<void> => {
    const store = openStore(":memory:");
    const dataDir = mkdtempSync(join(tmpdir(), "hyperagent-missions-"));
    try {
      const failingId = "claude-code:failing-session";
      const succeedingId = "claude-code:succeeding-session";
      seedSession(store, failingId);
      seedSession(store, succeedingId);
      const queueErrors: unknown[] = [];
      const queue = createMissionQueue({
        dataDir,
        store,
        onError: (_sessionId, error): void => {
          queueErrors.push(error);
        },
        deps: {
          runModel: async (prompt): Promise<string> => {
            if (prompt.includes(failingId)) {
              throw new Error("fixture model failure");
            }
            return acceptedModelOutput;
          },
        },
      });

      expect(queue.enqueue(failingId)).toBe(true);
      expect(queue.enqueue(succeedingId)).toBe(true);
      await queue.drain();

      expect(queueErrors).toEqual([]);
      expect(readFileSync(missionRecordPath(failingId, dataDir), "utf8"))
        .toStartWith("> Generated without model —");
      expect(readFileSync(missionRecordPath(succeedingId, dataDir), "utf8"))
        .toBe(acceptedModelOutput.trim());
    } finally {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("mission record persistence", (): void => {
  test("missionRecordPath sanitizes canonical ids and includes a collision-resistant suffix", (): void => {
    const dataDir = "/tmp/hyperagent-record-path";
    const first = missionRecordPath("claude-code:a/b", dataDir);
    const second = missionRecordPath("claude-code:a-b", dataDir);

    expect(first).not.toContain(":");
    expect(first.endsWith(".md")).toBe(true);
    expect(first).not.toBe(second);
  });

  test("writeMissionRecord creates the directory atomically with exact content", async (): Promise<void> => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperagent-missions-"));
    try {
      const record: MissionRecord = {
        sessionId: "claude-code:atomic/write",
        markdown: "# Exact mission record\n\nFixture content.\n",
        generatedBy: "model",
      };

      const path = await writeMissionRecord(record, dataDir);

      expect(readFileSync(path, "utf8")).toBe(record.markdown);
      expect(readdirSync(join(dataDir, "missions")).some((name) =>
        name.endsWith(".tmp")
      )).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
