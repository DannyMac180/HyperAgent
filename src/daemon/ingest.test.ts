import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ClaudeCodeAdapter } from "../adapters/claude-code/adapter.ts";
import { CodexAdapter } from "../adapters/codex/adapter.ts";
import type {
  DiscoveredSession,
  ObserveAdapter,
  ParseResult,
} from "../adapters/types.ts";
import { deterministicEventId } from "../schema/ids.ts";
import type { EventInput } from "../schema/events.ts";
import { openStore } from "../store/store.ts";
import { runIngestOnce } from "./ingest.ts";
import type { AdapterRunStats } from "./ingest.ts";
import {
  builtinAdapters,
  builtinInjectAdapters,
} from "./registry.ts";

const fixtureRoot = resolve(
  "src/adapters/claude-code/fixtures/projects",
);
const PATH_INVARIANCE_UUID = "11111111-1111-4111-8111-111111111111";
const CLAUDE_PATH_INVARIANCE_FIXTURE = resolve(
  "src/adapters/claude-code/conformance-fixtures/clean.jsonl",
);
const CODEX_PATH_INVARIANCE_FIXTURE = resolve(
  "src/adapters/codex/conformance-fixtures/clean.jsonl",
);
const temporaryDirectories: string[] = [];

function temporaryDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "hyperagent-ingest-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

const cliHome: string = temporaryDataDir();

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function onlyStats(adapters: AdapterRunStats[]): AdapterRunStats {
  const stats = adapters[0];
  if (stats === undefined) {
    throw new Error("Expected one adapter result");
  }
  return stats;
}

function event(
  sessionId: string,
  vendor: string,
  adapterVersion: string,
  type: EventInput["type"],
  ts: string,
  rawRef: string,
  payload: Record<string, unknown>,
): EventInput {
  return {
    id: deterministicEventId({ ts, sessionId, rawRef, type }),
    ts,
    type,
    session_id: sessionId,
    vendor,
    adapter_version: adapterVersion,
    raw_ref: rawRef,
    payload,
  } as EventInput;
}

interface PathInvariantFixtureRoots {
  claudeProjectsRoot: string;
  codexSessionsRoot: string;
}

interface StoredEventIdentity {
  id: string;
  rawRef: string;
  type: string;
}

function copyPathInvariantFixtures(
  label: string,
): PathInvariantFixtureRoots {
  const root: string = temporaryDataDir();
  const claudeProjectsRoot: string = join(root, `${label}-claude-projects`);
  const claudePath: string = join(
    claudeProjectsRoot,
    "-fixture-project",
    `${PATH_INVARIANCE_UUID}.jsonl`,
  );
  const codexSessionsRoot: string = join(root, `${label}-codex-sessions`);
  const codexPath: string = join(
    codexSessionsRoot,
    "2026",
    "07",
    "27",
    `rollout-2026-07-27T12-00-00-${PATH_INVARIANCE_UUID}.jsonl`,
  );

  mkdirSync(dirname(claudePath), { recursive: true });
  mkdirSync(dirname(codexPath), { recursive: true });
  copyFileSync(CLAUDE_PATH_INVARIANCE_FIXTURE, claudePath);
  copyFileSync(CODEX_PATH_INVARIANCE_FIXTURE, codexPath);
  const quiescentTime: Date = new Date("2026-07-27T12:05:00.000Z");
  utimesSync(claudePath, quiescentTime, quiescentTime);
  utimesSync(codexPath, quiescentTime, quiescentTime);

  return { claudeProjectsRoot, codexSessionsRoot };
}

function storedEventIdentities(
  dataDir: string,
  vendor: string,
): StoredEventIdentity[] {
  const store = openStore(join(dataDir, "hyperagent.db"));
  try {
    const rows: Array<{
      id: unknown;
      raw_ref: unknown;
      type: unknown;
    }> = store.db
      .query<
        { id: unknown; raw_ref: unknown; type: unknown },
        [string]
      >(
        "SELECT id, raw_ref, type FROM events "
        + "WHERE vendor = ? ORDER BY id",
      )
      .all(vendor);
    return rows.map(
      (row, index): StoredEventIdentity => {
        if (
          typeof row.id !== "string"
          || typeof row.raw_ref !== "string"
          || typeof row.type !== "string"
        ) {
          throw new Error(
            `Invalid stored ${vendor} event identity at index ${index}`,
          );
        }
        return {
          id: row.id,
          rawRef: row.raw_ref,
          type: row.type,
        };
      },
    );
  } finally {
    store.close();
  }
}

function healthyAdapter(options?: {
  vendor?: string;
  sessionId?: string;
  path?: string;
  mtimeMs?: number;
  events?: EventInput[];
  skippedUnknown?: number;
  parseFailures?: number;
}): ObserveAdapter {
  const vendor = options?.vendor ?? "healthy";
  const adapterVersion = "1.0.0";
  const sessionId = options?.sessionId ?? `${vendor}:session`;
  const path = options?.path ?? `/tmp/${vendor}-session.jsonl`;
  const mtimeMs = options?.mtimeMs ?? Date.UTC(2026, 0, 1);
  const events =
    options?.events ??
    [
      event(
        sessionId,
        vendor,
        adapterVersion,
        "turn_start",
        "2026-01-01T00:00:00.000Z",
        `${path}#1`,
        { turn_index: 0, role: "user" },
      ),
    ];
  return {
    vendor,
    adapterVersion,
    async detect() {
      return {
        status: "ok",
        harnessVersion: "test",
        detail: "healthy",
      };
    },
    async discoverSessions() {
      return [{ sessionId, path, mtimeMs, sizeBytes: 100 }];
    },
    async parseSession(): Promise<ParseResult> {
      return {
        events,
        resumeToken: "done",
        skippedUnknown: options?.skippedUnknown ?? 0,
        parseFailures: options?.parseFailures ?? 0,
      };
    },
  };
}

describe("runIngestOnce", () => {
  test("is idempotent for unchanged real adapter sessions", async () => {
    const dataDir = temporaryDataDir();
    const adapter = new ClaudeCodeAdapter({ projectsRoot: fixtureRoot });

    const first = onlyStats(
      (await runIngestOnce({ dataDir, adapters: [adapter] })).adapters,
    );
    const second = onlyStats(
      (await runIngestOnce({ dataDir, adapters: [adapter] })).adapters,
    );

    expect(first.eventsAppended).toBeGreaterThan(0);
    expect(first.sessionsParsed).toBeGreaterThan(0);
    expect(second.eventsAppended).toBe(0);
    expect(second.sessionsSkippedUnchanged).toBe(
      second.sessionsDiscovered,
    );
    expect(second.sessionsSkippedUnchanged).toBeGreaterThan(0);
  });

  test("cold re-ingest after state loss deduplicates stored events", async () => {
    const dataDir = temporaryDataDir();
    const adapter = new ClaudeCodeAdapter({ projectsRoot: fixtureRoot });
    await runIngestOnce({ dataDir, adapters: [adapter] });
    unlinkSync(join(dataDir, "ingest-state.json"));

    const stats = onlyStats(
      (await runIngestOnce({ dataDir, adapters: [adapter] })).adapters,
    );

    expect(stats.eventsAppended).toBe(0);
    expect(stats.sessionsParsed).toBe(stats.sessionsDiscovered);
    expect(stats.sessionsParsed).toBeGreaterThan(0);
    expect(stats.sessionsSkippedUnchanged).toBe(0);
  });

  test("keeps adapter and daemon event ids invariant across absolute roots", async () => {
    const firstRoots: PathInvariantFixtureRoots =
      copyPathInvariantFixtures("first");
    const secondRoots: PathInvariantFixtureRoots =
      copyPathInvariantFixtures("second");
    const firstDataDir: string = temporaryDataDir();
    const secondDataDir: string = temporaryDataDir();
    const fixedNow: number = Date.parse("2026-07-27T13:00:00.000Z");

    const adaptersFor = (
      roots: PathInvariantFixtureRoots,
    ): ObserveAdapter[] => [
      new ClaudeCodeAdapter({
        projectsRoot: roots.claudeProjectsRoot,
      }),
      new CodexAdapter({
        sessionsRoot: roots.codexSessionsRoot,
      }),
    ];

    // Local fixture ingestion is bounded by Bun's per-test timeout.
    await runIngestOnce({
      dataDir: firstDataDir,
      adapters: adaptersFor(firstRoots),
      quiesceMs: 1_000,
      now: (): number => fixedNow,
    });
    await runIngestOnce({
      dataDir: secondDataDir,
      adapters: adaptersFor(secondRoots),
      quiesceMs: 1_000,
      now: (): number => fixedNow,
    });

    for (const vendor of ["claude-code", "codex"]) {
      const first: StoredEventIdentity[] = storedEventIdentities(
        firstDataDir,
        vendor,
      );
      const second: StoredEventIdentity[] = storedEventIdentities(
        secondDataDir,
        vendor,
      );
      expect(first.length).toBeGreaterThan(1);
      expect(first).toEqual(second);

      const sessionEnds: StoredEventIdentity[] = first.filter(
        (eventIdentity): boolean => eventIdentity.type === "session_end",
      );
      expect(sessionEnds).toHaveLength(1);
      expect(sessionEnds[0]?.rawRef).toBe(
        `${vendor}:${PATH_INVARIANCE_UUID}#quiesce`,
      );
    }
  });

  test("recovers from a corrupt state file", async () => {
    const dataDir = temporaryDataDir();
    const adapter = new ClaudeCodeAdapter({ projectsRoot: fixtureRoot });
    await runIngestOnce({ dataDir, adapters: [adapter] });
    const statePath = join(dataDir, "ingest-state.json");
    writeFileSync(statePath, "{not json", "utf8");

    await expect(
      runIngestOnce({ dataDir, adapters: [adapter] }),
    ).resolves.toBeDefined();
    const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    expect(parsed).toBeObject();
  });

  test("closes a quiescent session exactly once with summary counts", async () => {
    const dataDir = temporaryDataDir();
    const nowMs = Date.UTC(2026, 0, 2);
    const sessionId = "fake:quiescent";
    const path = "/tmp/quiescent.jsonl";
    const adapter = healthyAdapter({
      vendor: "fake",
      sessionId,
      path,
      mtimeMs: nowMs - 60 * 60 * 1000,
      events: [
        event(
          sessionId,
          "fake",
          "1.0.0",
          "turn_start",
          "2026-01-01T00:00:00.000Z",
          `${path}#1`,
          { turn_index: 0, role: "user" },
        ),
        event(
          sessionId,
          "fake",
          "1.0.0",
          "tool_call",
          "2026-01-01T00:00:02.000Z",
          `${path}#2`,
          { name: "Read", status: "ok", turn_index: 0 },
        ),
      ],
    });

    const first = onlyStats(
      (
        await runIngestOnce({
          dataDir,
          adapters: [adapter],
          quiesceMs: 1_000,
          now: () => nowMs,
        })
      ).adapters,
    );
    const store = openStore(join(dataDir, "hyperagent.db"));
    const storedEvents = store.getEvents(sessionId);
    store.close();
    const endings = storedEvents.filter(
      (storedEvent) => storedEvent.type === "session_end",
    );
    const ending = endings[0];
    if (ending === undefined) {
      throw new Error("Expected a session_end event");
    }

    expect(first.sessionsClosed).toBe(1);
    expect(endings).toHaveLength(1);
    expect(ending.payload).toEqual({
      outcome: "unknown",
      duration_ms: 2_000,
      turn_count: 1,
      tool_call_count: 1,
    });

    const second = onlyStats(
      (
        await runIngestOnce({
          dataDir,
          adapters: [adapter],
          quiesceMs: 1_000,
          now: () => nowMs,
        })
      ).adapters,
    );
    const reopenedStore = openStore(join(dataDir, "hyperagent.db"));
    const endingsAfterSecondRun = reopenedStore
      .getEvents(sessionId)
      .filter((storedEvent) => storedEvent.type === "session_end");
    reopenedStore.close();

    expect(second.eventsAppended).toBe(0);
    expect(second.sessionsClosed).toBe(0);
    expect(endingsAfterSecondRun).toHaveLength(1);
  });

  test("skips an unavailable adapter without discovering sessions", async () => {
    const dataDir = temporaryDataDir();
    let attemptedWork = false;
    const adapter: ObserveAdapter = {
      vendor: "missing",
      adapterVersion: "1.0.0",
      async detect() {
        return {
          status: "unavailable",
          harnessVersion: null,
          detail: "not installed",
        };
      },
      async discoverSessions() {
        attemptedWork = true;
        return [];
      },
      async parseSession(
        _session: DiscoveredSession,
        _resumeToken: string,
      ) {
        attemptedWork = true;
        return {
          events: [],
          resumeToken: "",
          skippedUnknown: 0,
          parseFailures: 0,
        };
      },
    };

    const stats = onlyStats(
      (await runIngestOnce({ dataDir, adapters: [adapter] })).adapters,
    );

    expect(stats.status).toBe("unavailable");
    expect(stats.detail).toBe("not installed");
    expect(stats.sessionsDiscovered).toBe(0);
    expect(stats.sessionsParsed).toBe(0);
    expect(stats.eventsAppended).toBe(0);
    expect(attemptedWork).toBe(false);
  });

  test("continues with a healthy adapter after another adapter throws", async () => {
    const dataDir = temporaryDataDir();
    const failing: ObserveAdapter = {
      vendor: "broken",
      adapterVersion: "1.0.0",
      async detect() {
        throw new Error("detection exploded");
      },
      async discoverSessions() {
        return [];
      },
      async parseSession() {
        return {
          events: [],
          resumeToken: "",
          skippedUnknown: 0,
          parseFailures: 0,
        };
      },
    };

    const result = await runIngestOnce({
      dataDir,
      adapters: [failing, healthyAdapter({ mtimeMs: Date.now() })],
    });
    const broken = result.adapters.find((stats) => stats.vendor === "broken");
    const healthy = result.adapters.find(
      (stats) => stats.vendor === "healthy",
    );

    expect(broken?.status).toBe("unavailable");
    expect(broken?.detail).toContain("detection exploded");
    expect(healthy?.eventsAppended).toBe(1);
    expect(healthy?.sessionsParsed).toBe(1);
  });

  test("marks an adapter needs_update when parse failures cross five percent", async () => {
    const dataDir = temporaryDataDir();
    const path = "/tmp/high-failure-session.jsonl";
    const adapter = healthyAdapter({
      vendor: "fragile",
      path,
      parseFailures: 2,
      skippedUnknown: 1,
    });

    const stats = onlyStats(
      (await runIngestOnce({ dataDir, adapters: [adapter] })).adapters,
    );

    expect(stats.status).toBe("needs_update");
    expect(stats.parseFailures).toBe(2);
    expect(stats.detail).toContain(path);
    expect(stats.detail).toContain("2 parse failures");
  });
});

describe("daemon boundaries and CLI", () => {
  test("keeps vendor knowledge in the adapter registry", () => {
    const ingestSource = readFileSync(
      resolve("src/daemon/ingest.ts"),
      "utf8",
    );
    const cliSource = readFileSync(resolve("src/daemon/cli.ts"), "utf8");
    const registrySource = readFileSync(
      resolve("src/daemon/registry.ts"),
      "utf8",
    );

    expect(ingestSource.toLowerCase()).not.toContain("claude");
    expect(cliSource.toLowerCase()).not.toContain("claude");
    expect(registrySource.toLowerCase()).toContain("claude-code");
    expect(registrySource.toLowerCase()).toContain("codex");

    const adapters = builtinAdapters();
    expect(adapters.map((adapter): string => adapter.vendor)).toEqual([
      "claude-code",
      "codex",
    ]);
    for (const adapter of adapters) {
      expect(typeof adapter.vendor).toBe("string");
      expect(typeof adapter.adapterVersion).toBe("string");
      expect(typeof adapter.detect).toBe("function");
      expect(typeof adapter.discoverSessions).toBe("function");
      expect(typeof adapter.parseSession).toBe("function");
    }
    expect(
      builtinInjectAdapters().map((adapter): string => adapter.vendor),
    ).toEqual(["claude-code", "codex"]);
  });

  test("status CLI works before and after one-shot ingest", async () => {
    const dataDir = temporaryDataDir();
    const initialStatus = await runCli([
      "status",
      "--data-dir",
      dataDir,
    ]);
    expect(initialStatus.exitCode).toBe(0);
    expect(initialStatus.stdout.trim().length).toBeGreaterThan(0);

    const ingest = await runCli([
      "ingest",
      "--once",
      "--data-dir",
      dataDir,
      "--projects-root",
      fixtureRoot,
    ]);
    expect(ingest.exitCode).toBe(0);

    const status = await runCli(["status", "--data-dir", dataDir]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("claude-code");
    expect(status.stdout).toContain("codex");
    expect(status.stdout).toMatch(/sessions \d+/);
  });

  test("status reports the stored event total after a no-op ingest", async () => {
    const dataDir = temporaryDataDir();
    const ingestArgs = [
      "ingest",
      "--once",
      "--data-dir",
      dataDir,
      "--projects-root",
      fixtureRoot,
    ];

    expect((await runCli(ingestArgs)).exitCode).toBe(0);
    expect((await runCli(ingestArgs)).exitCode).toBe(0);

    const store = openStore(join(dataDir, "hyperagent.db"));
    let eventCount: number;
    try {
      const row = store.db
        .query<{ count: unknown }, []>(
          "SELECT count(*) AS count FROM events",
        )
        .get();
      if (row === null || typeof row.count !== "number") {
        throw new Error("Expected a numeric stored event count");
      }
      eventCount = row.count;
    } finally {
      store.close();
    }
    expect(eventCount).toBeGreaterThan(0);

    const status = await runCli(["status", "--data-dir", dataDir]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(`events ${eventCount}`);
  });
});

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const subprocess = Bun.spawn(
    ["bun", "src/daemon/cli.ts", ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: cliHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdoutPromise = new Response(subprocess.stdout).text();
  const stderrPromise = new Response(subprocess.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      subprocess.exited,
      new Promise<number>((_resolve, reject) => {
        timer = setTimeout(() => {
          subprocess.kill();
          reject(new Error(`CLI timed out: ${args.join(" ")}`));
        }, 5_000);
      }),
    ]);
    return {
      exitCode,
      stdout: await stdoutPromise,
      stderr: await stderrPromise,
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

describe("excludeProjects", () => {
  test("claude-code discovery reports each session's project directory", async () => {
    const adapter = new ClaudeCodeAdapter({ projectsRoot: fixtureRoot });
    const sessions = await adapter.discoverSessions();
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.projectDir).toBe("-home-user-project");
    }
  });

  test("an excluded project's sessions never enter the store, the state, or the parsed stats", async () => {
    const dataDir = temporaryDataDir();
    const result = await runIngestOnce({
      dataDir,
      adapters: [new ClaudeCodeAdapter({ projectsRoot: fixtureRoot })],
      excludeProjects: ["-home-user-project"],
    });
    const stats = onlyStats(result.adapters);
    expect(stats.sessionsDiscovered).toBeGreaterThan(0);
    expect(stats.sessionsExcluded).toBe(stats.sessionsDiscovered);
    expect(stats.sessionsParsed).toBe(0);
    expect(stats.eventsAppended).toBe(0);

    const store = openStore(join(dataDir, "hyperagent.db"));
    try {
      const row = store.db
        .query<{ count: unknown }, []>("SELECT count(*) AS count FROM events")
        .get();
      expect(row?.count).toBe(0);
    } finally {
      store.close();
    }
    const state = JSON.parse(
      readFileSync(join(dataDir, "ingest-state.json"), "utf8"),
    ) as { sessions: Record<string, unknown> };
    expect(Object.keys(state.sessions)).toHaveLength(0);
  });

  test("a non-matching exclusion changes nothing (negative control)", async () => {
    const dataDir = temporaryDataDir();
    const stats = onlyStats(
      (
        await runIngestOnce({
          dataDir,
          adapters: [new ClaudeCodeAdapter({ projectsRoot: fixtureRoot })],
          excludeProjects: ["some-other-project"],
        })
      ).adapters,
    );
    expect(stats.sessionsExcluded).toBe(0);
    expect(stats.sessionsParsed).toBe(stats.sessionsDiscovered);
    expect(stats.eventsAppended).toBeGreaterThan(0);
  });

  test("dropping the exclusion later ingests the project fresh", async () => {
    const dataDir = temporaryDataDir();
    const adapter = new ClaudeCodeAdapter({ projectsRoot: fixtureRoot });
    const excluded = onlyStats(
      (
        await runIngestOnce({
          dataDir,
          adapters: [adapter],
          excludeProjects: ["-home-user-project"],
        })
      ).adapters,
    );
    expect(excluded.sessionsParsed).toBe(0);
    const included = onlyStats(
      (await runIngestOnce({ dataDir, adapters: [adapter] })).adapters,
    );
    expect(included.sessionsParsed).toBe(included.sessionsDiscovered);
    expect(included.eventsAppended).toBeGreaterThan(0);
  });

  test("sessions with no project identity cannot be excluded by project", async () => {
    const dataDir = temporaryDataDir();
    const events = [
      event(
        "synthetic:no-project",
        "synthetic",
        "0.0.1",
        "session_start",
        "2026-08-05T12:00:00.000Z",
        "synthetic:no-project#L1",
        {},
      ),
    ];
    const adapter: ObserveAdapter = {
      vendor: "synthetic",
      adapterVersion: "0.0.1",
      detect: async () => ({
        status: "ok" as const,
        harnessVersion: null,
        detail: "synthetic",
      }),
      discoverSessions: async (): Promise<DiscoveredSession[]> => [
        {
          sessionId: "synthetic:no-project",
          path: "/dev/null/synthetic.jsonl",
          mtimeMs: 1,
          sizeBytes: 1,
        },
      ],
      parseSession: async (): Promise<ParseResult> => ({
        events,
        resumeToken: "end",
        skippedUnknown: 0,
        parseFailures: 0,
      }),
    };
    const stats = onlyStats(
      (
        await runIngestOnce({
          dataDir,
          adapters: [adapter],
          excludeProjects: ["-home-user-project"],
        })
      ).adapters,
    );
    expect(stats.sessionsExcluded).toBe(0);
    expect(stats.sessionsParsed).toBe(1);
  });

  test("CLI threads --exclude-projects through to a real ingest", async () => {
    const dataDir = temporaryDataDir();
    const ingest = await runCli([
      "ingest",
      "--once",
      "--data-dir",
      dataDir,
      "--projects-root",
      fixtureRoot,
      "--exclude-projects",
      "-home-user-project,unrelated",
    ]);
    expect(ingest.exitCode).toBe(0);
    const state = JSON.parse(
      readFileSync(join(dataDir, "ingest-state.json"), "utf8"),
    ) as { sessions: Record<string, unknown> };
    const claudeSessions = Object.keys(state.sessions).filter((id) =>
      id.startsWith("claude-code:"),
    );
    expect(claudeSessions).toHaveLength(0);
  });
});
