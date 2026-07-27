import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendOutcome,
  clearBounceCount,
  discardRotatedSpool,
  GATE_OUTCOME_VERSION,
  incrementBounceCount,
  readBounceCount,
  readSpool,
  rotateSpool,
  sessionContextFromSpool,
  spoolBacklogBytes,
} from "./spool.ts";
import type { GateOutcome } from "./spool.ts";
import {
  bounceCounterPath,
  bounceDir,
  gateDir,
  rotatedSpoolPath,
  spoolPath,
} from "./paths.ts";

const tempDirectories: string[] = [];
const runningAsRoot: boolean = (
  typeof process.geteuid === "function"
  && process.geteuid() === 0
);

afterEach((): void => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const directory: string = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function outcome(overrides: Partial<GateOutcome> = {}): GateOutcome {
  return {
    v: GATE_OUTCOME_VERSION,
    kind: "post_tool_use",
    ts: "2026-07-27T12:34:56.789Z",
    harness: "claude-code",
    sessionId: "claude-code:session-1",
    cwd: "/repo",
    decision: "allow",
    summary: "tool completed",
    matchedRules: [],
    failedChecks: [],
    command: "bun test",
    passed: true,
    touchedFiles: ["/repo/src/index.ts"],
    ...overrides,
  };
}

function completeLines(path: string): string[] {
  const raw: string = readFileSync(path, "utf8");
  expect(raw.endsWith("\n")).toBe(true);
  return raw.slice(0, -1).split("\n");
}

describe("gate outcome spool", () => {
  test("appends and reads one newline-free JSON outcome", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-spool-roundtrip-");
    const expected: GateOutcome = outcome({
      summary: "first line\nsecond line",
    });

    expect(await appendOutcome(dataDir, expected)).toBe(true);
    const raw: string = readFileSync(spoolPath(dataDir), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const serialized: string = raw.slice(0, -1);
    expect(serialized.includes("\n")).toBe(false);
    expect(JSON.parse(serialized) as unknown).toEqual(expected);
    expect(await readSpool(dataDir)).toEqual({
      outcomes: [expected],
      malformedLines: 0,
    });
  });

  test("creates the gate directory recursively when appending", async (): Promise<void> => {
    const root: string = makeTempDir("hyperagent-spool-mkdir-");
    const dataDir: string = join(root, "nested", "data");

    expect(await appendOutcome(dataDir, outcome())).toBe(true);
    expect(existsSync(gateDir(dataDir))).toBe(true);
  });

  test("uses append-safe writes for 50 concurrent hooks", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-spool-concurrent-");
    const writes: Promise<boolean>[] = Array.from(
      { length: 50 },
      (_unused: unknown, index: number): Promise<boolean> => appendOutcome(
        dataDir,
        outcome({ summary: `outcome-${index}` }),
      ),
    );

    const results: boolean[] = await Promise.all(writes);
    expect(results.every((result: boolean): boolean => result)).toBe(true);
    const lines: string[] = completeLines(spoolPath(dataDir));
    expect(lines).toHaveLength(50);
    const parsed: unknown[] = lines.map(
      (line: string): unknown => JSON.parse(line) as unknown,
    );
    expect(parsed).toHaveLength(50);

    const read = await readSpool(dataDir);
    expect(read.malformedLines).toBe(0);
    expect(read.outcomes).toHaveLength(50);
    expect(
      new Set(
        read.outcomes.map(
          (entry: GateOutcome): string => entry.summary,
        ),
      ).size,
    ).toBe(50);
  });

  test("returns false when serialization fails", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-spool-serialize-");
    const unserializable = {
      ...outcome(),
      unsupported: 1n,
    } as unknown as GateOutcome;

    expect(await appendOutcome(dataDir, unserializable)).toBe(false);
    expect(existsSync(spoolPath(dataDir))).toBe(false);
  });

  test("returns an empty read when both spool files are absent", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-spool-absent-");
    expect(await readSpool(dataDir)).toEqual({
      outcomes: [],
      malformedLines: 0,
    });
  });

  test("counts malformed, blank, invalid, and truncated lines without aborting", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-spool-malformed-");
    mkdirSync(gateDir(dataDir), { recursive: true });
    const validFirst: GateOutcome = outcome({ summary: "valid-first" });
    const validLast: GateOutcome = outcome({ summary: "valid-last" });
    const invalidCandidates: unknown[] = [
      { ...outcome(), v: 2 },
      { ...outcome(), kind: undefined },
      { ...outcome(), sessionId: undefined },
      { ...outcome(), ts: undefined },
      { ...outcome(), kind: "unknown_kind" },
      { ...outcome(), matchedRules: "not-an-array" },
    ];
    const complete: string[] = [
      JSON.stringify(validFirst),
      "",
      "{not json}",
      ...invalidCandidates.map(
        (candidate: unknown): string => JSON.stringify(candidate),
      ),
      JSON.stringify(validLast),
    ];
    writeFileSync(
      spoolPath(dataDir),
      `${complete.join("\n")}\n${JSON.stringify(outcome({ summary: "torn" }))}`,
    );

    const result = await readSpool(dataDir);
    expect(result.outcomes).toEqual([validFirst, validLast]);
    expect(result.malformedLines).toBe(9);
  });

  test("builds session context from only matching post-tool outcomes", (): void => {
    const targetSession = "claude-code:target";
    const outcomes: GateOutcome[] = [
      outcome({
        kind: "pre_tool_use",
        sessionId: targetSession,
        command: "ignored pre command",
        touchedFiles: ["/ignored/pre.ts"],
      }),
      outcome({
        sessionId: "claude-code:other",
        command: "ignored other command",
        touchedFiles: ["/ignored/other.ts"],
      }),
      outcome({
        sessionId: targetSession,
        command: "bun test",
        passed: undefined,
        touchedFiles: ["/repo/a.ts", "/repo/b.ts"],
      }),
      outcome({
        kind: "stop",
        sessionId: targetSession,
        command: "ignored stop command",
        touchedFiles: ["/ignored/stop.ts"],
      }),
      outcome({
        sessionId: targetSession,
        command: "bunx tsc --noEmit",
        passed: true,
        touchedFiles: ["/repo/c.ts"],
      }),
    ];

    expect(sessionContextFromSpool(outcomes, targetSession)).toEqual({
      commands: [
        { command: "bun test", passed: false, sequence: 2 },
        { command: "bunx tsc --noEmit", passed: true, sequence: 4 },
      ],
      touchedFiles: [
        { path: "/repo/a.ts", sequence: 2 },
        { path: "/repo/b.ts", sequence: 2 },
        { path: "/repo/c.ts", sequence: 4 },
      ],
    });
  });

  test("rotates old lines and sends later hook appends to a new live file", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-spool-rotation-");
    const oldFirst: GateOutcome = outcome({ summary: "old-first" });
    const oldSecond: GateOutcome = outcome({ summary: "old-second" });
    const newLive: GateOutcome = outcome({ summary: "new-live" });
    expect(await appendOutcome(dataDir, oldFirst)).toBe(true);
    expect(await appendOutcome(dataDir, oldSecond)).toBe(true);

    expect(await rotateSpool(dataDir, 0)).toBe(true);
    expect(await appendOutcome(dataDir, newLive)).toBe(true);
    expect(completeLines(rotatedSpoolPath(dataDir))).toHaveLength(2);
    expect(completeLines(spoolPath(dataDir))).toHaveLength(1);
    expect(await readSpool(dataDir)).toEqual({
      outcomes: [oldFirst, oldSecond, newLive],
      malformedLines: 0,
    });
  });

  test("does not rotate an absent or undersized live spool", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-spool-no-rotation-");
    expect(await rotateSpool(dataDir)).toBe(false);
    expect(await appendOutcome(dataDir, outcome())).toBe(true);
    const exactSize: number = statSync(spoolPath(dataDir)).size;

    expect(await rotateSpool(dataDir, exactSize)).toBe(false);
    expect(existsSync(rotatedSpoolPath(dataDir))).toBe(false);
  });

  test("never clobbers a pending rotated spool", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-spool-pending-");
    mkdirSync(gateDir(dataDir), { recursive: true });
    writeFileSync(rotatedSpoolPath(dataDir), "pending-generation\n");
    writeFileSync(spoolPath(dataDir), "new-generation\n");

    expect(await rotateSpool(dataDir, 0)).toBe(false);
    expect(readFileSync(rotatedSpoolPath(dataDir), "utf8")).toBe(
      "pending-generation\n",
    );
    expect(readFileSync(spoolPath(dataDir), "utf8")).toBe("new-generation\n");
  });

  test("discards only the rotated spool and is a no-op when absent", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-spool-discard-");
    await discardRotatedSpool(dataDir);
    mkdirSync(gateDir(dataDir), { recursive: true });
    writeFileSync(rotatedSpoolPath(dataDir), "old\n");
    writeFileSync(spoolPath(dataDir), "live\n");

    await discardRotatedSpool(dataDir);
    expect(existsSync(rotatedSpoolPath(dataDir))).toBe(false);
    expect(readFileSync(spoolPath(dataDir), "utf8")).toBe("live\n");
  });

  test("sums live and rotated backlog bytes and returns zero when absent", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-spool-backlog-");
    expect(await spoolBacklogBytes(dataDir)).toBe(0);
    mkdirSync(gateDir(dataDir), { recursive: true });
    writeFileSync(rotatedSpoolPath(dataDir), "12345");
    writeFileSync(spoolPath(dataDir), "1234567");

    expect(await spoolBacklogBytes(dataDir)).toBe(12);
  });

  test("increments, reads, clears, and re-clears bounce counts", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-bounce-roundtrip-");
    const sessionId = "claude-code:session/with unsafe chars";

    expect(await readBounceCount(dataDir, sessionId)).toBe(0);
    expect(await incrementBounceCount(dataDir, sessionId)).toBe(1);
    expect(await incrementBounceCount(dataDir, sessionId)).toBe(2);
    expect(await readBounceCount(dataDir, sessionId)).toBe(2);
    await clearBounceCount(dataDir, sessionId);
    expect(await readBounceCount(dataDir, sessionId)).toBe(0);
    await clearBounceCount(dataDir, sessionId);
  });

  test("treats corrupt and negative bounce counters as zero", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-bounce-corrupt-");
    const sessionId = "claude-code:corrupt";
    mkdirSync(bounceDir(dataDir), { recursive: true });
    const counterPath: string = bounceCounterPath(dataDir, sessionId);

    for (const corrupt of ["not-a-number", "-1", "1.5", "9007199254740992"]) {
      writeFileSync(counterPath, corrupt);
      expect(await incrementBounceCount(dataDir, sessionId)).toBe(1);
    }
  });

  test("treats counter I/O failure as a first bounce so enforcement is not inverted", async (): Promise<void> => {
    const dataDir: string = makeTempDir("hyperagent-bounce-io-failure-");
    writeFileSync(gateDir(dataDir), "not a directory");

    expect(
      await incrementBounceCount(dataDir, "claude-code:blocked-counter"),
    ).toBe(1);
    expect(
      await readBounceCount(dataDir, "claude-code:blocked-counter"),
    ).toBe(0);
    await clearBounceCount(dataDir, "claude-code:blocked-counter");
    expect(await appendOutcome(dataDir, outcome())).toBe(false);
    expect(await rotateSpool(dataDir, 0)).toBe(false);
    expect(await spoolBacklogBytes(dataDir)).toBe(0);
  });

  test.skipIf(runningAsRoot)(
    "fails open when the gate directory is not writable",
    async (): Promise<void> => {
      const dataDir: string = makeTempDir("hyperagent-spool-permissions-");
      mkdirSync(gateDir(dataDir), { recursive: true });
      chmodSync(gateDir(dataDir), 0o500);
      try {
        expect(await appendOutcome(dataDir, outcome())).toBe(false);
        expect(
          await incrementBounceCount(dataDir, "claude-code:permission-denied"),
        ).toBe(1);
      } finally {
        chmodSync(gateDir(dataDir), 0o700);
      }
    },
  );
});
