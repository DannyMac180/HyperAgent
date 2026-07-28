import { existsSync } from "node:fs";

import { loadContract } from "../gate/contract.ts";
import type { ContractLoadResult } from "../gate/contract.ts";
import { claimHash, openMemoryStore } from "../memory/store.ts";
import type { MemoryRow } from "../memory/store.ts";
import { contractPath } from "../gate/paths.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import { openWorkshopQueue } from "../workshop/queue.ts";
import type { WorkshopProposalRow } from "../workshop/queue.ts";
import type { ProposalType } from "../workshop/types.ts";

export const FORGE_REGISTRY_VERSION = "1";

/**
 * The capability registry is a DERIVED, read-only view (architecture-v2 §6.7,
 * §6.8): it unifies everything the suit currently has installed — workshop
 * proposals that reached `installed`, approved memories, and per-repo contract
 * required checks — into one record shape the decay audit and the Cockpit
 * consume. It is recomputable from the source stores at any time and is never
 * persisted; building it mutates no rows in any source store.
 */

export type CapabilityType = ProposalType | "contract_check";

export type CapabilitySource = "workshop" | "memory_store" | "contract";

export type CapabilityScopeLevel = "global" | "repo" | "agent";

export interface CapabilityScope {
  level: CapabilityScopeLevel;
  /** Repo path for repo scope, vendor/agent name for agent scope, null for global. */
  key: string | null;
}

export interface CapabilityRecord {
  /** Stable, source-prefixed id — unique across the whole registry. */
  id: string;
  type: CapabilityType;
  source: CapabilitySource;
  /** Human-readable one-liner: proposal title, memory claim, or check description. */
  title: string;
  scope: CapabilityScope;
  /** When the capability became active; null when the source records no date. */
  installedAt: string | null;
  /**
   * The normalized friction-cluster signature that motivated this capability.
   * This is the anchor of its falsifiable "still needed?" test; null means the
   * decay audit will report it as unauditable-by-recurrence.
   */
  originSignature: string | null;
  originSessionIds: string[];
  proposalId: string | null;
  memoryId: string | null;
  checkId: string | null;
  /** Repo root the contract check came from; null for non-contract records. */
  repoRoot: string | null;
}

export interface CapabilityRegistry {
  registryVersion: string;
  records: CapabilityRecord[];
  /** Honest notes: skipped sources, invalid contracts, dedup decisions. */
  diagnostics: string[];
}

export interface BuildRegistryOptions {
  dataDir?: string;
  /**
   * Repo roots to inspect for verification contracts. When omitted, candidate
   * repos are derived from the session store's distinct repo values — the
   * observer already knows every repo agents have worked in.
   */
  contractRepos?: string[];
}

export interface BuildRegistryDeps {
  store?: Store;
  queueRows?: WorkshopProposalRow[];
  memoryRows?: MemoryRow[];
  loadContract?: typeof loadContract;
  contractExists?: (repoRoot: string) => boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function proposalScope(row: WorkshopProposalRow): CapabilityScope {
  if (row.repo !== null) {
    return { level: "repo", key: row.repo };
  }
  if (row.agent !== null) {
    return { level: "agent", key: row.agent };
  }
  return { level: "global", key: null };
}

function memoryScope(row: MemoryRow): CapabilityScope {
  if (row.scope === "repo") {
    return { level: "repo", key: row.scope_key };
  }
  if (row.scope === "agent") {
    return { level: "agent", key: row.scope_key };
  }
  return { level: "global", key: null };
}

function proposalRecord(
  row: WorkshopProposalRow,
  memoryId: string | null,
): CapabilityRecord {
  return {
    id: `workshop:${row.id}`,
    type: row.type,
    source: "workshop",
    title: row.title,
    scope: proposalScope(row),
    installedAt: row.installedAt,
    originSignature: row.evidence.clusterSignature,
    originSessionIds: [...row.evidence.sessionIds].sort(),
    proposalId: row.id,
    memoryId,
    checkId: null,
    repoRoot: null,
  };
}

function memoryRecord(row: MemoryRow): CapabilityRecord {
  return {
    id: `memory:${row.id}`,
    type: "memory",
    source: "memory_store",
    title: row.claim,
    scope: memoryScope(row),
    installedAt: row.created_at,
    // Extraction/manual memories carry evidence sessions but no single
    // friction-cluster signature; which of a session's many signals birthed
    // the memory is ambiguous, so no recurrence anchor is claimed.
    originSignature: null,
    originSessionIds: row.evidence
      .map((entry): string => entry.session_id)
      .sort(),
    proposalId: null,
    memoryId: row.id,
    checkId: null,
    repoRoot: null,
  };
}

function contractRecords(
  repoRoot: string,
  result: ContractLoadResult,
  diagnostics: string[],
): CapabilityRecord[] {
  if (result.state === "absent") {
    return [];
  }
  if (result.state === "invalid" || result.contract === null) {
    diagnostics.push(
      `contract at ${repoRoot} is invalid and was skipped: ${result.error ?? "unknown error"}`,
    );
    return [];
  }
  return result.contract.requiredChecks.map(
    (check): CapabilityRecord => ({
      id: `contract:${repoRoot}#${check.id}`,
      type: "contract_check",
      source: "contract",
      title: check.description,
      scope: { level: "repo", key: repoRoot },
      // Contracts record no install timestamp; the decay audit treats the
      // window as unbounded and says so rather than inventing a date.
      installedAt: null,
      originSignature: null,
      originSessionIds: [],
      proposalId: null,
      memoryId: null,
      checkId: check.id,
      repoRoot,
    }),
  );
}

function distinctSessionRepos(store: Store): string[] {
  const repos = new Set<string>();
  for (const session of store.getSessions()) {
    if (session.repo !== null && session.repo.length > 0) {
      repos.add(session.repo);
    }
  }
  return [...repos].sort();
}

/**
 * Builds the unified registry. Dedup rule: a memory row that a workshop
 * memory-proposal installed (matched by claim hash against the proposal body
 * claim) appears once, as the workshop record with `memoryId` linked — never
 * as a second memory_store record.
 */
export function buildCapabilityRegistry(
  rawOptions: BuildRegistryOptions = {},
  rawDeps: BuildRegistryDeps = {},
): CapabilityRegistry {
  if (!isPlainObject(rawOptions)) {
    throw new Error("registry options must be a plain object");
  }
  if (!isPlainObject(rawDeps)) {
    throw new Error("registry deps must be a plain object");
  }
  const options = rawOptions as BuildRegistryOptions;
  const deps = rawDeps as BuildRegistryDeps;
  const diagnostics: string[] = [];
  const records: CapabilityRecord[] = [];

  const queueRows = deps.queueRows ?? readQueueRows(options, diagnostics);
  const memoryRows = deps.memoryRows ?? readMemoryRows(options, diagnostics);
  const load = deps.loadContract ?? loadContract;
  const contractExists = deps.contractExists
    ?? ((repoRoot: string): boolean => existsSync(contractPath(repoRoot)));

  const installed = queueRows
    .filter((row): boolean => row.status === "installed")
    .sort((left, right): number => left.id.localeCompare(right.id));

  const approvedMemories = memoryRows
    .filter((row): boolean => row.status === "approved")
    .sort((left, right): number => left.id.localeCompare(right.id));

  const memoriesByClaimHash = new Map<string, MemoryRow>();
  for (const row of approvedMemories) {
    if (!memoriesByClaimHash.has(row.claim_hash)) {
      memoriesByClaimHash.set(row.claim_hash, row);
    }
  }

  const consumedMemoryIds = new Set<string>();
  for (const row of installed) {
    let memoryId: string | null = null;
    if (row.type === "memory" && row.body.type === "memory") {
      const match = memoriesByClaimHash.get(claimHash(row.body.content));
      if (match !== undefined) {
        memoryId = match.id;
        consumedMemoryIds.add(match.id);
      }
    }
    records.push(proposalRecord(row, memoryId));
  }

  for (const row of approvedMemories) {
    if (consumedMemoryIds.has(row.id)) {
      continue;
    }
    records.push(memoryRecord(row));
  }

  const repos = options.contractRepos !== undefined
    ? [...options.contractRepos].sort()
    : deriveContractRepos(options, deps, diagnostics);
  for (const repoRoot of repos) {
    if (!contractExists(repoRoot)) {
      continue;
    }
    try {
      records.push(...contractRecords(repoRoot, load(repoRoot), diagnostics));
    } catch (error: unknown) {
      diagnostics.push(
        `contract at ${repoRoot} could not be read: ${errorMessage(error)}`,
      );
    }
  }

  return {
    registryVersion: FORGE_REGISTRY_VERSION,
    records,
    diagnostics,
  };
}

function readQueueRows(
  options: BuildRegistryOptions,
  diagnostics: string[],
): WorkshopProposalRow[] {
  try {
    const queue = openWorkshopQueue(
      options.dataDir === undefined ? {} : { dataDir: options.dataDir },
    );
    try {
      return queue.list();
    } finally {
      queue.close();
    }
  } catch (error: unknown) {
    diagnostics.push(`workshop queue unavailable: ${errorMessage(error)}`);
    return [];
  }
}

function readMemoryRows(
  options: BuildRegistryOptions,
  diagnostics: string[],
): MemoryRow[] {
  try {
    const store = openMemoryStore(
      options.dataDir === undefined
        ? {}
        : {
          dbPath: `${options.dataDir}/hyperagent.db`,
          memoryDir: `${options.dataDir}/memory`,
        },
    );
    try {
      return store.listMemories();
    } finally {
      store.close();
    }
  } catch (error: unknown) {
    diagnostics.push(`memory store unavailable: ${errorMessage(error)}`);
    return [];
  }
}

function deriveContractRepos(
  options: BuildRegistryOptions,
  deps: BuildRegistryDeps,
  diagnostics: string[],
): string[] {
  if (deps.store !== undefined) {
    return distinctSessionRepos(deps.store);
  }
  try {
    const store = openStore(
      options.dataDir === undefined
        ? undefined
        : `${options.dataDir}/hyperagent.db`,
    );
    try {
      return distinctSessionRepos(store);
    } finally {
      store.close();
    }
  } catch (error: unknown) {
    diagnostics.push(
      `session store unavailable for contract-repo discovery: ${errorMessage(error)}`,
    );
    return [];
  }
}
