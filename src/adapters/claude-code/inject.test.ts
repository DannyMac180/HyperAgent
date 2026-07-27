import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MEMORY_BLOCK_BEGIN,
  MEMORY_BLOCK_END,
} from "../../memory/inject.ts";
import type { MemoryRow } from "../../memory/store.ts";
import { ClaudeCodeInjectAdapter } from "./inject.ts";

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

function memory(id = "memory-1"): MemoryRow {
  return {
    id,
    claim: `claim ${id}`,
    kind: "factual",
    scope: "repo",
    scope_key: null,
    confidence: 1,
    status: "approved",
    evidence: [],
    source: "manual",
    claim_hash: `hash-${id}`,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_validated_at: null,
  };
}

function setup(): {
  root: string;
  fakeHome: string;
  repo: string;
  target: string;
  adapter: ClaudeCodeInjectAdapter;
} {
  const root = makeTempDir("hyperagent-claude-inject-");
  const fakeHome = join(root, "home");
  mkdirSync(fakeHome);
  const repo = makeRepo(join(root, "repo"));
  return {
    root,
    fakeHome,
    repo,
    target: join(repo, "CLAUDE.local.md"),
    adapter: new ClaudeCodeInjectAdapter({ homeDir: fakeHome }),
  };
}

describe("ClaudeCodeInjectAdapter", () => {
  test("creates a missing CLAUDE.local.md containing only the managed block", async () => {
    const { adapter, repo, target } = setup();
    const result = await adapter.renderInjection(repo, [memory()]);
    expect(result).toEqual({
      targetPath: join(realpathSync(repo), "CLAUDE.local.md"),
      changed: true,
    });
    expect(readFileSync(target, "utf8")).toBe([
      MEMORY_BLOCK_BEGIN,
      "<!-- managed by hyperagent — edits here are overwritten -->",
      "- claim memory-1",
      MEMORY_BLOCK_END,
    ].join("\n"));
  });

  test("adds a managed block without changing unrelated existing bytes", async () => {
    const { adapter, repo, target } = setup();
    const original = "# Existing\r\n\r\nKeep trailing spaces   \r\n";
    writeFileSync(target, original);
    const result = await adapter.renderInjection(repo, [memory()]);
    expect(result.changed).toBe(true);
    const actual = readFileSync(target, "utf8");
    expect(actual.startsWith(original)).toBe(true);
    expect(actual).toContain(MEMORY_BLOCK_BEGIN);
  });

  test("is byte-idempotent and skips the second write", async () => {
    const { adapter, repo, target } = setup();
    const first = await adapter.renderInjection(repo, [memory()]);
    const firstBytes = readFileSync(target);
    const second = await adapter.renderInjection(repo, [memory()]);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.reason).toContain("byte-identical");
    expect(readFileSync(target)).toEqual(firstBytes);
  });

  test("retiring to zero memories leaves empty markers and keeps the file", async () => {
    const { adapter, repo, target } = setup();
    await adapter.renderInjection(repo, [memory()]);
    const result = await adapter.renderInjection(repo, []);
    expect(result.changed).toBe(true);
    expect(existsSync(target)).toBe(true);
    const actual = readFileSync(target, "utf8");
    expect(actual).toContain(MEMORY_BLOCK_BEGIN);
    expect(actual).toContain(MEMORY_BLOCK_END);
    expect(actual).not.toContain("- claim memory-1");
    expect(actual.split("\n").some((line) => line.startsWith("- "))).toBe(
      false,
    );
  });

  test("returns failure for corrupted markers and leaves the file byte-identical", async () => {
    const { adapter, repo, target } = setup();
    const corrupted = Buffer.from(
      `prefix\r\n${MEMORY_BLOCK_BEGIN}\r\n- unterminated\r\n`,
    );
    writeFileSync(target, corrupted);
    const result = await adapter.renderInjection(repo, [memory()]);
    expect(result.changed).toBe(false);
    expect(result.reason).toContain("no matching end");
    expect(readFileSync(target)).toEqual(corrupted);
  });

  test("refuses a target under fake ~/.claude without creating a file", async () => {
    const root = makeTempDir("hyperagent-claude-inject-refused-");
    const fakeHome = join(root, "home");
    const repo = makeRepo(join(fakeHome, ".claude", "somerepo"));
    const target = join(repo, "CLAUDE.local.md");
    const adapter = new ClaudeCodeInjectAdapter({ homeDir: fakeHome });
    const result = await adapter.renderInjection(repo, [memory()]);
    expect(result.changed).toBe(false);
    expect(result.reason).toContain("Refused");
    expect(existsSync(target)).toBe(false);
  });
});
