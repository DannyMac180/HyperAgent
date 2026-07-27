import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import type {
  GateAdapter,
  GateInstallResult,
  GateStatus,
} from "../types.ts";
import type {
  GateDecision,
  GateHookInput,
  GateHookKind,
} from "../../gate/eval.ts";
import { validateTargetRepo } from "../../memory/inject.ts";

export const GATE_MARKER = "hyperagent gate eval";

const TARGET_DIRECTORY = ".claude";
const TARGET_FILENAME = "settings.local.json";

type ClaudeCodeHookEvent = "PreToolUse" | "PostToolUse" | "Stop";

interface HookInstallation {
  event: ClaudeCodeHookEvent;
  hook: GateHookKind;
  matcher: boolean;
}

const HOOK_INSTALLATIONS: HookInstallation[] = [
  { event: "PreToolUse", hook: "pre_tool_use", matcher: true },
  { event: "PostToolUse", hook: "post_tool_use", matcher: true },
  { event: "Stop", hook: "stop", matcher: false },
];

export interface ClaudeCodeGateAdapterOptions {
  homeDir?: string;
  /** Absolute path to the hyperagent CLI, computed at install time. */
  cliPath?: string;
  /** Bun executable used to run the CLI. */
  runtimePath?: string;
  /** Passed through as --data-dir when set (tests / non-default installs). */
  dataDir?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOwnedEntry(value: unknown): boolean {
  return isRecord(value)
    && value.type === "command"
    && typeof value.command === "string"
    && value.command.includes(GATE_MARKER);
}

function ownedCommands(settings: unknown): string[] {
  if (!isRecord(settings) || !isRecord(settings.hooks)) {
    return [];
  }

  const commands: string[] = [];
  for (const eventGroups of Object.values(settings.hooks)) {
    if (!Array.isArray(eventGroups)) {
      continue;
    }
    for (const group of eventGroups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        continue;
      }
      for (const entry of group.hooks) {
        if (
          isOwnedEntry(entry)
          && isRecord(entry)
          && typeof entry.command === "string"
        ) {
          commands.push(entry.command);
        }
      }
    }
  }
  return commands;
}

function removeOwnedEntries(hooks: Record<string, unknown>): boolean {
  let changed = false;

  for (const [eventName, eventValue] of Object.entries(hooks)) {
    if (!Array.isArray(eventValue)) {
      continue;
    }

    const retainedGroups: unknown[] = [];
    let eventChanged = false;
    for (const group of eventValue) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        retainedGroups.push(group);
        continue;
      }

      const retainedEntries = group.hooks.filter(
        (entry: unknown): boolean => !isOwnedEntry(entry),
      );
      if (retainedEntries.length === group.hooks.length) {
        retainedGroups.push(group);
        continue;
      }

      eventChanged = true;
      if (retainedEntries.length > 0) {
        retainedGroups.push({
          ...group,
          hooks: retainedEntries,
        });
      }
    }

    if (!eventChanged) {
      continue;
    }
    changed = true;
    if (retainedGroups.length === 0) {
      delete hooks[eventName];
    } else {
      hooks[eventName] = retainedGroups;
    }
  }

  return changed;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandForHook(
  runtimePath: string,
  cliPath: string,
  event: ClaudeCodeHookEvent,
  dataDir: string | undefined,
): string {
  const parts = [
    shellQuote(runtimePath),
    shellQuote(cliPath),
    "gate",
    "eval",
    "--harness",
    "claude-code",
    "--hook",
    event,
  ];
  if (dataDir !== undefined) {
    parts.push("--data-dir", shellQuote(dataDir));
  }
  // The ownership marker rides a trailing shell comment rather than the
  // executed words: the CLI's verb is `gate eval`, so splicing the marker in
  // as arguments would invoke a command that does not exist. A comment is
  // inert at execution time and still makes the entry unambiguously ours,
  // which matters because extra JSON keys on hook entries are undocumented.
  parts.push("#", GATE_MARKER);
  return parts.join(" ");
}

function parseShellWords(command: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  let started = false;

  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }

  if (escaped || quote !== null) {
    return null;
  }
  if (started) {
    words.push(current);
  }
  return words;
}

function cliPathFromCommand(command: string): string | null {
  const words = parseShellWords(command);
  if (words === null) {
    return null;
  }
  // The ownership marker sits in a trailing shell comment, so only the words
  // the shell would actually execute can be searched: otherwise the marker's
  // own "gate eval" wins and the CLI path resolves to "#".
  const commentIndex = words.indexOf("#");
  const executedWords = commentIndex === -1
    ? words
    : words.slice(0, commentIndex);

  for (let index = 1; index < executedWords.length - 1; index += 1) {
    if (
      executedWords[index] === "gate"
      && executedWords[index + 1] === "eval"
    ) {
      return executedWords[index - 1] ?? null;
    }
  }
  return null;
}

async function atomicWrite(
  targetPath: string,
  content: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(tempPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(tempPath, targetPath);
    return { ok: true };
  } catch (error: unknown) {
    let cleanupFailure: string | undefined;
    try {
      await unlink(tempPath);
    } catch (cleanupError: unknown) {
      if (errorCode(cleanupError) !== "ENOENT") {
        cleanupFailure = errorMessage(cleanupError);
      }
    }

    const cleanupDetail = cleanupFailure === undefined
      ? ""
      : ` Temp-file cleanup also failed: ${cleanupFailure}`;
    return {
      ok: false,
      reason: `Atomic write failed for ${targetPath}: ${errorMessage(error)}.${cleanupDetail}`,
    };
  }
}

function parseSettings(
  content: string,
  targetPath: string,
): { ok: true; settings: unknown } | { ok: false; reason: string } {
  try {
    return {
      ok: true,
      settings: JSON.parse(content) as unknown,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `Refused gate settings edit: invalid JSON in ${targetPath}: ${errorMessage(error)}`,
    };
  }
}

function serializeSettings(settings: Record<string, unknown>): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function positiveToolResponse(response: unknown): boolean {
  if (!isRecord(response)) {
    return false;
  }
  if (response.is_error === true || response.interrupted === true) {
    return false;
  }
  if (typeof response.exit_code === "number") {
    return response.exit_code === 0;
  }
  if (typeof response.exitCode === "number") {
    return response.exitCode === 0;
  }
  return response.interrupted === false;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value : null;
}

function pathFromToolInput(
  toolInput: Record<string, unknown>,
): string | null | undefined {
  const filePath = optionalString(toolInput, "file_path");
  if (filePath !== undefined) {
    return filePath;
  }
  return optionalString(toolInput, "path");
}

export class ClaudeCodeGateAdapter implements GateAdapter {
  readonly vendor = "claude-code";
  private readonly homeDir: string | undefined;
  private readonly cliPath: string;
  private readonly runtimePath: string;
  private readonly dataDir: string | undefined;

  constructor(options: ClaudeCodeGateAdapterOptions = {}) {
    this.homeDir = options.homeDir;
    this.cliPath = resolve(
      options.cliPath
        ?? fileURLToPath(new URL("../../daemon/cli.ts", import.meta.url)),
    );
    this.runtimePath = resolve(options.runtimePath ?? process.execPath);
    this.dataDir = options.dataDir;
  }

  async install(repoPath: string): Promise<GateInstallResult> {
    const validation = validateTargetRepo(repoPath, {
      homeDir: this.homeDir,
    });
    if (!validation.ok) {
      return {
        targetPath: join(repoPath, TARGET_DIRECTORY, TARGET_FILENAME),
        changed: false,
        reason: validation.reason,
      };
    }

    const targetDirectory = join(validation.repoPath, TARGET_DIRECTORY);
    const targetPath = join(targetDirectory, TARGET_FILENAME);
    let existingContent: string | undefined;
    try {
      existingContent = await readFile(targetPath, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") {
        return {
          targetPath,
          changed: false,
          reason: `Failed to read gate settings target ${targetPath}: ${errorMessage(error)}`,
        };
      }
    }

    let settings: Record<string, unknown>;
    if (existingContent === undefined) {
      settings = {};
    } else {
      const parsed = parseSettings(existingContent, targetPath);
      if (!parsed.ok) {
        return {
          targetPath,
          changed: false,
          reason: parsed.reason,
        };
      }
      if (!isRecord(parsed.settings)) {
        return {
          targetPath,
          changed: false,
          reason: `Refused gate settings edit: ${targetPath} must contain a JSON object.`,
        };
      }
      settings = parsed.settings;
    }

    let hooks: Record<string, unknown>;
    if (settings.hooks === undefined) {
      hooks = {};
      settings.hooks = hooks;
    } else if (isRecord(settings.hooks)) {
      hooks = settings.hooks;
    } else {
      return {
        targetPath,
        changed: false,
        reason: `Refused gate settings edit: "hooks" in ${targetPath} must be a JSON object.`,
      };
    }

    removeOwnedEntries(hooks);
    for (const installation of HOOK_INSTALLATIONS) {
      const existingEvent = hooks[installation.event];
      if (existingEvent !== undefined && !Array.isArray(existingEvent)) {
        return {
          targetPath,
          changed: false,
          reason: `Refused gate settings edit: hooks.${installation.event} in ${targetPath} must be an array.`,
        };
      }
      const eventGroups = existingEvent ?? [];
      const ownedGroup: Record<string, unknown> = {
        hooks: [{
          type: "command",
          command: commandForHook(
            this.runtimePath,
            this.cliPath,
            installation.event,
            this.dataDir,
          ),
        }],
      };
      if (installation.matcher) {
        ownedGroup.matcher = "*";
      }
      hooks[installation.event] = [...eventGroups, ownedGroup];
    }

    const updatedContent = serializeSettings(settings);
    if (updatedContent === existingContent) {
      return {
        targetPath,
        changed: false,
        reason: "Gate settings target is already byte-identical.",
      };
    }

    try {
      await mkdir(targetDirectory, { recursive: true });
    } catch (error: unknown) {
      return {
        targetPath,
        changed: false,
        reason: `Failed to create gate settings directory ${targetDirectory}: ${errorMessage(error)}`,
      };
    }
    const writeResult = await atomicWrite(targetPath, updatedContent);
    if (!writeResult.ok) {
      return {
        targetPath,
        changed: false,
        reason: writeResult.reason,
      };
    }
    return {
      targetPath,
      changed: true,
    };
  }

  async uninstall(repoPath: string): Promise<GateInstallResult> {
    const validation = validateTargetRepo(repoPath, {
      homeDir: this.homeDir,
    });
    if (!validation.ok) {
      return {
        targetPath: join(repoPath, TARGET_DIRECTORY, TARGET_FILENAME),
        changed: false,
        reason: validation.reason,
      };
    }

    const targetPath = join(
      validation.repoPath,
      TARGET_DIRECTORY,
      TARGET_FILENAME,
    );
    let existingContent: string;
    try {
      existingContent = await readFile(targetPath, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") {
        return {
          targetPath,
          changed: false,
          reason: "Gate settings target does not exist.",
        };
      }
      return {
        targetPath,
        changed: false,
        reason: `Failed to read gate settings target ${targetPath}: ${errorMessage(error)}`,
      };
    }

    const parsed = parseSettings(existingContent, targetPath);
    if (!parsed.ok) {
      return {
        targetPath,
        changed: false,
        reason: parsed.reason,
      };
    }
    if (!isRecord(parsed.settings)) {
      return {
        targetPath,
        changed: false,
        reason: "Gate settings contain no owned hook entries.",
      };
    }
    const hooks = parsed.settings.hooks;
    if (!isRecord(hooks) || !removeOwnedEntries(hooks)) {
      return {
        targetPath,
        changed: false,
        reason: "Gate settings contain no owned hook entries.",
      };
    }
    if (Object.keys(hooks).length === 0) {
      delete parsed.settings.hooks;
    }

    const writeResult = await atomicWrite(
      targetPath,
      serializeSettings(parsed.settings),
    );
    if (!writeResult.ok) {
      return {
        targetPath,
        changed: false,
        reason: writeResult.reason,
      };
    }
    return {
      targetPath,
      changed: true,
    };
  }

  parseHookStdin(hook: GateHookKind, raw: unknown): GateHookInput | null {
    return parseClaudeCodeHookStdin(hook, raw);
  }

  renderHookOutput(hook: GateHookKind, decision: GateDecision): string {
    return renderClaudeCodeHookOutput(hook, decision);
  }

  async status(repoPath: string): Promise<GateStatus> {
    const targetPath = join(
      resolve(repoPath),
      TARGET_DIRECTORY,
      TARGET_FILENAME,
    );
    // A permanently ineligible target reports `refused`, not `not-installed` —
    // the same validation install/uninstall enforce, so status can never
    // advertise an install that would be rejected.
    const validation = validateTargetRepo(repoPath, {
      homeDir: this.homeDir,
    });
    if (!validation.ok) {
      return {
        state: "refused",
        targetPath,
        ownedEntries: 0,
        detail: validation.reason,
      };
    }
    let content: string;
    try {
      content = await readFile(targetPath, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") {
        return {
          state: "not-installed",
          targetPath,
          ownedEntries: 0,
          detail: "Claude Code local settings do not exist.",
        };
      }
      return {
        state: "foreign",
        targetPath,
        ownedEntries: 0,
        detail: `Claude Code local settings could not be read: ${errorMessage(error)}`,
      };
    }

    const parsed = parseSettings(content, targetPath);
    if (!parsed.ok) {
      return {
        state: "foreign",
        targetPath,
        ownedEntries: 0,
        detail: parsed.reason,
      };
    }

    const commands = ownedCommands(parsed.settings);
    if (commands.length === 0) {
      return {
        state: "not-installed",
        targetPath,
        ownedEntries: 0,
        detail: "No HyperAgent-owned Claude Code hook entries were found.",
      };
    }

    const unresolvedCliPaths = commands
      .map((command: string): string | null => cliPathFromCommand(command))
      .filter(
        (cliPath: string | null): boolean =>
          cliPath === null || !isAbsolute(cliPath) || !existsSync(cliPath),
      );
    if (unresolvedCliPaths.length > 0) {
      return {
        state: "stale",
        targetPath,
        ownedEntries: commands.length,
        detail:
          `${String(unresolvedCliPaths.length)} owned hook command(s) reference a CLI path that no longer resolves.`,
      };
    }

    return {
      state: "installed",
      targetPath,
      ownedEntries: commands.length,
      detail:
        `${String(commands.length)} HyperAgent-owned hook command(s) have a resolvable CLI path.`,
    };
  }
}

/** Translate Claude Code hook stdin JSON -> canonical GateHookInput.
 * Returns null when the payload is unusable (caller fails open). */
export function parseClaudeCodeHookStdin(
  hook: GateHookKind,
  raw: unknown,
): GateHookInput | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.session_id !== "string"
    || raw.session_id.length === 0
    || typeof raw.cwd !== "string"
  ) {
    return null;
  }

  if (hook === "stop") {
    if (
      raw.stop_hook_active !== undefined
      && typeof raw.stop_hook_active !== "boolean"
    ) {
      return null;
    }
    return {
      hook,
      harness: "claude-code",
      sessionId: `claude-code:${raw.session_id}`,
      cwd: raw.cwd,
      toolName: "",
      command: "",
      readPaths: [],
      writePaths: [],
      ...(typeof raw.stop_hook_active === "boolean"
        ? { stopHookActive: raw.stop_hook_active }
        : {}),
    };
  }

  if (typeof raw.tool_name !== "string" || !isRecord(raw.tool_input)) {
    return null;
  }

  let command = "";
  const readPaths: string[] = [];
  const writePaths: string[] = [];
  if (raw.tool_name === "Bash") {
    const candidate = optionalString(raw.tool_input, "command");
    if (candidate === null) {
      return null;
    }
    command = candidate ?? "";
  } else if (
    raw.tool_name === "Edit"
    || raw.tool_name === "Write"
    || raw.tool_name === "MultiEdit"
    || raw.tool_name === "NotebookEdit"
  ) {
    const candidate = pathFromToolInput(raw.tool_input);
    if (candidate === null) {
      return null;
    }
    if (candidate !== undefined) {
      writePaths.push(candidate);
    }
  } else if (
    raw.tool_name === "Read"
    || raw.tool_name === "Glob"
    || raw.tool_name === "Grep"
  ) {
    const candidate = pathFromToolInput(raw.tool_input);
    if (candidate === null) {
      return null;
    }
    if (candidate !== undefined) {
      readPaths.push(candidate);
    }
  }

  return {
    hook,
    harness: "claude-code",
    sessionId: `claude-code:${raw.session_id}`,
    cwd: raw.cwd,
    toolName: raw.tool_name,
    command,
    readPaths,
    writePaths,
    ...(hook === "post_tool_use"
      ? { toolPassed: positiveToolResponse(raw.tool_response) }
      : {}),
  };
}

/** Render a GateDecision as the bytes Claude Code expects on stdout.
 * "" means "no decision output" (the non-decision path). */
export function renderClaudeCodeHookOutput(
  hook: GateHookKind,
  decision: GateDecision,
): string {
  if (hook === "pre_tool_use" && decision.kind === "deny") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason ?? "",
      },
    });
  }
  if (hook === "stop" && decision.kind === "block") {
    return JSON.stringify({
      decision: "block",
      reason: decision.reason ?? "",
    });
  }
  return "";
}
