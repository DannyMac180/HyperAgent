import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "bun:test";

import { policyPath } from "../gate/paths.ts";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const tempDirectories: string[] = [];
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

afterEach((): void => {
  for (const directory of tempDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function runCli(
  args: string[],
  stdin?: string,
): Promise<CliResult> {
  const subprocess = Bun.spawn(
    [process.execPath, cliPath, ...args],
    {
      cwd: process.cwd(),
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdoutPromise = new Response(subprocess.stdout).text();
  const stderrPromise = new Response(subprocess.stderr).text();
  return {
    exitCode: await subprocess.exited,
    stdout: await stdoutPromise,
    stderr: await stderrPromise,
  };
}

function preToolUseInput(
  cwd: string,
  command: string,
): string {
  return JSON.stringify({
    session_id: "gate-cli-test",
    cwd,
    tool_name: "Bash",
    tool_input: { command },
  });
}

describe("gate eval", (): void => {
  test("enabled block rule emits deny JSON and exits zero", async (): Promise<void> => {
    const dataDir = makeTempDir("hyperagent-gate-cli-data-");
    const repo = makeTempDir("hyperagent-gate-cli-repo-");
    writeFileSync(
      policyPath(dataDir),
      JSON.stringify({
        schema_version: "0.1.0",
        rules: [{
          id: "test-block",
          description: "Block the test command.",
          action: "block",
          enabled: true,
          match: { commandPattern: "^dangerous-command$" },
        }],
      }),
      "utf8",
    );

    const result = await runCli(
      [
        "gate",
        "eval",
        "--harness",
        "claude-code",
        "--hook",
        "PreToolUse",
        "--data-dir",
        dataDir,
      ],
      preToolUseInput(repo, "dangerous-command"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Blocked policy rules matched: test-block: Block the test command..",
      },
    });
  });

  test("garbage stdin fails open with empty stdout", async (): Promise<void> => {
    const dataDir = makeTempDir("hyperagent-gate-cli-data-");
    const result = await runCli(
      [
        "gate",
        "eval",
        "--harness",
        "claude-code",
        "--hook",
        "PreToolUse",
        "--data-dir",
        dataDir,
      ],
      "not json",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failed open");
  });

  test("unknown hook fails open with empty stdout", async (): Promise<void> => {
    const dataDir = makeTempDir("hyperagent-gate-cli-data-");
    const result = await runCli(
      [
        "gate",
        "eval",
        "--harness",
        "claude-code",
        "--hook",
        "UnknownHook",
        "--data-dir",
        dataDir,
      ],
      preToolUseInput(process.cwd(), "dangerous-command"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failed open");
  });

  test("allow emits empty stdout and exits zero", async (): Promise<void> => {
    const dataDir = makeTempDir("hyperagent-gate-cli-data-");
    const result = await runCli(
      [
        "gate",
        "eval",
        "--harness",
        "claude-code",
        "--hook",
        "PreToolUse",
        "--data-dir",
        dataDir,
      ],
      preToolUseInput(process.cwd(), "echo safe"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("gate human-facing commands", (): void => {
  test("policy validate rejects malformed policy and accepts missing policy", async (): Promise<void> => {
    const malformedDataDir = makeTempDir("hyperagent-gate-cli-bad-policy-");
    writeFileSync(policyPath(malformedDataDir), "{not json", "utf8");
    const malformed = await runCli([
      "gate",
      "policy",
      "validate",
      "--data-dir",
      malformedDataDir,
    ]);
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stdout).toContain("Policy: invalid");

    const missingDataDir = makeTempDir("hyperagent-gate-cli-no-policy-");
    const missing = await runCli([
      "gate",
      "policy",
      "validate",
      "--data-dir",
      missingDataDir,
    ]);
    expect(missing.exitCode).toBe(0);
    expect(missing.stdout).toContain("Policy: default");
  });

  test("contract validate accepts an absent contract", async (): Promise<void> => {
    const repo = makeTempDir("hyperagent-gate-cli-repo-");
    const result = await runCli([
      "gate",
      "contract",
      "validate",
      "--repo",
      repo,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Contract: absent");
  });

  test("violations accepts an empty store", async (): Promise<void> => {
    const dataDir = makeTempDir("hyperagent-gate-cli-violations-");
    mkdirSync(dirname(join(dataDir, "hyperagent.db")), { recursive: true });
    const result = await runCli([
      "violations",
      "--data-dir",
      dataDir,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No violations found.");
    expect(result.stderr).toBe("");
  });

  test("unknown gate subcommand exits with ArgumentError code", async (): Promise<void> => {
    const result = await runCli(["gate", "unknown"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown gate subcommand");
  });
});
