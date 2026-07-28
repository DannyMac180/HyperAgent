import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
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
import { CodexInjectAdapter } from "./inject.ts";

const REAL_SHAPED_FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "real-shaped-AGENTS.md",
);
const tempDirectories: string[] = [];

function makeTempDir(prefix: string): string {
  const directory: string = mkdtempSync(join(tmpdir(), prefix));
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
  fakeHome: string;
  repo: string;
  target: string;
  adapter: CodexInjectAdapter;
} {
  const root: string = makeTempDir("hyperagent-codex-inject-");
  const fakeHome: string = join(root, "home");
  mkdirSync(fakeHome);
  const repo: string = makeRepo(join(root, "repo"));
  return {
    fakeHome,
    repo,
    target: join(repo, "AGENTS.md"),
    adapter: new CodexInjectAdapter({ homeDir: fakeHome }),
  };
}

function bytesOutsideManagedBlock(content: Buffer): Buffer {
  const beginBytes = Buffer.from(MEMORY_BLOCK_BEGIN);
  const endBytes = Buffer.from(MEMORY_BLOCK_END);
  const begin: number = content.indexOf(beginBytes);
  const endMarkerStart: number = content.indexOf(endBytes);
  if (begin < 0 || endMarkerStart < begin) {
    throw new Error("fixture content must contain one ordered managed block");
  }
  const afterEnd: number = endMarkerStart + endBytes.length;
  return Buffer.concat([
    content.subarray(0, begin),
    content.subarray(afterEnd),
  ]);
}

afterEach((): void => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CodexInjectAdapter", (): void => {
  test("creates a missing AGENTS.md containing only the managed block", async (): Promise<void> => {
    const { adapter, repo, target } = setup();
    const result = await adapter.renderInjection(repo, [memory()]);
    expect(result).toEqual({
      targetPath: join(realpathSync(repo), "AGENTS.md"),
      changed: true,
    });
    expect(readFileSync(target, "utf8")).toBe([
      MEMORY_BLOCK_BEGIN,
      "<!-- managed by hyperagent — edits here are overwritten -->",
      "- claim memory-1",
      MEMORY_BLOCK_END,
    ].join("\n"));
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
  });

  test("adds a block while preserving unrelated CRLF bytes and trailing spaces", async (): Promise<void> => {
    const { adapter, repo, target } = setup();
    const original = Buffer.from(
      "# Existing\r\n\r\nKeep trailing spaces   \r\n",
    );
    writeFileSync(target, original);
    const result = await adapter.renderInjection(repo, [memory()]);
    expect(result.changed).toBe(true);
    const actual: Buffer = readFileSync(target);
    expect(actual.subarray(0, original.length)).toEqual(original);
    expect(actual.includes(Buffer.from(MEMORY_BLOCK_BEGIN))).toBe(true);
  });

  test("replaces only the managed block in a real-shaped AGENTS.md fixture", async (): Promise<void> => {
    const { adapter, repo, target } = setup();
    copyFileSync(REAL_SHAPED_FIXTURE, target);
    const original: Buffer = readFileSync(target);
    const result = await adapter.renderInjection(repo, [
      memory("replacement-memory"),
    ]);
    expect(result.changed).toBe(true);
    const actual: Buffer = readFileSync(target);
    expect(bytesOutsideManagedBlock(actual)).toEqual(
      bytesOutsideManagedBlock(original),
    );
    expect(actual.toString("utf8")).toContain("- claim replacement-memory");
    expect(actual.toString("utf8")).not.toContain("- stale fixture memory");
  });

  test("is byte-idempotent and skips the second write", async (): Promise<void> => {
    const { adapter, repo, target } = setup();
    const first = await adapter.renderInjection(repo, [memory()]);
    const firstBytes: Buffer = readFileSync(target);
    const second = await adapter.renderInjection(repo, [memory()]);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.reason).toContain("byte-identical");
    expect(readFileSync(target).equals(firstBytes)).toBe(true);
  });

  test("rendering zero memories leaves empty markers and foreign bytes", async (): Promise<void> => {
    const { adapter, repo, target } = setup();
    const foreign = "# User instructions\n\nPreserve me.\n";
    writeFileSync(target, foreign);
    await adapter.renderInjection(repo, [memory()]);
    const result = await adapter.renderInjection(repo, []);
    expect(result.changed).toBe(true);
    const actual: string = readFileSync(target, "utf8");
    expect(actual.startsWith(foreign)).toBe(true);
    expect(actual).toContain(MEMORY_BLOCK_BEGIN);
    expect(actual).toContain(MEMORY_BLOCK_END);
    expect(actual).not.toContain("- claim memory-1");
  });

  test("refuses corrupt markers and leaves AGENTS.md byte-identical", async (): Promise<void> => {
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

  test("refuses every protected home target without creating AGENTS.md", async (): Promise<void> => {
    const root: string = makeTempDir("hyperagent-codex-refused-");
    const fakeHome: string = join(root, "home");
    mkdirSync(fakeHome);
    const adapter = new CodexInjectAdapter({ homeDir: fakeHome });

    for (const protectedName of [".claude", ".hyperagent", ".codex"]) {
      const repo: string = makeRepo(
        join(fakeHome, protectedName, "nested", "repo"),
      );
      const target: string = join(repo, "AGENTS.md");
      const result = await adapter.renderInjection(repo, [memory()]);
      expect(result.changed).toBe(false);
      expect(result.reason).toContain("Refused");
      expect(existsSync(target)).toBe(false);
    }
  });

  test("refuses a non-git directory", async (): Promise<void> => {
    const root: string = makeTempDir("hyperagent-codex-no-git-");
    const fakeHome: string = join(root, "home");
    const target: string = join(root, "plain-directory");
    mkdirSync(fakeHome);
    mkdirSync(target);
    const result = await new CodexInjectAdapter({
      homeDir: fakeHome,
    }).renderInjection(target, [memory()]);
    expect(result.changed).toBe(false);
    expect(result.reason).toContain("does not contain a .git");
    expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
  });

  test("surfaces an unreadable target shape with path context", async (): Promise<void> => {
    const { adapter, repo, target } = setup();
    mkdirSync(target);
    const result = await adapter.renderInjection(repo, [memory()]);
    expect(result.changed).toBe(false);
    expect(result.reason).toContain(target);
    expect(result.reason).toContain("Failed to read injection target");
  });
});
