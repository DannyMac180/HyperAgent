import { homedir } from "node:os";
import { basename, join } from "node:path";
import { open, readdir, stat } from "node:fs/promises";

import { deterministicEventId } from "../../schema/ids.ts";
import type { EventInput } from "../../schema/events.ts";
import type {
  AdapterHealth,
  DiscoveredSession,
  ObserveAdapter,
  ParseResult,
} from "../types.ts";
import {
  KNOWN_LINE_TYPES,
  canonicalJson,
  classifyVerificationCommand,
  contentBlocks,
  digestInput,
  extractAssistantText,
  extractUserText,
  filesTouchedFrom,
  findCompletionClaims,
  isPlainObject,
  isRealUserTurn,
  isSystemErrorLine,
  isToolUseBlock,
  normalizeTimestamp,
  parseTranscriptLine,
  redactSummary,
  sha256Hex,
  systemErrorMessage,
  userToolResults,
} from "./transcript.ts";
import type {
  ToolResultBlock,
  ToolUseBlock,
  TranscriptLine,
} from "./transcript.ts";

interface ResumeState {
  v: 1;
  lines: number;
  bytes: number;
  turns: number;
}

interface PendingTool {
  block: ToolUseBlock;
  ts: string;
  cwd: string | undefined;
  isSidechain: boolean;
  turnIndex: number;
  lineNumber: number;
  byteOffset: number;
  linesBefore: number;
  turnsBefore: number;
}

interface EmittedEvent {
  event: EventInput;
  byteOffset: number;
}

interface CompleteLine {
  raw: string;
  lineNumber: number;
  byteOffset: number;
  nextByteOffset: number;
}

interface DirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

const currentTurnIndex = (turns: number): number =>
  turns > 0 ? turns - 1 : 0;

const resumeStateFrom = (
  token: string,
  fileSize: number,
): ResumeState => {
  if (token === "") {
    return { v: 1, lines: 0, bytes: 0, turns: 0 };
  }

  try {
    const parsed: unknown = JSON.parse(token);
    if (
      !isPlainObject(parsed) ||
      parsed.v !== 1 ||
      !Number.isInteger(parsed.lines) ||
      !Number.isInteger(parsed.bytes) ||
      !Number.isInteger(parsed.turns) ||
      typeof parsed.lines !== "number" ||
      typeof parsed.bytes !== "number" ||
      typeof parsed.turns !== "number" ||
      parsed.lines < 0 ||
      parsed.bytes < 0 ||
      parsed.turns < 0 ||
      parsed.bytes > fileSize
    ) {
      return { v: 1, lines: 0, bytes: 0, turns: 0 };
    }

    return {
      v: 1,
      lines: parsed.lines,
      bytes: parsed.bytes,
      turns: parsed.turns,
    };
  } catch {
    return { v: 1, lines: 0, bytes: 0, turns: 0 };
  }
};

const stringifyResultContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  return canonicalJson(content);
};

const parentIdFromLines = (
  lines: CompleteLine[],
  sessionId: string,
): string | null => {
  const nativeSessionId: string = sessionId.startsWith("claude-code:")
    ? sessionId.slice("claude-code:".length)
    : sessionId;

  for (const completeLine of lines) {
    const line: TranscriptLine | null = parseTranscriptLine(completeLine.raw);
    if (line === null || line.type !== "summary") {
      continue;
    }

    for (const candidate of [line.leafUuid, line.sessionId]) {
      if (typeof candidate !== "string" || candidate.length === 0) {
        continue;
      }

      const nativeCandidate: string = candidate.startsWith("claude-code:")
        ? candidate.slice("claude-code:".length)
        : candidate;
      if (
        nativeCandidate !== nativeSessionId &&
        `claude-code:${nativeCandidate}` !== sessionId
      ) {
        return `claude-code:${nativeCandidate}`;
      }
    }
  }

  for (const completeLine of lines) {
    const line: TranscriptLine | null = parseTranscriptLine(completeLine.raw);
    if (line === null || line.type !== "user" || line.message === undefined) {
      continue;
    }

    const text: string = extractUserText(line.message);
    const continuation =
      "This session is being continued from a previous conversation";
    if (!text.startsWith(continuation)) {
      return null;
    }

    const idMatch: RegExpMatchArray | null = text.match(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
    );
    if (idMatch?.[0] !== undefined && idMatch[0] !== nativeSessionId) {
      return `claude-code:${idMatch[0]}`;
    }

    return null;
  }

  return null;
};

export class ClaudeCodeAdapter implements ObserveAdapter {
  readonly vendor = "claude-code";
  readonly adapterVersion = "0.1.0";

  private readonly projectsRoot: string;

  constructor(options?: { projectsRoot?: string }) {
    this.projectsRoot =
      options?.projectsRoot ?? join(homedir(), ".claude", "projects");
  }

  async detect(): Promise<AdapterHealth> {
    let projectDirectories: DirectoryEntry[];
    try {
      projectDirectories = await readdir(this.projectsRoot, {
        withFileTypes: true,
      });
    } catch (error: unknown) {
      const detail: string =
        error instanceof Error ? error.message : String(error);
      return {
        status: "unavailable",
        harnessVersion: null,
        detail: `Cannot read ${this.projectsRoot}: ${detail}`,
      };
    }

    const sessions: DiscoveredSession[] = [];
    for (const projectDirectory of projectDirectories) {
      if (!projectDirectory.isDirectory()) {
        continue;
      }

      const directoryPath: string = join(
        this.projectsRoot,
        projectDirectory.name,
      );
      let entries: DirectoryEntry[];
      try {
        entries = await readdir(directoryPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          continue;
        }

        const path: string = join(directoryPath, entry.name);
        try {
          const metadata = await stat(path);
          sessions.push({
            sessionId: `claude-code:${basename(entry.name, ".jsonl")}`,
            path,
            mtimeMs: metadata.mtimeMs,
            sizeBytes: metadata.size,
          });
        } catch {
          continue;
        }
      }
    }

    let harnessVersion: string | null = null;
    let headReadDetail = "";
    const mostRecent: DiscoveredSession | undefined = sessions.sort(
      (left: DiscoveredSession, right: DiscoveredSession): number =>
        right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path),
    )[0];

    if (mostRecent !== undefined) {
      try {
        const handle = await open(mostRecent.path, "r");
        try {
          const headSize: number = Math.min(mostRecent.sizeBytes, 64 * 1024);
          const head: Buffer = Buffer.alloc(headSize);
          const { bytesRead } = await handle.read(head, 0, headSize, 0);
          const text: string = head.subarray(0, bytesRead).toString("utf8");
          for (const raw of text.split("\n")) {
            const line: TranscriptLine | null = parseTranscriptLine(raw);
            if (
              line !== null &&
              (line.type === "user" || line.type === "assistant")
            ) {
              harnessVersion =
                typeof line.version === "string" ? line.version : null;
              break;
            }
          }
        } finally {
          await handle.close();
        }
      } catch (error: unknown) {
        const detail: string =
          error instanceof Error ? error.message : String(error);
        headReadDetail = `; latest transcript head unreadable: ${detail}`;
      }
    }

    return {
      status: "ok",
      harnessVersion,
      detail:
        `${sessions.length} session transcripts under ${this.projectsRoot}` +
        headReadDetail,
    };
  }

  async discoverSessions(): Promise<DiscoveredSession[]> {
    let projectDirectories: DirectoryEntry[];
    try {
      projectDirectories = await readdir(this.projectsRoot, {
        withFileTypes: true,
      });
    } catch {
      return [];
    }

    const sessions: DiscoveredSession[] = [];
    for (const projectDirectory of projectDirectories) {
      if (!projectDirectory.isDirectory()) {
        continue;
      }

      const directoryPath: string = join(
        this.projectsRoot,
        projectDirectory.name,
      );
      let entries: DirectoryEntry[];
      try {
        entries = await readdir(directoryPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          continue;
        }

        const path: string = join(directoryPath, entry.name);
        try {
          const metadata = await stat(path);
          sessions.push({
            sessionId: `claude-code:${basename(entry.name, ".jsonl")}`,
            path,
            mtimeMs: metadata.mtimeMs,
            sizeBytes: metadata.size,
          });
        } catch {
          continue;
        }
      }
    }

    return sessions.sort(
      (left: DiscoveredSession, right: DiscoveredSession): number =>
        left.path.localeCompare(right.path),
    );
  }

  async parseSession(
    session: DiscoveredSession,
    resumeToken: string,
  ): Promise<ParseResult> {
    const file: Bun.BunFile = Bun.file(session.path);
    const fileSize: number = file.size;
    const initial: ResumeState = resumeStateFrom(resumeToken, fileSize);
    const bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    const lines: CompleteLine[] = [];

    let cursor: number = initial.bytes;
    let physicalLine: number = initial.lines;
    while (cursor < bytes.length) {
      const newline: number = bytes.indexOf(10, cursor);
      if (newline < 0) {
        break;
      }

      const lineEnd: number =
        newline > cursor && bytes[newline - 1] === 13 ? newline - 1 : newline;
      lines.push({
        raw: new TextDecoder().decode(bytes.subarray(cursor, lineEnd)),
        lineNumber: physicalLine + 1,
        byteOffset: cursor,
        nextByteOffset: newline + 1,
      });
      physicalLine += 1;
      cursor = newline + 1;
    }

    const parentSessionId: string | null = parentIdFromLines(
      lines,
      session.sessionId,
    );
    const sessionModelLine: TranscriptLine | undefined = lines
      .map((completeLine: CompleteLine): TranscriptLine | null =>
        parseTranscriptLine(completeLine.raw),
      )
      .find(
        (line: TranscriptLine | null): boolean =>
          line?.type === "assistant" &&
          isPlainObject(line.message) &&
          typeof line.message.model === "string",
      ) ?? undefined;
    const sessionModel: string | undefined =
      isPlainObject(sessionModelLine?.message) &&
      typeof sessionModelLine.message.model === "string"
        ? sessionModelLine.message.model
        : undefined;
    const pendingTools = new Map<string, PendingTool>();
    const emitted: EmittedEvent[] = [];
    let skippedUnknown = 0;
    let parseFailures = 0;
    let turns: number = initial.turns;
    let sessionStartEmitted: boolean = initial.bytes !== 0;

    const emit = (
      ts: string,
      type: EventInput["type"],
      rawRef: string,
      payload: Record<string, unknown>,
      byteOffset: number,
      discriminator?: string,
    ): EventInput => {
      const id: string = deterministicEventId(
        discriminator === undefined
          ? {
              ts,
              sessionId: session.sessionId,
              rawRef,
              type,
            }
          : {
              ts,
              sessionId: session.sessionId,
              rawRef,
              type,
              discriminator,
            },
      );
      const event = {
        id,
        ts,
        type,
        session_id: session.sessionId,
        vendor: this.vendor,
        adapter_version: this.adapterVersion,
        raw_ref: rawRef,
        payload,
      } as EventInput;
      emitted.push({ event, byteOffset });
      return event;
    };

    for (const completeLine of lines) {
      const linesBefore: number = completeLine.lineNumber - 1;
      const turnsBefore: number = turns;
      if (completeLine.raw.trim() === "") {
        continue;
      }

      const line: TranscriptLine | null = parseTranscriptLine(completeLine.raw);
      if (line === null) {
        skippedUnknown += 1;
        continue;
      }

      if (!KNOWN_LINE_TYPES.has(line.type)) {
        skippedUnknown += 1;
        continue;
      }

      if (line.type === "system") {
        if (!isSystemErrorLine(line)) {
          skippedUnknown += 1;
          continue;
        }

        const ts: string | null = normalizeTimestamp(line.timestamp);
        if (ts === null) {
          parseFailures += 1;
          continue;
        }

        const rawRef: string = `${session.path}#L${completeLine.lineNumber}`;
        const message: string = systemErrorMessage(line);
        const payload: Record<string, unknown> = {
          source: "harness",
          message_digest: sha256Hex(message),
          message_summary: redactSummary(message),
          turn_index: currentTurnIndex(turns),
          tool_call_id: null,
        };
        if (line.isSidechain === true) {
          payload.is_sidechain = true;
        }
        emit(
          ts,
          "error",
          rawRef,
          payload,
          completeLine.byteOffset,
          "system_error",
        );
        continue;
      }

      const ts: string | null = normalizeTimestamp(line.timestamp);
      if (ts === null || line.message === undefined) {
        parseFailures += 1;
        continue;
      }

      const rawRef: string = `${session.path}#L${completeLine.lineNumber}`;
      if (!sessionStartEmitted) {
        const payload: Record<string, unknown> = {
          agent: "claude-code",
          parent_session_id: parentSessionId,
        };
        if (sessionModel !== undefined) {
          payload.model = sessionModel;
        }
        if (typeof line.version === "string") {
          payload.harness_version = line.version;
        }
        if (typeof line.cwd === "string") {
          payload.repo = line.cwd;
          payload.cwd = line.cwd;
        }
        if (typeof line.gitBranch === "string") {
          payload.git_branch = line.gitBranch;
        }
        emit(
          ts,
          "session_start",
          rawRef,
          payload,
          completeLine.byteOffset,
        );
        sessionStartEmitted = true;
      }

      if (line.type === "user") {
        const results: ToolResultBlock[] = userToolResults(line.message);
        for (const result of results) {
          const pending: PendingTool | undefined = pendingTools.get(
            result.tool_use_id,
          );
          if (pending === undefined) {
            continue;
          }

          const useRawRef: string =
            `${session.path}#L${pending.lineNumber}`;
          const status: "ok" | "error" =
            result.is_error === true ? "error" : "ok";
          const toolPayload: Record<string, unknown> = {
            name: pending.block.name,
            input_digest: digestInput(pending.block.input, pending.cwd),
            input_summary: redactSummary(canonicalJson(pending.block.input)),
            status,
            turn_index: pending.turnIndex,
          };
          const durationMs: number =
            new Date(ts).getTime() - new Date(pending.ts).getTime();
          if (Number.isFinite(durationMs) && durationMs >= 0) {
            toolPayload.duration_ms = durationMs;
          }
          const filesTouched: string[] = filesTouchedFrom(
            pending.block.name,
            pending.block.input,
            pending.cwd,
          );
          if (filesTouched.length > 0) {
            toolPayload.files_touched = filesTouched;
          }
          if (pending.isSidechain) {
            toolPayload.is_sidechain = true;
          }
          const toolCall: EventInput = emit(
            pending.ts,
            "tool_call",
            useRawRef,
            toolPayload,
            pending.byteOffset,
            pending.block.id,
          );

          if (result.is_error === true) {
            const message: string = stringifyResultContent(result.content);
            const errorPayload: Record<string, unknown> = {
              source: "tool",
              message_digest: sha256Hex(message),
              message_summary: redactSummary(message),
              turn_index: pending.turnIndex,
              tool_call_id: toolCall.id,
            };
            if (line.isSidechain === true) {
              errorPayload.is_sidechain = true;
            }
            emit(
              ts,
              "error",
              rawRef,
              errorPayload,
              completeLine.byteOffset,
              `error:${result.tool_use_id}`,
            );
          }

          if (pending.block.name === "Bash") {
            const commandValue: unknown = pending.block.input.command;
            const command: string = String(commandValue);
            const kind: "test" | "typecheck" | "other" | null =
              classifyVerificationCommand(command);
            if (kind !== null) {
              const verificationPayload: Record<string, unknown> = {
                kind,
                command_digest: sha256Hex(command),
                command_summary: redactSummary(command),
                result: result.is_error === true ? "fail" : "pass",
                turn_index: pending.turnIndex,
                initiated_by: "agent",
              };
              if (pending.isSidechain) {
                verificationPayload.is_sidechain = true;
              }
              emit(
                pending.ts,
                "verification_event",
                useRawRef,
                verificationPayload,
                pending.byteOffset,
                `verify:${pending.block.id}`,
              );
            }
          }

          pendingTools.delete(result.tool_use_id);
        }

        if (isRealUserTurn(line.message)) {
          const text: string = extractUserText(line.message);
          const payload: Record<string, unknown> = {
            turn_index: turns,
            role: "user",
            text_digest: sha256Hex(text),
            text_chars: text.length,
            is_correction: null,
          };
          if (line.isSidechain === true) {
            payload.is_sidechain = true;
          }
          emit(
            ts,
            "turn_start",
            rawRef,
            payload,
            completeLine.byteOffset,
            "turn_start",
          );
          turns += 1;
        }
        continue;
      }

      for (const block of contentBlocks(line.message)) {
        if (!isToolUseBlock(block)) {
          continue;
        }

        pendingTools.set(block.id, {
          block,
          ts,
          cwd: line.cwd,
          isSidechain: line.isSidechain === true,
          turnIndex: currentTurnIndex(turns),
          lineNumber: completeLine.lineNumber,
          byteOffset: completeLine.byteOffset,
          linesBefore,
          turnsBefore,
        });
      }

      if (
        isPlainObject(line.message) &&
        typeof line.message.stop_reason === "string"
      ) {
        const text: string = extractAssistantText(line.message);
        const payload: Record<string, unknown> = {
          turn_index: currentTurnIndex(turns),
          role: "agent",
          text_digest: sha256Hex(text),
          text_chars: text.length,
          stop_reason: line.message.stop_reason,
        };
        if (line.isSidechain === true) {
          payload.is_sidechain = true;
        }
        emit(
          ts,
          "turn_end",
          rawRef,
          payload,
          completeLine.byteOffset,
          "turn_end",
        );
      }

      const assistantText: string = extractAssistantText(line.message);
      for (const claim of findCompletionClaims(assistantText)) {
        const payload: Record<string, unknown> = {
          claim_text: redactSummary(claim.text, 400),
          claim_kind: claim.kind,
          turn_index: currentTurnIndex(turns),
        };
        if (line.isSidechain === true) {
          payload.is_sidechain = true;
        }
        emit(
          ts,
          "completion_claim",
          rawRef,
          payload,
          completeLine.byteOffset,
          `claim:${claim.index}`,
        );
      }
    }

    let finalState: ResumeState = {
      v: 1,
      lines: physicalLine,
      bytes: cursor,
      turns,
    };
    let finalEvents: EventInput[] = emitted.map(
      (item: EmittedEvent): EventInput => item.event,
    );

    const earliestPending: PendingTool | undefined = [
      ...pendingTools.values(),
    ].sort(
      (left: PendingTool, right: PendingTool): number =>
        left.byteOffset - right.byteOffset,
    )[0];
    if (earliestPending !== undefined) {
      finalState = {
        v: 1,
        lines: earliestPending.linesBefore,
        bytes: earliestPending.byteOffset,
        turns: earliestPending.turnsBefore,
      };
      finalEvents = emitted
        .filter(
          (item: EmittedEvent): boolean =>
            item.byteOffset < earliestPending.byteOffset,
        )
        .map((item: EmittedEvent): EventInput => item.event);
    }

    finalEvents.sort((left: EventInput, right: EventInput): number =>
      left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id),
    );

    return {
      events: finalEvents,
      resumeToken: JSON.stringify(finalState),
      skippedUnknown,
      parseFailures,
    };
  }
}
