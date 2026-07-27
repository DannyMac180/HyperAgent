import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { HyperEvent } from "../schema/events.ts";
import type { Store } from "../store/store.ts";

export interface MissionDeps {
  runModel: (prompt: string) => Promise<string>;
}

export interface MissionToolUsage {
  count: number;
  statuses: Record<string, number>;
}

export interface MissionUserTurn {
  turnIndex: number | null;
  textDigest: string | null;
}

export interface MissionVerification {
  kind: string | null;
  commandSummary: string | null;
  result: string | null;
  stats: Record<string, unknown> | null;
}

export interface MissionCompletionClaim {
  claimText: string | null;
  claimKind: string | null;
}

export interface MissionError {
  source: string | null;
  messageSummary: string | null;
}

export interface MissionSessionInput {
  sessionId: string;
  vendor: string | null;
  agent: string | null;
  model: string | null;
  repo: string | null;
  gitBranch: string | null;
  startedAt: string | null;
  endedAt: string | null;
  outcome: string | null;
  durationMs: number | null;
  turnCount: number;
  userTurns: MissionUserTurn[];
  toolUsage: Record<string, MissionToolUsage>;
  verifications: MissionVerification[];
  completionClaims: MissionCompletionClaim[];
  errors: MissionError[];
}

export interface MissionRecord {
  sessionId: string;
  markdown: string;
  generatedBy: "model" | "fallback";
  reason?: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function payloadString(event: HyperEvent, key: string): string | null {
  const value = event.payload[key];
  return typeof value === "string" ? value : null;
}

function payloadNumber(event: HyperEvent, key: string): number | null {
  const value = event.payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function payloadRecord(
  event: HyperEvent,
  key: string,
): Record<string, unknown> | null {
  const value = event.payload[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isMainThreadEvent(event: HyperEvent): boolean {
  return event.payload.is_sidechain !== true;
}

function durationBetween(
  startedAt: string | null,
  endedAt: string | null,
): number | null {
  if (startedAt === null || endedAt === null) {
    return null;
  }
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    return null;
  }
  return ended - started;
}

function sortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    ),
  );
}

export function buildMissionInput(
  store: Store,
  sessionId: string,
): MissionSessionInput {
  const events = store.getEvents(sessionId).filter(isMainThreadEvent);
  const sessionStart = events.find((event) => event.type === "session_start");
  const sessionEnd = [...events]
    .reverse()
    .find((event) => event.type === "session_end");
  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];
  const startedAt = sessionStart?.ts ?? firstEvent?.ts ?? null;
  const endedAt = sessionEnd?.ts ?? lastEvent?.ts ?? null;
  const userTurns: MissionUserTurn[] = [];
  const toolUsage = new Map<string, MissionToolUsage>();
  const verifications: MissionVerification[] = [];
  const completionClaims: MissionCompletionClaim[] = [];
  const errors: MissionError[] = [];

  for (const event of events) {
    if (event.type === "turn_start") {
      userTurns.push({
        turnIndex: payloadNumber(event, "turn_index"),
        textDigest: payloadString(event, "text_digest"),
      });
      continue;
    }
    if (event.type === "tool_call") {
      const name = payloadString(event, "name") ?? "unknown";
      const status = payloadString(event, "status") ?? "unknown";
      const usage = toolUsage.get(name) ?? { count: 0, statuses: {} };
      usage.count += 1;
      usage.statuses[status] = (usage.statuses[status] ?? 0) + 1;
      toolUsage.set(name, usage);
      continue;
    }
    if (event.type === "verification_event") {
      verifications.push({
        kind: payloadString(event, "kind"),
        commandSummary: payloadString(event, "command_summary"),
        result: payloadString(event, "result"),
        stats: payloadRecord(event, "stats"),
      });
      continue;
    }
    if (event.type === "completion_claim") {
      completionClaims.push({
        claimText: payloadString(event, "claim_text"),
        claimKind: payloadString(event, "claim_kind"),
      });
      continue;
    }
    if (event.type === "error") {
      errors.push({
        source: payloadString(event, "source"),
        messageSummary: payloadString(event, "message_summary"),
      });
    }
  }

  const sortedToolUsage = sortedRecord(
    [...toolUsage.entries()].map(([name, usage]) => [
      name,
      {
        count: usage.count,
        statuses: sortedRecord(Object.entries(usage.statuses)),
      },
    ]),
  );
  const reportedDuration = sessionEnd === undefined
    ? null
    : payloadNumber(sessionEnd, "duration_ms");

  return {
    sessionId,
    vendor: sessionStart?.vendor ?? firstEvent?.vendor ?? null,
    agent: sessionStart === undefined
      ? null
      : payloadString(sessionStart, "agent"),
    model: sessionStart === undefined
      ? null
      : payloadString(sessionStart, "model"),
    repo: sessionStart === undefined
      ? null
      : payloadString(sessionStart, "repo"),
    gitBranch: sessionStart === undefined
      ? null
      : payloadString(sessionStart, "git_branch"),
    startedAt,
    endedAt,
    outcome: sessionEnd === undefined
      ? null
      : payloadString(sessionEnd, "outcome"),
    durationMs: reportedDuration ?? durationBetween(startedAt, endedAt),
    turnCount: userTurns.length,
    userTurns,
    toolUsage: sortedToolUsage,
    verifications,
    completionClaims,
    errors,
  };
}

function stableValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" ||
      typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      result[key] = stableValue(record[key], seen);
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value, new WeakSet<object>()));
}

export function buildMissionPrompt(input: MissionSessionInput): string {
  return `Write a concise, human-readable mission record from the structured facts below.
Cover what was attempted, what actually happened, the evidence (including which verifications ran and their results), and the outcome.
Do not invent facts or claim that a completion claim is verified evidence.
Emit markdown only, with no preamble.

Structured facts:
${stableJson(input)}`;
}

function display(value: string | number | null): string {
  return value === null ? "unknown" : String(value);
}

function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderToolUsage(toolUsage: Record<string, MissionToolUsage>): string[] {
  const names = Object.keys(toolUsage).sort();
  if (names.length === 0) {
    return ["- None recorded."];
  }
  return names.map((name) => {
    const usage = toolUsage[name];
    if (usage === undefined) {
      return `- ${name}: 0 (no statuses)`;
    }
    const statuses = Object.keys(usage.statuses)
      .sort()
      .map((status) => `${status}: ${usage.statuses[status]}`)
      .join(", ");
    return `- ${name}: ${usage.count} (${statuses || "no statuses"})`;
  });
}

export function buildFallbackRecord(
  input: MissionSessionInput,
  reason: string,
): string {
  const lines: string[] = [
    `> Generated without model — ${inline(reason)}`,
    "",
    `# Mission ${input.sessionId}`,
    "",
    "## Session",
    "",
    `- Vendor: ${display(input.vendor)}`,
    `- Agent: ${display(input.agent)}`,
    `- Model: ${display(input.model)}`,
    `- Repository: ${display(input.repo)}`,
    `- Git branch: ${display(input.gitBranch)}`,
    `- Started: ${display(input.startedAt)}`,
    `- Ended: ${display(input.endedAt)}`,
    `- Duration (ms): ${display(input.durationMs)}`,
    `- Main-thread turns: ${input.turnCount}`,
    "",
    "## What was attempted",
    "",
  ];

  if (input.userTurns.length === 0) {
    lines.push("- No user-turn digests were recorded.");
  } else {
    for (const turn of input.userTurns) {
      lines.push(
        `- Turn ${display(turn.turnIndex)}: ${display(turn.textDigest)}`,
      );
    }
  }

  lines.push("", "## What ran", "", ...renderToolUsage(input.toolUsage));
  lines.push("", "## Verification evidence", "");
  if (input.verifications.length === 0) {
    lines.push("- None recorded.");
  } else {
    for (const verification of input.verifications) {
      lines.push(
        `- ${display(verification.kind)}: ${display(verification.commandSummary)} — ${display(verification.result)}; stats: ${stableJson(verification.stats)}`,
      );
    }
  }

  lines.push("", "## Completion claims", "");
  if (input.completionClaims.length === 0) {
    lines.push("- None recorded.");
  } else {
    for (const claim of input.completionClaims) {
      lines.push(
        `- ${display(claim.claimKind)}: ${display(claim.claimText)}`,
      );
    }
  }

  lines.push("", "## Errors", "");
  if (input.errors.length === 0) {
    lines.push("- None recorded.");
  } else {
    for (const error of input.errors) {
      lines.push(
        `- ${display(error.source)}: ${display(error.messageSummary)}`,
      );
    }
  }

  lines.push(
    "",
    "## Outcome",
    "",
    `- ${display(input.outcome)}`,
    "",
  );
  return lines.join("\n");
}

export async function generateMission(
  deps: MissionDeps,
  input: MissionSessionInput,
): Promise<MissionRecord> {
  try {
    const output = await deps.runModel(buildMissionPrompt(input));
    const markdown = output.trim();
    if (markdown.length === 0) {
      const reason = "model returned empty output";
      return {
        sessionId: input.sessionId,
        markdown: buildFallbackRecord(input, reason),
        generatedBy: "fallback",
        reason,
      };
    }
    if (markdown.length < 40) {
      const reason = `model output was too short (${markdown.length} characters)`;
      return {
        sessionId: input.sessionId,
        markdown: buildFallbackRecord(input, reason),
        generatedBy: "fallback",
        reason,
      };
    }
    return {
      sessionId: input.sessionId,
      markdown,
      generatedBy: "model",
    };
  } catch (error: unknown) {
    const reason = `model invocation failed: ${errorMessage(error)}`;
    return {
      sessionId: input.sessionId,
      markdown: buildFallbackRecord(input, reason),
      generatedBy: "fallback",
      reason,
    };
  }
}

export function missionRecordPath(sessionId: string, dataDir: string): string {
  const missionsDir = resolve(dataDir, "missions");
  const sanitized = sessionId.replace(/[^A-Za-z0-9._-]/g, "-");
  const sha8 = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
  // Full sanitization makes path traversal structurally impossible.
  const path = resolve(missionsDir, `${sanitized}-${sha8}.md`);
  if (!path.startsWith(`${missionsDir}${sep}`)) {
    throw new Error(`Mission path escaped missions directory: ${path}`);
  }
  return path;
}

export async function writeMissionRecord(
  record: MissionRecord,
  dataDir: string,
): Promise<string> {
  const path = missionRecordPath(record.sessionId, dataDir);
  const missionsDir = resolve(dataDir, "missions");
  const temporaryPath = `${path}.tmp`;
  try {
    await mkdir(missionsDir, { recursive: true });
    await writeFile(temporaryPath, record.markdown, "utf8");
    await rename(temporaryPath, path);
    return path;
  } catch (error: unknown) {
    throw new Error(
      `Failed to write mission record for ${record.sessionId}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}
