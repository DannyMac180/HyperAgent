import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  open,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Dirent } from "node:fs";

import { deterministicEventId } from "../../schema/ids.ts";
import {
  AttributionEvidence,
  makeDefaultGitRootResolver,
  type GitRootResolver,
} from "../attribution.ts";
import type { EventInput } from "../../schema/events.ts";
import { detectCorrection } from "../correction.ts";
import type { CorrectionResult } from "../correction.ts";
import type {
  AdapterHealth,
  DiscoveredSession,
  ObserveAdapter,
  ParseResult,
} from "../types.ts";
import {
  KNOWN_ENVELOPE_TYPES,
  KNOWN_EVENT_MESSAGE_TYPES,
  KNOWN_RESPONSE_ITEM_TYPES,
  agentMessageFrom,
  callAndOutputMatch,
  callInput,
  canonicalJson,
  classifyVerificationCommand,
  customToolCallFrom,
  customToolCallOutputFrom,
  filesTouchedFrom,
  findCompletionClaims,
  functionCallFrom,
  functionCallOutputFrom,
  harnessErrorFrom,
  isJsonValue,
  isValidLifecycleDuplicate,
  isValidSchemaLessEventMessage,
  isValidSkippedResponseItem,
  isValidTaskStarted,
  isValidThreadSettingsApplied,
  isValidTokenCount,
  isValidWebSearchCall,
  normalizeTimestamp,
  outputStatus,
  outputValue,
  parseRolloutEnvelope,
  rawLooksLikeKnownEnvelope,
  redactSummary,
  sessionMetadataFrom,
  sha256Hex,
  taskCompleteFrom,
  toolSearchCallFrom,
  toolSearchOutputFrom,
  turnAbortedFrom,
  userMessageFrom,
  webSearchEndFrom,
} from "./transcript.ts";
import type {
  JsonValue,
  RolloutEnvelope,
  SessionMetadata,
  ToolCallPayload,
  ToolOutputPayload,
} from "./transcript.ts";

export const CODEX_DIALECT_VERSION =
  "codex-rollout-jsonl-2026-07-27-v1";

const ADAPTER_VERSION = "0.2.0";
const OPERATION_TIMEOUT_MS = 10_000;
const FIRST_LINE_CHUNK_BYTES = 64 * 1024;
const MAX_FIRST_LINE_BYTES = 1024 * 1024;
const textDecoder = new TextDecoder();

interface CompleteLine {
  raw: string;
  lineNumber: number;
  byteOffset: number;
}

interface PendingTool {
  call: ToolCallPayload;
  input: Record<string, JsonValue>;
  timestamp: string;
  lineNumber: number;
  byteOffset: number;
  turnIndex: number;
}

interface EmittedEvent {
  event: EventInput;
  byteOffset: number;
}

interface SessionCandidate extends DiscoveredSession {
  cliVersion: string;
}

interface ScanResult {
  sessions: SessionCandidate[];
  skippedMalformed: number;
  skippedUnreadable: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function bounded<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject): void => {
    timer = setTimeout((): void => {
      reject(new Error(`${label} timed out after ${OPERATION_TIMEOUT_MS}ms`));
    }, OPERATION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function resumeOffsetFrom(token: string, fileSize: number): number {
  if (token === "") {
    return 0;
  }
  if (!/^\d+$/.test(token)) {
    return 0;
  }
  const offset: number = Number(token);
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= fileSize
    ? offset
    : 0;
}

function completeLinesFrom(bytes: Uint8Array): {
  lines: CompleteLine[];
  resumeOffset: number;
} {
  const lines: CompleteLine[] = [];
  let cursor = 0;
  let lineNumber = 0;

  while (cursor < bytes.length) {
    const newline: number = bytes.indexOf(10, cursor);
    if (newline < 0) {
      break;
    }
    const lineEnd: number =
      newline > cursor && bytes[newline - 1] === 13 ? newline - 1 : newline;
    lineNumber += 1;
    lines.push({
      raw: textDecoder.decode(bytes.subarray(cursor, lineEnd)),
      lineNumber,
      byteOffset: cursor,
    });
    cursor = newline + 1;
  }

  return { lines, resumeOffset: cursor };
}

function canonicalSessionId(nativeSessionId: string): string {
  return `codex:${nativeSessionId}`;
}

function rawRefFor(nativeSessionId: string, lineNumber: number): string {
  return `${canonicalSessionId(nativeSessionId)}#L${lineNumber}`;
}

function callName(call: ToolCallPayload): string {
  return call.type === "tool_search_call" ? "tool_search" : call.name;
}

function commandFrom(
  call: ToolCallPayload,
  input: Record<string, JsonValue>,
): string | null {
  if (call.type !== "function_call") {
    return null;
  }
  const command: JsonValue | undefined = input.cmd ?? input.command;
  return typeof command === "string" ? command : null;
}

async function firstCompleteLine(
  path: string,
  fileSize: number,
): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const maximum: number = Math.min(fileSize, MAX_FIRST_LINE_BYTES);
    const collected = Buffer.alloc(maximum);
    let offset = 0;

    while (offset < maximum) {
      const length: number = Math.min(
        FIRST_LINE_CHUNK_BYTES,
        maximum - offset,
      );
      const { bytesRead } = await handle.read(
        collected,
        offset,
        length,
        offset,
      );
      if (bytesRead === 0) {
        break;
      }
      const newline: number = collected.indexOf(10, offset);
      offset += bytesRead;
      if (newline >= 0 && newline < offset) {
        const lineEnd: number =
          newline > 0 && collected[newline - 1] === 13
            ? newline - 1
            : newline;
        return collected.subarray(0, lineEnd).toString("utf8");
      }
    }
    return null;
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
  }
}

export class CodexAdapter implements ObserveAdapter {
  readonly vendor = "codex";
  readonly adapterVersion = ADAPTER_VERSION;
  readonly dialectVersion = CODEX_DIALECT_VERSION;

  private readonly sessionsRoot: string;
  private readonly gitRootResolver: GitRootResolver;
  private readonly attributionExclusions: readonly string[];

  constructor(options?: {
    sessionsRoot?: string;
    /**
     * Injected so tests and conformance stay byte-deterministic — the
     * default walks the live filesystem looking for `.git`.
     */
    gitRootResolver?: GitRootResolver;
    /**
     * Paths whose touches are instrument noise rather than session subject
     * (defaults to the harness's own state directory and the suit's data
     * dir). Every session writes there regardless of what it was about.
     */
    attributionExclusions?: readonly string[];
  }) {
    this.sessionsRoot =
      options?.sessionsRoot ?? join(homedir(), ".codex", "sessions");
    this.gitRootResolver =
      options?.gitRootResolver ?? makeDefaultGitRootResolver();
    this.attributionExclusions = options?.attributionExclusions ?? [
      join(homedir(), ".codex"),
      join(homedir(), ".hyperagent"),
    ];
  }

  async detect(): Promise<AdapterHealth> {
    return bounded("Codex adapter detection", async (): Promise<AdapterHealth> => {
      let scan: ScanResult;
      try {
        scan = await this.scanSessions();
      } catch (error: unknown) {
        return {
          status: "unavailable",
          harnessVersion: null,
          detail: `Cannot read ${this.sessionsRoot}: ${errorMessage(error)}`,
        };
      }

      const newest: SessionCandidate | undefined = [...scan.sessions].sort(
        (left: SessionCandidate, right: SessionCandidate): number =>
          right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path),
      )[0];
      const skipped: number =
        scan.skippedMalformed + scan.skippedUnreadable;
      return {
        status: "ok",
        harnessVersion: newest?.cliVersion ?? null,
        detail:
          `${scan.sessions.length} session rollouts under ${this.sessionsRoot}; ` +
          `skipped ${skipped} ` +
          `(${scan.skippedMalformed} malformed, ${scan.skippedUnreadable} unreadable)`,
      };
    });
  }

  async discoverSessions(): Promise<DiscoveredSession[]> {
    return bounded(
      "Codex session discovery",
      async (): Promise<DiscoveredSession[]> => {
        try {
          const scan: ScanResult = await this.scanSessions();
          return scan.sessions.map(
            (session: SessionCandidate): DiscoveredSession => ({
              sessionId: session.sessionId,
              path: session.path,
              mtimeMs: session.mtimeMs,
              sizeBytes: session.sizeBytes,
            }),
          );
        } catch {
          // The observe contract follows the Claude Code convention: detect()
          // reports root failures, while enumeration degrades to no sessions.
          return [];
        }
      },
    );
  }

  async parseSession(
    session: DiscoveredSession,
    resumeToken: string,
  ): Promise<ParseResult> {
    return bounded(
      `Codex rollout parse for ${JSON.stringify(session.sessionId)}`,
      async (): Promise<ParseResult> => {
        let bytes: Uint8Array;
        try {
          bytes = await readFile(session.path);
        } catch (error: unknown) {
          throw new Error(
            `Cannot read Codex rollout ${session.path}: ${errorMessage(error)}`,
          );
        }
        return this.parseBytes(session, resumeToken, bytes);
      },
    );
  }

  private async scanSessions(): Promise<ScanResult> {
    const sessions: SessionCandidate[] = [];
    const directories: string[] = [this.sessionsRoot];
    let skippedMalformed = 0;
    let skippedUnreadable = 0;

    while (directories.length > 0) {
      const directory: string = directories.pop()!;
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error: unknown) {
        if (directory === this.sessionsRoot) {
          throw error;
        }
        skippedUnreadable += 1;
        continue;
      }

      for (const entry of entries) {
        const path: string = join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(path);
          continue;
        }
        if (
          !entry.isFile() ||
          !entry.name.startsWith("rollout-") ||
          !entry.name.endsWith(".jsonl")
        ) {
          continue;
        }

        try {
          const metadata = await stat(path);
          const firstLine: string | null = await firstCompleteLine(
            path,
            metadata.size,
          );
          if (firstLine === null) {
            skippedMalformed += 1;
            continue;
          }
          const envelope: RolloutEnvelope | null =
            parseRolloutEnvelope(firstLine);
          const sessionMetadata: SessionMetadata | null =
            envelope === null ? null : sessionMetadataFrom(envelope);
          if (sessionMetadata === null) {
            skippedMalformed += 1;
            continue;
          }
          sessions.push({
            sessionId: canonicalSessionId(sessionMetadata.nativeSessionId),
            path,
            mtimeMs: metadata.mtimeMs,
            sizeBytes: metadata.size,
            cliVersion: sessionMetadata.cliVersion,
          });
        } catch {
          skippedUnreadable += 1;
        }
      }
    }

    sessions.sort(
      (left: SessionCandidate, right: SessionCandidate): number =>
        left.path.localeCompare(right.path),
    );
    return { sessions, skippedMalformed, skippedUnreadable };
  }

  private parseBytes(
    session: DiscoveredSession,
    resumeToken: string,
    bytes: Uint8Array,
  ): ParseResult {
    const initialOffset: number = resumeOffsetFrom(resumeToken, bytes.length);
    const { lines, resumeOffset } = completeLinesFrom(bytes);
    const firstLine: CompleteLine | undefined = lines[0];
    if (firstLine === undefined) {
      return {
        events: [],
        resumeToken: "0",
        skippedUnknown: 0,
        parseFailures: 0,
      };
    }

    const firstEnvelope: RolloutEnvelope | null = parseRolloutEnvelope(
      firstLine.raw,
    );
    const sessionMetadata: SessionMetadata | null =
      firstEnvelope === null ? null : sessionMetadataFrom(firstEnvelope);
    if (sessionMetadata === null) {
      return {
        events: [],
        resumeToken: "0",
        skippedUnknown: 0,
        parseFailures: 1,
      };
    }

    const sessionId: string = canonicalSessionId(
      sessionMetadata.nativeSessionId,
    );
    if (session.sessionId !== sessionId) {
      return {
        events: [],
        resumeToken: "0",
        skippedUnknown: 0,
        parseFailures: 1,
      };
    }

    const pendingTools = new Map<string, PendingTool>();
    const emitted: EmittedEvent[] = [];
    let skippedUnknown = 0;
    let parseFailures = 0;
    let turns = 0;
    // Correction-detection context (DAN-224). Rebuilt on every pass because
    // this parser always walks the full artifact and filters emission by
    // offset — no resume-token state needed.
    let pendingClaim = false;
    let interruptedPending = false;

    const countable = (line: CompleteLine): boolean =>
      line.byteOffset >= initialOffset;
    const skipped = (line: CompleteLine): void => {
      if (countable(line)) {
        skippedUnknown += 1;
      }
    };
    const failed = (line: CompleteLine): void => {
      if (countable(line)) {
        parseFailures += 1;
      }
    };
    const emit = (
      timestamp: string,
      type: EventInput["type"],
      lineNumber: number,
      byteOffset: number,
      payload: Record<string, unknown>,
      discriminator?: string,
    ): EventInput | null => {
      if (byteOffset < initialOffset) {
        return null;
      }
      const rawRef: string = rawRefFor(
        sessionMetadata.nativeSessionId,
        lineNumber,
      );
      const id: string = deterministicEventId({
        ts: timestamp,
        sessionId,
        rawRef,
        type,
        ...(discriminator === undefined ? {} : { discriminator }),
      });
      const event: EventInput = {
        id,
        ts: timestamp,
        type,
        session_id: sessionId,
        vendor: this.vendor,
        adapter_version: this.adapterVersion,
        raw_ref: rawRef,
        payload: {
          ...payload,
          dialect: this.dialectVersion,
        },
      };
      emitted.push({ event, byteOffset });
      return event;
    };

    // Codex records one cwd for the whole rollout; file touches accumulate
    // below as apply_patch records pair with their outputs. The derived repo
    // is stamped into session_start at the tail of this pass.
    const evidence = new AttributionEvidence(
      this.gitRootResolver,
      this.attributionExclusions,
    );
    evidence.addCwd(sessionMetadata.cwd);

    if (initialOffset === 0) {
      const payload: Record<string, unknown> = {
        agent: "codex",
        harness_version: sessionMetadata.cliVersion,
        // `repo` is patched to the derived attribution after the loop
        // (schema.md: git root, NOT the raw cwd). `cwd` stays raw.
        cwd: sessionMetadata.cwd,
        originator: sessionMetadata.originator,
        source: sessionMetadata.source,
        model_provider: sessionMetadata.modelProvider,
      };
      if (sessionMetadata.threadSource !== undefined) {
        payload.thread_source = sessionMetadata.threadSource;
      }
      if (sessionMetadata.gitBranch !== undefined) {
        payload.git_branch = sessionMetadata.gitBranch;
      }
      emit(
        sessionMetadata.timestamp,
        "session_start",
        firstLine.lineNumber,
        firstLine.byteOffset,
        payload,
      );
    }

    for (const line of lines) {
      if (line.lineNumber === 1 || line.raw.trim() === "") {
        continue;
      }

      const envelope: RolloutEnvelope | null = parseRolloutEnvelope(line.raw);
      if (envelope === null) {
        if (rawLooksLikeKnownEnvelope(line.raw)) {
          failed(line);
        } else {
          skipped(line);
        }
        continue;
      }
      if (!KNOWN_ENVELOPE_TYPES.has(envelope.type)) {
        skipped(line);
        continue;
      }
      const timestamp: string | null = normalizeTimestamp(envelope.timestamp);
      if (timestamp === null || !isJsonValue(envelope.payload)) {
        failed(line);
        continue;
      }

      if (envelope.type === "session_meta") {
        // Some rollouts embed subagent metadata later in the parent artifact.
        // DiscoveredSession represents the first-line native session, so a
        // second metadata envelope cannot become another canonical session here.
        // Its fields are not trusted or copied; the already deep-validated
        // envelope is deliberately skipped even when it uses an older shape.
        skipped(line);
        continue;
      }
      if (
        envelope.type === "turn_context" ||
        envelope.type === "world_state"
      ) {
        // The closed v0.1 schema has no context/world-state event. The envelope
        // is validated above, then deliberately counted and skipped.
        skipped(line);
        continue;
      }

      const payloadType: unknown = envelope.payload.type;
      if (typeof payloadType !== "string") {
        failed(line);
        continue;
      }

      if (envelope.type === "event_msg") {
        if (!KNOWN_EVENT_MESSAGE_TYPES.has(payloadType)) {
          skipped(line);
          continue;
        }

        if (payloadType === "user_message") {
          const message = userMessageFrom(envelope.payload);
          if (message === null) {
            failed(line);
            continue;
          }
          const correction: CorrectionResult = detectCorrection(
            message.message,
            {
              afterCompletionClaim: pendingClaim,
              interrupted: interruptedPending,
            },
          );
          const turnStartPayload: Record<string, unknown> = {
            turn_index: turns,
            role: "user",
            text_digest: sha256Hex(message.message),
            text_chars: message.message.length,
            is_correction: correction.isCorrection,
          };
          if (correction.isCorrection) {
            turnStartPayload.correction_basis = correction.basis;
          }
          pendingClaim = false;
          interruptedPending = false;
          emit(
            timestamp,
            "turn_start",
            line.lineNumber,
            line.byteOffset,
            turnStartPayload,
            "user_message",
          );
          turns += 1;
          continue;
        }

        if (payloadType === "agent_message") {
          const message = agentMessageFrom(envelope.payload);
          if (message === null) {
            failed(line);
            continue;
          }
          emit(
            timestamp,
            "turn_end",
            line.lineNumber,
            line.byteOffset,
            {
              turn_index: Math.max(0, turns - 1),
              role: "agent",
              text_digest: sha256Hex(message.message),
              text_chars: message.message.length,
              stop_reason: message.phase ?? null,
            },
            "agent_message",
          );
          continue;
        }

        if (payloadType === "task_started") {
          if (!isValidTaskStarted(envelope.payload)) {
            failed(line);
          } else {
            // user_message is the canonical turn_start source. Emitting another
            // start here would double-count the same turn.
            skipped(line);
          }
          continue;
        }

        if (payloadType === "task_complete") {
          const taskComplete = taskCompleteFrom(envelope.payload);
          if (taskComplete === null) {
            failed(line);
            continue;
          }
          const message: string | null = taskComplete.lastAgentMessage;
          if (message === null) {
            // Aborted/empty tasks have no completion claim to preserve.
            skipped(line);
            continue;
          }
          const claims = findCompletionClaims(message);
          if (claims.length > 0) {
            pendingClaim = true;
          }
          if (claims.length === 0) {
            // agent_message already supplies turn_end. task_complete adds only
            // claim evidence that the closed schema can represent.
            skipped(line);
            continue;
          }
          for (const claim of claims) {
            emit(
              timestamp,
              "completion_claim",
              line.lineNumber,
              line.byteOffset,
              {
                claim_text: redactSummary(claim.text, 400),
                claim_kind: claim.kind,
                turn_index: Math.max(0, turns - 1),
              },
              `claim:${claim.index}`,
            );
          }
          continue;
        }

        if (payloadType === "token_count") {
          if (!isValidTokenCount(envelope.payload)) {
            failed(line);
          } else {
            // v0.1 has no canonical usage event or usage payload home.
            skipped(line);
          }
          continue;
        }

        if (payloadType === "thread_settings_applied") {
          if (!isValidThreadSettingsApplied(envelope.payload)) {
            failed(line);
          } else {
            // Thread settings are harness configuration, absent from v0.1.
            skipped(line);
          }
          continue;
        }

        if (payloadType === "web_search_end") {
          const search = webSearchEndFrom(envelope.payload);
          if (search === null) {
            failed(line);
            continue;
          }
          const input: JsonValue = {
            query: search.query,
            action: search.action,
          };
          const output: JsonValue = search.results;
          const inputText: string = canonicalJson(input);
          const outputText: string = canonicalJson(output);
          emit(
            timestamp,
            "tool_call",
            line.lineNumber,
            line.byteOffset,
            {
              name: "web_search",
              input_digest: sha256Hex(inputText),
              input_summary: redactSummary(inputText),
              output_digest: sha256Hex(outputText),
              output_summary: redactSummary(outputText),
              status: "ok",
              turn_index: Math.max(0, turns - 1),
            },
            search.callId,
          );
          continue;
        }

        if (payloadType === "turn_aborted") {
          const aborted = turnAbortedFrom(envelope.payload);
          if (aborted === null) {
            failed(line);
            continue;
          }
          // The pilot stopped the agent mid-turn: the next user turn is an
          // intervention by harness evidence, whatever its wording (DAN-224).
          // Gated on the only reason observed in the wild ("interrupted",
          // 144/144 in a 497-rollout corpus, 2026-08-15) so a future
          // system-side abort reason cannot masquerade as a pilot action.
          if (aborted.reason === "interrupted") {
            interruptedPending = true;
          }
          emit(
            timestamp,
            "turn_end",
            line.lineNumber,
            line.byteOffset,
            {
              turn_index: Math.max(0, turns - 1),
              role: "agent",
              text_digest: sha256Hex(""),
              text_chars: 0,
              stop_reason: aborted.reason,
            },
            aborted.turnId,
          );
          continue;
        }

        if (payloadType === "error") {
          const harnessError = harnessErrorFrom(envelope.payload);
          if (harnessError === null) {
            failed(line);
            continue;
          }
          emit(
            timestamp,
            "error",
            line.lineNumber,
            line.byteOffset,
            {
              source: "harness",
              message_digest: sha256Hex(harnessError.message),
              message_summary: redactSummary(harnessError.message),
              turn_index: Math.max(0, turns - 1),
              tool_call_id: null,
            },
            "harness_error",
          );
          continue;
        }

        if (
          payloadType === "exec_command_end" ||
          payloadType === "patch_apply_end" ||
          payloadType === "mcp_tool_call_end"
        ) {
          if (!isValidLifecycleDuplicate(envelope.payload)) {
            failed(line);
          } else {
            // response_item call/output pairs are the canonical tool source.
            // These event_msg summaries duplicate the same call_id and would
            // otherwise double-count command, patch, and MCP tool activity.
            skipped(line);
          }
          continue;
        }

        if (!isValidSchemaLessEventMessage(envelope.payload)) {
          failed(line);
        } else {
          // Reasoning, compaction, thread metadata, and sub-item completion
          // have no canonical v0.1 event type. They are shape-validated and
          // deliberately counted instead of being silently discarded.
          skipped(line);
        }
        continue;
      }

      if (!KNOWN_RESPONSE_ITEM_TYPES.has(payloadType)) {
        skipped(line);
        continue;
      }

      let call: ToolCallPayload | null = null;
      if (payloadType === "function_call") {
        call = functionCallFrom(envelope.payload);
      } else if (payloadType === "custom_tool_call") {
        call = customToolCallFrom(envelope.payload);
      } else if (payloadType === "tool_search_call") {
        call = toolSearchCallFrom(envelope.payload);
      }
      if (call !== null) {
        const input: Record<string, JsonValue> | null = callInput(call);
        if (input === null || pendingTools.has(call.call_id)) {
          failed(line);
          continue;
        }
        pendingTools.set(call.call_id, {
          call,
          input,
          timestamp,
          lineNumber: line.lineNumber,
          byteOffset: line.byteOffset,
          turnIndex: Math.max(0, turns - 1),
        });
        continue;
      }

      let output: ToolOutputPayload | null = null;
      if (payloadType === "function_call_output") {
        output = functionCallOutputFrom(envelope.payload);
      } else if (payloadType === "custom_tool_call_output") {
        output = customToolCallOutputFrom(envelope.payload);
      } else if (payloadType === "tool_search_output") {
        output = toolSearchOutputFrom(envelope.payload);
      }
      if (output !== null) {
        const pending: PendingTool | undefined = pendingTools.get(
          output.call_id,
        );
        if (
          pending === undefined ||
          !callAndOutputMatch(pending.call, output)
        ) {
          failed(line);
          continue;
        }

        const status = outputStatus(pending.call, output);
        const resultValue: JsonValue = outputValue(output);
        const outputText: string = canonicalJson(resultValue);
        const outputSummaryText: string =
          typeof resultValue === "string" ? resultValue : outputText;
        const inputText: string = canonicalJson(pending.input);
        const toolPayload: Record<string, unknown> = {
          name: callName(pending.call),
          input_digest: sha256Hex(inputText),
          input_summary: redactSummary(inputText),
          output_digest: sha256Hex(outputText),
          output_summary: redactSummary(outputSummaryText),
          status,
          turn_index: pending.turnIndex,
        };
        const durationMs: number =
          new Date(timestamp).getTime() -
          new Date(pending.timestamp).getTime();
        if (Number.isFinite(durationMs) && durationMs >= 0) {
          toolPayload.duration_ms = durationMs;
        }
        const filesTouched: string[] = filesTouchedFrom(
          pending.call,
          pending.input,
          sessionMetadata.cwd,
        );
        if (filesTouched.length > 0) {
          toolPayload.files_touched = filesTouched;
          for (const touched of filesTouched) {
            // apply_patch only writes, so every touch is a mutation.
            evidence.addTouch(resolve(sessionMetadata.cwd, touched), true);
          }
        }
        const toolCall: EventInput | null = emit(
          pending.timestamp,
          "tool_call",
          pending.lineNumber,
          pending.byteOffset,
          toolPayload,
          pending.call.call_id,
        );

        if (status === "error" && toolCall !== null) {
          emit(
            timestamp,
            "error",
            line.lineNumber,
            line.byteOffset,
            {
              source: "tool",
              message_digest: sha256Hex(outputText),
              message_summary: redactSummary(outputSummaryText),
              turn_index: pending.turnIndex,
              tool_call_id: toolCall.id,
            },
            `error:${output.call_id}`,
          );
        }

        const command: string | null = commandFrom(
          pending.call,
          pending.input,
        );
        const verificationKind =
          command === null ? null : classifyVerificationCommand(command);
        if (command !== null && verificationKind !== null) {
          emit(
            pending.timestamp,
            "verification_event",
            pending.lineNumber,
            pending.byteOffset,
            {
              kind: verificationKind,
              command_digest: sha256Hex(command),
              command_summary: redactSummary(command),
              result: status === "ok" ? "pass" : "fail",
              turn_index: pending.turnIndex,
              initiated_by: "agent",
            },
            `verify:${pending.call.call_id}`,
          );
        }
        pendingTools.delete(output.call_id);
        continue;
      }

      if (
        payloadType === "message" ||
        payloadType === "reasoning"
      ) {
        if (!isValidSkippedResponseItem(envelope.payload)) {
          failed(line);
        } else {
          // event_msg is the non-duplicated source for user/assistant turns.
          // Those response messages repeat it; developer instructions and
          // reasoning have no canonical v0.1 event and are not turn content.
          skipped(line);
        }
        continue;
      }

      if (payloadType === "web_search_call") {
        if (!isValidWebSearchCall(envelope.payload)) {
          failed(line);
        } else {
          // This item has no stable call_id in most rollouts. The paired
          // event_msg/web_search_end record carries call_id, query, and
          // results, so it is the single canonical tool_call source.
          skipped(line);
        }
        continue;
      }

      // A known tool payload type that reached here failed its shape guard.
      failed(line);
    }

    let finalOffset: number = resumeOffset;
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
      finalOffset = earliestPending.byteOffset;
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

    // Stamp the full-pass attribution into session_start (schema.md: `repo`
    // is a git root; omitted when none is honestly derivable).
    const sessionRepo: string | null = evidence.deriveRepo();
    for (const event of finalEvents) {
      if (event.type !== "session_start") {
        continue;
      }
      const payload = event.payload as Record<string, unknown>;
      if (sessionRepo !== null) {
        payload.repo = sessionRepo;
      }
    }

    return {
      events: finalEvents,
      resumeToken: String(finalOffset),
      skippedUnknown,
      parseFailures,
      sessionRepo,
    };
  }
}
