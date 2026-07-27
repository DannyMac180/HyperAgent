import { selectMemoriesForRepo } from "../memory/inject.ts";
import {
  claimHash,
  type MemoryRow,
  type MemoryScope,
} from "../memory/store.ts";
import type { HyperEvent } from "../schema/events.ts";
import { scoreSession } from "../scoring/score.ts";
import type { SessionRow, Store } from "../store/store.ts";
import {
  buildPredicateContext,
  evaluatePredicate,
  validatePredicate,
} from "./predicates.ts";
import type { DraftedProposal } from "./propose.ts";
import type { ProposalType } from "./types.ts";

export const REPLAY_EVAL_VERSION = "1";

/**
 * The real selector has no K-limit and admits every approved global memory.
 * Consequently, global injection membership is not evidence that a memory
 * would have helped a historical session, and replay never calls it a catch.
 */
export const MEMORY_REPLAY_SELECTION_LIMITATION =
  "selectMemoriesForRepo has no K-limit and selects every approved global memory; membership alone is not evidence that the memory would have helped.";

export const DEFAULT_NEGATIVE_CONTROL_PASS_RATE = 0.6;
export const DEFAULT_NEGATIVE_CONTROL_LIMIT = 3;

export type FixtureRole = "positive" | "negative_control";

export interface ReplayFixture {
  sessionId: string;
  role: FixtureRole;
  /** Provenance: the exact stored event ids this fixture was built from. */
  eventIds: string[];
  repo: string | null;
  vendor: string;
  ts: string;
}

export type FixtureVerdict =
  | "would_have_caught"
  | "no_effect"
  | "false_flag"
  | "error";

export interface FixtureOutcome {
  sessionId: string;
  role: FixtureRole;
  verdict: FixtureVerdict;
  reason: string;
}

export interface ReplayEval {
  proposalType: ProposalType;
  evalVersion: string;
  fixtures: ReplayFixture[];
  outcomes: FixtureOutcome[];
  positivesCaught: number;
  positivesTotal: number;
  falseFlags: number;
  negativeControlsTotal: number;
  errors: number;
  passed: boolean;
  failureReason:
    | "eval_failed"
    | "false_flag"
    | "no_fixtures"
    | "unsupported"
    | null;
  diagnostics: string[];
}

export interface BuildFixtureOptions {
  /** Every failing session in the source friction cluster. */
  failingSessionIds: string[];
  /**
   * When non-empty, holdouts replace the other failing sessions as positives.
   * All failing ids remain excluded from negative-control selection.
   */
  holdoutSessionIds?: string[];
  repo?: string | null;
  passingThreshold?: number;
  negativeControlLimit?: number;
  dataDir?: string;
}

export interface VerificationReplayOptions {
  repoRoot?: string;
  dataDir?: string;
}

export interface MemoryReplayOptions {
  scope?: MemoryScope;
  scopeKey?: string | null;
  dataDir?: string;
}

export interface EvaluateProposalOptions
  extends VerificationReplayOptions, MemoryReplayOptions {
  memoryStoreRows?: MemoryRow[];
  passingThreshold?: number;
  negativeControlLimit?: number;
}

interface LoadedFixtureEvents {
  events: HyperEvent[];
  error: string | null;
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

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function validRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function sessionMap(store: Store): Map<string, SessionRow> {
  return new Map(
    store.getSessions().map(
      (session: SessionRow): [string, SessionRow] =>
        [session.session_id, session],
    ),
  );
}

function fixtureFromSession(
  store: Store,
  session: SessionRow,
  role: FixtureRole,
): ReplayFixture | string {
  try {
    const events = store.getEvents(session.session_id);
    if (events.length === 0) {
      return `session ${session.session_id} has no stored events`;
    }
    const eventIds = events.map((event: HyperEvent): string => event.id);
    if (new Set(eventIds).size !== eventIds.length) {
      return `session ${session.session_id} has duplicate stored event ids`;
    }
    return {
      sessionId: session.session_id,
      role,
      eventIds,
      repo: session.repo,
      vendor: session.vendor,
      ts: session.started_at,
    };
  } catch (error: unknown) {
    return `session ${session.session_id} events could not be read: ${errorMessage(error)}`;
  }
}

/**
 * Anti-circularity boundary: the options contain only stored session ids and
 * scalar selection controls. Proposal text, claims, and drafts cannot enter
 * fixture construction through this type.
 */
export function buildFixtures(
  store: Store,
  options: BuildFixtureOptions,
): { fixtures: ReplayFixture[]; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const fixtures: ReplayFixture[] = [];
  const failingSessionIds = uniqueSorted(options.failingSessionIds);
  const holdoutSessionIds = uniqueSorted(options.holdoutSessionIds ?? []);
  const positiveSessionIds = holdoutSessionIds.length > 0
    ? holdoutSessionIds
    : failingSessionIds;
  const allFailingIds = new Set([
    ...failingSessionIds,
    ...holdoutSessionIds,
  ]);
  const passingThreshold =
    options.passingThreshold ?? DEFAULT_NEGATIVE_CONTROL_PASS_RATE;
  const negativeControlLimit =
    options.negativeControlLimit ?? DEFAULT_NEGATIVE_CONTROL_LIMIT;

  if (!validRate(passingThreshold)) {
    return {
      fixtures: [],
      diagnostics: [
        `passingThreshold must be between 0 and 1; received ${String(passingThreshold)}`,
      ],
    };
  }
  if (!validLimit(negativeControlLimit)) {
    return {
      fixtures: [],
      diagnostics: [
        `negativeControlLimit must be a non-negative safe integer; received ${String(negativeControlLimit)}`,
      ],
    };
  }

  let sessions: Map<string, SessionRow>;
  try {
    sessions = sessionMap(store);
  } catch (error: unknown) {
    return {
      fixtures: [],
      diagnostics: [`stored sessions could not be read: ${errorMessage(error)}`],
    };
  }

  for (const sessionId of positiveSessionIds) {
    const session = sessions.get(sessionId);
    if (session === undefined) {
      diagnostics.push(`positive session ${sessionId} was not found in the store`);
      continue;
    }
    const fixture = fixtureFromSession(store, session, "positive");
    if (typeof fixture === "string") {
      diagnostics.push(fixture);
      continue;
    }
    fixtures.push(fixture);
  }

  const positiveRepos = new Set(
    fixtures
      .filter((fixture: ReplayFixture): boolean => fixture.role === "positive")
      .map((fixture: ReplayFixture): string | null => fixture.repo),
  );
  const targetRepoSpecified = Object.prototype.hasOwnProperty.call(options, "repo");

  // scoreSession has no aggregate total. verification_pass_rate is its only
  // normalized 0..1 quality scalar, so 0.60 mirrors the existing 60% boundary.
  // Excluding every cluster failure id ensures a control contributed no signal
  // to this cluster without accepting cluster text or proposal text here.
  const candidates = [...sessions.values()]
    .filter((session: SessionRow): boolean => !allFailingIds.has(session.session_id))
    .filter((session: SessionRow): boolean =>
      targetRepoSpecified
        ? session.repo === options.repo
        : positiveRepos.has(session.repo)
    )
    .sort((left: SessionRow, right: SessionRow): number =>
      left.started_at === right.started_at
        ? left.session_id.localeCompare(right.session_id)
        : right.started_at.localeCompare(left.started_at)
    );

  for (const session of candidates) {
    if (
      fixtures.filter(
        (fixture: ReplayFixture): boolean =>
          fixture.role === "negative_control",
      ).length >= negativeControlLimit
    ) {
      break;
    }
    try {
      const score = scoreSession(store, session.session_id);
      if (
        score.verification_pass_rate === null
        || !validRate(score.verification_pass_rate)
        || score.verification_pass_rate < passingThreshold
      ) {
        continue;
      }
    } catch (error: unknown) {
      diagnostics.push(
        `negative-control candidate ${session.session_id} could not be scored: ${errorMessage(error)}`,
      );
      continue;
    }
    const fixture = fixtureFromSession(store, session, "negative_control");
    if (typeof fixture === "string") {
      diagnostics.push(fixture);
      continue;
    }
    fixtures.push(fixture);
  }

  if (
    fixtures.every(
      (fixture: ReplayFixture): boolean =>
        fixture.role !== "negative_control",
    )
  ) {
    // Honesty guarantee: without a passing control, replay cannot detect a
    // check that merely fires on every session, so the evaluation must not pass.
    diagnostics.push("no passing negative-control fixture was available");
  }

  return { fixtures, diagnostics };
}

function loadFixtureEvents(
  store: Store,
  fixture: ReplayFixture,
): LoadedFixtureEvents {
  if (
    !isPlainObject(fixture)
    || typeof fixture.sessionId !== "string"
    || !Array.isArray(fixture.eventIds)
    || fixture.eventIds.length === 0
  ) {
    return {
      events: [],
      error: `fixture ${String(fixture?.sessionId)} has invalid or empty provenance`,
    };
  }
  try {
    const storedEvents = store.getEvents(fixture.sessionId);
    const byId = new Map(
      storedEvents.map(
        (event: HyperEvent): [string, HyperEvent] => [event.id, event],
      ),
    );
    const captured: HyperEvent[] = [];
    for (const eventId of fixture.eventIds) {
      if (typeof eventId !== "string") {
        return {
          events: [],
          error: `fixture ${fixture.sessionId} has a non-string event id`,
        };
      }
      const event = byId.get(eventId);
      if (event === undefined) {
        return {
          events: [],
          error: `fixture ${fixture.sessionId} references missing stored event ${eventId}`,
        };
      }
      if (event.session_id !== fixture.sessionId) {
        return {
          events: [],
          error: `fixture ${fixture.sessionId} references event ${eventId} from another session`,
        };
      }
      captured.push(event);
    }
    return { events: captured, error: null };
  } catch (error: unknown) {
    return {
      events: [],
      error: `fixture ${fixture.sessionId} events could not be read: ${errorMessage(error)}`,
    };
  }
}

function finalizeEvaluation(
  proposalType: ProposalType,
  fixtures: ReplayFixture[],
  outcomes: FixtureOutcome[],
  diagnostics: string[],
): ReplayEval {
  const positivesCaught = outcomes.filter(
    (outcome: FixtureOutcome): boolean =>
      outcome.role === "positive"
      && outcome.verdict === "would_have_caught",
  ).length;
  const positivesTotal = fixtures.filter(
    (fixture: ReplayFixture): boolean => fixture.role === "positive",
  ).length;
  const falseFlags = outcomes.filter(
    (outcome: FixtureOutcome): boolean =>
      outcome.verdict === "false_flag",
  ).length;
  const negativeControlsTotal = fixtures.filter(
    (fixture: ReplayFixture): boolean =>
      fixture.role === "negative_control",
  ).length;
  const errors = outcomes.filter(
    (outcome: FixtureOutcome): boolean => outcome.verdict === "error",
  ).length;
  const passed =
    positivesTotal > 0
    && negativeControlsTotal > 0
    && positivesCaught > 0
    && falseFlags === 0
    && errors === 0;
  let failureReason: ReplayEval["failureReason"] = null;
  if (!passed) {
    if (positivesTotal === 0 || negativeControlsTotal === 0) {
      failureReason = "no_fixtures";
    } else if (falseFlags > 0) {
      failureReason = "false_flag";
    } else {
      failureReason = "eval_failed";
    }
  }
  return {
    proposalType,
    evalVersion: REPLAY_EVAL_VERSION,
    fixtures: [...fixtures],
    outcomes,
    positivesCaught,
    positivesTotal,
    falseFlags,
    negativeControlsTotal,
    errors,
    passed,
    failureReason,
    diagnostics,
  };
}

function errorOutcome(
  fixture: ReplayFixture,
  reason: string,
): FixtureOutcome {
  return {
    sessionId: fixture.sessionId,
    role: fixture.role,
    verdict: "error",
    reason,
  };
}

export function evaluateVerificationCheckProposal(
  store: Store,
  proposal: DraftedProposal,
  fixtures: ReplayFixture[],
  options: VerificationReplayOptions = {},
): ReplayEval {
  const diagnostics: string[] = [];
  const outcomes: FixtureOutcome[] = [];
  if (
    proposal.type !== "verification_check"
    || proposal.body.type !== "verification_check"
  ) {
    for (const fixture of fixtures) {
      outcomes.push(errorOutcome(
        fixture,
        "proposal does not contain a verification_check body",
      ));
    }
    diagnostics.push("verification replay received an incompatible proposal");
    return finalizeEvaluation(
      "verification_check",
      fixtures,
      outcomes,
      diagnostics,
    );
  }
  const predicateProblems = validatePredicate(proposal.body.predicate);
  if (predicateProblems.length > 0) {
    const reason = `invalid verification predicate: ${predicateProblems.join(" ")}`;
    for (const fixture of fixtures) {
      outcomes.push(errorOutcome(fixture, reason));
    }
    diagnostics.push(reason);
    return finalizeEvaluation(
      "verification_check",
      fixtures,
      outcomes,
      diagnostics,
    );
  }

  for (const fixture of fixtures) {
    try {
      const loaded = loadFixtureEvents(store, fixture);
      if (loaded.error !== null) {
        outcomes.push(errorOutcome(fixture, loaded.error));
        diagnostics.push(loaded.error);
        continue;
      }
      const verdict = evaluatePredicate(
        proposal.body.predicate,
        buildPredicateContext(loaded.events),
        { repoRoot: options.repoRoot },
      );
      const fixtureVerdict: FixtureVerdict = verdict.satisfied
        ? "no_effect"
        : fixture.role === "positive"
          ? "would_have_caught"
          : "false_flag";
      outcomes.push({
        sessionId: fixture.sessionId,
        role: fixture.role,
        verdict: fixtureVerdict,
        reason: verdict.reason,
      });
    } catch (error: unknown) {
      const reason =
        `fixture ${fixture.sessionId} verification replay failed: ${errorMessage(error)}`;
      outcomes.push(errorOutcome(fixture, reason));
      diagnostics.push(reason);
    }
  }
  return finalizeEvaluation(
    "verification_check",
    fixtures,
    outcomes,
    diagnostics,
  );
}

function candidateScopeKey(
  scope: MemoryScope,
  fixture: ReplayFixture,
  explicitScopeKey: string | null | undefined,
): string | null {
  if (explicitScopeKey !== undefined) {
    return explicitScopeKey;
  }
  if (scope === "repo") {
    return fixture.repo;
  }
  if (scope === "agent") {
    return fixture.vendor;
  }
  return null;
}

function memoryCandidateAt(
  claim: string,
  scope: MemoryScope,
  scopeKey: string | null,
  fixture: ReplayFixture,
): MemoryRow {
  const hash = claimHash(claim);
  return {
    id: `replay-${hash}`,
    claim,
    kind: "behavior",
    scope,
    scope_key: scopeKey,
    confidence: 1,
    status: "approved",
    evidence: fixture.eventIds.map(
      (eventId: string): MemoryRow["evidence"][number] => ({
        session_id: fixture.sessionId,
        raw_ref: eventId,
      }),
    ),
    source: "manual",
    claim_hash: hash,
    created_at: fixture.ts,
    updated_at: fixture.ts,
    last_validated_at: null,
  };
}

function memoriesExistingAt(
  rows: MemoryRow[],
  fixture: ReplayFixture,
  diagnostics: string[],
): MemoryRow[] | null {
  const fixtureTime = Date.parse(fixture.ts);
  if (!Number.isFinite(fixtureTime)) {
    diagnostics.push(
      `fixture ${fixture.sessionId} has invalid start timestamp ${JSON.stringify(fixture.ts)}`,
    );
    return null;
  }
  return rows.filter((row: MemoryRow): boolean => {
    const createdAt = Date.parse(row.created_at);
    if (!Number.isFinite(createdAt)) {
      diagnostics.push(
        `memory ${row.id} has invalid created_at ${JSON.stringify(row.created_at)} and was excluded`,
      );
      return false;
    }
    if (createdAt > fixtureTime) {
      diagnostics.push(
        `memory ${row.id} post-dates fixture ${fixture.sessionId} and was excluded`,
      );
      return false;
    }
    return true;
  });
}

export function evaluateMemoryProposal(
  store: Store,
  memoryStoreRows: MemoryRow[],
  proposal: DraftedProposal,
  fixtures: ReplayFixture[],
  options: MemoryReplayOptions = {},
): ReplayEval {
  const diagnostics: string[] = [];
  const outcomes: FixtureOutcome[] = [];
  const scope = options.scope ?? "repo";
  if (proposal.type !== "memory" || proposal.body.type !== "memory") {
    for (const fixture of fixtures) {
      outcomes.push(errorOutcome(
        fixture,
        "proposal does not contain a memory body",
      ));
    }
    diagnostics.push("memory replay received an incompatible proposal");
    return finalizeEvaluation("memory", fixtures, outcomes, diagnostics);
  }
  if (scope === "global") {
    diagnostics.push(MEMORY_REPLAY_SELECTION_LIMITATION);
  }

  for (const fixture of fixtures) {
    try {
      const loaded = loadFixtureEvents(store, fixture);
      if (loaded.error !== null) {
        outcomes.push(errorOutcome(fixture, loaded.error));
        diagnostics.push(loaded.error);
        continue;
      }
      const existing = memoriesExistingAt(
        memoryStoreRows,
        fixture,
        diagnostics,
      );
      if (existing === null) {
        outcomes.push(errorOutcome(
          fixture,
          `fixture ${fixture.sessionId} has an invalid start timestamp`,
        ));
        continue;
      }
      const scopeKey = candidateScopeKey(scope, fixture, options.scopeKey);
      if (scope !== "global" && (scopeKey === null || scopeKey.length === 0)) {
        outcomes.push(errorOutcome(
          fixture,
          `fixture ${fixture.sessionId} cannot resolve a ${scope} memory scope key`,
        ));
        continue;
      }
      const candidate = memoryCandidateAt(
        proposal.body.content,
        scope,
        scopeKey,
        fixture,
      );
      const selected = selectMemoriesForRepo(
        [...existing, candidate],
        fixture.repo ?? "",
        fixture.vendor,
      );
      const isMember = selected.some(
        (memory: MemoryRow): boolean => memory.id === candidate.id,
      );
      let verdict: FixtureVerdict = "no_effect";
      let reason: string;
      if (!isMember) {
        reason =
          "The candidate memory was absent from the real historical injection selection.";
      } else if (scope === "global") {
        reason =
          "The candidate was selected only by unconditional global-scope admission; membership does not show it would have helped.";
      } else if (fixture.role === "positive") {
        verdict = "would_have_caught";
        reason =
          "The candidate memory belonged to the real injection set available before this failing session.";
      } else {
        // Injection is advisory, not a bounce. Membership on a good session is
        // therefore not a false flag; replay has no outcome evidence showing
        // help or harm, so it records correct uncertainty as no_effect.
        reason =
          "The candidate was injected into a passing control, but advisory membership alone cannot establish harm or a false flag.";
      }
      outcomes.push({
        sessionId: fixture.sessionId,
        role: fixture.role,
        verdict,
        reason,
      });
    } catch (error: unknown) {
      const reason =
        `fixture ${fixture.sessionId} memory replay failed: ${errorMessage(error)}`;
      outcomes.push(errorOutcome(fixture, reason));
      diagnostics.push(reason);
    }
  }
  return finalizeEvaluation("memory", fixtures, outcomes, diagnostics);
}

function unsupportedEvaluation(
  proposalType: ProposalType,
): ReplayEval {
  return {
    proposalType,
    evalVersion: REPLAY_EVAL_VERSION,
    fixtures: [],
    outcomes: [],
    positivesCaught: 0,
    positivesTotal: 0,
    falseFlags: 0,
    negativeControlsTotal: 0,
    errors: 0,
    passed: false,
    failureReason: "unsupported",
    diagnostics: [
      `${proposalType} proposals have no honest deterministic replay evaluation`,
    ],
  };
}

export function evaluateProposal(
  store: Store,
  proposal: DraftedProposal,
  options: EvaluateProposalOptions = {},
): ReplayEval {
  if (proposal.type === "instruction_edit" || proposal.type === "skill") {
    return unsupportedEvaluation(proposal.type);
  }
  const failingSessionIds = uniqueSorted([
    ...proposal.evidence.sessionIds,
    ...proposal.holdoutSessionIds,
  ]);
  const built = buildFixtures(store, {
    failingSessionIds,
    holdoutSessionIds: proposal.holdoutSessionIds,
    passingThreshold: options.passingThreshold,
    negativeControlLimit: options.negativeControlLimit,
    dataDir: options.dataDir,
  });
  const evaluation = proposal.type === "verification_check"
    ? evaluateVerificationCheckProposal(store, proposal, built.fixtures, {
      repoRoot: options.repoRoot,
      dataDir: options.dataDir,
    })
    : evaluateMemoryProposal(
      store,
      options.memoryStoreRows ?? [],
      proposal,
      built.fixtures,
      {
        // Scope follows the proposal's declared scope so the eval judges the
        // same memory install would write. A cluster spanning repos yields a
        // global proposal, which this eval honestly scores no_effect — it can
        // never be judged repo-scoped and then installed global.
        scope: options.scope
          ?? (proposal.repo !== null
            ? "repo"
            : proposal.agent !== null
              ? "agent"
              : "global"),
        scopeKey: options.scopeKey,
        dataDir: options.dataDir,
      },
    );
  evaluation.diagnostics.unshift(...built.diagnostics);
  return evaluation;
}

export function gateProposal(
  evaluation: ReplayEval,
): { status: "pending" } | { status: "draft"; reason: string } {
  if (evaluation.passed) {
    return { status: "pending" };
  }
  return {
    status: "draft",
    reason: evaluation.failureReason === "false_flag"
      ? "false_flag"
      : evaluation.failureReason === "unsupported"
        ? "unsupported"
        : "eval_failed",
  };
}
