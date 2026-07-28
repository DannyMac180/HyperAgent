import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const KNOWN_ENVELOPE_TYPES: ReadonlySet<string> = new Set([
  "session_meta",
  "turn_context",
  "world_state",
  "event_msg",
  "response_item",
]);

export const KNOWN_EVENT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "user_message",
  "agent_message",
  "agent_reasoning",
  "task_started",
  "task_complete",
  "token_count",
  "thread_settings_applied",
  "exec_command_end",
  "patch_apply_end",
  "mcp_tool_call_end",
  "web_search_end",
  "turn_aborted",
  "error",
  "context_compacted",
  "thread_goal_updated",
  "thread_name_updated",
  "thread_rolled_back",
  "item_completed",
]);

export const KNOWN_RESPONSE_ITEM_TYPES: ReadonlySet<string> = new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "tool_search_call",
  "tool_search_output",
  "web_search_call",
]);

export interface RolloutEnvelope {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface SessionMetadata {
  nativeSessionId: string;
  timestamp: string;
  cwd: string;
  cliVersion: string;
  originator: string;
  source: JsonValue;
  threadSource?: JsonValue;
  modelProvider: string;
  gitBranch?: string;
}

export interface UserMessagePayload {
  type: "user_message";
  message: string;
}

export interface AgentMessagePayload {
  type: "agent_message";
  message: string;
  phase?: string | null;
}

export interface TaskCompletePayload {
  type: "task_complete";
  turnId: string;
  lastAgentMessage: string | null;
}

export interface WebSearchEndPayload {
  type: "web_search_end";
  callId: string;
  query: string;
  action: JsonValue;
  results: JsonValue[] | null;
}

export interface TurnAbortedPayload {
  type: "turn_aborted";
  turnId: string;
  reason: string;
}

export interface HarnessErrorPayload {
  type: "error";
  message: string;
}

export interface FunctionCallPayload {
  type: "function_call";
  name: string;
  arguments: string;
  call_id: string;
}

export interface FunctionCallOutputPayload {
  type: "function_call_output";
  call_id: string;
  output: JsonValue;
}

export interface CustomToolCallPayload {
  type: "custom_tool_call";
  name: string;
  input: string;
  call_id: string;
  status: string;
}

export interface CustomToolCallOutputPayload {
  type: "custom_tool_call_output";
  call_id: string;
  output: JsonValue;
}

export interface ToolSearchCallPayload {
  type: "tool_search_call";
  call_id: string;
  arguments: Record<string, JsonValue>;
  status: string;
}

export interface ToolSearchOutputPayload {
  type: "tool_search_output";
  call_id: string;
  tools: JsonValue[];
  status: string;
}

export type ToolCallPayload =
  | FunctionCallPayload
  | CustomToolCallPayload
  | ToolSearchCallPayload;

export type ToolOutputPayload =
  | FunctionCallOutputPayload
  | CustomToolCallOutputPayload
  | ToolSearchOutputPayload;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CompletionClaim {
  text: string;
  kind: "done" | "tests_pass" | "deployed" | "fixed" | "other";
  index: number;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
}

export function parseRolloutEnvelope(raw: string): RolloutEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  if (
    !isPlainObject(parsed) ||
    typeof parsed.type !== "string" ||
    typeof parsed.timestamp !== "string" ||
    !isPlainObject(parsed.payload)
  ) {
    return null;
  }

  return {
    timestamp: parsed.timestamp,
    type: parsed.type,
    payload: parsed.payload,
  };
}

export function rawLooksLikeKnownEnvelope(raw: string): boolean {
  const match: RegExpMatchArray | null = raw.match(
    /"type"\s*:\s*"([^"\\]+)"/,
  );
  return match?.[1] !== undefined && KNOWN_ENVELOPE_TYPES.has(match[1]);
}

export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function optionalJsonValue(
  object: Record<string, unknown>,
  key: string,
): JsonValue | undefined {
  const value: unknown = object[key];
  return value === undefined || !isJsonValue(value) ? undefined : value;
}

export function sessionMetadataFrom(
  envelope: RolloutEnvelope,
): SessionMetadata | null {
  if (envelope.type !== "session_meta") {
    return null;
  }

  const payload: Record<string, unknown> = envelope.payload;
  const sessionId: unknown = payload.session_id;
  const legacyId: unknown = payload.id;
  const nativeSessionId: unknown =
    typeof sessionId === "string" && sessionId.length > 0
      ? sessionId
      : legacyId;
  const timestamp: string | null = normalizeTimestamp(envelope.timestamp);
  const source: JsonValue | undefined = optionalJsonValue(payload, "source");
  const threadSource: JsonValue | undefined = optionalJsonValue(
    payload,
    "thread_source",
  );

  if (
    typeof nativeSessionId !== "string" ||
    nativeSessionId.length === 0 ||
    timestamp === null ||
    typeof payload.cwd !== "string" ||
    payload.cwd.length === 0 ||
    typeof payload.cli_version !== "string" ||
    payload.cli_version.length === 0 ||
    typeof payload.originator !== "string" ||
    payload.originator.length === 0 ||
    source === undefined ||
    typeof payload.model_provider !== "string" ||
    payload.model_provider.length === 0
  ) {
    return null;
  }

  let gitBranch: string | undefined;
  if (payload.git !== undefined) {
    if (!isPlainObject(payload.git)) {
      return null;
    }
    if (
      payload.git.branch !== undefined &&
      typeof payload.git.branch !== "string"
    ) {
      return null;
    }
    gitBranch =
      typeof payload.git.branch === "string" ? payload.git.branch : undefined;
  }

  return {
    nativeSessionId,
    timestamp,
    cwd: payload.cwd,
    cliVersion: payload.cli_version,
    originator: payload.originator,
    source,
    ...(threadSource === undefined ? {} : { threadSource }),
    modelProvider: payload.model_provider,
    ...(gitBranch === undefined ? {} : { gitBranch }),
  };
}

export function userMessageFrom(
  payload: Record<string, unknown>,
): UserMessagePayload | null {
  return payload.type === "user_message" &&
    typeof payload.message === "string"
    ? { type: "user_message", message: payload.message }
    : null;
}

export function agentMessageFrom(
  payload: Record<string, unknown>,
): AgentMessagePayload | null {
  if (
    payload.type !== "agent_message" ||
    typeof payload.message !== "string" ||
    !(
      payload.phase === undefined ||
      payload.phase === null ||
      typeof payload.phase === "string"
    )
  ) {
    return null;
  }

  return {
    type: "agent_message",
    message: payload.message,
    ...(payload.phase === undefined ? {} : { phase: payload.phase }),
  };
}

export function functionCallFrom(
  payload: Record<string, unknown>,
): FunctionCallPayload | null {
  return payload.type === "function_call" &&
    typeof payload.name === "string" &&
    payload.name.length > 0 &&
    typeof payload.arguments === "string" &&
    typeof payload.call_id === "string" &&
    payload.call_id.length > 0
    ? {
        type: "function_call",
        name: payload.name,
        arguments: payload.arguments,
        call_id: payload.call_id,
      }
    : null;
}

export function functionCallOutputFrom(
  payload: Record<string, unknown>,
): FunctionCallOutputPayload | null {
  return payload.type === "function_call_output" &&
    typeof payload.call_id === "string" &&
    payload.call_id.length > 0 &&
    isJsonValue(payload.output)
    ? {
        type: "function_call_output",
        call_id: payload.call_id,
        output: payload.output,
      }
    : null;
}

export function customToolCallFrom(
  payload: Record<string, unknown>,
): CustomToolCallPayload | null {
  return payload.type === "custom_tool_call" &&
    typeof payload.name === "string" &&
    payload.name.length > 0 &&
    typeof payload.input === "string" &&
    typeof payload.call_id === "string" &&
    payload.call_id.length > 0 &&
    typeof payload.status === "string"
    ? {
        type: "custom_tool_call",
        name: payload.name,
        input: payload.input,
        call_id: payload.call_id,
        status: payload.status,
      }
    : null;
}

export function customToolCallOutputFrom(
  payload: Record<string, unknown>,
): CustomToolCallOutputPayload | null {
  return payload.type === "custom_tool_call_output" &&
    typeof payload.call_id === "string" &&
    payload.call_id.length > 0 &&
    isJsonValue(payload.output)
    ? {
        type: "custom_tool_call_output",
        call_id: payload.call_id,
        output: payload.output,
      }
    : null;
}

function jsonRecordFrom(
  value: unknown,
): Record<string, JsonValue> | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const record: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isJsonValue(item)) {
      return null;
    }
    record[key] = item;
  }
  return record;
}

export function toolSearchCallFrom(
  payload: Record<string, unknown>,
): ToolSearchCallPayload | null {
  const argumentsValue: Record<string, JsonValue> | null = jsonRecordFrom(
    payload.arguments,
  );
  return payload.type === "tool_search_call" &&
    typeof payload.call_id === "string" &&
    payload.call_id.length > 0 &&
    argumentsValue !== null &&
    typeof payload.status === "string"
    ? {
        type: "tool_search_call",
        call_id: payload.call_id,
        arguments: argumentsValue,
        status: payload.status,
      }
    : null;
}

export function toolSearchOutputFrom(
  payload: Record<string, unknown>,
): ToolSearchOutputPayload | null {
  if (
    payload.type !== "tool_search_output" ||
    typeof payload.call_id !== "string" ||
    payload.call_id.length === 0 ||
    !Array.isArray(payload.tools) ||
    !payload.tools.every(isJsonValue) ||
    typeof payload.status !== "string"
  ) {
    return null;
  }

  return {
    type: "tool_search_output",
    call_id: payload.call_id,
    tools: payload.tools,
    status: payload.status,
  };
}

export function parseFunctionArguments(
  value: string,
): Record<string, JsonValue> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  return jsonRecordFrom(parsed);
}

export function callInput(
  call: ToolCallPayload,
): Record<string, JsonValue> | null {
  if (call.type === "function_call") {
    return parseFunctionArguments(call.arguments);
  }
  if (call.type === "custom_tool_call") {
    return { input: call.input };
  }
  return call.arguments;
}

export function outputValue(output: ToolOutputPayload): JsonValue {
  return output.type === "tool_search_output" ? output.tools : output.output;
}

export function callAndOutputMatch(
  call: ToolCallPayload,
  output: ToolOutputPayload,
): boolean {
  return (
    (call.type === "function_call" &&
      output.type === "function_call_output") ||
    (call.type === "custom_tool_call" &&
      output.type === "custom_tool_call_output") ||
    (call.type === "tool_search_call" &&
      output.type === "tool_search_output")
  );
}

export function isValidTaskStarted(
  payload: Record<string, unknown>,
): boolean {
  return (
    payload.type === "task_started" &&
    typeof payload.turn_id === "string" &&
    payload.turn_id.length > 0
  );
}

export function taskCompleteFrom(
  payload: Record<string, unknown>,
): TaskCompletePayload | null {
  if (
    payload.type !== "task_complete" ||
    typeof payload.turn_id !== "string" ||
    payload.turn_id.length === 0 ||
    !(
      payload.last_agent_message === null ||
      typeof payload.last_agent_message === "string"
    )
  ) {
    return null;
  }
  return {
    type: "task_complete",
    turnId: payload.turn_id,
    lastAgentMessage: payload.last_agent_message,
  };
}

export function isValidTokenCount(
  payload: Record<string, unknown>,
): boolean {
  return (
    payload.type === "token_count" &&
    (payload.info === null ||
      (isPlainObject(payload.info) && isJsonValue(payload.info))) &&
    (payload.rate_limits === undefined || isJsonValue(payload.rate_limits))
  );
}

export function isValidThreadSettingsApplied(
  payload: Record<string, unknown>,
): boolean {
  return (
    payload.type === "thread_settings_applied" &&
    isPlainObject(payload.thread_settings) &&
    isJsonValue(payload.thread_settings)
  );
}

export function webSearchEndFrom(
  payload: Record<string, unknown>,
): WebSearchEndPayload | null {
  if (
    payload.type !== "web_search_end" ||
    typeof payload.call_id !== "string" ||
    payload.call_id.length === 0 ||
    typeof payload.query !== "string" ||
    !isJsonValue(payload.action) ||
    !(
      payload.results === undefined ||
      (Array.isArray(payload.results) && payload.results.every(isJsonValue))
    )
  ) {
    return null;
  }
  return {
    type: "web_search_end",
    callId: payload.call_id,
    query: payload.query,
    action: payload.action,
    results: Array.isArray(payload.results) ? payload.results : null,
  };
}

export function turnAbortedFrom(
  payload: Record<string, unknown>,
): TurnAbortedPayload | null {
  return payload.type === "turn_aborted" &&
    typeof payload.turn_id === "string" &&
    payload.turn_id.length > 0 &&
    typeof payload.reason === "string"
    ? {
        type: "turn_aborted",
        turnId: payload.turn_id,
        reason: payload.reason,
      }
    : null;
}

export function harnessErrorFrom(
  payload: Record<string, unknown>,
): HarnessErrorPayload | null {
  return payload.type === "error" && typeof payload.message === "string"
    ? { type: "error", message: payload.message }
    : null;
}

export function isValidLifecycleDuplicate(
  payload: Record<string, unknown>,
): boolean {
  if (
    payload.type === "exec_command_end" ||
    payload.type === "patch_apply_end" ||
    payload.type === "mcp_tool_call_end"
  ) {
    return (
      typeof payload.call_id === "string" &&
      payload.call_id.length > 0 &&
      isJsonValue(payload)
    );
  }
  return false;
}

export function isValidSchemaLessEventMessage(
  payload: Record<string, unknown>,
): boolean {
  return (
    [
      "agent_reasoning",
      "context_compacted",
      "thread_goal_updated",
      "thread_name_updated",
      "thread_rolled_back",
      "item_completed",
    ].includes(String(payload.type)) && isJsonValue(payload)
  );
}

export function isValidWebSearchCall(
  payload: Record<string, unknown>,
): boolean {
  return (
    payload.type === "web_search_call" &&
    typeof payload.status === "string" &&
    isJsonValue(payload.action)
  );
}

export function isValidSkippedResponseItem(
  payload: Record<string, unknown>,
): boolean {
  if (payload.type === "message") {
    return (
      typeof payload.role === "string" &&
      Array.isArray(payload.content) &&
      payload.content.every(isJsonValue)
    );
  }
  if (payload.type === "reasoning") {
    return (
      Array.isArray(payload.summary) &&
      payload.summary.every(isJsonValue) &&
      (payload.content === undefined ||
        payload.content === null ||
        (Array.isArray(payload.content) && payload.content.every(isJsonValue)))
    );
  }
  return false;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonValue(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonValue).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map(
      (key: string): string =>
        `${JSON.stringify(key)}:${canonicalJsonValue(value[key]!)}`,
    )
    .join(",")}}`;
}

export function canonicalJson(value: JsonValue): string {
  return canonicalJsonValue(value);
}

export function redactSummary(text: string, max = 200): string {
  const collapsed: string = text.replace(/\s+/g, " ").trim();
  const redactedTokens: string = collapsed.replace(
    /\b(?:sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]+|AKIA[A-Z0-9]+)\b/g,
    "[redacted]",
  );
  const redactedBearer: string = redactedTokens.replace(
    /\bBearer\s+\S+/gi,
    "Bearer [redacted]",
  );
  const redactedAssignments: string = redactedBearer.replace(
    /\b(password|api_key|token)\s*=\s*[^\s,;]+/gi,
    "$1=[redacted]",
  );
  const limit: number = Math.max(0, Math.trunc(max));
  return redactedAssignments.length > limit
    ? `${redactedAssignments.slice(0, limit)}…`
    : redactedAssignments;
}

export function findCompletionClaims(text: string): CompletionClaim[] {
  const sentences: string[] = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence: string): string => sentence.trim())
    .filter((sentence: string): boolean => sentence.length > 0);
  const claimPattern =
    /\b(done|complete[d]?|fixed|all tests pass(ing)?|deployed|works now)\b/i;
  const claims: CompletionClaim[] = [];

  sentences.forEach((sentence: string, index: number): void => {
    if (sentence.length > 400 || !claimPattern.test(sentence)) {
      return;
    }

    let kind: CompletionClaim["kind"] = "other";
    if (/all tests pass/i.test(sentence)) {
      kind = "tests_pass";
    } else if (/deployed/i.test(sentence)) {
      kind = "deployed";
    } else if (/fixed/i.test(sentence)) {
      kind = "fixed";
    } else if (/\b(done|completed?)\b/i.test(sentence)) {
      kind = "done";
    }
    claims.push({ text: sentence, kind, index });
  });

  return claims;
}

export function classifyVerificationCommand(
  command: string,
): "test" | "typecheck" | "other" | null {
  const verificationPattern =
    /\b(bun test|pytest|cargo test|go test|tsc|bunx tsc|make (test|check)|vitest|jest)\b/;
  if (!verificationPattern.test(command)) {
    return null;
  }
  if (/\b(?:bunx\s+tsc|tsc)\b/.test(command)) {
    return "typecheck";
  }
  if (/\bmake\s+check\b/.test(command)) {
    return "other";
  }
  return "test";
}

function toRepoRelative(
  path: string,
  cwd: string,
): string | null {
  if (!isAbsolute(path) || !isAbsolute(cwd)) {
    return null;
  }
  const relativePath: string = relative(resolve(cwd), resolve(path));
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath === "" ? "." : relativePath.split(sep).join("/");
}

export function filesTouchedFrom(
  call: ToolCallPayload,
  input: Record<string, JsonValue>,
  cwd: string,
): string[] {
  if (call.type !== "custom_tool_call" || call.name !== "apply_patch") {
    return [];
  }

  const patch: JsonValue | undefined = input.input;
  if (typeof patch !== "string") {
    return [];
  }

  const files = new Set<string>();
  for (const match of patch.matchAll(
    /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
  )) {
    const path: string | undefined = match[1];
    if (path === undefined) {
      continue;
    }
    const relativePath: string | null = toRepoRelative(path.trim(), cwd);
    if (relativePath !== null) {
      files.add(relativePath);
    }
  }
  return [...files].sort();
}

export function outputStatus(
  call: ToolCallPayload,
  output: ToolOutputPayload,
): "ok" | "error" | "denied" | "aborted" {
  const statuses: string[] = [];
  if ("status" in call) {
    statuses.push(call.status.toLowerCase());
  }
  if ("status" in output) {
    statuses.push(output.status.toLowerCase());
  }
  if (statuses.some((status: string): boolean => status === "denied")) {
    return "denied";
  }
  if (
    statuses.some(
      (status: string): boolean =>
        status === "aborted" || status === "cancelled",
    )
  ) {
    return "aborted";
  }
  if (
    statuses.some(
      (status: string): boolean =>
        status === "error" || status === "failed",
    )
  ) {
    return "error";
  }

  const value: JsonValue = outputValue(output);
  if (typeof value === "string") {
    const exitCode: RegExpMatchArray | null = value.match(
      /(?:Process exited with code|Exit code:)\s*(-?\d+)/,
    );
    if (exitCode?.[1] !== undefined && Number(exitCode[1]) !== 0) {
      return "error";
    }
    if (/^(?:error|tool call failed)\b/i.test(value.trim())) {
      return "error";
    }
  }
  return "ok";
}
