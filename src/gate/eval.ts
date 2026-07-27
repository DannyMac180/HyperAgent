import {
  evaluateContract,
  loadContract,
} from "./contract.ts";
import {
  isSuitRuntimeWritePath,
  policyPath,
} from "./paths.ts";
import {
  loadPolicy,
  matchPolicy,
} from "./policy.ts";
import type {
  PolicyCandidate,
  PolicyLoadResult,
  PolicyMatch,
} from "./policy.ts";
import { redactSummary } from "./redact.ts";
import {
  appendOutcome,
  GATE_OUTCOME_VERSION,
  incrementBounceCount,
  readSpool,
  sessionContextFromSpool,
} from "./spool.ts";
import type {
  GateOutcome,
  GateOutcomeDecision,
  GateOutcomeKind,
} from "./spool.ts";

export const GATE_EVAL_TIMEOUT_MS = 2_000;
export const DEFAULT_MAX_BOUNCES = 2;

export type GateHookKind = "pre_tool_use" | "post_tool_use" | "stop";

/** Canonical, harness-neutral hook input. Adapters translate their dialect
 * into this; src/gate/ never sees a vendor payload shape. */
export interface GateHookInput {
  hook: GateHookKind;
  harness: string;
  /** Canonical session id, e.g. "claude-code:<native id>". */
  sessionId: string;
  cwd: string;
  toolName: string;
  command: string;
  readPaths: string[];
  writePaths: string[];
  /** post_tool_use only: did the tool succeed? undefined = unknown = not passed. */
  toolPassed?: boolean;
  /** stop only: harness says a stop hook is already active. */
  stopHookActive?: boolean;
}

export type GateDecisionKind = "allow" | "deny" | "block";

export interface GateDecision {
  kind: GateDecisionKind;
  /** Present for deny/block. Names WHAT failed. Never instructions. */
  reason?: string;
  matchedRules: string[];
  failedChecks: string[];
  /** Set when the decision was reached by failing open after an error. */
  failedOpen?: boolean;
  /** Set when the bounce limit was reached and the stop was allowed through. */
  gaveUp?: boolean;
}

export interface GateEvalOptions {
  dataDir: string;
  input: GateHookInput;
  /** Injected for tests; defaults to loadPolicy(policyPath(dataDir)). */
  policyLoad?: PolicyLoadResult;
  maxBounces?: number;
  timeoutMs?: number;
  now?: () => number;
}

interface EvaluationContext {
  options: GateEvalOptions;
  now: () => number;
  deadline: number;
  timedOut: () => boolean;
}

class GateDeadlineError extends Error {
  public constructor() {
    super("GATE_TIMEOUT: gate evaluation exceeded its deadline.");
    this.name = "GateDeadlineError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decision(
  kind: GateDecisionKind,
  matchedRules: string[] = [],
  failedChecks: string[] = [],
  extra: Pick<GateDecision, "reason" | "failedOpen" | "gaveUp"> = {},
): GateDecision {
  return {
    kind,
    matchedRules,
    failedChecks,
    ...extra,
  };
}

function ensureWithinDeadline(context: EvaluationContext): void {
  if (context.timedOut() || context.now() >= context.deadline) {
    throw new GateDeadlineError();
  }
}

function timestamp(now: () => number): string {
  return new Date(now()).toISOString();
}

function outcome(
  context: EvaluationContext,
  kind: GateOutcomeKind,
  outcomeDecision: GateOutcomeDecision,
  summary: string,
  matchedRules: string[],
  failedChecks: string[],
  details: Pick<
    GateOutcome,
    "command" | "passed" | "touchedFiles" | "error"
  > = {},
): GateOutcome {
  const { input } = context.options;
  return {
    v: GATE_OUTCOME_VERSION,
    kind,
    ts: timestamp(context.now),
    harness: input.harness,
    sessionId: input.sessionId,
    cwd: input.cwd,
    decision: outcomeDecision,
    summary: redactSummary(summary),
    matchedRules,
    failedChecks,
    ...details,
  };
}

async function requireOutcome(
  context: EvaluationContext,
  gateOutcome: GateOutcome,
): Promise<void> {
  ensureWithinDeadline(context);
  const appended: boolean = await appendOutcome(
    context.options.dataDir,
    gateOutcome,
  );
  ensureWithinDeadline(context);
  if (!appended) {
    throw new Error("GATE_SPOOL_WRITE_ERROR: gate outcome was not recorded.");
  }
}

function writeDiagnostic(error: unknown): void {
  try {
    const message: string = redactSummary(errorMessage(error));
    process.stderr.write(`HyperAgent gate failed open: ${message}\n`);
  } catch {
    // Diagnostics are best effort and must never alter the allow decision.
  }
}

async function failOpen(
  options: GateEvalOptions,
  error: unknown,
): Promise<GateDecision> {
  const fallback: GateDecision = decision(
    "allow",
    [],
    [],
    { failedOpen: true },
  );
  try {
    const message: string = errorMessage(error);
    const gateOutcome: GateOutcome = {
      v: GATE_OUTCOME_VERSION,
      kind: "gate_error",
      ts: new Date().toISOString(),
      harness: options.input.harness,
      sessionId: options.input.sessionId,
      cwd: options.input.cwd,
      decision: "allow",
      summary: "Gate evaluation failed open.",
      matchedRules: [],
      failedChecks: [],
      error: redactSummary(message, 1_000),
    };
    if (!await appendOutcome(options.dataDir, gateOutcome)) {
      writeDiagnostic(error);
    }
  } catch {
    writeDiagnostic(error);
  }
  return fallback;
}

function policyCandidate(
  input: GateHookInput,
  dataDir: string,
): PolicyCandidate {
  return {
    toolName: input.toolName,
    command: input.command,
    readPaths: input.readPaths.filter(
      (path: string): boolean => !isSuitRuntimeWritePath(path, dataDir),
    ),
    writePaths: input.writePaths.filter(
      (path: string): boolean => !isSuitRuntimeWritePath(path, dataDir),
    ),
    // cwd is the repo the hook fired in — the same root the contract is
    // resolved from — so a user-authored relative pathPattern matches the
    // absolute paths the harness reports.
    ...(input.cwd.length > 0 ? { repoRoot: input.cwd } : {}),
  };
}

function matchedRuleIds(matches: PolicyMatch[]): string[] {
  return matches.map((match: PolicyMatch): string => match.ruleId);
}

function denyReason(matches: PolicyMatch[]): string {
  const namedRules: string = matches.map(
    (match: PolicyMatch): string =>
      `${match.ruleId}: ${redactSummary(match.description)}`,
  ).join("; ");
  return `Blocked policy rules matched: ${namedRules}.`;
}

function blockReason(failedChecks: string[]): string {
  return `Contract checks failed: ${failedChecks.join(", ")}.`;
}

async function recordPolicyLoadFailure(
  context: EvaluationContext,
  policyLoad: PolicyLoadResult,
): Promise<void> {
  if (policyLoad.state !== "invalid") {
    return;
  }
  await requireOutcome(
    context,
    outcome(
      context,
      "gate_error",
      "allow",
      "Policy failed to load; flag-only baseline applied.",
      [],
      [],
      {
        error: redactSummary(
          policyLoad.error ?? "POLICY_LOAD_ERROR: invalid policy.",
          1_000,
        ),
      },
    ),
  );
}

async function evaluatePolicyHook(
  context: EvaluationContext,
): Promise<GateDecision> {
  const { dataDir, input } = context.options;
  ensureWithinDeadline(context);
  const policyLoad: PolicyLoadResult = context.options.policyLoad
    ?? loadPolicy(policyPath(dataDir));
  ensureWithinDeadline(context);
  await recordPolicyLoadFailure(context, policyLoad);
  ensureWithinDeadline(context);

  const matches: PolicyMatch[] = matchPolicy(
    policyLoad.policy,
    policyCandidate(input, dataDir),
  );
  ensureWithinDeadline(context);
  const ruleIds: string[] = matchedRuleIds(matches);
  const failedOpen: boolean = policyLoad.state === "invalid";

  if (input.hook === "post_tool_use") {
    await requireOutcome(
      context,
      outcome(
        context,
        "post_tool_use",
        "allow",
        "Post-tool outcome recorded.",
        ruleIds,
        [],
        {
          command: redactSummary(input.command),
          passed: input.toolPassed,
          touchedFiles: input.writePaths,
        },
      ),
    );
    return decision(
      "allow",
      ruleIds,
      [],
      failedOpen ? { failedOpen: true } : {},
    );
  }

  const blockingMatches: PolicyMatch[] = matches.filter(
    (match: PolicyMatch): boolean => match.action === "block",
  );
  const kind: GateDecisionKind = blockingMatches.length > 0 ? "deny" : "allow";
  const reason: string | undefined = blockingMatches.length > 0
    ? denyReason(blockingMatches)
    : undefined;
  await requireOutcome(
    context,
    outcome(
      context,
      "pre_tool_use",
      kind,
      reason ?? "Pre-tool use allowed.",
      ruleIds,
      [],
    ),
  );
  return decision(
    kind,
    ruleIds,
    [],
    {
      ...(reason === undefined ? {} : { reason }),
      ...(failedOpen ? { failedOpen: true } : {}),
    },
  );
}

async function evaluateStopHook(
  context: EvaluationContext,
): Promise<GateDecision> {
  const { dataDir, input } = context.options;
  if (input.stopHookActive === true) {
    await requireOutcome(
      context,
      outcome(
        context,
        "stop",
        "allow",
        "Stop hook already active.",
        [],
        [],
      ),
    );
    return decision("allow");
  }

  ensureWithinDeadline(context);
  const contractLoad = loadContract(input.cwd);
  ensureWithinDeadline(context);
  if (contractLoad.state === "absent") {
    await requireOutcome(
      context,
      outcome(
        context,
        "stop",
        "allow",
        "Verification contract absent.",
        [],
        [],
      ),
    );
    return decision("allow");
  }
  if (contractLoad.state === "invalid") {
    const contractError: string = contractLoad.error
      ?? "CONTRACT_LOAD_ERROR: invalid contract.";
    await requireOutcome(
      context,
      outcome(
        context,
        "gate_error",
        "allow",
        "Verification contract failed to load.",
        [],
        [],
        { error: redactSummary(contractError, 1_000) },
      ),
    );
    return decision("allow", [], [], { failedOpen: true });
  }

  // `state` and `contract` are separate fields, so a loaded result carrying no
  // contract would be an internal inconsistency rather than a policy verdict.
  // Treat it as infrastructure and allow, exactly like an invalid contract.
  const loadedContract = contractLoad.contract;
  if (loadedContract === null) {
    await requireOutcome(
      context,
      outcome(
        context,
        "gate_error",
        "allow",
        "Verification contract loaded without a document.",
        [],
        [],
        { error: "CONTRACT_STATE_ERROR: loaded contract was absent." },
      ),
    );
    return decision("allow", [], [], { failedOpen: true });
  }

  const spool = await readSpool(dataDir);
  ensureWithinDeadline(context);
  const sessionContext = sessionContextFromSpool(
    spool.outcomes,
    input.sessionId,
  );
  // The contract was resolved from cwd, so cwd is the root its relative
  // protectedPaths are written against.
  const failures = evaluateContract(loadedContract, sessionContext, {
    repoRoot: input.cwd,
  });
  ensureWithinDeadline(context);
  const failedChecks: string[] = failures.map(
    (failure): string => failure.checkId,
  );
  if (failedChecks.length === 0) {
    await requireOutcome(
      context,
      outcome(
        context,
        "stop",
        "allow",
        "Verification contract satisfied.",
        [],
        [],
      ),
    );
    return decision("allow");
  }

  const bounceCount: number = await incrementBounceCount(
    dataDir,
    input.sessionId,
  );
  ensureWithinDeadline(context);
  const maxBounces: number = context.options.maxBounces
    ?? DEFAULT_MAX_BOUNCES;
  if (bounceCount > maxBounces) {
    await requireOutcome(
      context,
      outcome(
        context,
        "gate_gave_up",
        "allow",
        blockReason(failedChecks),
        [],
        failedChecks,
      ),
    );
    return decision(
      "allow",
      [],
      failedChecks,
      { gaveUp: true },
    );
  }

  const reason: string = blockReason(failedChecks);
  await requireOutcome(
    context,
    outcome(
      context,
      "stop",
      "block",
      reason,
      [],
      failedChecks,
    ),
  );
  return decision("block", [], failedChecks, { reason });
}

async function evaluateGate(
  context: EvaluationContext,
): Promise<GateDecision> {
  ensureWithinDeadline(context);
  if (
    context.options.input.hook === "pre_tool_use"
    || context.options.input.hook === "post_tool_use"
  ) {
    return evaluatePolicyHook(context);
  }
  if (context.options.input.hook === "stop") {
    return evaluateStopHook(context);
  }
  throw new Error("GATE_INPUT_ERROR: unsupported hook kind.");
}

/**
 * The hook runtime core. NEVER throws. NEVER blocks on infrastructure failure.
 *
 * - pre_tool_use: deny iff an ENABLED `block` rule matches. flag rules spool only.
 * - post_tool_use: always allow; spools command/pass/touched files.
 * - stop: load the repo contract from `input.cwd`; evaluate against the spooled
 *   session context; block with a reason naming failed checks. Honors
 *   stopHookActive and the per-session bounce counter (allow + `gate_gave_up`
 *   past maxBounces).
 * - Any internal error, a policy that failed to load, or exceeding timeoutMs
 *   => {kind:"allow", failedOpen:true} plus a best-effort spooled/stderr
 *   diagnostic.
 */
export function runGateEval(options: GateEvalOptions): Promise<GateDecision> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutMs: number = options.timeoutMs ?? GATE_EVAL_TIMEOUT_MS;
    const maxBounces: number = options.maxBounces ?? DEFAULT_MAX_BOUNCES;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error("GATE_TIMEOUT_CONFIG_ERROR: timeoutMs must be non-negative.");
    }
    if (
      !Number.isSafeInteger(maxBounces)
      || maxBounces < 0
    ) {
      throw new Error(
        "GATE_BOUNCE_CONFIG_ERROR: maxBounces must be a non-negative integer.",
      );
    }

    const now: () => number = options.now ?? Date.now;
    const startedAt: number = now();
    if (!Number.isFinite(startedAt)) {
      throw new Error("GATE_CLOCK_ERROR: clock returned a non-finite value.");
    }
    const deadline: number = startedAt + timeoutMs;
    let timedOut = false;
    const context: EvaluationContext = {
      options,
      now,
      deadline,
      timedOut: (): boolean => timedOut,
    };
    const timeoutDecision: Promise<GateDecision> = new Promise(
      (resolve): void => {
        timer = setTimeout((): void => {
          timedOut = true;
          resolve(
            decision(
              "allow",
              [],
              [],
              { failedOpen: true },
            ),
          );
        }, timeoutMs);
      },
    );
    const evaluation: Promise<GateDecision> = evaluateGate(context).catch(
      (error: unknown): Promise<GateDecision> => failOpen(options, error),
    );

    return Promise.race([evaluation, timeoutDecision])
      .catch(
        (error: unknown): Promise<GateDecision> => failOpen(options, error),
      )
      .finally((): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
  } catch (error: unknown) {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    return failOpen(options, error);
  }
}
