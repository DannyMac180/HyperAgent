import { homedir } from "node:os";
import { join } from "node:path";

import {
  spawnAgentRunner,
  type AgentRunnerConfig,
} from "../missions/runner.ts";
import {
  validatePredicate,
  type VerificationPredicate,
} from "./predicates.ts";
import type { FrictionCluster } from "./friction.ts";
import type {
  DurabilityCategory,
  ProposalEvidence,
  ProposalType,
} from "./types.ts";

export const WORKSHOP_DRAFTER_VERSION = "1";

export const DEFAULT_DISALLOWED_DRAFT_TOOLS: readonly string[] = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
];

export const HOW_TO_THINK_PATTERNS: readonly {
  name: string;
  pattern: RegExp;
}[] = [
  { name: "always-think", pattern: /\balways\s+(?:stop\s+(?:and\s+)?)?think\b/iu },
  { name: "consider", pattern: /\bconsider(?:ing)?\b/iu },
  { name: "be-careful-to", pattern: /\bbe\s+careful\s+to\b/iu },
  { name: "approach-by", pattern: /\bapproach\b[\s\S]{0,100}?\bby\b/iu },
  { name: "remember-to-reason", pattern: /\bremember\s+to\s+reason\b/iu },
  { name: "make-sure-to-think", pattern: /\bmake\s+sure\s+to\s+think\b/iu },
  { name: "keep-in-mind", pattern: /\bkeep\s+in\s+mind\b/iu },
];

export type ProposalBody =
  | { type: "memory"; content: string }
  | {
    type: "verification_check";
    description: string;
    predicate: VerificationPredicate;
  }
  | { type: "instruction_edit"; content: string }
  | { type: "skill"; content: string };

export interface DraftedProposal {
  type: ProposalType;
  durability: DurabilityCategory;
  title: string;
  rationale: string;
  body: ProposalBody;
  evidence: ProposalEvidence;
  holdoutSessionIds: string[];
  drafterVersion: string;
  /**
   * Scope inherited from the friction cluster. A cluster confined to one repo
   * (or one agent) produces a proposal scoped to it; anything wider is null.
   * Install and the replay eval both derive scope from these fields, so a
   * memory judged as repo-scoped can never silently install as global (the
   * eval/install scope-widening defect the DAN-204 live probe caught).
   */
  repo: string | null;
  agent: string | null;
}

export interface ProposeResult {
  proposals: DraftedProposal[];
  rejected: Array<{ title: string; reason: string; rule: string }>;
  diagnostics: string[];
}

export interface ProposeDeps {
  runAgent: (prompt: string) => Promise<string>;
}

export interface ProposalPromptContext {
  sessionIds: string[];
  additionalContext?: string;
}

export interface ProposeOptions {
  additionalContext?: string;
}

const DEFAULT_DRAFT_TIMEOUT_MS = 60_000;
const PROPOSAL_TYPES: readonly ProposalType[] = [
  "memory",
  "verification_check",
  "instruction_edit",
  "skill",
];
const DURABILITY_CATEGORIES: readonly DurabilityCategory[] = [
  "ground_truth",
  "actuation",
  "measurement",
  "persistence",
];

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key: string): boolean => keys.includes(key));
}

function titleFor(value: unknown): string {
  return isPlainObject(value) && isNonEmptyString(value.title)
    ? value.title.trim()
    : "(untitled proposal)";
}

function emptyResult(diagnostic?: string): ProposeResult {
  return {
    proposals: [],
    rejected: [],
    diagnostics: diagnostic === undefined ? [] : [diagnostic],
  };
}

interface SessionPartition {
  draftSessionIds: string[];
  holdoutSessionIds: string[];
}

function partitionSessions(cluster: FrictionCluster): SessionPartition {
  const sessionIds = [...new Set(cluster.sessionIds)].sort();
  if (sessionIds.length < 3) {
    return { draftSessionIds: sessionIds, holdoutSessionIds: [] };
  }
  // Deterministic one-third holdout: reserve the final sorted third, rounded
  // down but never below one session, and draft only from the remaining IDs.
  const holdoutCount = Math.max(1, Math.floor(sessionIds.length / 3));
  const splitAt = sessionIds.length - holdoutCount;
  return {
    draftSessionIds: sessionIds.slice(0, splitAt),
    holdoutSessionIds: sessionIds.slice(splitAt),
  };
}

function stableClusterEvidence(
  cluster: FrictionCluster,
  sessionIds: string[],
): string {
  return JSON.stringify({
    signature: cluster.signature,
    kind: cluster.kind,
    count: cluster.count,
    sessionIds,
    repos: [...cluster.repos].sort(),
    agents: [...cluster.agents].sort(),
    firstSeen: cluster.firstSeen,
    lastSeen: cluster.lastSeen,
    exemplars: [...cluster.exemplars],
  });
}

export function buildProposalPrompt(
  cluster: FrictionCluster,
  context: ProposalPromptContext,
): string {
  const extra = context.additionalContext?.trim();
  return `Draft zero or more durable HyperAgent Workshop proposals from the stored friction evidence below.
Return JSON only: one array, with no markdown fences or prose.
Every array item must contain exactly:
- "type": one of "memory", "verification_check", "instruction_edit", "skill"
- "durability": one of "ground_truth", "actuation", "measurement", "persistence"
- "title": a non-empty string
- "rationale": a non-empty string grounded in the supplied evidence
- "body": for memory, instruction_edit, or skill, exactly {"type": the matching type, "content": a non-empty string}; for verification_check, exactly {"type":"verification_check","description":a non-empty string,"predicate":a valid predicate object}

Valid predicate shapes are:
{"type":"command_ran_matching","pattern":"..."}
{"type":"command_after_last_mutation","pattern":"..."}
{"type":"event_present","eventType":"...","payloadMatch":{"key":"value"}}
{"type":"event_absent","eventType":"...","payloadMatch":{"key":"value"}}
{"type":"path_untouched","glob":"..."}

Admit only capabilities that remain useful because they provide external ground truth, actuation, measurement, or cross-session persistence. Do not propose generic advice about how an agent should think or work. Do not create or propose replay fixtures; later stages derive fixtures only from stored events.
If no candidate passes, return [].

Stored friction evidence:
${stableClusterEvidence(cluster, [...new Set(context.sessionIds)].sort())}${extra === undefined || extra.length === 0 ? "" : `\n\nAdditional local context:\n${extra}`}`;
}

function parseJsonResponse(raw: string): unknown {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)) {
    if (match[1] !== undefined) {
      candidates.push(match[1].trim());
    }
  }
  const firstArray = trimmed.indexOf("[");
  const lastArray = trimmed.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) {
    candidates.push(trimmed.slice(firstArray, lastArray + 1));
  }
  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.push(trimmed.slice(firstObject, lastObject + 1));
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next defensively extracted JSON candidate.
    }
  }
  throw new Error("response did not contain valid JSON");
}

type BodyParseResult =
  | { ok: true; body: ProposalBody }
  | { ok: false; reason: string; rule: string };

function parseBody(type: ProposalType, value: unknown): BodyParseResult {
  if (!isPlainObject(value) || value.type !== type) {
    return {
      ok: false,
      reason: `body must be an object discriminated by type "${type}"`,
      rule: "proposal-body-schema",
    };
  }
  if (type === "verification_check") {
    if (
      !hasOnlyKeys(value, ["type", "description", "predicate"])
      || !isNonEmptyString(value.description)
    ) {
      return {
        ok: false,
        reason: "verification_check body requires only type, description, and predicate",
        rule: "verification-body-schema",
      };
    }
    const problems = validatePredicate(value.predicate);
    if (problems.length > 0) {
      return {
        ok: false,
        reason: `verification predicate is invalid: ${problems.join(" ")}`,
        rule: "verification-predicate",
      };
    }
    return {
      ok: true,
      body: {
        type,
        description: value.description.trim(),
        predicate: value.predicate as VerificationPredicate,
      },
    };
  }
  if (
    !hasOnlyKeys(value, ["type", "content"])
    || !isNonEmptyString(value.content)
  ) {
    return {
      ok: false,
      reason: `${type} body requires only type and non-empty content`,
      rule: "proposal-body-schema",
    };
  }
  return {
    ok: true,
    body: { type, content: value.content.trim() },
  };
}

type ProposalParseResult =
  | { ok: true; proposal: DraftedProposal }
  | { ok: false; title: string; reason: string; rule: string };

function parseProposal(
  value: unknown,
  cluster: FrictionCluster,
  partition: SessionPartition,
): ProposalParseResult {
  const title = titleFor(value);
  if (!isPlainObject(value)) {
    return {
      ok: false,
      title,
      reason: "proposal must be an object",
      rule: "proposal-schema",
    };
  }
  if (!hasOnlyKeys(value, ["type", "durability", "title", "rationale", "body"])) {
    return {
      ok: false,
      title,
      reason: "proposal contains unknown fields",
      rule: "proposal-schema",
    };
  }
  if (
    typeof value.type !== "string"
    || !(PROPOSAL_TYPES as readonly string[]).includes(value.type)
  ) {
    return {
      ok: false,
      title,
      reason: `type must be one of ${PROPOSAL_TYPES.join(", ")}`,
      rule: "proposal-type",
    };
  }
  if (
    typeof value.durability !== "string"
    || !(DURABILITY_CATEGORIES as readonly string[]).includes(value.durability)
  ) {
    return {
      ok: false,
      title,
      reason: `durability must be one of ${DURABILITY_CATEGORIES.join(", ")}`,
      rule: "proposal-durability",
    };
  }
  if (!isNonEmptyString(value.title) || !isNonEmptyString(value.rationale)) {
    return {
      ok: false,
      title,
      reason: "title and rationale must be non-empty strings",
      rule: "proposal-schema",
    };
  }
  const type = value.type as ProposalType;
  const body = parseBody(type, value.body);
  if (!body.ok) {
    return { ok: false, title, reason: body.reason, rule: body.rule };
  }
  const proposal: DraftedProposal = {
    type,
    durability: value.durability as DurabilityCategory,
    title: value.title.trim(),
    rationale: value.rationale.trim(),
    body: body.body,
    evidence: {
      sessionIds: [...partition.draftSessionIds],
      eventIds: [...new Set(cluster.eventIds)].sort(),
      clusterSignature: cluster.signature,
    },
    holdoutSessionIds: [...partition.holdoutSessionIds],
    drafterVersion: WORKSHOP_DRAFTER_VERSION,
    repo: cluster.repos.length === 1 ? cluster.repos[0] ?? null : null,
    agent: cluster.agents.length === 1 ? cluster.agents[0] ?? null : null,
  };
  const durability = applyDurabilityTest(proposal);
  return durability.ok
    ? { ok: true, proposal }
    : {
      ok: false,
      title: proposal.title,
      reason: durability.reason,
      rule: durability.rule,
    };
}

export function parseProposalResponse(
  raw: string,
  cluster: FrictionCluster,
): ProposeResult {
  let parsed: unknown;
  try {
    parsed = parseJsonResponse(raw);
  } catch (error: unknown) {
    return emptyResult(`Workshop proposal output was malformed: ${errorMessage(error)}`);
  }
  if (!Array.isArray(parsed)) {
    return emptyResult("Workshop proposal output must be a JSON array.");
  }
  const result = emptyResult();
  const partition = partitionSessions(cluster);
  for (const [index, value] of parsed.entries()) {
    const candidate = parseProposal(value, cluster, partition);
    if (candidate.ok) {
      result.proposals.push(candidate.proposal);
      continue;
    }
    result.rejected.push({
      title: candidate.title,
      reason: candidate.reason,
      rule: candidate.rule,
    });
    result.diagnostics.push(
      `Workshop proposal ${index} was rejected by ${candidate.rule}: ${candidate.reason}`,
    );
  }
  return result;
}

export function applyDurabilityTest(
  proposal: DraftedProposal,
): { ok: true } | { ok: false; reason: string; rule: string } {
  if (
    proposal.body.type !== "instruction_edit"
    && proposal.body.type !== "skill"
  ) {
    return { ok: true };
  }
  for (const heuristic of HOW_TO_THINK_PATTERNS) {
    if (heuristic.pattern.test(proposal.body.content)) {
      return {
        ok: false,
        reason: `Instructional content tells the model how to think or work (matched "${heuristic.name}").`,
        rule: heuristic.name,
      };
    }
  }
  return { ok: true };
}

export function buildProposalRunnerConfig(
  options: AgentRunnerConfig = {},
): AgentRunnerConfig {
  return {
    ...options,
    dataDir: options.dataDir ?? join(homedir(), ".hyperagent"),
    timeoutMs: options.timeoutMs ?? DEFAULT_DRAFT_TIMEOUT_MS,
    disallowedTools: options.disallowedTools
      ?? [...DEFAULT_DISALLOWED_DRAFT_TOOLS],
  };
}

export function createProposeDeps(
  options: AgentRunnerConfig = {},
): ProposeDeps {
  return {
    runAgent: spawnAgentRunner(buildProposalRunnerConfig(options)),
  };
}

export async function proposeForCluster(
  cluster: FrictionCluster,
  deps: ProposeDeps,
  options: ProposeOptions = {},
): Promise<ProposeResult> {
  const partition = partitionSessions(cluster);
  const prompt = buildProposalPrompt(cluster, {
    sessionIds: partition.draftSessionIds,
    additionalContext: options.additionalContext,
  });
  try {
    const raw = await deps.runAgent(prompt);
    return parseProposalResponse(raw, cluster);
  } catch (error: unknown) {
    return emptyResult(
      `Workshop proposal agent invocation failed: ${errorMessage(error)}`,
    );
  }
}

export async function proposeForClusters(
  clusters: FrictionCluster[],
  deps: ProposeDeps,
  options: ProposeOptions = {},
): Promise<ProposeResult> {
  const combined = emptyResult();
  for (const cluster of clusters) {
    const result = await proposeForCluster(cluster, deps, options);
    combined.proposals.push(...result.proposals);
    combined.rejected.push(...result.rejected);
    combined.diagnostics.push(
      ...result.diagnostics.map(
        (diagnostic: string): string => `[${cluster.signature}] ${diagnostic}`,
      ),
    );
  }
  return combined;
}
