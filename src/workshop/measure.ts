import { scoreSession } from "../scoring/score.ts";
import type { SessionScore } from "../scoring/score.ts";
import type {
  SessionFilter,
  SessionRow,
  Store,
} from "../store/store.ts";
import type { WorkshopProposalRow } from "./queue.ts";

export const MEASUREMENT_VERSION = "1";
export const DEFAULT_MIN_SESSIONS_PER_SIDE = 5;

/**
 * Mean scores must move by more than one percentage point before the change is
 * considered meaningful. DAN-208 consumes no_movement as its retirement signal.
 */
export const MEAN_SCORE_EPSILON = 0.01;

export type MeasurementStatus =
  | "improved"
  | "regressed"
  | "no_movement"
  | "insufficient_data";

export interface CapabilityMeasurement {
  proposalId: string;
  installedAt: string;
  scope: { repo: string | null; agent: string | null };
  before: { sessionCount: number; meanScore: number | null };
  after: { sessionCount: number; meanScore: number | null };
  delta: number | null;
  status: MeasurementStatus;
  /** Why this status — always populated, especially for insufficient_data. */
  reason: string;
  measurementVersion: string;
}

export interface MeasureOptions {
  minSessionsPerSide?: number;
  dataDir?: string;
}

interface PartitionedScores {
  before: number[];
  after: number[];
  skipped: number;
  skippedErrors: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function validateOptions(options: MeasureOptions | undefined): number {
  if (options === undefined) {
    return DEFAULT_MIN_SESSIONS_PER_SIDE;
  }
  const candidate: unknown = options;
  if (!isPlainObject(candidate)) {
    throw new Error("measure options must be a plain object");
  }
  const dataDir = candidate.dataDir;
  if (
    dataDir !== undefined
    && (typeof dataDir !== "string" || dataDir.length === 0)
  ) {
    throw new Error("measure options dataDir must be a non-empty string");
  }
  const minimum = candidate.minSessionsPerSide
    ?? DEFAULT_MIN_SESSIONS_PER_SIDE;
  if (
    typeof minimum !== "number"
    || !Number.isSafeInteger(minimum)
    || minimum < 1
  ) {
    throw new Error("minSessionsPerSide must be a positive safe integer");
  }
  return minimum;
}

function emptyMeasurement(
  row: WorkshopProposalRow,
  installedAt: string,
  reason: string,
): CapabilityMeasurement {
  return {
    proposalId: row.id,
    installedAt,
    scope: { repo: row.repo, agent: row.agent },
    before: { sessionCount: 0, meanScore: null },
    after: { sessionCount: 0, meanScore: null },
    delta: null,
    status: "insufficient_data",
    reason,
    measurementVersion: MEASUREMENT_VERSION,
  };
}

function sessionFilter(row: WorkshopProposalRow): SessionFilter {
  return row.repo === null ? {} : { repo: row.repo };
}

function inScope(session: SessionRow, row: WorkshopProposalRow): boolean {
  return row.agent === null || session.agent === row.agent;
}

function scoreValue(score: SessionScore): number | null {
  const value = score.verification_pass_rate;
  return value !== null && Number.isFinite(value) ? value : null;
}

function partitionScores(
  store: Store,
  row: WorkshopProposalRow,
  installedMilliseconds: number,
): PartitionedScores {
  const sessions = store
    .getSessions(sessionFilter(row))
    .filter((session: SessionRow): boolean => inScope(session, row))
    .sort((left: SessionRow, right: SessionRow): number =>
      left.session_id.localeCompare(right.session_id)
    );
  const partitioned: PartitionedScores = {
    before: [],
    after: [],
    skipped: 0,
    skippedErrors: [],
  };

  for (const session of sessions) {
    const startedMilliseconds = Date.parse(session.started_at);
    if (Number.isNaN(startedMilliseconds)) {
      partitioned.skipped += 1;
      partitioned.skippedErrors.push(
        `session ${session.session_id} has an invalid start timestamp`,
      );
      continue;
    }

    let value: number | null;
    try {
      value = scoreValue(scoreSession(store, session.session_id));
    } catch (error: unknown) {
      partitioned.skipped += 1;
      partitioned.skippedErrors.push(errorMessage(error));
      continue;
    }
    if (value === null) {
      partitioned.skipped += 1;
      continue;
    }

    if (startedMilliseconds < installedMilliseconds) {
      partitioned.before.push(value);
    } else {
      partitioned.after.push(value);
    }
  }
  return partitioned;
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce(
    (total: number, value: number): number => total + value,
    0,
  ) / values.length;
}

function skippedSuffix(skipped: number, skippedErrors: string[]): string {
  if (skipped === 0) {
    return "";
  }
  const errorDetail = skippedErrors[0];
  return `; skipped ${skipped} unscoreable or malformed session${skipped === 1 ? "" : "s"}${errorDetail === undefined ? "" : ` (first error: ${errorDetail})`}`;
}

function shortageReason(
  beforeCount: number,
  afterCount: number,
  minimum: number,
  skipped: number,
  skippedErrors: string[],
): string {
  const shortages: string[] = [];
  if (beforeCount < minimum) {
    shortages.push(
      `before side is short by ${minimum - beforeCount} session${minimum - beforeCount === 1 ? "" : "s"} (${beforeCount}/${minimum})`,
    );
  }
  if (afterCount < minimum) {
    shortages.push(
      `after side is short by ${minimum - afterCount} session${minimum - afterCount === 1 ? "" : "s"} (${afterCount}/${minimum})`,
    );
  }
  return `Insufficient data: ${shortages.join("; ")}${skippedSuffix(skipped, skippedErrors)}.`;
}

function movement(
  delta: number,
): { status: Exclude<MeasurementStatus, "insufficient_data">; reason: string } {
  if (delta > MEAN_SCORE_EPSILON) {
    return {
      status: "improved",
      reason: `Mean session score improved by ${delta}.`,
    };
  }
  if (delta < -MEAN_SCORE_EPSILON) {
    return {
      status: "regressed",
      reason: `Mean session score regressed by ${Math.abs(delta)}.`,
    };
  }
  return {
    status: "no_movement",
    reason: `Mean session score changed by ${delta}, within the ${MEAN_SCORE_EPSILON} no-movement epsilon; this is the DAN-208 retirement signal.`,
  };
}

export function measureProposal(
  store: Store,
  row: WorkshopProposalRow,
  options?: MeasureOptions,
): CapabilityMeasurement {
  const minimum = validateOptions(options);
  if (row.installedAt === null) {
    return emptyMeasurement(
      row,
      "",
      "Insufficient data: proposal is not installed.",
    );
  }

  const installedMilliseconds = Date.parse(row.installedAt);
  if (Number.isNaN(installedMilliseconds)) {
    return emptyMeasurement(
      row,
      row.installedAt,
      "Insufficient data: installed_at is not a valid timestamp.",
    );
  }

  const scores = partitionScores(store, row, installedMilliseconds);
  const beforeMean = mean(scores.before);
  const afterMean = mean(scores.after);
  const before = {
    sessionCount: scores.before.length,
    meanScore: beforeMean,
  };
  const after = {
    sessionCount: scores.after.length,
    meanScore: afterMean,
  };

  if (scores.before.length < minimum || scores.after.length < minimum) {
    return {
      proposalId: row.id,
      installedAt: row.installedAt,
      scope: { repo: row.repo, agent: row.agent },
      before,
      after,
      delta: null,
      status: "insufficient_data",
      reason: shortageReason(
        scores.before.length,
        scores.after.length,
        minimum,
        scores.skipped,
        scores.skippedErrors,
      ),
      measurementVersion: MEASUREMENT_VERSION,
    };
  }
  if (beforeMean === null || afterMean === null) {
    throw new Error("score means are unexpectedly absent after minimum checks");
  }

  const delta = afterMean - beforeMean;
  const result = movement(delta);
  return {
    proposalId: row.id,
    installedAt: row.installedAt,
    scope: { repo: row.repo, agent: row.agent },
    before,
    after,
    delta,
    status: result.status,
    reason: `${result.reason}${skippedSuffix(scores.skipped, scores.skippedErrors)}`,
    measurementVersion: MEASUREMENT_VERSION,
  };
}

export function measureInstalled(
  store: Store,
  rows: WorkshopProposalRow[],
  options?: MeasureOptions,
): CapabilityMeasurement[] {
  validateOptions(options);
  return [...rows]
    .sort((left: WorkshopProposalRow, right: WorkshopProposalRow): number =>
      left.id.localeCompare(right.id)
    )
    .map((row: WorkshopProposalRow): CapabilityMeasurement =>
      measureProposal(store, row, options)
    );
}
