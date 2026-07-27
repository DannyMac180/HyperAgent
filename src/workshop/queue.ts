/**
 * SQLite is the source of truth for the Workshop queue. The Markdown mirror is
 * derived, rebuildable output and must never be treated as authoritative.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { Database } from "bun:sqlite";

import { validatePredicate } from "./predicates.ts";
import type { DraftedProposal, ProposalBody } from "./propose.ts";
import type { ReplayEval } from "./replay.ts";
import type {
  DurabilityCategory,
  ProposalEvidence,
  ProposalStatus,
  ProposalType,
} from "./types.ts";

const HUMAN_APPROVAL_BRAND: unique symbol = Symbol("HumanApproval");
const issuedHumanApprovals = new WeakSet<object>();

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
const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  "draft",
  "pending",
  "approved",
  "rejected",
  "installed",
];
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface HumanApproval {
  readonly actor: "human";
  readonly proposalId: string;
  readonly [HUMAN_APPROVAL_BRAND]: true;
}

export interface WorkshopProposalRow {
  id: string;
  type: ProposalType;
  durability: DurabilityCategory;
  title: string;
  rationale: string;
  body: ProposalBody;
  evidence: ProposalEvidence;
  holdout: string[];
  contentHash: string;
  eval: ReplayEval | null;
  status: ProposalStatus;
  repo: string | null;
  agent: string | null;
  createdAt: string;
  updatedAt: string;
  installedAt: string | null;
  receipt: unknown | null;
}

export interface WorkshopTransitionRow {
  id: number;
  proposalId: string;
  fromStatus: ProposalStatus | null;
  toStatus: ProposalStatus;
  ts: string;
  actor: string;
  note: string | null;
}

export interface WorkshopProposalFilter {
  status?: ProposalStatus;
  type?: ProposalType;
  repo?: string;
  limit?: number;
}

export interface WorkshopQueue {
  readonly db: Database;
  addDrafts(
    drafts: DraftedProposal[],
    evals?: Map<string, ReplayEval> | undefined,
  ): WorkshopProposalRow[];
  get(id: string): WorkshopProposalRow | null;
  list(filter?: WorkshopProposalFilter): WorkshopProposalRow[];
  promoteToPending(id: string, note?: string): WorkshopProposalRow;
  approve(
    id: string,
    approval: HumanApproval,
    expectedHash: string,
  ): WorkshopProposalRow;
  reject(id: string, actor: string, note?: string): WorkshopProposalRow;
  markInstalled(id: string, receipt: unknown): WorkshopProposalRow;
  transitions(id: string): WorkshopTransitionRow[];
  statusFromTransitions(id: string): ProposalStatus;
  rebuildMirror(): number;
  close(): void;
}

export interface OpenWorkshopQueueOptions {
  dataDir?: string;
  dbPath?: string;
  retries?: number;
  retryDelayMs?: number;
}

interface RawProposalRow {
  id: string;
  type: string;
  durability: string;
  title: string;
  rationale: string;
  body: string;
  evidence: string;
  holdout: string;
  content_hash: string;
  eval: string | null;
  status: string;
  repo: string | null;
  agent: string | null;
  created_at: string;
  updated_at: string;
  installed_at: string | null;
  receipt: string | null;
}

interface RawTransitionRow {
  id: number;
  proposal_id: string;
  from_status: string | null;
  to_status: string;
  ts: string;
  actor: string;
  note: string | null;
}

interface CanonicalProposalContent {
  body: ProposalBody;
  durability: DurabilityCategory;
  evidence: ProposalEvidence;
  title: string;
  type: ProposalType;
}

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

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (
    !Array.isArray(value)
    || value.some((entry: unknown): boolean => !isNonEmptyString(entry))
  ) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
}

function assertProposalType(value: unknown, label: string): asserts value is ProposalType {
  if (
    typeof value !== "string"
    || !PROPOSAL_TYPES.includes(value as ProposalType)
  ) {
    throw new Error(`${label} must be one of ${PROPOSAL_TYPES.join(", ")}`);
  }
}

function assertDurability(
  value: unknown,
  label: string,
): asserts value is DurabilityCategory {
  if (
    typeof value !== "string"
    || !DURABILITY_CATEGORIES.includes(value as DurabilityCategory)
  ) {
    throw new Error(
      `${label} must be one of ${DURABILITY_CATEGORIES.join(", ")}`,
    );
  }
}

function assertProposalStatus(
  value: unknown,
  label: string,
): asserts value is ProposalStatus {
  if (
    typeof value !== "string"
    || !PROPOSAL_STATUSES.includes(value as ProposalStatus)
  ) {
    throw new Error(`${label} must be one of ${PROPOSAL_STATUSES.join(", ")}`);
  }
}

function assertOptionalString(
  value: unknown,
  label: string,
): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${label} must be a string when provided`);
  }
}

function canonicalizeJson(value: unknown, label: string): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must not contain non-finite numbers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(
      (entry: unknown, index: number): unknown =>
        canonicalizeJson(entry, `${label}[${String(index)}]`),
    );
  }
  if (!isPlainObject(value)) {
    throw new Error(`${label} must contain only JSON-compatible values`);
  }
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined) {
      throw new Error(`${label}.${key} must not be undefined`);
    }
    canonical[key] = canonicalizeJson(entry, `${label}.${key}`);
  }
  return canonical;
}

function jsonStringify(value: unknown, label: string): string {
  try {
    return JSON.stringify(canonicalizeJson(value, label));
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith(`${label}`)) {
      throw error;
    }
    throw new Error(`${label} could not be serialized: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} contains invalid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function assertProposalBody(
  value: unknown,
  expectedType: ProposalType,
  label: string,
): asserts value is ProposalBody {
  if (!isPlainObject(value) || value.type !== expectedType) {
    throw new Error(`${label} must be an object with type "${expectedType}"`);
  }
  const keys = Object.keys(value).sort();
  if (expectedType === "verification_check") {
    if (
      keys.join(",") !== "description,predicate,type"
      || !isNonEmptyString(value.description)
    ) {
      throw new Error(
        `${label} must contain exactly type, description, and predicate`,
      );
    }
    const problems = validatePredicate(value.predicate);
    if (problems.length > 0) {
      throw new Error(`${label}.predicate is invalid: ${problems.join(" ")}`);
    }
  } else if (
    keys.join(",") !== "content,type"
    || !isNonEmptyString(value.content)
  ) {
    throw new Error(`${label} must contain exactly type and non-empty content`);
  }
  canonicalizeJson(value, label);
}

function assertEvidence(
  value: unknown,
  label: string,
): asserts value is ProposalEvidence {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (
    Object.keys(value).sort().join(",")
    !== "clusterSignature,eventIds,sessionIds"
  ) {
    throw new Error(
      `${label} must contain exactly sessionIds, eventIds, and clusterSignature`,
    );
  }
  assertStringArray(value.sessionIds, `${label}.sessionIds`);
  assertStringArray(value.eventIds, `${label}.eventIds`);
  assertNonEmptyString(value.clusterSignature, `${label}.clusterSignature`);
  canonicalizeJson(value, label);
}

function assertDraft(value: unknown, index: number): asserts value is DraftedProposal {
  const label = `drafts[${String(index)}]`;
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertProposalType(value.type, `${label}.type`);
  assertDurability(value.durability, `${label}.durability`);
  assertNonEmptyString(value.title, `${label}.title`);
  assertNonEmptyString(value.rationale, `${label}.rationale`);
  assertProposalBody(value.body, value.type, `${label}.body`);
  assertEvidence(value.evidence, `${label}.evidence`);
  assertStringArray(value.holdoutSessionIds, `${label}.holdoutSessionIds`);
  assertNonEmptyString(value.drafterVersion, `${label}.drafterVersion`);
  assertNullableString(value.repo, `${label}.repo`);
  assertNullableString(value.agent, `${label}.agent`);
}

function assertNullableString(value: unknown, label: string): void {
  if (value !== null && typeof value !== "string") {
    throw new Error(`${label} must be a string or null`);
  }
}

function canonicalContent(
  value: Pick<
    WorkshopProposalRow,
    "type" | "durability" | "title" | "body" | "evidence"
  >,
): CanonicalProposalContent {
  return {
    body: value.body,
    durability: value.durability,
    evidence: value.evidence,
    title: value.title,
    type: value.type,
  };
}

function proposalContentHash(
  value: Pick<
    WorkshopProposalRow,
    "type" | "durability" | "title" | "body" | "evidence"
  >,
): string {
  const canonical = jsonStringify(canonicalContent(value), "proposal content");
  return createHash("sha256").update(canonical).digest("hex");
}

export function verifyContentHash(
  row: WorkshopProposalRow,
): { ok: true } | { ok: false; expected: string; actual: string } {
  const actual = proposalContentHash(row);
  if (actual === row.contentHash) {
    return { ok: true };
  }
  return { ok: false, expected: row.contentHash, actual };
}

/**
 * This factory is the sole authority boundary for approval. The private symbol
 * prevents construction that typechecks elsewhere, and the private WeakSet
 * rejects runtime-forged objects even when callers bypass TypeScript.
 */
export function humanApprovalFromCli(input: {
  proposalId: string;
  confirmed: true;
}): HumanApproval {
  if (!isPlainObject(input)) {
    throw new Error("human approval input must be an object");
  }
  assertNonEmptyString(input.proposalId, "human approval proposalId");
  if (input.confirmed !== true) {
    throw new Error("human approval requires confirmed === true");
  }
  const approval: HumanApproval = Object.freeze({
    actor: "human",
    proposalId: input.proposalId,
    [HUMAN_APPROVAL_BRAND]: true as const,
  });
  issuedHumanApprovals.add(approval);
  return approval;
}

function proposalFromRaw(raw: RawProposalRow): WorkshopProposalRow {
  assertProposalType(raw.type, `proposal ${raw.id} type`);
  assertDurability(raw.durability, `proposal ${raw.id} durability`);
  assertProposalStatus(raw.status, `proposal ${raw.id} status`);
  const body = parseJson(raw.body, `proposal ${raw.id} body`);
  assertProposalBody(body, raw.type, `proposal ${raw.id} body`);
  const evidence = parseJson(raw.evidence, `proposal ${raw.id} evidence`);
  assertEvidence(evidence, `proposal ${raw.id} evidence`);
  const holdout = parseJson(raw.holdout, `proposal ${raw.id} holdout`);
  assertStringArray(holdout, `proposal ${raw.id} holdout`);
  return {
    id: raw.id,
    type: raw.type,
    durability: raw.durability,
    title: raw.title,
    rationale: raw.rationale,
    body,
    evidence,
    holdout,
    contentHash: raw.content_hash,
    eval: raw.eval === null
      ? null
      : parseJson(raw.eval, `proposal ${raw.id} eval`) as ReplayEval,
    status: raw.status,
    repo: raw.repo,
    agent: raw.agent,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    installedAt: raw.installed_at,
    receipt: raw.receipt === null
      ? null
      : parseJson(raw.receipt, `proposal ${raw.id} receipt`),
  };
}

function transitionFromRaw(raw: RawTransitionRow): WorkshopTransitionRow {
  assertProposalStatus(raw.to_status, `transition ${String(raw.id)} to_status`);
  if (raw.from_status !== null) {
    assertProposalStatus(
      raw.from_status,
      `transition ${String(raw.id)} from_status`,
    );
  }
  return {
    id: raw.id,
    proposalId: raw.proposal_id,
    fromStatus: raw.from_status,
    toStatus: raw.to_status,
    ts: raw.ts,
    actor: raw.actor,
    note: raw.note,
  };
}

function frontmatterValue(value: unknown): string {
  return value === null ? "null" : jsonStringify(value, "frontmatter value");
}

function renderProposalMarkdown(row: WorkshopProposalRow): string {
  const frontmatter: Array<[string, unknown]> = [
    ["id", row.id],
    ["type", row.type],
    ["durability", row.durability],
    ["status", row.status],
    ["content_hash", row.contentHash],
    ["repo", row.repo],
    ["agent", row.agent],
    ["created_at", row.createdAt],
    ["updated_at", row.updatedAt],
    ["installed_at", row.installedAt],
  ];
  const lines = [
    "---",
    ...frontmatter.map(
      ([key, value]: [string, unknown]): string =>
        `${key}: ${frontmatterValue(value)}`,
    ),
    "---",
    "",
    `# ${row.title}`,
    "",
    "## Rationale",
    "",
    row.rationale,
    "",
    "## Body",
    "",
    "```json",
    jsonStringify(row.body, "proposal body"),
    "```",
    "",
    "## Evidence",
    "",
    "```json",
    jsonStringify(row.evidence, "proposal evidence"),
    "```",
    "",
    "## Holdout",
    "",
    "```json",
    jsonStringify(row.holdout, "proposal holdout"),
    "```",
    "",
    "## Evaluation",
    "",
    row.eval === null ? "null" : `\`\`\`json\n${jsonStringify(row.eval, "proposal eval")}\n\`\`\``,
    "",
    "## Receipt",
    "",
    row.receipt === null
      ? "null"
      : `\`\`\`json\n${jsonStringify(row.receipt, "proposal receipt")}\n\`\`\``,
    "",
  ];
  return lines.join("\n");
}

function mirrorPath(row: WorkshopProposalRow, dir: string): string {
  if (!SHA256_PATTERN.test(row.id)) {
    throw new Error(`proposal id is not a SHA-256 digest: ${row.id}`);
  }
  const root = resolve(dir);
  const path = resolve(root, `${row.id}.md`);
  const pathRelativeToRoot = relative(root, path);
  if (
    pathRelativeToRoot.startsWith(`..${sep}`)
    || pathRelativeToRoot === ".."
    || pathRelativeToRoot.length === 0
  ) {
    throw new Error(`workshop mirror path escaped ${root}: ${path}`);
  }
  return path;
}

function writeMirror(row: WorkshopProposalRow, dir: string): void {
  const path = mirrorPath(row, dir);
  const temporaryPath = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporaryPath, renderProposalMarkdown(row), "utf8");
    renameSync(temporaryPath, path);
  } catch (error: unknown) {
    throw new Error(
      `failed to write workshop mirror for ${row.id}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (
    isPlainObject(error)
    && typeof error.code === "string"
    && error.code.toUpperCase().includes("SQLITE_BUSY")
  ) {
    return true;
  }
  const message = errorMessage(error).toUpperCase();
  return message.includes("SQLITE_BUSY") || message.includes("DATABASE IS LOCKED");
}

function synchronousDelay(delayMs: number): void {
  const end = Date.now() + delayMs;
  while (Date.now() < end) {
    // Bounded synchronous delay keeps the queue API consistently synchronous.
  }
}

function withBusyRetry<T>(
  operation: () => T,
  retries: number,
  retryDelayMs: number,
): T {
  const attempts = retries + 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return operation();
    } catch (error: unknown) {
      if (!isSqliteBusy(error)) {
        throw error;
      }
      if (attempt === attempts) {
        throw new Error(
          `SQLite contention persisted after ${String(attempts)} attempts: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      synchronousDelay(retryDelayMs);
    }
  }
  throw new Error("SQLite retry loop ended without a result");
}

function assertOptionKeys(options: Record<string, unknown>): void {
  const allowed = new Set(["dataDir", "dbPath", "retries", "retryDelayMs"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new Error(`unknown workshop queue option: ${key}`);
    }
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

export function openWorkshopQueue(
  options: OpenWorkshopQueueOptions = {},
): WorkshopQueue {
  if (!isPlainObject(options)) {
    throw new Error("workshop queue options must be an object");
  }
  assertOptionKeys(options);
  if (options.dataDir !== undefined) {
    assertNonEmptyString(options.dataDir, "dataDir");
  }
  if (options.dbPath !== undefined) {
    assertNonEmptyString(options.dbPath, "dbPath");
  }
  if (options.retries !== undefined) {
    assertNonNegativeInteger(options.retries, "retries");
  }
  if (options.retryDelayMs !== undefined) {
    assertNonNegativeInteger(options.retryDelayMs, "retryDelayMs");
  }
  const retries: number = options.retries ?? 5;
  const retryDelayMs: number = options.retryDelayMs ?? 50;

  const dataDir = options.dataDir ?? join(homedir(), ".hyperagent");
  const dbPath = options.dbPath ?? join(dataDir, "workshop.db");
  const workshopDir = join(dataDir, "workshop");
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);

  try {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
    } catch (error: unknown) {
      if (dbPath !== ":memory:") {
        throw error;
      }
    }
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS workshop_proposals (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('memory', 'verification_check', 'instruction_edit', 'skill')),
        durability TEXT NOT NULL CHECK (durability IN ('ground_truth', 'actuation', 'measurement', 'persistence')),
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        body TEXT NOT NULL CHECK (json_valid(body)),
        evidence TEXT NOT NULL CHECK (json_valid(evidence)),
        holdout TEXT NOT NULL CHECK (json_valid(holdout)),
        content_hash TEXT NOT NULL,
        eval TEXT CHECK (eval IS NULL OR json_valid(eval)),
        status TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'installed')),
        repo TEXT,
        agent TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        installed_at TEXT,
        receipt TEXT CHECK (receipt IS NULL OR json_valid(receipt))
      ) STRICT;

      CREATE INDEX IF NOT EXISTS workshop_proposals_status_idx
        ON workshop_proposals(status);
      CREATE INDEX IF NOT EXISTS workshop_proposals_repo_idx
        ON workshop_proposals(repo);

      CREATE TABLE IF NOT EXISTS workshop_proposal_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT NOT NULL REFERENCES workshop_proposals(id),
        from_status TEXT CHECK (from_status IS NULL OR from_status IN ('draft', 'pending', 'approved', 'rejected', 'installed')),
        to_status TEXT NOT NULL CHECK (to_status IN ('draft', 'pending', 'approved', 'rejected', 'installed')),
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        note TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS workshop_transitions_proposal_id_idx
        ON workshop_proposal_transitions(proposal_id, id);

      CREATE TRIGGER IF NOT EXISTS workshop_transitions_no_update BEFORE UPDATE ON workshop_proposal_transitions
        BEGIN SELECT RAISE(ABORT, 'workshop_proposal_transitions is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS workshop_transitions_no_delete BEFORE DELETE ON workshop_proposal_transitions
        BEGIN SELECT RAISE(ABORT, 'workshop_proposal_transitions is append-only'); END;
    `);

    const selectProposal = db.query(`
      SELECT id, type, durability, title, rationale, body, evidence, holdout,
             content_hash, eval, status, repo, agent, created_at, updated_at,
             installed_at, receipt
      FROM workshop_proposals
      WHERE id = ?
    `);
    const selectAllProposals = db.query(`
      SELECT id, type, durability, title, rationale, body, evidence, holdout,
             content_hash, eval, status, repo, agent, created_at, updated_at,
             installed_at, receipt
      FROM workshop_proposals
      ORDER BY created_at DESC, id ASC
    `);
    const insertProposal = db.query(`
      INSERT OR IGNORE INTO workshop_proposals (
        id, type, durability, title, rationale, body, evidence, holdout,
        content_hash, eval, status, repo, agent, created_at, updated_at,
        installed_at, receipt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, NULL, NULL)
    `);
    const insertTransition = db.query(`
      INSERT INTO workshop_proposal_transitions (
        proposal_id, from_status, to_status, ts, actor, note
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const updateStatus = db.query(`
      UPDATE workshop_proposals
      SET status = ?, updated_at = ?, installed_at = ?, receipt = ?
      WHERE id = ? AND status = ?
    `);
    const selectTransitions = db.query(`
      SELECT id, proposal_id, from_status, to_status, ts, actor, note
      FROM workshop_proposal_transitions
      WHERE proposal_id = ?
      ORDER BY id ASC
    `);

    function get(id: string): WorkshopProposalRow | null {
      assertNonEmptyString(id, "proposal id");
      const raw = selectProposal.get(id) as RawProposalRow | null;
      return raw === null ? null : proposalFromRaw(raw);
    }

    function requireProposal(id: string): WorkshopProposalRow {
      const row = get(id);
      if (row === null) {
        throw new Error(`workshop proposal not found: ${id}`);
      }
      return row;
    }

    function list(filter: WorkshopProposalFilter = {}): WorkshopProposalRow[] {
      if (!isPlainObject(filter)) {
        throw new Error("workshop proposal filter must be an object");
      }
      const allowed = new Set(["status", "type", "repo", "limit"]);
      for (const key of Object.keys(filter)) {
        if (!allowed.has(key)) {
          throw new Error(`unknown workshop proposal filter: ${key}`);
        }
      }
      if (filter.status !== undefined) {
        assertProposalStatus(filter.status, "filter.status");
      }
      if (filter.type !== undefined) {
        assertProposalType(filter.type, "filter.type");
      }
      if (filter.repo !== undefined) {
        assertNonEmptyString(filter.repo, "filter.repo");
      }
      if (filter.limit !== undefined) {
        assertNonNegativeInteger(filter.limit, "filter.limit");
      }
      const rows = (selectAllProposals.all() as RawProposalRow[])
        .map(proposalFromRaw)
        .filter((row: WorkshopProposalRow): boolean =>
          filter.status === undefined || row.status === filter.status
        )
        .filter((row: WorkshopProposalRow): boolean =>
          filter.type === undefined || row.type === filter.type
        )
        .filter((row: WorkshopProposalRow): boolean =>
          filter.repo === undefined || row.repo === filter.repo
        );
      return filter.limit === undefined ? rows : rows.slice(0, filter.limit);
    }

    function addDrafts(
      drafts: DraftedProposal[],
      evals?: Map<string, ReplayEval> | undefined,
    ): WorkshopProposalRow[] {
      if (!Array.isArray(drafts)) {
        throw new Error("drafts must be an array");
      }
      drafts.forEach(assertDraft);
      if (evals !== undefined && !(evals instanceof Map)) {
        throw new Error("evals must be a Map when provided");
      }
      const ids: string[] = [];
      withBusyRetry(
        db.transaction((): void => {
          for (const draft of drafts) {
            const contentHash = proposalContentHash({
              type: draft.type,
              durability: draft.durability,
              title: draft.title,
              body: draft.body,
              evidence: draft.evidence,
            });
            const id = contentHash;
            ids.push(id);
            const evaluation = evals?.get(id)
              ?? evals?.get(draft.title)
              ?? evals?.get(draft.evidence.clusterSignature);
            const now = new Date().toISOString();
            const result = insertProposal.run(
              id,
              draft.type,
              draft.durability,
              draft.title,
              draft.rationale,
              jsonStringify(draft.body, `draft ${id} body`),
              jsonStringify(draft.evidence, `draft ${id} evidence`),
              jsonStringify(draft.holdoutSessionIds, `draft ${id} holdout`),
              contentHash,
              evaluation === undefined
                ? null
                : jsonStringify(evaluation, `draft ${id} eval`),
              draft.repo,
              draft.agent,
              now,
              now,
            );
            if (result.changes === 1) {
              insertTransition.run(id, null, "draft", now, "workshop", null);
            }
          }
        }),
        retries,
        retryDelayMs,
      );
      const rows = ids.map(requireProposal);
      for (const row of new Map(
        rows.map(
          (proposal: WorkshopProposalRow): [string, WorkshopProposalRow] =>
            [proposal.id, proposal],
        ),
      ).values()) {
        writeMirror(row, workshopDir);
      }
      return rows;
    }

    function transition(
      id: string,
      fromStatus: ProposalStatus,
      toStatus: ProposalStatus,
      actor: string,
      note: string | undefined,
      installedAt: string | null,
      receipt: string | null,
    ): WorkshopProposalRow {
      assertNonEmptyString(actor, "transition actor");
      assertOptionalString(note, "transition note");
      const current = requireProposal(id);
      if (current.status !== fromStatus) {
        throw new Error(
          `invalid workshop proposal transition: ${current.status} -> ${toStatus}`,
        );
      }
      const now = new Date().toISOString();
      withBusyRetry(
        db.transaction((): void => {
          const result = updateStatus.run(
            toStatus,
            now,
            installedAt,
            receipt,
            id,
            fromStatus,
          );
          if (result.changes !== 1) {
            const latest = requireProposal(id);
            throw new Error(
              `invalid workshop proposal transition: ${latest.status} -> ${toStatus}`,
            );
          }
          insertTransition.run(
            id,
            fromStatus,
            toStatus,
            now,
            actor,
            note ?? null,
          );
        }),
        retries,
        retryDelayMs,
      );
      const updated = requireProposal(id);
      writeMirror(updated, workshopDir);
      return updated;
    }

    function promoteToPending(
      id: string,
      note?: string,
    ): WorkshopProposalRow {
      return transition(
        id,
        "draft",
        "pending",
        "agent",
        note,
        null,
        null,
      );
    }

    function approve(
      id: string,
      approval: HumanApproval,
      expectedHash: string,
    ): WorkshopProposalRow {
      if (
        approval === null
        || typeof approval !== "object"
        || !issuedHumanApprovals.has(approval)
      ) {
        throw new Error("approval token was not issued by humanApprovalFromCli");
      }
      if (approval.proposalId !== id) {
        throw new Error(
          `approval token proposal mismatch: token is for ${approval.proposalId}, requested ${id}`,
        );
      }
      if (!SHA256_PATTERN.test(expectedHash)) {
        throw new Error("expectedHash must be a lowercase SHA-256 digest");
      }
      const current = requireProposal(id);
      const actualHash = proposalContentHash(current);
      if (actualHash !== expectedHash) {
        throw new Error(
          `proposal content hash mismatch: expected ${expectedHash}, actual ${actualHash}`,
        );
      }
      if (current.contentHash !== actualHash) {
        throw new Error(
          `stored proposal content hash mismatch: expected ${current.contentHash}, actual ${actualHash}`,
        );
      }
      return transition(
        id,
        "pending",
        "approved",
        approval.actor,
        undefined,
        null,
        null,
      );
    }

    function reject(
      id: string,
      actor: string,
      note?: string,
    ): WorkshopProposalRow {
      assertNonEmptyString(actor, "reject actor");
      assertOptionalString(note, "reject note");
      const current = requireProposal(id);
      if (current.status !== "draft" && current.status !== "pending") {
        throw new Error(
          `invalid workshop proposal transition: ${current.status} -> rejected`,
        );
      }
      return transition(
        id,
        current.status,
        "rejected",
        actor,
        note,
        null,
        null,
      );
    }

    function markInstalled(
      id: string,
      receipt: unknown,
    ): WorkshopProposalRow {
      const receiptJson = jsonStringify(receipt, "installation receipt");
      return transition(
        id,
        "approved",
        "installed",
        "installer",
        undefined,
        new Date().toISOString(),
        receiptJson,
      );
    }

    function transitions(id: string): WorkshopTransitionRow[] {
      assertNonEmptyString(id, "proposal id");
      requireProposal(id);
      return (selectTransitions.all(id) as RawTransitionRow[])
        .map(transitionFromRaw);
    }

    function statusFromTransitions(id: string): ProposalStatus {
      const history = transitions(id);
      if (history.length === 0) {
        throw new Error(`workshop proposal has no transitions: ${id}`);
      }
      let expectedFrom: ProposalStatus | null = null;
      for (const entry of history) {
        if (entry.fromStatus !== expectedFrom) {
          throw new Error(
            `workshop transition log is discontinuous for ${id}: expected from_status ${String(expectedFrom)}, found ${String(entry.fromStatus)}`,
          );
        }
        expectedFrom = entry.toStatus;
      }
      return history[history.length - 1]!.toStatus;
    }

    function rebuildMirror(): number {
      mkdirSync(workshopDir, { recursive: true });
      for (const entry of readdirSync(workshopDir, { withFileTypes: true })) {
        if (
          entry.isFile()
          && (entry.name.endsWith(".md") || entry.name.endsWith(".md.tmp"))
        ) {
          unlinkSync(join(workshopDir, entry.name));
        }
      }
      const rows = list();
      for (const row of rows) {
        writeMirror(row, workshopDir);
      }
      return rows.length;
    }

    let closed = false;
    function close(): void {
      if (!closed) {
        db.close();
        closed = true;
      }
    }

    return {
      db,
      addDrafts,
      get,
      list,
      promoteToPending,
      approve,
      reject,
      markInstalled,
      transitions,
      statusFromTransitions,
      rebuildMirror,
      close,
    };
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}
