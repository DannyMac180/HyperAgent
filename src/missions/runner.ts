import { accessSync, constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import type { HyperEvent } from "../schema/events.ts";

export interface AgentRunnerConfig {
  cliPath?: string;
  model?: string;
  timeoutMs?: number;
  cwd?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Tool names the spawned CLI must refuse. Workshop drafting runs unattended,
   * so it passes the file-mutating tools here: an unattended nightly run must
   * carry zero filesystem authority through the LLM.
   */
  disallowedTools?: string[];
}

const MAX_CAPTURE_BYTES = 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;
const KILL_GRACE_MS = 2_000;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function resolveClaudeCliPath(env: NodeJS.ProcessEnv): string {
  // launchd commonly supplies only /usr/bin:/bin, so spawning bare "claude"
  // produces ENOENT even when the user's CLI is installed elsewhere.
  for (const entry of (env.PATH ?? "").split(":")) {
    if (entry.length === 0) {
      continue;
    }
    const candidate = resolve(entry, "claude");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH in order.
    }
  }
  return join(homedir(), ".local", "bin", "claude");
}

export function sanitizeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^CLAUDECODE/.test(key) || /^CLAUDE_CODE_/.test(key)) {
      continue;
    }
    // Never remove ANTHROPIC_* variables: they carry the user's auth path.
    sanitized[key] = value;
  }
  return sanitized;
}

export function buildAgentRunnerArgv(
  config: Pick<AgentRunnerConfig, "model" | "disallowedTools"> = {},
): string[] {
  const argv = [
    "-p",
    "--model",
    config.model ?? "haiku",
    "--output-format",
    "text",
  ];
  const disallowedTools = config.disallowedTools;
  if (disallowedTools === undefined || disallowedTools.length === 0) {
    return argv;
  }
  for (const [index, tool] of disallowedTools.entries()) {
    if (typeof tool !== "string" || tool.trim().length === 0) {
      throw new Error(
        `disallowedTools[${index}] must be a non-empty string`,
      );
    }
    if (tool.includes(",")) {
      throw new Error(
        `disallowedTools[${index}] must not contain a comma`,
      );
    }
  }
  argv.push("--disallowedTools", disallowedTools.join(","));
  return argv;
}

export function isSuitOwnSession(
  events: HyperEvent[],
  dataDir: string,
): boolean {
  const resolvedDataDir = resolve(dataDir);
  for (const event of events) {
    const record = isRecord(event) ? event : undefined;
    if (record?.type !== "session_start" || !isRecord(record.payload)) {
      continue;
    }
    for (const key of ["cwd", "repo"]) {
      const value = record.payload[key];
      if (typeof value !== "string") {
        continue;
      }
      const candidate = resolve(value);
      // The separator matters: raw startsWith false-positives on sibling paths
      // such as ~/.hyperagent-other.
      if (
        candidate === resolvedDataDir ||
        candidate.startsWith(`${resolvedDataDir}${sep}`)
      ) {
        return true;
      }
    }
  }
  return false;
}

function appendCapped(
  chunks: Buffer[],
  capturedBytes: number,
  chunk: Buffer,
): number {
  const remaining = MAX_CAPTURE_BYTES - capturedBytes;
  if (remaining <= 0) {
    return capturedBytes;
  }
  const captured = chunk.subarray(0, remaining);
  chunks.push(captured);
  return capturedBytes + captured.length;
}

function appendTail(current: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= MAX_CAPTURE_BYTES
    ? combined
    : combined.subarray(combined.length - MAX_CAPTURE_BYTES);
}

function stderrTail(stderr: Buffer): string {
  return stderr
    .subarray(Math.max(0, stderr.length - STDERR_TAIL_BYTES))
    .toString("utf8")
    .trim();
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The process group may already be gone.
  }
}

export function spawnAgentRunner(
  config: AgentRunnerConfig = {},
): (prompt: string) => Promise<string> {
  const dataDir = config.dataDir ?? join(homedir(), ".hyperagent");
  const sourceEnv = config.env ?? process.env;
  const cliPath =
    config.cliPath === undefined
      ? resolveClaudeCliPath(sourceEnv)
      : isAbsolute(config.cliPath)
        ? config.cliPath
        : resolve(config.cliPath);
  const model = config.model ?? "haiku";
  const timeoutMs = config.timeoutMs ?? 120_000;
  const cwd = config.cwd ?? join(dataDir, "modelruns");
  const env = sanitizeChildEnv(sourceEnv);

  return async (prompt: string): Promise<string> => {
    try {
      await mkdir(cwd, { recursive: true });
    } catch (error) {
      throw new Error(
        `Failed to create Claude runner cwd "${cwd}": ${errorMessage(error)}`,
      );
    }

    return await new Promise<string>((resolvePromise, rejectPromise) => {
      let settled = false;
      let timedOut = false;
      let stdoutBytes = 0;
      const stdoutChunks: Buffer[] = [];
      let stderr: Buffer = Buffer.alloc(0);
      let timeoutTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const settle = (error: Error | undefined, output?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutTimer !== undefined) {
          clearTimeout(timeoutTimer);
        }
        if (!timedOut && killTimer !== undefined) {
          clearTimeout(killTimer);
        }
        if (error !== undefined) {
          rejectPromise(error);
        } else {
          resolvePromise(output ?? "");
        }
      };

      let child;
      try {
        child = spawn(
          cliPath,
          buildAgentRunnerArgv({
            model,
            disallowedTools: config.disallowedTools,
          }),
          {
            cwd,
            env,
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
      } catch (error) {
        settle(
          new Error(
            `Failed to spawn Claude CLI at "${cliPath}": ${errorMessage(error)}`,
          ),
        );
        return;
      }

      child.stdout.on("data", (chunk: Buffer | string): void => {
        stdoutBytes = appendCapped(
          stdoutChunks,
          stdoutBytes,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        );
      });
      child.stderr.on("data", (chunk: Buffer | string): void => {
        stderr = appendTail(
          stderr,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        );
      });

      child.on("error", (error: Error): void => {
        settle(
          new Error(
            `Failed to run Claude CLI at "${cliPath}": ${errorMessage(error)}`,
          ),
        );
      });

      child.on(
        "close",
        (code: number | null, signal: NodeJS.Signals | null): void => {
          if (timedOut) {
            return;
          }
          if (code !== 0) {
            const tail = stderrTail(stderr);
            settle(
              new Error(
                `Claude CLI at "${cliPath}" exited with code ${String(code)} and signal ${String(signal)}${
                  tail.length > 0 ? `; stderr tail: ${tail}` : ""
                }`,
              ),
            );
            return;
          }
          const output = Buffer.concat(stdoutChunks).toString("utf8").trim();
          if (output.length === 0) {
            settle(
              new Error(
                `Claude CLI at "${cliPath}" exited successfully but returned empty stdout`,
              ),
            );
            return;
          }
          settle(undefined, output);
        },
      );

      child.stdin.on("error", (error: NodeJS.ErrnoException): void => {
        if (error.code === "EPIPE") {
          return;
        }
        settle(
          new Error(
            `Failed writing prompt to Claude CLI at "${cliPath}": ${errorMessage(error)}`,
          ),
        );
      });
      // Prompts use stdin because they can be large and argv has an OS limit.
      child.stdin.end(prompt);

      timeoutTimer = setTimeout((): void => {
        timedOut = true;
        killProcessGroup(child.pid, "SIGTERM");
        killTimer = setTimeout((): void => {
          killProcessGroup(child.pid, "SIGKILL");
        }, KILL_GRACE_MS);
        killTimer.unref();
        settle(
          new Error(
            `Claude CLI at "${cliPath}" timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      timeoutTimer.unref();
    });
  };
}
