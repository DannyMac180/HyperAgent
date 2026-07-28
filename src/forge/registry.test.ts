import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMemoryStore } from "../memory/store.ts";
import type { MemoryRow } from "../memory/store.ts";
import type { ContractLoadResult } from "../gate/contract.ts";
import type { WorkshopProposalRow } from "../workshop/queue.ts";
import {
  buildCapabilityRegistry,
  FORGE_REGISTRY_VERSION,
} from "./registry.ts";

const tempDirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-registry-"));
  tempDirs.push(dir);
  return dir;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

interface ProposalOverrides {
  id?: string;
  type?: WorkshopProposalRow["type"];
  status?: WorkshopProposalRow["status"];
  repo?: string | null;
  agent?: string | null;
  body?: WorkshopProposalRow["body"];
  clusterSignature?: string;
  installedAt?: string | null;
}

function proposal(overrides: ProposalOverrides = {}): WorkshopProposalRow {
  return {
    id: overrides.id ?? "prop-1",
    type: overrides.type ?? "verification_check",
    durability: "measurement",
    title: "run tests after mutation",
    rationale: "sessions kept skipping tests",
    body: overrides.body ?? {
      type: "verification_check",
      description: "tests must run",
      predicate: { kind: "required_command", pattern: "bun test" },
    },
    evidence: {
      sessionIds: ["s-2", "s-1"],
      eventIds: ["e-1"],
      clusterSignature: overrides.clusterSignature ?? "sig:skip-tests",
    },
    holdout: [],
    contentHash: "a".repeat(64),
    eval: null,
    status: overrides.status ?? "installed",
    repo: overrides.repo ?? null,
    agent: overrides.agent ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    installedAt: overrides.installedAt === undefined
      ? "2026-01-02T00:00:00.000Z"
      : overrides.installedAt,
    receipt: null,
  } as unknown as WorkshopProposalRow;
}

interface MemoryOverrides {
  id?: string;
  claim?: string;
  claim_hash?: string;
  status?: MemoryRow["status"];
  scope?: MemoryRow["scope"];
  scope_key?: string | null;
  source?: MemoryRow["source"];
}

function memoryRow(overrides: MemoryOverrides = {}): MemoryRow {
  return {
    id: overrides.id ?? "mem-1",
    claim: overrides.claim ?? "the deploy script needs FOO=1",
    kind: "gotcha",
    scope: overrides.scope ?? "global",
    scope_key: overrides.scope_key ?? null,
    confidence: 0.9,
    status: overrides.status ?? "approved",
    evidence: [{ session_id: "s-9", raw_ref: null }],
    source: overrides.source ?? "extraction",
    claim_hash: overrides.claim_hash ?? "b".repeat(64),
    created_at: "2026-01-03T00:00:00.000Z",
    updated_at: "2026-01-03T00:00:00.000Z",
    last_validated_at: null,
  };
}

function loadedContract(checkIds: string[]): ContractLoadResult {
  return {
    state: "loaded",
    contract: {
      schema_version: "0.1.0",
      requiredChecks: checkIds.map((id): {
        id: string;
        description: string;
        commandPattern: string;
      } => ({
        id,
        description: `check ${id}`,
        commandPattern: "bun test",
      })),
      protectedPaths: [],
    },
    path: "contract.json",
  };
}

describe("buildCapabilityRegistry", (): void => {
  test("unifies workshop, memory store, and contract sources", (): void => {
    const registry = buildCapabilityRegistry(
      { contractRepos: ["repo-a"] },
      {
        queueRows: [proposal()],
        memoryRows: [memoryRow()],
        contractExists: (): boolean => true,
        loadContract: (): ContractLoadResult => loadedContract(["unit-tests"]),
      },
    );
    expect(registry.registryVersion).toBe(FORGE_REGISTRY_VERSION);
    const ids = registry.records.map((record): string => record.id);
    expect(ids).toEqual([
      "workshop:prop-1",
      "memory:mem-1",
      "contract:repo-a#unit-tests",
    ]);
    const workshop = registry.records[0]!;
    expect(workshop.originSignature).toBe("sig:skip-tests");
    expect(workshop.originSessionIds).toEqual(["s-1", "s-2"]);
    const contract = registry.records[2]!;
    expect(contract.checkId).toBe("unit-tests");
    expect(contract.scope).toEqual({ level: "repo", key: "repo-a" });
    expect(contract.installedAt).toBeNull();
  });

  test("memory installed via workshop proposal appears once, linked", (): void => {
    const claim = "always export FOO before deploying";
    const store = openMemoryStore({ dbPath: ":memory:" });
    let hash: string;
    try {
      const added = store.addManual({
        claim,
        kind: "gotcha",
        scope: "global",
        confidence: 0.9,
        evidence: [{ session_id: "s-1", raw_ref: null }],
        source: "manual",
      });
      hash = added.claim_hash;
      expect(added.status).toBe("approved");
    } finally {
      store.close();
    }
    const registry = buildCapabilityRegistry(
      { contractRepos: [] },
      {
        queueRows: [
          proposal({
            id: "prop-mem",
            type: "memory",
            body: { type: "memory", content: claim },
          }),
        ],
        memoryRows: [
          memoryRow({ id: "mem-linked", claim, claim_hash: hash }),
        ],
      },
    );
    expect(registry.records).toHaveLength(1);
    expect(registry.records[0]!.id).toBe("workshop:prop-mem");
    expect(registry.records[0]!.memoryId).toBe("mem-linked");
  });

  test("excludes non-installed proposals and non-approved memories", (): void => {
    const registry = buildCapabilityRegistry(
      { contractRepos: [] },
      {
        queueRows: [
          proposal({ id: "p-pending", status: "pending" }),
          proposal({ id: "p-rejected", status: "rejected" }),
        ],
        memoryRows: [
          memoryRow({ id: "m-candidate", status: "candidate" }),
          memoryRow({ id: "m-retired", status: "retired" }),
        ],
      },
    );
    expect(registry.records).toHaveLength(0);
  });

  test("invalid contract becomes a diagnostic, not a throw", (): void => {
    const registry = buildCapabilityRegistry(
      { contractRepos: ["repo-bad"] },
      {
        queueRows: [],
        memoryRows: [],
        contractExists: (): boolean => true,
        loadContract: (): ContractLoadResult => ({
          state: "invalid",
          contract: null,
          path: "contract.json",
          error: "CONTRACT_PARSE_ERROR: not json",
        }),
      },
    );
    expect(registry.records).toHaveLength(0);
    expect(registry.diagnostics.join(" ")).toContain("repo-bad");
  });

  test("does not mutate the memory store it reads", (): void => {
    const dataDir = tempDataDir();
    const dbPath = join(dataDir, "hyperagent.db");
    const memoryDir = join(dataDir, "memory");
    const seed = openMemoryStore({ dbPath, memoryDir });
    let seededUpdatedAt: string;
    try {
      const added = seed.addManual({
        claim: "the linter config lives at lint.toml",
        kind: "factual",
        scope: "global",
        confidence: 1,
        evidence: [{ session_id: "s-1", raw_ref: null }],
        source: "manual",
      });
      expect(added.status).toBe("approved");
      seededUpdatedAt = added.updated_at;
    } finally {
      seed.close();
    }

    const registry = buildCapabilityRegistry({
      dataDir,
      contractRepos: [],
    });
    expect(registry.records).toHaveLength(1);
    expect(registry.records[0]!.source).toBe("memory_store");

    const verify = openMemoryStore({ dbPath, memoryDir });
    try {
      const rows = verify.listMemories();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("approved");
      expect(rows[0]!.updated_at).toBe(seededUpdatedAt);
    } finally {
      verify.close();
    }
  });

  test("rejects non-plain-object options and deps", (): void => {
    expect((): void => {
      buildCapabilityRegistry(
        [] as unknown as Record<string, never>,
      );
    }).toThrow("plain object");
    expect((): void => {
      buildCapabilityRegistry(
        {},
        [] as unknown as Record<string, never>,
      );
    }).toThrow("plain object");
  });
});
