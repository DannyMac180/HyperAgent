import { measureInstalled as defaultMeasureInstalled } from "../workshop/measure.ts";
import type { CapabilityMeasurement } from "../workshop/measure.ts";
import type { WorkshopProposalRow, WorkshopQueue } from "../workshop/queue.ts";
import type { Store } from "../store/store.ts";

export const META_REVIEW_VERSION = "1";

/**
 * The meta-review is a DERIVED, read-only self-audit of the Workshop
 * (architecture-v2 §6.8): it reports how many proposals the Workshop has
 * produced, how they were decided, how much real evidence their replay evals
 * carried, how narrowly scoped they were, and how the installed ones actually
 * measured. It mutates nothing and is recomputable from the queue and store at
 * any time.
 *
 * Honesty invariant: every ratio in the output is `null` when its denominator
 * is zero. `NaN`, `Infinity`, and `-Infinity` must never appear in the returned
 * object — a missing measurement reads as missing, never as a number.
 */

/**
 * Only `list` is required. Acceptance is computed from each proposal's CURRENT
 * status, which `list` already returns, so the transition log is not read.
 * A full `WorkshopQueue` satisfies this type.
 */
export type MetaReviewQueue = Pick<WorkshopQueue, "list">;

export interface MetaReviewDeps {
  measureInstalled?: typeof defaultMeasureInstalled;
  now?: () => Date;
}

export interface MetaReviewProposals {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
}

export interface MetaReviewAcceptance {
  decided: number;
  approved: number;
  rejected: number;
  acceptanceRate: number | null;
  installRate: number | null;
}

export interface MetaReviewEvalQuality {
  proposalsWithEval: number;
  meanPositivesCaughtRatio: number | null;
  totalFalseFlags: number;
  withNegativeControls: number;
  negativeControlShare: number | null;
  withHoldout: number;
  evalErrorCount: number;
}

export interface MetaReviewScopeDistribution {
  global: number;
  repo: number;
  agent: number;
}

export interface MetaReviewSpecificity {
  scopeDistribution: MetaReviewScopeDistribution;
  distinctClusters: number;
  proposalsPerCluster: number | null;
}

export interface MetaReviewMeasurement {
  measured: number;
  byStatus: Record<string, number>;
}

export interface WorkshopMetaReview {
  metaReviewVersion: string;
  generatedAt: string;
  proposals: MetaReviewProposals;
  acceptance: MetaReviewAcceptance;
  evalQuality: MetaReviewEvalQuality;
  specificity: MetaReviewSpecificity;
  measurement: MetaReviewMeasurement;
  diagnostics: string[];
}

interface ResolvedDeps {
  measure: typeof defaultMeasureInstalled;
  now: () => Date;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * The single division site in this module. Returning `null` rather than a
 * non-finite number is what keeps NaN and Infinity out of the report.
 */
function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) {
    return null;
  }
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

/** Counts keyed in sorted order so serialized output is byte-stable. */
function sortedCounts(counts: Map<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) {
    const count = counts.get(key);
    if (count !== undefined) {
      result[key] = count;
    }
  }
  return result;
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function validateDeps(deps: MetaReviewDeps | undefined): ResolvedDeps {
  if (deps === undefined) {
    return { measure: defaultMeasureInstalled, now: (): Date => new Date() };
  }
  const candidate: unknown = deps;
  if (!isPlainObject(candidate)) {
    throw new Error("meta review deps must be a plain object");
  }
  const measure = candidate.measureInstalled;
  if (measure !== undefined && typeof measure !== "function") {
    throw new Error("meta review deps measureInstalled must be a function");
  }
  const now = candidate.now;
  if (now !== undefined && typeof now !== "function") {
    throw new Error("meta review deps now must be a function");
  }
  return {
    measure: (measure ?? defaultMeasureInstalled) as
      typeof defaultMeasureInstalled,
    now: (now ?? ((): Date => new Date())) as () => Date,
  };
}

function generatedAt(deps: ResolvedDeps): string {
  const date = deps.now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error("meta review now() must return a valid Date");
  }
  return date.toISOString();
}

function scopeOf(row: WorkshopProposalRow): keyof MetaReviewScopeDistribution {
  if (row.agent !== null) {
    return "agent";
  }
  return row.repo !== null ? "repo" : "global";
}

function summarizeProposals(rows: WorkshopProposalRow[]): MetaReviewProposals {
  const byStatus = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const row of rows) {
    increment(byStatus, row.status);
    increment(byType, row.type);
  }
  return {
    total: rows.length,
    byStatus: sortedCounts(byStatus),
    byType: sortedCounts(byType),
  };
}

/** `installed` counts as approved — it cleared the approval gate to get there. */
function summarizeAcceptance(
  rows: WorkshopProposalRow[],
): MetaReviewAcceptance {
  let approved = 0;
  let rejected = 0;
  let installed = 0;
  for (const row of rows) {
    if (row.status === "installed") {
      approved += 1;
      installed += 1;
    } else if (row.status === "approved") {
      approved += 1;
    } else if (row.status === "rejected") {
      rejected += 1;
    }
  }
  return {
    decided: approved + rejected,
    approved,
    rejected,
    acceptanceRate: ratio(approved, approved + rejected),
    installRate: ratio(installed, approved),
  };
}

function summarizeEvalQuality(
  rows: WorkshopProposalRow[],
): MetaReviewEvalQuality {
  let proposalsWithEval = 0;
  let totalFalseFlags = 0;
  let withNegativeControls = 0;
  let withHoldout = 0;
  let evalErrorCount = 0;
  let ratioSum = 0;
  let ratioCount = 0;
  for (const row of rows) {
    if (row.holdout.length > 0) {
      withHoldout += 1;
    }
    const replay = row.eval;
    if (replay === null) {
      continue;
    }
    proposalsWithEval += 1;
    totalFalseFlags += replay.falseFlags;
    evalErrorCount += replay.errors;
    if (replay.negativeControlsTotal > 0) {
      withNegativeControls += 1;
    }
    // A zero positivesTotal carries no signal about catch rate, so it is
    // excluded from the mean rather than counted as a zero.
    const caught = ratio(replay.positivesCaught, replay.positivesTotal);
    if (caught !== null) {
      ratioSum += caught;
      ratioCount += 1;
    }
  }
  return {
    proposalsWithEval,
    meanPositivesCaughtRatio: ratio(ratioSum, ratioCount),
    totalFalseFlags,
    withNegativeControls,
    negativeControlShare: ratio(withNegativeControls, proposalsWithEval),
    withHoldout,
    evalErrorCount,
  };
}

function summarizeSpecificity(
  rows: WorkshopProposalRow[],
): MetaReviewSpecificity {
  const scopeDistribution: MetaReviewScopeDistribution = {
    global: 0,
    repo: 0,
    agent: 0,
  };
  const clusters = new Set<string>();
  for (const row of rows) {
    scopeDistribution[scopeOf(row)] += 1;
    clusters.add(row.evidence.clusterSignature);
  }
  return {
    scopeDistribution,
    distinctClusters: clusters.size,
    proposalsPerCluster: ratio(rows.length, clusters.size),
  };
}

function summarizeMeasurement(
  store: Store,
  rows: WorkshopProposalRow[],
  deps: ResolvedDeps,
): MetaReviewMeasurement {
  const installed = rows.filter(
    (row: WorkshopProposalRow): boolean => row.status === "installed",
  );
  // Measuring an empty set would scan every session in the store for no rows,
  // so the empty case short-circuits instead of calling through.
  if (installed.length === 0) {
    return { measured: 0, byStatus: {} };
  }
  const measurements = deps.measure(store, installed);
  if (!Array.isArray(measurements)) {
    throw new Error("meta review measureInstalled must return an array");
  }
  const byStatus = new Map<string, number>();
  for (const measurement of measurements) {
    increment(byStatus, (measurement as CapabilityMeasurement).status);
  }
  return { measured: measurements.length, byStatus: sortedCounts(byStatus) };
}

function buildDiagnostics(
  review: Omit<WorkshopMetaReview, "diagnostics">,
): string[] {
  if (review.proposals.total === 0) {
    return ["no workshop proposals recorded"];
  }
  const diagnostics: string[] = [];
  if (review.acceptance.decided === 0) {
    diagnostics.push("no proposals have been approved or rejected");
  }
  if (review.evalQuality.proposalsWithEval === 0) {
    diagnostics.push("no proposals carry a replay eval");
  } else if (review.evalQuality.withNegativeControls === 0) {
    diagnostics.push("no replay eval included a negative control");
  }
  if (review.evalQuality.withHoldout === 0) {
    diagnostics.push("no proposal reserved a holdout");
  }
  if (review.measurement.measured === 0) {
    diagnostics.push("no installed capability could be measured");
  }
  return diagnostics;
}

export function computeMetaReview(
  queue: MetaReviewQueue,
  store: Store,
  deps?: MetaReviewDeps,
): WorkshopMetaReview {
  const resolved = validateDeps(deps);
  const candidate: unknown = queue;
  if (!isPlainObject(candidate) || typeof candidate.list !== "function") {
    throw new Error("meta review queue must expose a list() function");
  }
  const listed = queue.list();
  if (!Array.isArray(listed)) {
    throw new Error("meta review queue list() must return an array");
  }
  // Stable iteration order keeps accumulation — and therefore floating-point
  // sums — identical across runs on the same data.
  const rows = [...listed].sort(
    (left: WorkshopProposalRow, right: WorkshopProposalRow): number =>
      left.id.localeCompare(right.id),
  );
  const partial: Omit<WorkshopMetaReview, "diagnostics"> = {
    metaReviewVersion: META_REVIEW_VERSION,
    generatedAt: generatedAt(resolved),
    proposals: summarizeProposals(rows),
    acceptance: summarizeAcceptance(rows),
    evalQuality: summarizeEvalQuality(rows),
    specificity: summarizeSpecificity(rows),
    measurement: summarizeMeasurement(store, rows, resolved),
  };
  return { ...partial, diagnostics: buildDiagnostics(partial) };
}
