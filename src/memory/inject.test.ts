import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyManagedBlock,
  computeTargetRepos,
  MEMORY_BLOCK_BEGIN,
  MEMORY_BLOCK_END,
  renderMemoryBlockBody,
  selectMemoriesForRepo,
  syncTargets,
  validateTargetRepo,
} from "./inject.ts";
import type { MemoryRow } from "./store.ts";

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

function memory(
  id: string,
  scope: MemoryRow["scope"],
  scopeKey: string | null,
  status: MemoryRow["status"] = "approved",
): MemoryRow {
  return {
    id,
    claim: `claim ${id}`,
    kind: "factual",
    scope,
    scope_key: scopeKey,
    confidence: 1,
    status,
    evidence: [],
    source: "manual",
    claim_hash: `hash-${id}`,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_validated_at: null,
  };
}

function expectRefusal(result: ReturnType<typeof applyManagedBlock>): string {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected managed-block edit to be refused.");
  }
  expect(result.reason.length).toBeGreaterThan(0);
  return result.reason;
}

describe("applyManagedBlock", () => {
  test.each([
    ["without trailing newline", "original"],
    ["with trailing newline", "original\n"],
  ])("appends a block and preserves content %s", (_label, existing) => {
    const result = applyManagedBlock(existing, "- new");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.content.startsWith(existing)).toBe(true);
    expect(result.content).toContain(MEMORY_BLOCK_BEGIN);
    expect(result.content).toContain("- new");
    expect(result.content.endsWith(MEMORY_BLOCK_END)).toBe(true);
  });

  test("renders exactly the managed block for an empty file", () => {
    const result = applyManagedBlock("", "- only");
    expect(result).toEqual({
      ok: true,
      content: [
        MEMORY_BLOCK_BEGIN,
        "<!-- managed by hyperagent — edits here are overwritten -->",
        "- only",
        MEMORY_BLOCK_END,
      ].join("\n"),
    });
  });

  test("replaces a block while preserving every byte outside its markers", () => {
    const prefix = "# prefix\r\n \t\r\n";
    const suffix = "\r\n\t suffix  \r\n";
    const existing = `${prefix}${MEMORY_BLOCK_BEGIN}\r\n- old\r\n${MEMORY_BLOCK_END}${suffix}`;
    const result = applyManagedBlock(existing, "- replacement");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.content.slice(0, prefix.length)).toBe(prefix);
    expect(result.content.slice(-suffix.length)).toBe(suffix);
  });

  test("refuses begin without end", () => {
    expect(expectRefusal(applyManagedBlock(MEMORY_BLOCK_BEGIN, "x"))).toContain(
      "no matching end",
    );
  });

  test("refuses end without begin", () => {
    expect(expectRefusal(applyManagedBlock(MEMORY_BLOCK_END, "x"))).toContain(
      "before any begin",
    );
  });

  test("refuses end before begin", () => {
    const content = `${MEMORY_BLOCK_END}\n${MEMORY_BLOCK_BEGIN}`;
    expect(expectRefusal(applyManagedBlock(content, "x"))).toContain(
      "before begin",
    );
  });

  test("refuses duplicate begin markers", () => {
    const content = [
      MEMORY_BLOCK_BEGIN,
      MEMORY_BLOCK_END,
      MEMORY_BLOCK_BEGIN,
    ].join("\n");
    expect(expectRefusal(applyManagedBlock(content, "x"))).toContain(
      "duplicate begin",
    );
  });

  test("refuses duplicate end markers", () => {
    const content = [
      MEMORY_BLOCK_BEGIN,
      MEMORY_BLOCK_END,
      MEMORY_BLOCK_END,
    ].join("\n");
    expect(expectRefusal(applyManagedBlock(content, "x"))).toContain(
      "duplicate end",
    );
  });

  test("refuses a nested begin marker", () => {
    const content = [
      MEMORY_BLOCK_BEGIN,
      MEMORY_BLOCK_BEGIN,
      MEMORY_BLOCK_END,
    ].join("\n");
    expect(expectRefusal(applyManagedBlock(content, "x"))).toContain(
      "nested begin",
    );
  });

  test("matches markers only when they occupy a full line", () => {
    const inline = `text ${MEMORY_BLOCK_BEGIN} more`;
    const result = applyManagedBlock(inline, "- new");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.content.startsWith(inline)).toBe(true);
    expect(result.content.match(/<!-- hyperagent:memory:begin -->/gu)?.length)
      .toBe(2);
  });

  test("preserves pseudo-random surrounding bytes and is idempotent", () => {
    let state = 0x5eed1234;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    const fragments = [
      "plain",
      "\n",
      "\r\n",
      "\n\n",
      "  ",
      "\t",
      "# markdown",
      "- bullet",
      "unicode: café 雪 🚀",
      "trailing   ",
      `inline ${MEMORY_BLOCK_BEGIN} text`,
      `inline ${MEMORY_BLOCK_END} text`,
    ];
    const generated = (): string => {
      let output = "";
      const count = 1 + (next() % 12);
      for (let index = 0; index < count; index += 1) {
        output += fragments[next() % fragments.length];
      }
      return output;
    };

    for (let iteration = 0; iteration < 50; iteration += 1) {
      const prefix = `${generated()}\n`;
      const suffix = `\n${generated()}`;
      const existing =
        `${prefix}${MEMORY_BLOCK_BEGIN}\n- old\n${MEMORY_BLOCK_END}${suffix}`;
      const first = applyManagedBlock(existing, "- deterministic");
      expect(first.ok).toBe(true);
      if (!first.ok) {
        throw new Error(first.reason);
      }
      expect(first.content.slice(0, prefix.length)).toBe(prefix);
      expect(first.content.slice(-suffix.length)).toBe(suffix);

      const second = applyManagedBlock(first.content, "- deterministic");
      expect(second).toEqual(first);
    }
  });
});

test("empty memories render an empty managed block rather than deleting it", () => {
  const result = applyManagedBlock("", renderMemoryBlockBody([]));
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  expect(result.content).toContain(MEMORY_BLOCK_BEGIN);
  expect(result.content).toContain(
    "<!-- managed by hyperagent — edits here are overwritten -->",
  );
  expect(result.content).toContain(MEMORY_BLOCK_END);
  expect(result.content.split("\n").some((line) => line.startsWith("- ")))
    .toBe(false);
});

describe("memory selection and target computation", () => {
  test("selects approved global, matching repo, and matching agent memories in deterministic order", () => {
    const all = [
      memory("z-repo", "repo", "/repo-a"),
      memory("b-global", "global", null),
      memory("a-agent", "agent", "claude-code"),
      memory("a-global", "global", null),
      memory("a-repo", "repo", "/repo-a"),
      memory("other-repo", "repo", "/repo-b"),
      memory("other-agent", "agent", "codex"),
      memory("rejected", "global", null, "rejected"),
    ];

    expect(selectMemoriesForRepo(all, "/repo-a", "claude-code").map(
      ({ scope, id }) => [scope, id],
    )).toEqual([
      ["agent", "a-agent"],
      ["global", "a-global"],
      ["global", "b-global"],
      ["repo", "a-repo"],
      ["repo", "z-repo"],
    ]);
  });

  test("keeps repo-scoped memories isolated between repositories", () => {
    const all = [
      memory("repo-a-only", "repo", "/repo-a"),
      memory("repo-b-only", "repo", "/repo-b"),
    ];
    expect(selectMemoriesForRepo(all, "/repo-b", "claude-code").map(
      ({ id }) => id,
    )).toEqual(["repo-b-only"]);
  });

  test("global memories create zero targets; approved repos and explicit repo are unioned, deduped, and sorted", () => {
    expect(computeTargetRepos([
      memory("global-only", "global", null),
    ])).toEqual([]);

    const all = [
      memory("b", "repo", "/repo-b"),
      memory("a", "repo", "/repo-a"),
      memory("a-duplicate", "repo", "/repo-a"),
      memory("not-approved", "repo", "/repo-c", "candidate"),
      memory("global", "global", null),
    ];
    expect(computeTargetRepos(all, "/repo-b")).toEqual([
      "/repo-a",
      "/repo-b",
    ]);
    expect(computeTargetRepos(all, "/repo-explicit")).toEqual([
      "/repo-a",
      "/repo-b",
      "/repo-explicit",
    ]);
  });
});

describe("validateTargetRepo", () => {
  test("accepts a directory containing .git", () => {
    const root = makeTempDir("hyperagent-inject-valid-");
    const fakeHome = join(root, "home");
    mkdirSync(fakeHome);
    const repo = makeRepo(join(root, "repo"));
    expect(validateTargetRepo(repo, { homeDir: fakeHome })).toEqual({
      ok: true,
      repoPath: realpathSync(repo),
    });
  });

  test("refuses a nonexistent path", () => {
    const root = makeTempDir("hyperagent-inject-missing-");
    const fakeHome = join(root, "home");
    mkdirSync(fakeHome);
    expect(validateTargetRepo(join(root, "missing"), { homeDir: fakeHome }).ok)
      .toBe(false);
  });

  test("refuses a directory without .git", () => {
    const root = makeTempDir("hyperagent-inject-no-git-");
    const fakeHome = join(root, "home");
    const candidate = join(root, "candidate");
    mkdirSync(fakeHome);
    mkdirSync(candidate);
    expect(validateTargetRepo(candidate, { homeDir: fakeHome }).ok).toBe(false);
  });

  test("refuses a file", () => {
    const root = makeTempDir("hyperagent-inject-file-");
    const fakeHome = join(root, "home");
    const candidate = join(root, "file");
    mkdirSync(fakeHome);
    writeFileSync(candidate, "not a repo");
    const result = validateTargetRepo(candidate, { homeDir: fakeHome });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("not a directory");
    }
  });

  test("refuses a valid repo under fake ~/.claude", () => {
    const root = makeTempDir("hyperagent-inject-claude-");
    const fakeHome = join(root, "home");
    const repo = makeRepo(join(fakeHome, ".claude", "somerepo"));
    const result = validateTargetRepo(repo, { homeDir: fakeHome });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Refused");
      expect(result.reason).toContain("PAI infrastructure");
    }
  });

  test("refuses a valid repo under fake ~/.hyperagent", () => {
    const root = makeTempDir("hyperagent-inject-hyperagent-");
    const fakeHome = join(root, "home");
    const repo = makeRepo(join(fakeHome, ".hyperagent", "somerepo"));
    const result = validateTargetRepo(repo, { homeDir: fakeHome });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Refused");
      expect(result.reason).toContain("HyperAgent data");
    }
  });

  test("does not reject separator-distinct sibling directories", () => {
    const root = makeTempDir("hyperagent-inject-sibling-");
    const fakeHome = join(root, "home");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    const repo = makeRepo(join(fakeHome, ".claude-backup", "repo"));
    expect(validateTargetRepo(repo, { homeDir: fakeHome })).toEqual({
      ok: true,
      repoPath: realpathSync(repo),
    });
  });

  test("canonicalizes a symlink before applying protected-directory guards", () => {
    const root = makeTempDir("hyperagent-inject-symlink-");
    const fakeHome = join(root, "home");
    const protectedRepo = makeRepo(join(fakeHome, ".claude", "somerepo"));
    const link = join(root, "apparently-allowed");
    try {
      symlinkSync(protectedRepo, link, "dir");
    } catch (error: unknown) {
      throw new Error(
        `Symlinks are unavailable; security test could not run: ${String(error)}`,
      );
    }
    const result = validateTargetRepo(link, { homeDir: fakeHome });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Refused");
      expect(result.reason).toContain("PAI infrastructure");
    }
  });
});

test("syncTargets reports a rejected render without aborting the batch", async () => {
  const results = await syncTargets(
    ["repo-a", "repo-fail", "repo-b"],
    async (repo) => {
      if (repo === "repo-fail") {
        throw new Error("expected failure");
      }
      return { targetPath: `${repo}/target`, changed: true };
    },
  );

  expect(results).toHaveLength(3);
  expect(results[0]).toEqual({ targetPath: "repo-a/target", changed: true });
  expect(results[1]?.changed).toBe(false);
  expect(results[1]?.reason).toContain("expected failure");
  expect(results[2]).toEqual({ targetPath: "repo-b/target", changed: true });
});
