import { open, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  analyzeFriction,
  type FrictionAnalysis,
} from "./friction";
import {
  proposeForClusters,
  type DraftedProposal,
  type ProposeDeps,
} from "./propose";
import {
  evaluateProposal,
  gateProposal,
  type ReplayEval,
} from "./replay";
import {
  openWorkshopQueue,
  type WorkshopQueue,
} from "./queue";
import type { Store } from "../store/store";

export type WorkshopStage = "cluster" | "propose" | "eval" | "queue";

export interface WorkshopRunOptions {
  dataDir?: string;
  repo?: string;
  /** Stop after this stage. "cluster" is READ-ONLY — see §2.2. */
  until?: WorkshopStage;
  minSessions?: number;
  now?: () => Date;
}

export interface WorkshopRunDeps {
  store: Store;
  queue?: WorkshopQueue;
  propose?: ProposeDeps;
}

export interface WorkshopRunResult {
  runId: string;
  startedAt: string;
  completedAt: string | null;
  status: "completed" | "failed";
  stagesRun: WorkshopStage[];
  analysis: FrictionAnalysis;
  clustersForwarded: number;
  proposalsDrafted: number;
  proposalsRejected: number;
  proposalsPending: number;
  proposalsHeldAtDraft: number;
  error: string | null;
  diagnostics: string[];
}

export interface WorkshopRunGuard {
  acquired: boolean;
  lockPath: string;
  diagnostics: string[];
  release: () => Promise<void>;
}

interface LockContents {
  pid: number;
  startedAt: string;
}

interface LedgerRecord {
  runId: string;
  startedAt: string;
  completedAt: string | null;
  status: "started" | "completed" | "failed";
  stagesRun: WorkshopStage[];
  clustersForwarded: number;
  proposalsDrafted: number;
  proposalsRejected: number;
  proposalsPending: number;
  proposalsHeldAtDraft: number;
  error: string | null;
}

const STAGE_ORDER: readonly WorkshopStage[] = [
  "cluster",
  "propose",
  "eval",
  "queue",
];

/** Locks older than six hours are stale even if their recorded pid still exists. */
export const WORKSHOP_RUN_LOCK_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function emptyAnalysis(): FrictionAnalysis {
  return {
    clusters: [],
    allClusters: [],
    signals: [],
    fragmentation: {
      totalSignals: 0,
      totalSignatures: 0,
      singletonSignatures: 0,
      singleSessionSignatures: 0,
      forwardedClusters: 0,
      distribution: [],
    },
    diagnostics: [],
    excludedSessionIds: [],
    extractorVersion: "unknown",
  };
}

function validateOptions(suppliedOptions: WorkshopRunOptions): void {
  if (!isPlainObject(suppliedOptions)) {
    throw new Error("workshop run options must be an object");
  }
  // isPlainObject narrows its argument to Record<string, unknown>, which would
  // erase the declared property types; read fields through the typed alias.
  const options: WorkshopRunOptions = suppliedOptions;
  const until: WorkshopStage | undefined = options.until;
  if (until !== undefined && !STAGE_ORDER.includes(until)) {
    throw new Error(`invalid workshop stage: ${String(until)}`);
  }
  const minSessions: number | undefined = options.minSessions;
  if (
    minSessions !== undefined
    && (
      typeof minSessions !== "number"
      || !Number.isSafeInteger(minSessions)
      || minSessions < 1
    )
  ) {
    throw new Error("minSessions must be a positive integer");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new Error("now must be a function");
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = errorCode(error);
    return code === "EPERM";
  }
}

async function readLock(lockPath: string): Promise<LockContents | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (
      !isPlainObject(parsed)
      || typeof parsed.pid !== "number"
      || typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

async function lockIsStale(
  lockPath: string,
  now: Date,
  maxAgeMs: number,
): Promise<boolean> {
  const contents = await readLock(lockPath);
  let ageMs: number;
  if (contents === null) {
    const metadata = await stat(lockPath);
    ageMs = now.getTime() - metadata.mtimeMs;
    return ageMs > maxAgeMs;
  }
  ageMs = now.getTime() - Date.parse(contents.startedAt);
  return !processIsAlive(contents.pid)
    || !Number.isFinite(ageMs)
    || ageMs > maxAgeMs;
}

function alreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

export async function acquireWorkshopRunGuard(options: {
  dataDir?: string;
  now?: () => Date;
  maxAgeMs?: number;
} = {}): Promise<WorkshopRunGuard> {
  if (!isPlainObject(options)) {
    throw new Error("workshop run guard options must be an object");
  }
  const dataDir = options.dataDir ?? join(homedir(), ".hyperagent");
  const now = options.now ?? ((): Date => new Date());
  const maxAgeMs = options.maxAgeMs ?? WORKSHOP_RUN_LOCK_MAX_AGE_MS;
  const workshopDir = join(dataDir, "workshop");
  const lockPath = join(workshopDir, "run.lock");
  const diagnostics: string[] = [];
  await mkdir(workshopDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        startedAt: now().toISOString(),
      }));
      await handle.close();
      let released = false;
      return {
        acquired: true,
        lockPath,
        diagnostics,
        release: async (): Promise<void> => {
          if (released) {
            return;
          }
          released = true;
          await unlink(lockPath);
        },
      };
    } catch (error: unknown) {
      if (!alreadyExists(error)) {
        throw error;
      }
      if (attempt === 0 && await lockIsStale(lockPath, now(), maxAgeMs)) {
        await unlink(lockPath);
        diagnostics.push(`reclaimed stale Workshop run lock at ${lockPath}`);
        continue;
      }
      return {
        acquired: false,
        lockPath,
        diagnostics,
        release: async (): Promise<void> => {},
      };
    }
  }

  throw new Error("failed to acquire Workshop run lock");
}

async function appendLedger(
  ledgerPath: string,
  record: LedgerRecord,
): Promise<void> {
  await mkdir(dirname(ledgerPath), { recursive: true });
  const handle = await open(ledgerPath, "a");
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
  } finally {
    await handle.close();
  }
}

function ledgerRecord(
  result: WorkshopRunResult,
  status: LedgerRecord["status"],
): LedgerRecord {
  return {
    runId: result.runId,
    startedAt: result.startedAt,
    completedAt: status === "started" ? null : result.completedAt,
    status,
    stagesRun: [...result.stagesRun],
    clustersForwarded: result.clustersForwarded,
    proposalsDrafted: result.proposalsDrafted,
    proposalsRejected: result.proposalsRejected,
    proposalsPending: result.proposalsPending,
    proposalsHeldAtDraft: result.proposalsHeldAtDraft,
    error: result.error,
  };
}

function stageReached(until: WorkshopStage, stage: WorkshopStage): boolean {
  return STAGE_ORDER.indexOf(until) >= STAGE_ORDER.indexOf(stage);
}

export async function runWorkshop(
  deps: WorkshopRunDeps,
  options: WorkshopRunOptions = {},
): Promise<WorkshopRunResult> {
  validateOptions(options);
  const now = options.now ?? ((): Date => new Date());
  const dataDir = options.dataDir ?? join(homedir(), ".hyperagent");
  const until = options.until ?? "queue";
  const startedAt = now().toISOString();
  const result: WorkshopRunResult = {
    runId: `workshop-${Date.parse(startedAt)}-${process.pid}`,
    startedAt,
    completedAt: null,
    status: "completed",
    stagesRun: [],
    analysis: emptyAnalysis(),
    clustersForwarded: 0,
    proposalsDrafted: 0,
    proposalsRejected: 0,
    proposalsPending: 0,
    proposalsHeldAtDraft: 0,
    error: null,
    diagnostics: [],
  };
  const ledgerPath = join(dataDir, "workshop", "runs.jsonl");
  let guard: WorkshopRunGuard | null = null;
  let ownedQueue: WorkshopQueue | null = null;

  try {
    guard = await acquireWorkshopRunGuard({ dataDir, now });
    result.diagnostics.push(...guard.diagnostics);
    try {
      await appendLedger(ledgerPath, ledgerRecord(result, "started"));
    } catch (error: unknown) {
      result.diagnostics.push(
        `failed to write Workshop run ledger start: ${errorMessage(error)}`,
      );
    }

    if (!guard.acquired) {
      throw new Error("Workshop is already running");
    }

    result.stagesRun.push("cluster");
    result.analysis = analyzeFriction(deps.store, {
      dataDir,
      repo: options.repo,
      minSessions: options.minSessions,
    });
    result.diagnostics.push(...result.analysis.diagnostics);
    result.clustersForwarded = result.analysis.clusters.length;

    // This early return makes cluster-only runs structurally read-only: no
    // proposer is invoked and no queue is opened or written.
    if (until === "cluster") {
      return result;
    }

    if (deps.propose === undefined) {
      throw new Error("propose dependencies are required after the cluster stage");
    }
    result.stagesRun.push("propose");
    const proposed = await proposeForClusters(
      result.analysis.clusters,
      deps.propose,
    );
    result.proposalsDrafted = proposed.proposals.length;
    result.proposalsRejected = proposed.rejected.length;
    result.diagnostics.push(...proposed.diagnostics);
    if (until === "propose") {
      return result;
    }

    result.stagesRun.push("eval");
    const evaluations = new Map<DraftedProposal, ReplayEval>();
    const pending = new Set<DraftedProposal>();
    for (const proposal of proposed.proposals) {
      const evaluation = evaluateProposal(deps.store, proposal, {
        dataDir,
        repoRoot: options.repo,
      });
      evaluations.set(proposal, evaluation);
      result.diagnostics.push(...evaluation.diagnostics);
      if (gateProposal(evaluation).status === "pending") {
        pending.add(proposal);
      } else {
        result.proposalsHeldAtDraft += 1;
      }
    }
    if (until === "eval") {
      return result;
    }

    result.stagesRun.push("queue");
    const queue = deps.queue ?? openWorkshopQueue({
      dataDir,
      dbPath: join(dataDir, "workshop", "queue.db"),
    });
    if (deps.queue === undefined) {
      ownedQueue = queue;
    }
    const evalsByTitle = new Map<string, ReplayEval>(
      proposed.proposals.flatMap((proposal): Array<[string, ReplayEval]> => {
        const evaluation = evaluations.get(proposal);
        return evaluation === undefined ? [] : [[proposal.title, evaluation]];
      }),
    );
    queue.db.transaction((): void => {
      const rows = queue.addDrafts(proposed.proposals, evalsByTitle);
      for (let index = 0; index < rows.length; index += 1) {
        if (pending.has(proposed.proposals[index]!)) {
          queue.promoteToPending(rows[index]!.id, "Workshop replay evaluation passed");
          result.proposalsPending += 1;
        }
      }
    })();

    // Deliberate safety boundary: this orchestrator never constructs or imports
    // a HumanApproval token, so it cannot reach approved or installed.
    return result;
  } catch (error: unknown) {
    result.status = "failed";
    result.error = errorMessage(error);
    return result;
  } finally {
    result.completedAt = now().toISOString();
    if (ownedQueue !== null) {
      try {
        ownedQueue.close();
      } catch (error: unknown) {
        result.diagnostics.push(`failed to close Workshop queue: ${errorMessage(error)}`);
      }
    }
    try {
      await appendLedger(
        ledgerPath,
        ledgerRecord(result, result.status),
      );
    } catch (error: unknown) {
      result.diagnostics.push(
        `failed to write Workshop run ledger terminal record: ${errorMessage(error)}`,
      );
    }
    if (guard?.acquired) {
      try {
        await guard.release();
      } catch (error: unknown) {
        result.diagnostics.push(
          `failed to release Workshop run lock: ${errorMessage(error)}`,
        );
      }
    }
  }
}
