import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeTargetRepos } from "../memory/inject.ts";
import { openMemoryStore } from "../memory/store.ts";
import { syncMemoryTargets } from "./memory-sync.ts";

describe("builtin memory target sync", (): void => {
  test("continues fanout after one target is refused", async (): Promise<void> => {
    const directory = mkdtempSync(join(tmpdir(), "hyperagent-memory-sync-"));
    const validRepo = join(directory, "valid-repo");
    const refusedRepo = join(directory, "missing-repo");
    mkdirSync(join(validRepo, ".git"), { recursive: true });
    const memoryStore = openMemoryStore({
      dbPath: join(directory, "memory.db"),
      memoryDir: join(directory, "memory"),
    });
    try {
      const fixtures: Array<[string, string]> = [
        ["Render this memory.", validRepo],
        ["This target will be refused.", refusedRepo],
      ];
      for (const [claim, scopeKey] of fixtures) {
        memoryStore.addManual({
          claim,
          kind: "factual",
          scope: "repo",
          scope_key: scopeKey,
          confidence: 1,
          evidence: [{ session_id: "manual", raw_ref: null }],
        });
      }

      const results = await syncMemoryTargets({ memoryStore });

      expect(results).toHaveLength(4);
      expect(results.filter((result) => result.changed)).toHaveLength(2);
      expect(
        results.filter((result) =>
          result.reason?.includes("cannot be canonicalized")
        ),
      ).toHaveLength(2);
      expect(existsSync(join(validRepo, "CLAUDE.local.md"))).toBe(true);
      expect(existsSync(join(validRepo, "AGENTS.md"))).toBe(true);
    } finally {
      memoryStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retiring a repo's last repo-scoped memory empties its block instead of stranding globals", async (): Promise<void> => {
    const directory = mkdtempSync(join(tmpdir(), "hyperagent-memory-orphan-"));
    const repo = join(directory, "repo-r");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const memoryStore = openMemoryStore({
      dbPath: join(directory, "memory.db"),
      memoryDir: join(directory, "memory"),
    });
    try {
      const globalMemory = memoryStore.addManual({
        claim: "Global lesson that applies everywhere.",
        kind: "factual",
        scope: "global",
        scope_key: null,
        confidence: 1,
        evidence: [{ session_id: "manual", raw_ref: null }],
      });
      const repoMemory = memoryStore.addManual({
        claim: "Repo specific gotcha.",
        kind: "gotcha",
        scope: "repo",
        scope_key: repo,
        confidence: 1,
        evidence: [{ session_id: "manual", raw_ref: null }],
      });

      await syncMemoryTargets({ memoryStore });
      const blockPaths = [
        join(repo, "CLAUDE.local.md"),
        join(repo, "AGENTS.md"),
      ];
      for (const blockPath of blockPaths) {
        const rendered = readFileSync(blockPath, "utf8");
        // Both bullets are present while repo-scoped memory sustains the target.
        expect(rendered).toContain("Repo specific gotcha.");
        expect(rendered).toContain("Global lesson that applies everywhere.");
      }

      // The repro: retire the only repo-scoped memory, which drops the repo
      // out of the target set. Capture the target set BEFORE the mutation.
      const previousTargets = computeTargetRepos(memoryStore.listMemories());
      expect(previousTargets).toContain(repo);
      memoryStore.retire(repoMemory.id);
      expect(computeTargetRepos(memoryStore.listMemories())).not.toContain(repo);

      await syncMemoryTargets({ memoryStore, previousTargets });

      for (const blockPath of blockPaths) {
        const afterRetire = readFileSync(blockPath, "utf8");
        // Each file survives with markers and no stranded memory bullets.
        expect(existsSync(blockPath)).toBe(true);
        expect(afterRetire).toContain("<!-- hyperagent:memory:begin -->");
        expect(afterRetire).toContain("<!-- hyperagent:memory:end -->");
        expect(afterRetire).not.toContain("Repo specific gotcha.");
        expect(afterRetire).not.toContain(
          "Global lesson that applies everywhere.",
        );
        expect(afterRetire).not.toContain("\n- ");
      }

      // The global memory is untouched in the store; only its rendering went.
      expect(memoryStore.getMemory(globalMemory.id)?.status).toBe("approved");
    } finally {
      memoryStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("approving a repo-scoped memory brings global bullets into that repo", async (): Promise<void> => {
    const directory = mkdtempSync(join(tmpdir(), "hyperagent-memory-adopt-"));
    const repo = join(directory, "repo-r");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const memoryStore = openMemoryStore({
      dbPath: join(directory, "memory.db"),
      memoryDir: join(directory, "memory"),
    });
    try {
      memoryStore.addManual({
        claim: "Global lesson that applies everywhere.",
        kind: "factual",
        scope: "global",
        scope_key: null,
        confidence: 1,
        evidence: [{ session_id: "manual", raw_ref: null }],
      });
      const candidate = memoryStore.addCandidate({
        claim: "Newly approved repo rule.",
        kind: "gotcha",
        scope: "repo",
        scope_key: repo,
        confidence: 0.9,
        evidence: [{ session_id: "session-1", raw_ref: null }],
      });

      // A global memory alone creates no target, so nothing renders yet.
      const previousTargets = computeTargetRepos(memoryStore.listMemories());
      expect(previousTargets).not.toContain(repo);
      expect(existsSync(join(repo, "CLAUDE.local.md"))).toBe(false);

      memoryStore.approve(candidate.id);
      await syncMemoryTargets({ memoryStore, previousTargets });

      for (const filename of ["CLAUDE.local.md", "AGENTS.md"]) {
        const rendered = readFileSync(join(repo, filename), "utf8");
        expect(rendered).toContain("Newly approved repo rule.");
        expect(rendered).toContain("Global lesson that applies everywhere.");
      }
    } finally {
      memoryStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
