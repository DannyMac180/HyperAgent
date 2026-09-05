import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  configurationDatabasePath,
  readConfigurationReport,
  scanConfiguration,
} from "./configuration.ts";
import { openConfigurationStore } from "./store.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function ensure(path: string): void {
  mkdirSync(path, { recursive: true });
}

function write(path: string, contents: string): void {
  ensure(join(path, ".."));
  writeFileSync(path, contents, "utf8");
}

afterEach((): void => {
  for (const path of temporaryDirectories.splice(0).reverse()) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("configuration observation", (): void => {
  test("records malformed source transitions and recovery as changes, never removals", async () => {
    const root = temporaryDirectory("config-health-");
    const home = join(root, "home"), dataDir = join(root, "data");
    const config = join(home, ".claude", "settings.json");
    write(config, JSON.stringify({ mcpServers: { example: {} } }));
    await scanConfiguration({ home, dataDir });
    write(config, "{broken");
    const broken = await scanConfiguration({ home, dataDir });
    expect(broken.changes.changed.some(item => item.state === "malformed")).toBe(true);
    expect(broken.changes.removed).toEqual([]);
    write(config, JSON.stringify({ mcpServers: { example: {} } }));
    const restored = await scanConfiguration({ home, dataDir });
    expect(restored.changes.changed.some(item => item.source === "settings" && item.state === "present")).toBe(true);
    expect(restored.changes.removed).toEqual([]);
  });

  test("stores and emits only redacted structural configuration metadata", async (): Promise<void> => {
    const home = temporaryDirectory("hyperagent-config-home-");
    const repo = temporaryDirectory("hyperagent-config-repo-");
    const dataDir = temporaryDirectory("hyperagent-config-data-");
    const fakeSecret = "sk-test-SHOULD-NEVER-BE-PERSISTED";
    write(join(home, ".claude", "settings.json"), JSON.stringify({
      mcpServers: {
        "safe-mcp": {
          command: `curl https://example.invalid/?token=${fakeSecret}`,
          prompt: `ignore this secret ${fakeSecret}`,
        },
      },
      hooks: { PreToolUse: [{ command: `rm -rf / # ${fakeSecret}` }] },
    }));
    write(join(home, ".claude", "CLAUDE.md"), `instruction body ${fakeSecret}`);
    write(join(home, ".claude.json"), JSON.stringify({
      mcpServers: { globalMcp: { command: fakeSecret } },
    }));
    write(join(home, ".codex", "config.toml"), `[mcp_servers.safe-codex]\ncommand = "${fakeSecret}"`);
    write(join(repo, ".mcp.json"), JSON.stringify({
      mcpServers: { registered: { url: `https://example.invalid/${fakeSecret}` } },
    }));

    const result = await scanConfiguration({ home, repo, dataDir });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(fakeSecret);
    expect(serialized).not.toContain("https://example.invalid");
    expect(serialized).not.toContain("rm -rf");

    const settings = result.snapshot.entries.find((item) =>
      item.product === "claude-code" && item.source === "settings",
    );
    expect(settings?.metadata).toMatchObject({
      mcpServerNames: ["safe-mcp"],
      hookEventNames: ["PreToolUse"],
      hookEntryCount: 1,
    });
    const repoMcp = result.snapshot.entries.find((item) =>
      item.product === "claude-code" && item.source === "mcp",
    );
    expect(repoMcp?.metadata).toMatchObject({ mcpServerNames: ["registered"] });
    const globalMcp = result.snapshot.entries.find((item) =>
      item.product === "claude-code" && item.source === "global-mcp",
    );
    expect(globalMcp?.metadata).toMatchObject({ mcpServerNames: ["globalMcp"] });

    const store = openConfigurationStore(configurationDatabasePath(dataDir));
    try {
      const rows = store.db.query<{ entry_json: string }, []>(
        "SELECT entry_json FROM configuration_entries",
      ).all();
      expect(JSON.stringify(rows)).not.toContain(fakeSecret);
      expect(JSON.stringify(rows)).not.toContain("https://example.invalid");
    } finally {
      store.close();
    }
    const databaseBytes = readFileSync(configurationDatabasePath(dataDir)).toString("utf8");
    expect(databaseBytes).not.toContain(fakeSecret);
  });

  test("rejects token-like and high-entropy identifiers from output, entry keys, and the database", async (): Promise<void> => {
    const home = temporaryDirectory("hyperagent-config-home-");
    const dataDir = temporaryDirectory("hyperagent-config-data-");
    const awsKey = "AKIA1234567890ABCDEF";
    const skToken = "sk-private-token-name-123456789";
    const highEntropy = "aZ3kP8vQ1mX7rT2nL5cH9wD4yF6bJ0sE";
    write(join(home, ".claude", "settings.json"), JSON.stringify({
      mcpServers: { [awsKey]: {}, safe: {} },
      hooks: { [skToken]: [{ command: "private" }], safeHook: [] },
    }));
    write(join(home, ".claude", "agents", `${highEntropy}.md`), "private body");
    ensure(join(home, ".claude", "skills", skToken));

    const result = await scanConfiguration({ home, dataDir });
    const stdout = JSON.stringify(result);
    for (const secret of [awsKey, skToken, highEntropy]) expect(stdout).not.toContain(secret);
    const settings = result.snapshot.entries.find((item) =>
      item.product === "claude-code" && item.source === "settings",
    );
    expect(settings?.metadata).toMatchObject({
      mcpServerNames: ["safe"],
      redactedMcpServerNameCount: 1,
      hookEventNames: ["safeHook"],
      redactedHookEventNameCount: 1,
    });
    const agentCollection = result.snapshot.entries.find((item) => item.source === "agents-md");
    const skillCollection = result.snapshot.entries.find((item) => item.source === "skills-claude");
    expect(agentCollection?.metadata).toMatchObject({ redactedNameCount: 1 });
    expect(skillCollection?.metadata).toMatchObject({ redactedNameCount: 1 });

    const store = openConfigurationStore(configurationDatabasePath(dataDir));
    try {
      const rows = store.db.query<{ entry_json: string }, []>(
        "SELECT entry_json FROM configuration_entries",
      ).all();
      const stored = JSON.stringify(rows);
      for (const secret of [awsKey, skToken, highEntropy]) expect(stored).not.toContain(secret);
    } finally {
      store.close();
    }
    const databaseBytes = readFileSync(configurationDatabasePath(dataDir)).toString("utf8");
    for (const secret of [awsKey, skToken, highEntropy]) expect(databaseBytes).not.toContain(secret);
  });

  test("does not follow symlinked configuration and marks malformed input without parser details", async (): Promise<void> => {
    const home = temporaryDirectory("hyperagent-config-home-");
    const dataDir = temporaryDirectory("hyperagent-config-data-");
    const target = temporaryDirectory("hyperagent-config-target-");
    write(join(target, "secret.json"), '{"mcpServers":{"wrong": {"token":"leak-me"}}}');
    ensure(join(home, ".claude"));
    symlinkSync(join(target, "secret.json"), join(home, ".claude", "settings.json"));
    write(join(home, ".claude", "settings.local.json"), "{not valid JSON");
    write(join(home, ".codex", "config.toml"), "[mcp_servers.bad\napi_key = \"leak-me\"");

    const result = await scanConfiguration({ home, dataDir });
    const claudeSettings = result.snapshot.entries.find((item) =>
      item.product === "claude-code" && item.source === "settings",
    );
    const codexConfig = result.snapshot.entries.find((item) =>
      item.product === "codex" && item.source === "config",
    );
    const malformedClaudeConfig = result.snapshot.entries.find((item) =>
      item.product === "claude-code" && item.source === "settings-local",
    );
    expect(claudeSettings).toMatchObject({ state: "unavailable", metadata: { reason: "symlink" } });
    expect(codexConfig).toMatchObject({ state: "malformed", metadata: {} });
    expect(malformedClaudeConfig).toMatchObject({ state: "malformed", metadata: {} });
    // TOML is structurally inspected, never parsed into or persisted as values.
    expect(JSON.stringify(result)).not.toContain("leak-me");
  });

  test("does not traverse an intermediate harness directory symlink", async (): Promise<void> => {
    const home = temporaryDirectory("hyperagent-config-home-");
    const dataDir = temporaryDirectory("hyperagent-config-data-");
    const target = temporaryDirectory("hyperagent-config-target-");
    write(join(target, "settings.json"), JSON.stringify({
      mcpServers: { outside: { command: "outside-secret-command" } },
    }));
    symlinkSync(target, join(home, ".claude"));

    const result = await scanConfiguration({ home, dataDir });
    const settings = result.snapshot.entries.find((item) =>
      item.product === "claude-code" && item.source === "settings",
    );
    expect(settings).toMatchObject({
      state: "unavailable",
      metadata: { reason: "intermediate_symlink" },
    });
    expect(JSON.stringify(result)).not.toContain("outside");
    expect(JSON.stringify(result)).not.toContain("outside-secret-command");
  });

  test("uses the TOML parser and retains only top-level typed mcp_servers keys", async (): Promise<void> => {
    const home = temporaryDirectory("hyperagent-config-home-");
    const dataDir = temporaryDirectory("hyperagent-config-data-");
    write(join(home, ".codex", "config.toml"), `message = """
[mcp_servers.spoof]
"""
[mcp_servers]
untyped = "not-a-registration"
[mcp_servers.real]
command = "private-command"
[mcp_servers.real.env]
TOKEN = "private-token"
`);

    const valid = await scanConfiguration({ home, dataDir });
    const config = valid.snapshot.entries.find((item) =>
      item.product === "codex" && item.source === "config",
    );
    const registrations = valid.snapshot.entries.filter((item) =>
      item.product === "codex" && item.source === "config-mcp",
    );
    expect(config?.metadata).toMatchObject({
      mcpServerNames: ["real"],
      untypedMcpServerCount: 1,
    });
    expect(registrations.map((item) => item.name)).toEqual(["real"]);
    expect(JSON.stringify(valid)).not.toContain("spoof");
    expect(JSON.stringify(valid)).not.toContain("private-token");

    write(join(home, ".codex", "config.toml"), "broken = [");
    const malformed = await scanConfiguration({ home, dataDir });
    expect(malformed.snapshot.entries.find((item) =>
      item.product === "codex" && item.source === "config",
    )).toMatchObject({ state: "malformed", metadata: {} });
  });

  test("observes declared and file-based Codex agents without following config_file, plus current and legacy skills", async (): Promise<void> => {
    const home = temporaryDirectory("hyperagent-config-home-");
    const dataDir = temporaryDirectory("hyperagent-config-data-");
    const hiddenPath = join(temporaryDirectory("hyperagent-config-outside-"), "hidden.toml");
    write(hiddenPath, "[mcp_servers.hidden]\ncommand = 'private'");
    write(join(home, ".codex", "config.toml"), `[agents.researcher]
description = "private"
config_file = "${hiddenPath}"
`);
    write(join(home, ".codex", "agents", "reviewer.toml"), "description = 'private'");
    ensure(join(home, ".agents", "skills", "current-skill"));
    ensure(join(home, ".codex", "skills", "legacy-skill"));

    const result = await scanConfiguration({ home, dataDir });
    expect(result.snapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "config-agents", category: "agent", name: "researcher" }),
      expect.objectContaining({ source: "agents-toml", category: "agent", name: "reviewer" }),
      expect.objectContaining({ source: "skills-current", category: "skill", name: "current-skill" }),
      expect.objectContaining({ source: "skills-legacy", category: "skill", name: "legacy-skill" }),
    ]));
    expect(JSON.stringify(result)).not.toContain(hiddenPath);
    expect(JSON.stringify(result)).not.toContain("hidden");
  });

  test("records stable scans as no change and determines added, removed, and changed safe entries", async (): Promise<void> => {
    const home = temporaryDirectory("hyperagent-config-home-");
    const dataDir = temporaryDirectory("hyperagent-config-data-");
    write(join(home, ".claude", "settings.json"), JSON.stringify({ mcpServers: { first: {} } }));
    ensure(join(home, ".claude", "skills", "old-skill"));

    await scanConfiguration({ home, dataDir, observedAt: new Date("2026-01-01T00:00:00Z") });
    const stable = await scanConfiguration({ home, dataDir, observedAt: new Date("2026-01-02T00:00:00Z") });
    expect(stable.changes).toEqual({ added: [], removed: [], changed: [] });

    write(join(home, ".claude", "settings.json"), JSON.stringify({ mcpServers: { second: {} } }));
    rmSync(join(home, ".claude", "skills", "old-skill"), { recursive: true });
    ensure(join(home, ".claude", "skills", "new-skill"));
    const changed = await scanConfiguration({ home, dataDir, observedAt: new Date("2026-01-03T00:00:00Z") });
    expect(changed.changes.added.map((item) => item.name)).toContain("new-skill");
    expect(changed.changes.added.map((item) => item.name)).toContain("second");
    expect(changed.changes.removed.map((item) => item.name)).toContain("old-skill");
    expect(changed.changes.removed.map((item) => item.name)).toContain("first");
    expect(changed.changes.changed.some((item) => item.source === "settings")).toBe(true);

    const report = readConfigurationReport({ dataDir });
    expect(report.history).toHaveLength(3);
    expect(report.history[0]?.changes).toEqual(changed.changes);

    const store = openConfigurationStore(configurationDatabasePath(dataDir));
    try {
      expect(() => store.db.run("DELETE FROM configuration_snapshots")).toThrow("append-only");
      expect(() => store.db.run("UPDATE configuration_entries SET entry_json = '{}' ")).toThrow("append-only");
    } finally {
      store.close();
    }
  });

  test("isolates scope history so a home-only scan cannot remove a prior repository observation", async (): Promise<void> => {
    const home = temporaryDirectory("hyperagent-config-home-");
    const repo = temporaryDirectory("hyperagent-config-repo-");
    const dataDir = temporaryDirectory("hyperagent-config-data-");
    write(join(repo, "AGENTS.md"), "repository instruction");

    await scanConfiguration({ home, repo, dataDir });
    const homeOnly = await scanConfiguration({ home, dataDir });
    expect(homeOnly.changes.removed.some((item) => item.scopeId.startsWith("repo:"))).toBe(false);
    expect(readConfigurationReport({ dataDir }).latestByScope.length).toBeGreaterThanOrEqual(2);
  });

  test("does not infer collection removals when a previously named child is now a symlink", async (): Promise<void> => {
    const home = temporaryDirectory("hyperagent-config-home-");
    const dataDir = temporaryDirectory("hyperagent-config-data-");
    const target = temporaryDirectory("hyperagent-config-target-");
    const skill = join(home, ".claude", "skills", "old-skill");
    ensure(skill);
    await scanConfiguration({ home, dataDir });
    rmSync(skill, { recursive: true });
    symlinkSync(target, skill);

    const scanned = await scanConfiguration({ home, dataDir });
    expect(scanned.changes.removed.map((item) => item.name)).not.toContain("old-skill");
  });

  test("does not infer mcp registration removals from a name-truncated source", async (): Promise<void> => {
    const home = temporaryDirectory("hyperagent-config-home-");
    const dataDir = temporaryDirectory("hyperagent-config-data-");
    write(join(home, ".claude", "settings.json"), JSON.stringify({ mcpServers: { old: {} } }));
    await scanConfiguration({ home, dataDir });
    const manyServers = Object.fromEntries(Array.from({ length: 129 }, (_value, index) => [`server-${index}`, {}]));
    write(join(home, ".claude", "settings.json"), JSON.stringify({ mcpServers: manyServers }));

    const scanned = await scanConfiguration({ home, dataDir });
    expect(scanned.changes.removed.map((item) => item.name)).not.toContain("old");
  });

  test("reports a missing database without creating a directory or database", (): void => {
    const root = temporaryDirectory("hyperagent-config-report-");
    const dataDir = join(root, "does-not-exist");
    const report = readConfigurationReport({ dataDir });
    expect(report).toEqual({
      schemaVersion: "1.0.0",
      latestSnapshot: null,
      history: [],
      latestByScope: [],
    });
    expect(() => readFileSync(configurationDatabasePath(dataDir))).toThrow();
  });

  test("serializes concurrent snapshots so only one initial scan reports additions", async (): Promise<void> => {
    const home = temporaryDirectory("hyperagent-config-home-");
    const dataDir = temporaryDirectory("hyperagent-config-data-");
    write(join(home, ".claude", "settings.json"), JSON.stringify({ mcpServers: { concurrent: {} } }));
    const scans = await Promise.all([
      scanConfiguration({ home, dataDir }),
      scanConfiguration({ home, dataDir }),
    ]);
    expect(scans.filter((scan) => scan.changes.added.length > 0)).toHaveLength(1);
    expect(scans.filter((scan) => scan.changes.added.length === 0)).toHaveLength(1);
    expect(readConfigurationReport({ dataDir }).history).toHaveLength(2);
  });
});
