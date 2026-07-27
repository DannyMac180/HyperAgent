import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

import type { SessionGateContext } from "./contract.ts";
import {
  bounceCounterPath,
  bounceDir,
  gateDir,
  rotatedSpoolPath,
  spoolPath,
} from "./paths.ts";

export const GATE_OUTCOME_VERSION = 1;

export type GateOutcomeKind =
  | "pre_tool_use"
  | "post_tool_use"
  | "stop"
  | "gate_gave_up"
  | "gate_error";

export type GateOutcomeDecision = "allow" | "deny" | "block";

export interface GateOutcome {
  v: 1;
  kind: GateOutcomeKind;
  ts: string;
  harness: string;
  sessionId: string;
  cwd: string;
  decision: GateOutcomeDecision;
  summary: string;
  matchedRules: string[];
  failedChecks: string[];
  command?: string;
  passed?: boolean;
  touchedFiles?: string[];
  error?: string;
}

export interface SpoolRead {
  outcomes: GateOutcome[];
  malformedLines: number;
}

const OUTCOME_KINDS: ReadonlySet<string> = new Set([
  "pre_tool_use",
  "post_tool_use",
  "stop",
  "gate_gave_up",
  "gate_error",
]);

const OUTCOME_DECISIONS: ReadonlySet<string> = new Set([
  "allow",
  "deny",
  "block",
]);

interface BounceRead {
  value: number;
  ioFailed: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: object | null = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value)
    && value.every((entry: unknown): entry is string => typeof entry === "string")
  );
}

function isIsoUtcWithMilliseconds(value: unknown): value is string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isOptionalStringArray(
  value: unknown,
): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isGateOutcome(value: unknown): value is GateOutcome {
  return (
    isPlainObject(value)
    && value.v === GATE_OUTCOME_VERSION
    && typeof value.kind === "string"
    && OUTCOME_KINDS.has(value.kind)
    && isIsoUtcWithMilliseconds(value.ts)
    && typeof value.harness === "string"
    && value.harness.length > 0
    && typeof value.sessionId === "string"
    && value.sessionId.length > 0
    && typeof value.cwd === "string"
    && typeof value.decision === "string"
    && OUTCOME_DECISIONS.has(value.decision)
    && typeof value.summary === "string"
    && isStringArray(value.matchedRules)
    && isStringArray(value.failedChecks)
    && isOptionalString(value.command)
    && isOptionalBoolean(value.passed)
    && isOptionalStringArray(value.touchedFiles)
    && isOptionalString(value.error)
  );
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function parseCompleteLine(line: string, result: SpoolRead): void {
  if (line.trim().length === 0) {
    result.malformedLines += 1;
    return;
  }
  try {
    const candidate: unknown = JSON.parse(line) as unknown;
    if (isGateOutcome(candidate)) {
      result.outcomes.push(candidate);
    } else {
      result.malformedLines += 1;
    }
  } catch {
    result.malformedLines += 1;
  }
}

function parseSpoolText(raw: string, result: SpoolRead): void {
  if (raw.length === 0) {
    return;
  }

  const lines: string[] = raw.split("\n");
  if (raw.endsWith("\n")) {
    lines.pop();
  } else {
    // Appends are newline-terminated. A final fragment without that delimiter
    // may be a torn write, even when its bytes happen to parse as JSON.
    lines.pop();
    result.malformedLines += 1;
  }

  for (const line of lines) {
    parseCompleteLine(line, result);
  }
}

async function readSpoolFile(path: string, result: SpoolRead): Promise<void> {
  try {
    const raw: string = await readFile(path, "utf8");
    parseSpoolText(raw, result);
  } catch {
    // Hooks and the daemon must keep operating when either spool is absent,
    // unreadable, or concurrently renamed.
  }
}

export async function appendOutcome(
  dataDir: string,
  outcome: GateOutcome,
): Promise<boolean> {
  try {
    const serialized: string = JSON.stringify(outcome);
    // JSON strings escape embedded newlines. Refuse unexpected output so one
    // outcome can never become multiple spool records.
    if (serialized.includes("\n")) {
      return false;
    }
    await mkdir(gateDir(dataDir), { recursive: true });
    // One O_APPEND write keeps concurrent short-lived hooks from overwriting
    // each other and leaves SQLite exclusively owned by the daemon.
    await appendFile(spoolPath(dataDir), `${serialized}\n`, {
      encoding: "utf8",
      flag: "a",
    });
    return true;
  } catch {
    // Gate recording is diagnostic: every I/O or serialization failure must
    // fail open rather than interrupt the user's tool.
    return false;
  }
}

export async function readSpool(dataDir: string): Promise<SpoolRead> {
  const result: SpoolRead = { outcomes: [], malformedLines: 0 };
  try {
    // The daemon rotates old bytes first, so reading rotated before live
    // preserves the original chronology.
    await readSpoolFile(rotatedSpoolPath(dataDir), result);
    await readSpoolFile(spoolPath(dataDir), result);
  } catch {
    // Path construction can fail for invalid runtime inputs; reads still fail
    // open with the successfully accumulated prefix.
  }
  return result;
}

export function sessionContextFromSpool(
  outcomes: GateOutcome[],
  sessionId: string,
): SessionGateContext {
  const context: SessionGateContext = { commands: [], touchedFiles: [] };

  outcomes.forEach((outcome: GateOutcome, sequence: number): void => {
    if (outcome.kind !== "post_tool_use" || outcome.sessionId !== sessionId) {
      return;
    }

    if (outcome.command !== undefined) {
      context.commands.push({
        command: outcome.command,
        // An unknown result must never satisfy a required verification check.
        passed: outcome.passed ?? false,
        sequence,
      });
    }

    for (const path of outcome.touchedFiles ?? []) {
      context.touchedFiles.push({ path, sequence });
    }
  });

  return context;
}

export async function rotateSpool(
  dataDir: string,
  maxBytes = 5_000_000,
): Promise<boolean> {
  try {
    const livePath: string = spoolPath(dataDir);
    const rotatedPath: string = rotatedSpoolPath(dataDir);
    const liveStats = await stat(livePath);
    if (!liveStats.isFile() || liveStats.size <= maxBytes) {
      return false;
    }

    try {
      await stat(rotatedPath);
      // Rotation is daemon-only, and an unconsumed generation always wins:
      // replacing it would silently discard outcomes.
      return false;
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") {
        return false;
      }
    }

    await rename(livePath, rotatedPath);
    return true;
  } catch {
    return false;
  }
}

export async function discardRotatedSpool(dataDir: string): Promise<void> {
  try {
    await rm(rotatedSpoolPath(dataDir), { force: true });
  } catch {
    // Discard is idempotent and daemon cleanup must not become fatal.
  }
}

async function regularFileSize(path: string): Promise<number> {
  try {
    const fileStats = await stat(path);
    return fileStats.isFile() ? fileStats.size : 0;
  } catch {
    return 0;
  }
}

export async function spoolBacklogBytes(dataDir: string): Promise<number> {
  try {
    const [rotatedBytes, liveBytes]: [number, number] = await Promise.all([
      regularFileSize(rotatedSpoolPath(dataDir)),
      regularFileSize(spoolPath(dataDir)),
    ]);
    return rotatedBytes + liveBytes;
  } catch {
    return 0;
  }
}

function parseBounceCount(raw: string): number {
  const trimmed: string = raw.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return 0;
  }
  const parsed: number = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

async function readBounceFile(path: string): Promise<BounceRead> {
  try {
    const raw: string = await readFile(path, "utf8");
    return { value: parseBounceCount(raw), ioFailed: false };
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return { value: 0, ioFailed: false };
    }
    return { value: 0, ioFailed: true };
  }
}

export async function incrementBounceCount(
  dataDir: string,
  sessionId: string,
): Promise<number> {
  try {
    await mkdir(bounceDir(dataDir), { recursive: true });
    const path: string = bounceCounterPath(dataDir, sessionId);
    const current: BounceRead = await readBounceFile(path);
    if (current.ioFailed) {
      // A high sentinel trips the bounce guard toward ALLOW, so broken
      // bookkeeping can never trap a user in repeated denials.
      return Number.MAX_SAFE_INTEGER;
    }
    const next: number = Math.min(
      current.value + 1,
      Number.MAX_SAFE_INTEGER,
    );
    await writeFile(path, `${next}\n`, "utf8");
    return next;
  } catch {
    // Counter persistence is advisory; I/O failure must fail open.
    return Number.MAX_SAFE_INTEGER;
  }
}

export async function readBounceCount(
  dataDir: string,
  sessionId: string,
): Promise<number> {
  try {
    const result: BounceRead = await readBounceFile(
      bounceCounterPath(dataDir, sessionId),
    );
    return result.ioFailed ? 0 : result.value;
  } catch {
    return 0;
  }
}

export async function clearBounceCount(
  dataDir: string,
  sessionId: string,
): Promise<void> {
  try {
    await rm(bounceCounterPath(dataDir, sessionId), { force: true });
  } catch {
    // Clearing an absent or inaccessible advisory counter is a no-op.
  }
}
