import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type {
  GateDecision,
  GateHookInput,
} from "../../gate/eval.ts";
import {
  ClaudeCodeGateAdapter,
  GATE_MARKER,
  parseClaudeCodeHookStdin,
  renderClaudeCodeHookOutput,
} from "./gate.ts";

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

const MANAGED_EVENTS = ["PostToolUse", "PreToolUse", "Stop"] as const;
const tempDirectories: string[] = [];

afterEach((): void => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function makeRepo(path: string): string {
  mkdirSync(join(path, ".git"), { recursive: true });
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

function isOwnedEntry(value: unknown): boolean {
  return isRecord(value)
    && value.type === "command"
    && typeof value.command === "string"
    && value.command.includes(GATE_MARKER);
}

function settingsPath(repo: string): string {
  return join(repo, ".claude", "settings.local.json");
}

function writeSettings(repo: string, content: string): string {
  const target = settingsPath(repo);
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function readJsonObject(target: string): JsonObject {
  const parsed = JSON.parse(readFileSync(target, "utf8")) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error(`Expected a JSON object in ${target}`);
  }
  return parsed;
}

function cloneJsonObject(value: JsonObject): JsonObject {
  const clone = JSON.parse(JSON.stringify(value)) as unknown;
  if (!isJsonObject(clone)) {
    throw new Error("Expected cloned JSON to remain an object.");
  }
  return clone;
}

function stripOwnedEntries(value: JsonObject): JsonObject {
  const stripped = cloneJsonObject(value);
  const hooks = stripped.hooks;
  if (!isJsonObject(hooks)) {
    return stripped;
  }

  for (const [event, eventValue] of Object.entries(hooks)) {
    if (!Array.isArray(eventValue)) {
      continue;
    }
    const retainedGroups: JsonValue[] = [];
    for (const group of eventValue) {
      if (!isJsonObject(group) || !Array.isArray(group.hooks)) {
        retainedGroups.push(group);
        continue;
      }
      const retainedEntries = group.hooks.filter(
        (entry: JsonValue): boolean => !isOwnedEntry(entry),
      );
      if (retainedEntries.length > 0) {
        retainedGroups.push({
          ...group,
          hooks: retainedEntries,
        });
      }
    }
    if (retainedGroups.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = retainedGroups;
    }
  }
  return stripped;
}

function normalizeEmptyHooks(value: JsonObject): JsonObject {
  const normalized = cloneJsonObject(value);
  // Claude Code treats an absent hooks key and an empty hooks object identically.
  if (
    isJsonObject(normalized.hooks)
    && Object.keys(normalized.hooks).length === 0
  ) {
    delete normalized.hooks;
  }
  return normalized;
}

function ownedEntriesForEvent(
  settings: JsonObject,
  event: string,
): JsonObject[] {
  if (!isJsonObject(settings.hooks)) {
    return [];
  }
  const groups = settings.hooks[event];
  if (!Array.isArray(groups)) {
    return [];
  }

  const owned: JsonObject[] = [];
  for (const group of groups) {
    if (!isJsonObject(group) || !Array.isArray(group.hooks)) {
      continue;
    }
    for (const entry of group.hooks) {
      if (isJsonObject(entry) && isOwnedEntry(entry)) {
        owned.push(entry);
      }
    }
  }
  return owned;
}

function countOwnedEntries(settings: JsonObject): number {
  return MANAGED_EVENTS.reduce(
    (total: number, event: string): number =>
      total + ownedEntriesForEvent(settings, event).length,
    0,
  );
}

function decision(
  kind: GateDecision["kind"],
  reason?: string,
): GateDecision {
  return {
    kind,
    matchedRules: [],
    failedChecks: [],
    ...(reason === undefined ? {} : { reason }),
  };
}

function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomInt(random: () => number, maximum: number): number {
  return Math.floor(random() * maximum);
}

function randomPrimitive(random: () => number, label: string): JsonPrimitive {
  const choice = randomInt(random, 4);
  if (choice === 0) {
    return `${label}-${String(randomInt(random, 1_000_000))}`;
  }
  if (choice === 1) {
    return randomInt(random, 1_000_000);
  }
  if (choice === 2) {
    return random() >= 0.5;
  }
  return null;
}

function randomJson(
  random: () => number,
  label: string,
  depth: number,
): JsonValue {
  if (depth === 0) {
    return randomPrimitive(random, label);
  }
  const choice = randomInt(random, 3);
  if (choice === 0) {
    return randomPrimitive(random, label);
  }
  if (choice === 1) {
    const values: JsonValue[] = [];
    const length = 1 + randomInt(random, 4);
    for (let index = 0; index < length; index += 1) {
      values.push(randomJson(random, `${label}-array-${String(index)}`, depth - 1));
    }
    return values;
  }

  const object: JsonObject = {};
  const length = 1 + randomInt(random, 4);
  for (let index = 0; index < length; index += 1) {
    object[`${label}_nested_${String(index)}`] = randomJson(
      random,
      `${label}-object-${String(index)}`,
      depth - 1,
    );
  }
  return object;
}

function foreignGroup(
  random: () => number,
  caseIndex: number,
  event: string,
  groupIndex: number,
): JsonObject {
  const entries: JsonValue[] = [];
  const entryCount = 1 + randomInt(random, 3);
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    entries.push({
      type: "command",
      command:
        `foreign-${String(caseIndex)}-${event}-${String(groupIndex)}-${String(entryIndex)}`,
      timeout: randomInt(random, 10_000),
    });
  }
  return {
    matcher: random() >= 0.5 ? "*" : `matcher-${String(randomInt(random, 100))}`,
    hooks: entries,
    foreignMetadata: randomJson(random, `group-${String(groupIndex)}`, 2),
  };
}

function generatedSettings(random: () => number, caseIndex: number): JsonObject {
  const settings: JsonObject = {};
  const topLevelKeyCount = 1 + randomInt(random, 6);
  for (let index = 0; index < topLevelKeyCount; index += 1) {
    settings[`foreign_top_${String(caseIndex)}_${String(index)}`] = randomJson(
      random,
      `case-${String(caseIndex)}-top-${String(index)}`,
      2,
    );
  }

  const hooks: JsonObject = {};
  for (const event of MANAGED_EVENTS) {
    const groups: JsonValue[] = [];
    const groupCount = 1 + randomInt(random, 3);
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      groups.push(foreignGroup(random, caseIndex, event, groupIndex));
    }
    hooks[event] = groups;
  }

  const foreignEvents = ["Notification", "SessionStart"] as const;
  const foreignEventCount = 1 + randomInt(random, foreignEvents.length);
  for (let index = 0; index < foreignEventCount; index += 1) {
    const event = foreignEvents[index];
    if (event === undefined) {
      throw new Error("Seeded foreign event index was unexpectedly undefined.");
    }
    hooks[event] = [foreignGroup(random, caseIndex, event, 0)];
  }
  settings.hooks = hooks;
  return settings;
}

function setup(options: { dataDir?: string } = {}): {
  root: string;
  fakeHome: string;
  repo: string;
  target: string;
  cliPath: string;
  runtimePath: string;
  adapter: ClaudeCodeGateAdapter;
} {
  const root = makeTempDir("hyperagent-claude-gate-");
  const fakeHome = join(root, "home");
  mkdirSync(fakeHome);
  const repo = makeRepo(join(root, "repo"));
  const cliPath = join(root, "hyperagent cli.ts");
  const runtimePath = join(root, "bun runtime");
  writeFileSync(cliPath, "");
  writeFileSync(runtimePath, "");
  const adapterOptions = options.dataDir === undefined
    ? { homeDir: fakeHome, cliPath, runtimePath }
    : {
        homeDir: fakeHome,
        cliPath,
        runtimePath,
        dataDir: options.dataDir,
      };
  return {
    root,
    fakeHome,
    repo,
    target: settingsPath(repo),
    cliPath,
    runtimePath,
    adapter: new ClaudeCodeGateAdapter(adapterOptions),
  };
}

describe("ClaudeCodeGateAdapter", () => {
  test("preserves arbitrary foreign settings across install and uninstall", async (): Promise<void> => {
    const random = makeLcg(0x5eed_c0de);
    const root = makeTempDir("hyperagent-claude-gate-property-");
    const fakeHome = join(root, "home");
    const cliPath = join(root, "cli.ts");
    const runtimePath = join(root, "bun");
    mkdirSync(fakeHome);
    writeFileSync(cliPath, "");
    writeFileSync(runtimePath, "");
    const adapter = new ClaudeCodeGateAdapter({
      homeDir: fakeHome,
      cliPath,
      runtimePath,
    });

    for (let caseIndex = 0; caseIndex < 32; caseIndex += 1) {
      const repo = makeRepo(join(root, `repo-${String(caseIndex)}`));
      const target = settingsPath(repo);
      const original = generatedSettings(random, caseIndex);
      writeSettings(repo, `${JSON.stringify(original, null, 2)}\n`);

      const firstInstall = await adapter.install(repo);
      expect(firstInstall.changed).toBe(true);
      const installed = readJsonObject(target);
      expect(stripOwnedEntries(installed)).toEqual(original);

      const installedBytes = readFileSync(target);
      const secondInstall = await adapter.install(repo);
      expect(secondInstall.changed).toBe(false);
      expect(readFileSync(target)).toEqual(installedBytes);

      const uninstall = await adapter.uninstall(repo);
      expect(uninstall.changed).toBe(true);
      expect(normalizeEmptyHooks(readJsonObject(target))).toEqual(
        normalizeEmptyHooks(original),
      );
    }
  });

  test("creates .claude/settings.local.json with exactly three owned entries", async (): Promise<void> => {
    const { adapter, repo, target } = setup();
    expect(existsSync(join(repo, ".claude"))).toBe(false);

    const result = await adapter.install(repo);

    expect(result).toEqual({
      targetPath: join(realpathSync(repo), ".claude", "settings.local.json"),
      changed: true,
    });
    expect(existsSync(target)).toBe(true);
    const settings = readJsonObject(target);
    expect(countOwnedEntries(settings)).toBe(3);
    expect(isJsonObject(settings.hooks)).toBe(true);
    if (!isJsonObject(settings.hooks)) {
      throw new Error("Expected installed hooks to be an object.");
    }
    expect(Object.keys(settings.hooks).sort()).toEqual([...MANAGED_EVENTS]);
  });

  test("installs absolute event-specific commands including a configured data directory", async (): Promise<void> => {
    const root = makeTempDir("hyperagent-claude-gate-command-");
    const dataDir = join(root, "gate data");
    const {
      adapter,
      repo,
      target,
      cliPath,
    } = setup({ dataDir });
    expect(isAbsolute(cliPath)).toBe(true);

    await adapter.install(repo);

    const settings = readJsonObject(target);
    for (const event of MANAGED_EVENTS) {
      const entries = ownedEntriesForEvent(settings, event);
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      if (entry === undefined || typeof entry.command !== "string") {
        throw new Error(`Expected one command for ${event}.`);
      }
      expect(entry.command).toContain(GATE_MARKER);
      expect(entry.command).toContain(cliPath);
      expect(entry.command).toContain(`--hook ${event}`);
      expect(entry.command).toContain("--data-dir");
      expect(entry.command).toContain(dataDir);
    }
  });

  test("repairs duplicate owned entries to one entry for the event", async (): Promise<void> => {
    const { adapter, repo, target } = setup();
    const duplicate = {
      type: "command",
      command: `bun cli ${GATE_MARKER} --hook PreToolUse`,
    };
    writeSettings(repo, `${JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "*",
          hooks: [duplicate, duplicate, duplicate],
        }],
      },
    }, null, 2)}\n`);

    const result = await adapter.install(repo);

    expect(result.changed).toBe(true);
    expect(ownedEntriesForEvent(readJsonObject(target), "PreToolUse")).toHaveLength(1);
  });

  test("refuses invalid JSON without changing bytes and reports foreign status", async (): Promise<void> => {
    const { adapter, repo, target } = setup();
    const original = Buffer.from("{ invalid json\r\n");
    writeSettings(repo, original.toString("utf8"));

    const result = await adapter.install(repo);

    expect(result.changed).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(readFileSync(target)).toEqual(original);
    const status = await adapter.status(repo);
    expect(status.state).toBe("foreign");
  });

  test("refuses settings whose top level is an array or number", async (): Promise<void> => {
    const { adapter, root } = setup();
    const documents: JsonValue[] = [[], 42];
    for (let index = 0; index < documents.length; index += 1) {
      const repo = makeRepo(join(root, `non-object-${String(index)}`));
      const target = writeSettings(
        repo,
        `${JSON.stringify(documents[index], null, 2)}\n`,
      );
      const original = readFileSync(target);

      const result = await adapter.install(repo);

      expect(result.changed).toBe(false);
      expect(result.reason).toBeTruthy();
      expect(readFileSync(target)).toEqual(original);
    }
  });

  test("uninstall with no owned entries is byte-identical", async (): Promise<void> => {
    const { adapter, repo, target } = setup();
    const original = Buffer.from(
      "{\r\n  \"hooks\": {\"SessionStart\": []},\r\n  \"foreign\": true\r\n}\r\n",
    );
    writeSettings(repo, original.toString("utf8"));

    const result = await adapter.uninstall(repo);

    expect(result.changed).toBe(false);
    expect(readFileSync(target)).toEqual(original);
  });

  test("uninstall on a missing file changes nothing and creates no file", async (): Promise<void> => {
    const { adapter, repo, target } = setup();

    const result = await adapter.uninstall(repo);

    expect(result.changed).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(existsSync(target)).toBe(false);
  });

  test("uninstall removes an owned entry but keeps a foreign entry in the same matcher group", async (): Promise<void> => {
    const { adapter, repo, target } = setup();
    const foreignEntry: JsonObject = {
      type: "command",
      command: "foreign-shared-matcher-command",
      timeout: 5000,
    };
    writeSettings(repo, `${JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "*",
          label: "shared",
          hooks: [
            foreignEntry,
            {
              type: "command",
              command: `bun cli ${GATE_MARKER} --hook PreToolUse`,
            },
          ],
        }],
      },
    }, null, 2)}\n`);

    const result = await adapter.uninstall(repo);

    expect(result.changed).toBe(true);
    expect(readJsonObject(target)).toEqual({
      hooks: {
        PreToolUse: [{
          matcher: "*",
          label: "shared",
          hooks: [foreignEntry],
        }],
      },
    });
  });

  test("refuses protected, missing, and non-repository targets without creating settings", async (): Promise<void> => {
    const root = makeTempDir("hyperagent-claude-gate-refusals-");
    const fakeHome = join(root, "home");
    mkdirSync(fakeHome);
    const cliPath = join(root, "cli.ts");
    const runtimePath = join(root, "bun");
    writeFileSync(cliPath, "");
    writeFileSync(runtimePath, "");
    const adapter = new ClaudeCodeGateAdapter({
      homeDir: fakeHome,
      cliPath,
      runtimePath,
    });
    const underClaude = makeRepo(join(fakeHome, ".claude", "repo"));
    const underHyperAgent = makeRepo(join(fakeHome, ".hyperagent", "repo"));
    const missing = join(root, "missing");
    const noGit = join(root, "no-git");
    mkdirSync(noGit);

    for (const repo of [underClaude, underHyperAgent, missing, noGit]) {
      const target = settingsPath(repo);
      const result = await adapter.install(repo);
      expect(result.changed).toBe(false);
      expect(result.reason).toBeTruthy();
      expect(existsSync(target)).toBe(false);
    }
  });

  test("status distinguishes absent, foreign-only, installed, and stale settings", async (): Promise<void> => {
    const {
      adapter,
      root,
      cliPath,
    } = setup();
    const absentRepo = makeRepo(join(root, "status-absent"));
    const foreignRepo = makeRepo(join(root, "status-foreign"));
    const installedRepo = makeRepo(join(root, "status-installed"));
    const staleRepo = makeRepo(join(root, "status-stale"));
    writeSettings(foreignRepo, `${JSON.stringify({
      hooks: {
        Notification: [{
          hooks: [{ type: "command", command: "foreign" }],
        }],
      },
    }, null, 2)}\n`);

    expect((await adapter.status(absentRepo)).state).toBe("not-installed");
    expect((await adapter.status(foreignRepo)).state).toBe("not-installed");

    await adapter.install(installedRepo);
    const installedStatus = await adapter.status(installedRepo);
    expect(installedStatus.state).toBe("installed");
    expect(installedStatus.ownedEntries).toBe(3);

    await adapter.install(staleRepo);
    unlinkSync(cliPath);
    const staleStatus = await adapter.status(staleRepo);
    expect(staleStatus.state).toBe("stale");
    expect(staleStatus.ownedEntries).toBe(3);
  });
});

describe("parseClaudeCodeHookStdin", () => {
  test("returns null for unusable payloads", (): void => {
    const cases: Array<{
      hook: "post_tool_use" | "pre_tool_use" | "stop";
      raw: unknown;
    }> = [
      { hook: "pre_tool_use", raw: [] },
      { hook: "pre_tool_use", raw: { cwd: "/repo", tool_name: "Bash", tool_input: {} } },
      { hook: "pre_tool_use", raw: { session_id: "", cwd: "/repo", tool_name: "Bash", tool_input: {} } },
      { hook: "pre_tool_use", raw: { session_id: "s", tool_name: "Bash", tool_input: {} } },
      { hook: "pre_tool_use", raw: { session_id: "s", cwd: "/repo", tool_input: {} } },
      { hook: "pre_tool_use", raw: { session_id: "s", cwd: "/repo", tool_name: "Bash", tool_input: [] } },
      { hook: "stop", raw: { session_id: "s", cwd: "/repo", stop_hook_active: "yes" } },
    ];

    for (const entry of cases) {
      expect(parseClaudeCodeHookStdin(entry.hook, entry.raw)).toBeNull();
    }
  });

  test("returns canonical Bash, file-tool, and Stop shapes", (): void => {
    const successes: Array<{
      hook: "pre_tool_use" | "stop";
      raw: JsonObject;
      expected: GateHookInput;
    }> = [
      {
        hook: "pre_tool_use",
        raw: {
          session_id: "bash-session",
          cwd: "/repo",
          tool_name: "Bash",
          tool_input: { command: "bun test" },
        },
        expected: {
          hook: "pre_tool_use",
          harness: "claude-code",
          sessionId: "claude-code:bash-session",
          cwd: "/repo",
          toolName: "Bash",
          command: "bun test",
          readPaths: [],
          writePaths: [],
        },
      },
      {
        hook: "pre_tool_use",
        raw: {
          session_id: "edit-session",
          cwd: "/repo",
          tool_name: "Edit",
          tool_input: { file_path: "/repo/edit.ts" },
        },
        expected: {
          hook: "pre_tool_use",
          harness: "claude-code",
          sessionId: "claude-code:edit-session",
          cwd: "/repo",
          toolName: "Edit",
          command: "",
          readPaths: [],
          writePaths: ["/repo/edit.ts"],
        },
      },
      {
        hook: "pre_tool_use",
        raw: {
          session_id: "write-session",
          cwd: "/repo",
          tool_name: "Write",
          tool_input: { path: "/repo/write.ts" },
        },
        expected: {
          hook: "pre_tool_use",
          harness: "claude-code",
          sessionId: "claude-code:write-session",
          cwd: "/repo",
          toolName: "Write",
          command: "",
          readPaths: [],
          writePaths: ["/repo/write.ts"],
        },
      },
      {
        hook: "pre_tool_use",
        raw: {
          session_id: "read-session",
          cwd: "/repo",
          tool_name: "Read",
          tool_input: { file_path: "/repo/read.ts" },
        },
        expected: {
          hook: "pre_tool_use",
          harness: "claude-code",
          sessionId: "claude-code:read-session",
          cwd: "/repo",
          toolName: "Read",
          command: "",
          readPaths: ["/repo/read.ts"],
          writePaths: [],
        },
      },
      {
        hook: "pre_tool_use",
        raw: {
          session_id: "grep-session",
          cwd: "/repo",
          tool_name: "Grep",
          tool_input: { path: "/repo/src" },
        },
        expected: {
          hook: "pre_tool_use",
          harness: "claude-code",
          sessionId: "claude-code:grep-session",
          cwd: "/repo",
          toolName: "Grep",
          command: "",
          readPaths: ["/repo/src"],
          writePaths: [],
        },
      },
      {
        hook: "stop",
        raw: {
          session_id: "stop-session",
          cwd: "/repo",
          stop_hook_active: true,
        },
        expected: {
          hook: "stop",
          harness: "claude-code",
          sessionId: "claude-code:stop-session",
          cwd: "/repo",
          toolName: "",
          command: "",
          readPaths: [],
          writePaths: [],
          stopHookActive: true,
        },
      },
    ];

    for (const entry of successes) {
      const parsed = parseClaudeCodeHookStdin(entry.hook, entry.raw);
      expect(parsed).toEqual(entry.expected);
      expect(parsed?.sessionId).toBe(`claude-code:${String(entry.raw.session_id)}`);
    }
  });

  test("marks post-tool use passed only with positive evidence", (): void => {
    const responses: Array<{ response: unknown; expected: boolean }> = [
      { response: { exit_code: 0 }, expected: true },
      { response: undefined, expected: false },
      { response: {}, expected: false },
      { response: { is_error: true }, expected: false },
      { response: { interrupted: true }, expected: false },
      { response: { exit_code: 1 }, expected: false },
      { response: "success", expected: false },
    ];

    for (let index = 0; index < responses.length; index += 1) {
      const entry = responses[index];
      if (entry === undefined) {
        throw new Error("Expected conservative response case.");
      }
      const raw: Record<string, unknown> = {
        session_id: `post-${String(index)}`,
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: "true" },
      };
      if (entry.response !== undefined) {
        raw.tool_response = entry.response;
      }
      const parsed = parseClaudeCodeHookStdin("post_tool_use", raw);
      expect(parsed?.sessionId).toBe(`claude-code:post-${String(index)}`);
      expect(parsed?.toolPassed).toBe(entry.expected);
    }
  });
});

describe("renderClaudeCodeHookOutput", () => {
  test("emits only matching deny and block decisions", (): void => {
    const denied = JSON.parse(renderClaudeCodeHookOutput(
      "pre_tool_use",
      decision("deny", "policy denied the command"),
    )) as unknown;
    expect(denied).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "policy denied the command",
      },
    });
    if (
      !isRecord(denied)
      || !isRecord(denied.hookSpecificOutput)
      || typeof denied.hookSpecificOutput.permissionDecisionReason !== "string"
    ) {
      throw new Error("Expected a Claude Code PreToolUse denial object.");
    }
    expect(denied.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0);

    const blocked = JSON.parse(renderClaudeCodeHookOutput(
      "stop",
      decision("block", "unfinished work remains"),
    )) as unknown;
    expect(blocked).toEqual({
      decision: "block",
      reason: "unfinished work remains",
    });

    expect(renderClaudeCodeHookOutput("pre_tool_use", decision("allow"))).toBe("");
    expect(renderClaudeCodeHookOutput("post_tool_use", decision("allow"))).toBe("");
    expect(renderClaudeCodeHookOutput("stop", decision("allow"))).toBe("");
    expect(renderClaudeCodeHookOutput("stop", decision("deny", "wrong hook"))).toBe("");
    expect(renderClaudeCodeHookOutput("pre_tool_use", decision("block", "wrong hook"))).toBe("");
  });
});
