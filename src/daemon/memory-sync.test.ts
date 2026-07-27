import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMemoryStore } from "../memory/store.ts";
import { syncMemoryTargets } from "./memory-sync.ts";

describe("Claude memory target sync", (): void => {
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

      expect(results).toHaveLength(2);
      expect(results.some((result) => result.changed)).toBe(true);
      expect(
        results.some((result) =>
          result.reason?.includes("cannot be canonicalized")
        ),
      ).toBe(true);
      expect(existsSync(join(validRepo, "CLAUDE.local.md"))).toBe(true);
    } finally {
      memoryStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
