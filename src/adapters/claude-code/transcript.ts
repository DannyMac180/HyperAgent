import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface TranscriptLine {
  type: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  sessionId?: string;
  uuid?: string;
  message?: unknown;
  [k: string]: unknown;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean | null;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ClaimMatch {
  text: string;
  kind: "done" | "tests_pass" | "deployed" | "fixed" | "other";
  index: number;
}

export const KNOWN_LINE_TYPES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "system",
]);

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) {
    return false;
  }

  const prototype: object | null = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
}

export function parseTranscriptLine(raw: string): TranscriptLine | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed) || typeof parsed.type !== "string") {
      return null;
    }

    return { ...parsed, type: parsed.type };
  } catch {
    return null;
  }
}

export function isToolUseBlock(v: unknown): v is ToolUseBlock {
  return (
    isPlainObject(v) &&
    v.type === "tool_use" &&
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    isPlainObject(v.input)
  );
}

export function isToolResultBlock(v: unknown): v is ToolResultBlock {
  return (
    isPlainObject(v) &&
    v.type === "tool_result" &&
    typeof v.tool_use_id === "string" &&
    (v.is_error === undefined ||
      v.is_error === null ||
      typeof v.is_error === "boolean")
  );
}

export function isTextBlock(v: unknown): v is TextBlock {
  return (
    isPlainObject(v) &&
    v.type === "text" &&
    typeof v.text === "string"
  );
}

export function normalizeTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }

  const timestamp: Date = new Date(raw);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }

  return timestamp.toISOString();
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function canonicalJsonValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return "null";
  }

  if (typeof value === "bigint") {
    throw new TypeError("BigInt values cannot be serialized as JSON");
  }

  if (ancestors.has(value)) {
    throw new TypeError("Circular values cannot be serialized as JSON");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((item: unknown): string => canonicalJsonValue(item, ancestors))
        .join(",")}]`;
    }

    if (isPlainObject(value)) {
      const properties: string[] = [];
      const keys: string[] = Object.keys(value).sort();

      for (const key of keys) {
        const item: unknown = value[key];
        if (
          typeof item === "undefined" ||
          typeof item === "function" ||
          typeof item === "symbol"
        ) {
          continue;
        }

        properties.push(
          `${JSON.stringify(key)}:${canonicalJsonValue(item, ancestors)}`,
        );
      }

      return `{${properties.join(",")}}`;
    }

    const serialized: string | undefined = JSON.stringify(value);
    return serialized ?? "null";
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalJsonValue(value, new Set<object>());
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

export function contentBlocks(message: unknown): unknown[] {
  if (!isPlainObject(message) || !Array.isArray(message.content)) {
    return [];
  }

  return [...message.content];
}

export function extractUserText(message: unknown): string {
  if (!isPlainObject(message)) {
    return "";
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  return contentBlocks(message)
    .filter(isTextBlock)
    .map((block: TextBlock): string => block.text)
    .join("\n");
}

export function extractAssistantText(message: unknown): string {
  return contentBlocks(message)
    .filter(isTextBlock)
    .map((block: TextBlock): string => block.text)
    .join("\n");
}

export function userToolResults(message: unknown): ToolResultBlock[] {
  return contentBlocks(message).filter(isToolResultBlock);
}

export function isRealUserTurn(message: unknown): boolean {
  if (!isPlainObject(message)) {
    return false;
  }

  if (typeof message.content === "string") {
    return true;
  }

  return (
    Array.isArray(message.content) &&
    !message.content.some((block: unknown): boolean =>
      isToolResultBlock(block),
    )
  );
}

export function toRepoRelative(
  absolutePath: string,
  cwd: string | undefined,
): string | null {
  if (
    cwd === undefined ||
    !isAbsolute(cwd) ||
    !isAbsolute(absolutePath)
  ) {
    return null;
  }

  const root: string = resolve(cwd);
  const target: string = resolve(absolutePath);
  const relativePath: string = relative(root, target);

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }

  return relativePath === "" ? "." : relativePath.split(sep).join("/");
}

const FILE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "MultiEdit",
]);

export function filesTouchedFrom(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
): string[] {
  if (!FILE_TOOL_NAMES.has(toolName)) {
    return [];
  }

  const pathValue: unknown = input.file_path ?? input.path;
  if (typeof pathValue !== "string") {
    return [];
  }

  const relativePath: string | null = toRepoRelative(pathValue, cwd);
  return relativePath === null ? [] : [relativePath];
}

function rewriteRepoPaths(value: unknown, cwd: string | undefined): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown): unknown => rewriteRepoPaths(item, cwd));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const rewritten: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      (key === "file_path" || key === "path") &&
      typeof item === "string"
    ) {
      rewritten[key] = toRepoRelative(item, cwd) ?? item;
    } else {
      rewritten[key] = rewriteRepoPaths(item, cwd);
    }
  }

  return rewritten;
}

export function digestInput(
  input: Record<string, unknown>,
  cwd: string | undefined,
): string {
  return sha256Hex(canonicalJson(rewriteRepoPaths(input, cwd)));
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence: string): string => sentence.trim())
    .filter((sentence: string): boolean => sentence.length > 0);
}

export function findCompletionClaims(text: string): ClaimMatch[] {
  const claimPattern =
    /\b(done|complete[d]?|fixed|all tests pass(ing)?|deployed|works now)\b/i;
  const sentences: string[] = splitSentences(text);
  const claims: ClaimMatch[] = [];

  sentences.forEach((sentence: string, index: number): void => {
    if (sentence.length > 400 || !claimPattern.test(sentence)) {
      return;
    }

    let kind: ClaimMatch["kind"] = "other";
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
    /\b(bun test|npm test|pytest|cargo test|go test|tsc|bunx tsc|make (test|check)|vitest|jest)\b/;

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

export function isSystemErrorLine(line: TranscriptLine): boolean {
  if (line.type !== "system") {
    return false;
  }

  return [line.subtype, line.level].some(
    (value: unknown): boolean =>
      typeof value === "string" && value.toLowerCase().includes("error"),
  );
}

function stringifyMessageValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    const serialized: string | undefined = JSON.stringify(value);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}

export function systemErrorMessage(line: TranscriptLine): string {
  const candidates: unknown[] = [line.content, line.message, line.text];
  const value: unknown = candidates.find(
    (candidate: unknown): boolean =>
      candidate !== undefined && candidate !== null,
  );

  return value === undefined ? "" : stringifyMessageValue(value);
}
