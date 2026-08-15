import { isUlid } from "./ulid.ts";

export const SCHEMA_VERSION = "0.2.0" as const;

export const EVENT_TYPES = [
  "session_start",
  "session_end",
  "turn_start",
  "turn_end",
  "tool_call",
  "error",
  "retry",
  "completion_claim",
  "verification_event",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type KnownVendor = "claude-code" | "codex" | "openclaw" | "amp" | "cursor";
export type Vendor = KnownVendor | `unknown:${string}` | (string & {});

export interface EventEnvelope {
  id: string;
  ts: string;
  observed_at: string;
  type: EventType;
  session_id: string;
  vendor: Vendor;
  adapter_version: string;
  schema_version: string;
  raw_ref: string | null;
  payload: Record<string, unknown>;
}

export interface EventEnvelopeInput {
  id: string;
  ts: string;
  observed_at?: string;
  type: EventType;
  session_id: string;
  vendor: Vendor;
  adapter_version: string;
  schema_version?: string;
  raw_ref?: string | null;
  payload?: Record<string, unknown>;
}

export interface SessionStartPayload {
  agent?: string;
  model?: string;
  harness_version?: string;
  repo?: string;
  git_branch?: string;
  cwd?: string;
  [key: string]: unknown;
}

export interface SessionEndPayload {
  outcome?: "completed" | "abandoned" | "crashed" | "unknown";
  duration_ms?: number;
  turn_count?: number;
  tool_call_count?: number;
  [key: string]: unknown;
}

export interface TurnStartPayload {
  turn_index?: number;
  role?: "user";
  text_digest?: string;
  text_chars?: number;
  is_correction?: boolean | null;
  /**
   * Which deterministic signals flagged the correction (closed enum:
   * "explicit_phrase" | "after_completion_claim" | "interrupt"). Present only
   * when is_correction is true. Never contains prose.
   */
  correction_basis?: string[];
  [key: string]: unknown;
}

export interface TurnEndPayload {
  turn_index?: number;
  role?: "agent";
  text_digest?: string;
  text_chars?: number;
  stop_reason?: string | null;
  [key: string]: unknown;
}

export interface ToolCallPayload {
  name?: string;
  input_digest?: string;
  input_summary?: string;
  status?: "ok" | "error" | "denied" | "aborted";
  duration_ms?: number;
  files_touched?: string[];
  turn_index?: number;
  [key: string]: unknown;
}

export interface ErrorPayload {
  source?: "tool" | "harness" | "model" | "adapter";
  message_digest?: string;
  message_summary?: string;
  turn_index?: number;
  tool_call_id?: string | null;
  [key: string]: unknown;
}

export interface RetryPayload {
  of_event_id?: string;
  attempt?: number;
  turn_index?: number;
  [key: string]: unknown;
}

export interface CompletionClaimPayload {
  claim_text?: string;
  claim_kind?: "done" | "tests_pass" | "deployed" | "fixed" | "other";
  turn_index?: number;
  [key: string]: unknown;
}

export interface VerificationEventPayload {
  kind?: "test" | "build" | "typecheck" | "lint" | "gate" | "other";
  command_digest?: string;
  command_summary?: string;
  result?: "pass" | "fail" | "error";
  stats?: Record<string, unknown>;
  turn_index?: number;
  initiated_by?: "agent" | "suit" | "user" | "unknown";
  [key: string]: unknown;
}

type EventFor<T extends EventType, P extends Record<string, unknown>> =
  Omit<EventEnvelope, "type" | "payload"> & { type: T; payload: P };

type EventInputFor<T extends EventType, P extends Record<string, unknown>> =
  Omit<EventEnvelopeInput, "type" | "payload"> & { type: T; payload?: P };

export type SessionStartEvent = EventFor<"session_start", SessionStartPayload>;
export type SessionEndEvent = EventFor<"session_end", SessionEndPayload>;
export type TurnStartEvent = EventFor<"turn_start", TurnStartPayload>;
export type TurnEndEvent = EventFor<"turn_end", TurnEndPayload>;
export type ToolCallEvent = EventFor<"tool_call", ToolCallPayload>;
export type ErrorEvent = EventFor<"error", ErrorPayload>;
export type RetryEvent = EventFor<"retry", RetryPayload>;
export type CompletionClaimEvent = EventFor<"completion_claim", CompletionClaimPayload>;
export type VerificationEvent = EventFor<"verification_event", VerificationEventPayload>;

export type HyperEvent =
  | SessionStartEvent
  | SessionEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | ToolCallEvent
  | ErrorEvent
  | RetryEvent
  | CompletionClaimEvent
  | VerificationEvent;

export type SessionStartEventInput = EventInputFor<"session_start", SessionStartPayload>;
export type SessionEndEventInput = EventInputFor<"session_end", SessionEndPayload>;
export type TurnStartEventInput = EventInputFor<"turn_start", TurnStartPayload>;
export type TurnEndEventInput = EventInputFor<"turn_end", TurnEndPayload>;
export type ToolCallEventInput = EventInputFor<"tool_call", ToolCallPayload>;
export type ErrorEventInput = EventInputFor<"error", ErrorPayload>;
export type RetryEventInput = EventInputFor<"retry", RetryPayload>;
export type CompletionClaimEventInput =
  EventInputFor<"completion_claim", CompletionClaimPayload>;
export type VerificationEventInput =
  EventInputFor<"verification_event", VerificationEventPayload>;

export type EventInput =
  | SessionStartEventInput
  | SessionEndEventInput
  | TurnStartEventInput
  | TurnEndEventInput
  | ToolCallEventInput
  | ErrorEventInput
  | RetryEventInput
  | CompletionClaimEventInput
  | VerificationEventInput;

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function display(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch (error: unknown) {
    return `<unserializable: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SEMVER = /^\d+\.\d+\.\d+/;

function isIsoUtcMilliseconds(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC_MS.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validateRequiredNonEmptyString(
  event: Record<string, unknown>,
  field: string,
  problems: string[],
): void {
  if (!hasOwn(event, field)) {
    problems.push(`${field}: field is required`);
    return;
  }
  const value = event[field];
  if (typeof value !== "string" || value.length === 0) {
    problems.push(`${field}: expected a non-empty string, got ${display(value)}`);
  }
}

export function validateEnvelope(e: unknown): string[] {
  if (!isPlainObject(e)) {
    return ["event: expected a non-null, non-array plain object"];
  }

  const problems: string[] = [];

  validateRequiredNonEmptyString(e, "id", problems);
  if (typeof e.id === "string" && e.id.length > 0 && !isUlid(e.id)) {
    problems.push(`id: expected a valid 26-character ULID, got ${display(e.id)}`);
  }

  if (!hasOwn(e, "ts")) {
    problems.push("ts: field is required");
  } else if (!isIsoUtcMilliseconds(e.ts)) {
    problems.push(
      `ts: expected ISO-8601 UTC with milliseconds (YYYY-MM-DDTHH:MM:SS.sssZ), got ${display(e.ts)}`,
    );
  }

  if (hasOwn(e, "observed_at") && !isIsoUtcMilliseconds(e.observed_at)) {
    problems.push(
      `observed_at: expected ISO-8601 UTC with milliseconds (YYYY-MM-DDTHH:MM:SS.sssZ), got ${display(e.observed_at)}`,
    );
  }

  if (!hasOwn(e, "type")) {
    problems.push("type: field is required");
  } else if (!isEventType(e.type)) {
    problems.push(`type: expected one of ${EVENT_TYPES.join(", ")}, got ${display(e.type)}`);
  }

  validateRequiredNonEmptyString(e, "session_id", problems);
  validateRequiredNonEmptyString(e, "vendor", problems);
  validateRequiredNonEmptyString(e, "adapter_version", problems);

  if (hasOwn(e, "schema_version")) {
    if (typeof e.schema_version !== "string" || e.schema_version.length === 0) {
      problems.push(
        `schema_version: expected a non-empty semantic version string, got ${display(e.schema_version)}`,
      );
    } else if (!SEMVER.test(e.schema_version)) {
      problems.push(
        `schema_version: expected a version beginning with MAJOR.MINOR.PATCH, got ${display(e.schema_version)}`,
      );
    }
  }

  if (
    hasOwn(e, "raw_ref")
    && e.raw_ref !== null
    && typeof e.raw_ref !== "string"
  ) {
    problems.push(`raw_ref: expected a string, null, or absence, got ${display(e.raw_ref)}`);
  }

  if (hasOwn(e, "payload") && !isPlainObject(e.payload)) {
    problems.push(`payload: expected a plain non-null, non-array object, got ${display(e.payload)}`);
  }

  return problems;
}

export function assertValidEnvelope(e: unknown): void {
  const problems = validateEnvelope(e);
  if (problems.length > 0) {
    throw new Error(`invalid event envelope: ${problems.join("; ")}`);
  }
}
