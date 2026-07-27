import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  join,
  resolve,
  sep,
} from "node:path";

import { isUlid, ulid } from "../schema/ulid.ts";

export type MemoryKind = "factual" | "gotcha" | "preference" | "behavior";
export type MemoryScope = "global" | "repo" | "agent";
export type MemoryStatus = "candidate" | "approved" | "rejected" | "retired";
export type MemorySource = "extraction" | "manual";

export interface MemoryEvidence {
  session_id: string;
  raw_ref: string | null;
}

export interface MemoryRow {
  id: string;
  claim: string;
  kind: MemoryKind;
  scope: MemoryScope;
  scope_key: string | null;
  confidence: number;
  status: MemoryStatus;
  evidence: MemoryEvidence[];
  source: MemorySource;
  claim_hash: string;
  created_at: string;
  updated_at: string;
  last_validated_at: string | null;
}

export interface AddMemoryInput {
  claim: string;
  kind: MemoryKind;
  scope: MemoryScope;
  scope_key?: string | null;
  confidence: number;
  /**
   * The calling pipeline must stamp evidence session_id values. Model output
   * must never supply them directly; this store validates the stamped shape.
   */
  evidence: MemoryEvidence[];
  source?: MemorySource;
  last_validated_at?: string | null;
}

export interface MemoryUpdate {
  claim?: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  scope_key?: string | null;
  confidence?: number;
  evidence?: MemoryEvidence[];
  last_validated_at?: string | null;
}

export interface MemoryFilter {
  status?: MemoryStatus;
  scope?: MemoryScope;
  scope_key?: string | null;
  kind?: MemoryKind;
  staleBefore?: string;
}

export interface MemoryStore {
  addCandidate(input: AddMemoryInput): MemoryRow;
  addManual(input: AddMemoryInput): MemoryRow;
  approve(id: string): MemoryRow;
  reject(id: string): MemoryRow;
  retire(id: string): MemoryRow;
  update(id: string, fields: MemoryUpdate): MemoryRow;
  listMemories(filter?: MemoryFilter): MemoryRow[];
  getMemory(id: string): MemoryRow | null;
  close(): void;
}

export interface OpenMemoryStoreOptions {
  dbPath?: string;
  memoryDir?: string;
  now?: () => Date;
}

interface MemoryDatabaseRow {
  id: unknown;
  claim: unknown;
  kind: unknown;
  scope: unknown;
  scope_key: unknown;
  confidence: unknown;
  status: unknown;
  evidence: unknown;
  source: unknown;
  claim_hash: unknown;
  created_at: unknown;
  updated_at: unknown;
  last_validated_at: unknown;
}

interface PreparedMemory {
  claim: string;
  kind: MemoryKind;
  scope: MemoryScope;
  scopeKey: string | null;
  confidence: number;
  evidence: MemoryEvidence[];
  source: MemorySource;
  lastValidatedAt: string | null;
}

const MEMORY_KINDS: ReadonlySet<string> = new Set([
  "factual",
  "gotcha",
  "preference",
  "behavior",
]);
const MEMORY_SCOPES: ReadonlySet<string> = new Set([
  "global",
  "repo",
  "agent",
]);
const MEMORY_STATUSES: ReadonlySet<string> = new Set([
  "candidate",
  "approved",
  "rejected",
  "retired",
]);
const MEMORY_SOURCES: ReadonlySet<string> = new Set([
  "extraction",
  "manual",
]);

const MEMORY_DDL = `
CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  claim             TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('factual','gotcha','preference','behavior')),
  scope             TEXT NOT NULL CHECK (scope IN ('global','repo','agent')),
  scope_key         TEXT,
  confidence        REAL NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('candidate','approved','rejected','retired')),
  evidence          TEXT NOT NULL CHECK (json_valid(evidence)),
  source            TEXT NOT NULL CHECK (source IN ('extraction','manual')),
  claim_hash        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_validated_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memories_claim_hash
  ON memories(claim_hash);
CREATE INDEX IF NOT EXISTS idx_memories_status_scope
  ON memories(status, scope);
`;

const MEMORY_COLUMNS = `
  id, claim, kind, scope, scope_key, confidence, status, evidence, source,
  claim_hash, created_at, updated_at, last_validated_at
`;

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

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${label} contains unsupported field ${JSON.stringify(key)}`);
    }
  }
}

function validateNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function validateNullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  return validateNonEmptyString(value, label);
}

function validateKind(value: unknown, label: string): MemoryKind {
  if (typeof value !== "string" || !MEMORY_KINDS.has(value)) {
    throw new Error(
      `${label} must be one of factual, gotcha, preference, behavior`,
    );
  }
  return value as MemoryKind;
}

function validateScope(value: unknown, label: string): MemoryScope {
  if (typeof value !== "string" || !MEMORY_SCOPES.has(value)) {
    throw new Error(`${label} must be one of global, repo, agent`);
  }
  return value as MemoryScope;
}

function validateStatus(value: unknown, label: string): MemoryStatus {
  if (typeof value !== "string" || !MEMORY_STATUSES.has(value)) {
    throw new Error(
      `${label} must be one of candidate, approved, rejected, retired`,
    );
  }
  return value as MemoryStatus;
}

function validateSource(value: unknown, label: string): MemorySource {
  if (typeof value !== "string" || !MEMORY_SOURCES.has(value)) {
    throw new Error(`${label} must be one of extraction, manual`);
  }
  return value as MemorySource;
}

function validateConfidence(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) {
    throw new Error(`${label} must be a finite number between 0 and 1`);
  }
  return value;
}

function validateScopeKey(
  scope: MemoryScope,
  scopeKey: unknown,
  label: string,
): string | null {
  if (scope === "global") {
    if (scopeKey !== null && scopeKey !== undefined) {
      throw new Error(`${label} must be null when scope is global`);
    }
    return null;
  }

  if (typeof scopeKey !== "string" || scopeKey.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string when scope is ${scope}`);
  }
  return scopeKey;
}

function validateEvidence(value: unknown, label: string): MemoryEvidence[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be an array with at least one entry`);
  }

  return value.map((entry: unknown, index: number): MemoryEvidence => {
    const entryLabel = `${label}[${index}]`;
    if (!isPlainObject(entry)) {
      throw new Error(`${entryLabel} must be an object`);
    }
    assertOnlyKeys(
      entry,
      new Set(["session_id", "raw_ref"]),
      entryLabel,
    );
    const sessionId = validateNonEmptyString(
      entry.session_id,
      `${entryLabel}.session_id`,
    );
    const rawRef = entry.raw_ref;
    if (rawRef !== null && typeof rawRef !== "string") {
      throw new Error(`${entryLabel}.raw_ref must be a string or null`);
    }
    return {
      session_id: sessionId,
      raw_ref: rawRef,
    };
  });
}

function serializeEvidence(evidence: MemoryEvidence[], label: string): string {
  try {
    return JSON.stringify(evidence);
  } catch (error: unknown) {
    throw new Error(`${label} could not be serialized: ${errorMessage(error)}`);
  }
}

function parseEvidence(value: unknown, memoryId: string): MemoryEvidence[] {
  if (typeof value !== "string") {
    throw new Error(`memory ${memoryId} has non-text stored evidence`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(
      `memory ${memoryId} has invalid stored evidence JSON: ${errorMessage(error)}`,
    );
  }
  return validateEvidence(parsed, `memory ${memoryId} stored evidence`);
}

function validateMemoryId(value: unknown, label: string): string {
  if (typeof value !== "string" || !isUlid(value)) {
    throw new Error(`${label} must be a ULID, got ${JSON.stringify(value)}`);
  }
  return value;
}

function currentTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("memory store now() must return a valid Date");
  }
  return value.toISOString();
}

function readMemoryRow(row: MemoryDatabaseRow): MemoryRow {
  const id = validateMemoryId(row.id, "stored memory id");
  const claim = validateNonEmptyString(row.claim, `memory ${id} claim`);
  const kind = validateKind(row.kind, `memory ${id} kind`);
  const scope = validateScope(row.scope, `memory ${id} scope`);
  const scopeKey = validateScopeKey(
    scope,
    row.scope_key,
    `memory ${id} scope_key`,
  );
  const confidence = validateConfidence(
    row.confidence,
    `memory ${id} confidence`,
  );
  const status = validateStatus(row.status, `memory ${id} status`);
  const evidence = parseEvidence(row.evidence, id);
  const source = validateSource(row.source, `memory ${id} source`);
  const storedClaimHash = validateNonEmptyString(
    row.claim_hash,
    `memory ${id} claim_hash`,
  );
  const expectedClaimHash = claimHash(claim);
  if (storedClaimHash !== expectedClaimHash) {
    throw new Error(`memory ${id} claim_hash does not match its claim`);
  }
  const createdAt = validateNonEmptyString(
    row.created_at,
    `memory ${id} created_at`,
  );
  const updatedAt = validateNonEmptyString(
    row.updated_at,
    `memory ${id} updated_at`,
  );
  const lastValidatedAt = validateNullableTimestamp(
    row.last_validated_at,
    `memory ${id} last_validated_at`,
  );

  return {
    id,
    claim,
    kind,
    scope,
    scope_key: scopeKey,
    confidence,
    status,
    evidence,
    source,
    claim_hash: storedClaimHash,
    created_at: createdAt,
    updated_at: updatedAt,
    last_validated_at: lastValidatedAt,
  };
}

function prepareAddInput(
  input: AddMemoryInput,
  defaultSource: MemorySource,
): PreparedMemory {
  if (!isPlainObject(input)) {
    throw new Error("memory input must be an object");
  }
  assertOnlyKeys(
    input,
    new Set([
      "claim",
      "kind",
      "scope",
      "scope_key",
      "confidence",
      "evidence",
      "source",
      "last_validated_at",
    ]),
    "memory input",
  );

  const claim = validateNonEmptyString(input.claim, "memory claim");
  const kind = validateKind(input.kind, "memory kind");
  const scope = validateScope(input.scope, "memory scope");
  const scopeKey = validateScopeKey(scope, input.scope_key, "memory scope_key");
  const confidence = validateConfidence(input.confidence, "memory confidence");
  const evidence = validateEvidence(input.evidence, "memory evidence");
  const source = input.source === undefined
    ? defaultSource
    : validateSource(input.source, "memory source");
  const lastValidatedAt = input.last_validated_at === undefined
    ? null
    : validateNullableTimestamp(
      input.last_validated_at,
      "memory last_validated_at",
    );

  return {
    claim,
    kind,
    scope,
    scopeKey,
    confidence,
    evidence,
    source,
    lastValidatedAt,
  };
}

function validateFilter(filter: MemoryFilter): void {
  if (!isPlainObject(filter)) {
    throw new Error("memory filter must be an object");
  }
  assertOnlyKeys(
    filter,
    new Set(["status", "scope", "scope_key", "kind", "staleBefore"]),
    "memory filter",
  );
  if (filter.status !== undefined) {
    validateStatus(filter.status, "memory filter status");
  }
  if (filter.scope !== undefined) {
    validateScope(filter.scope, "memory filter scope");
  }
  if (
    filter.scope_key !== undefined
    && filter.scope_key !== null
    && (
      typeof filter.scope_key !== "string"
      || filter.scope_key.trim().length === 0
    )
  ) {
    throw new Error("memory filter scope_key must be null or a non-empty string");
  }
  if (filter.kind !== undefined) {
    validateKind(filter.kind, "memory filter kind");
  }
  if (filter.staleBefore !== undefined) {
    validateNonEmptyString(filter.staleBefore, "memory filter staleBefore");
  }
}

function validateUpdate(fields: MemoryUpdate): Record<string, unknown> {
  if (!isPlainObject(fields)) {
    throw new Error("memory update must be an object");
  }
  if (Object.hasOwn(fields, "status")) {
    throw new Error(
      "status cannot be changed via update(); use approve/reject/retire",
    );
  }
  assertOnlyKeys(
    fields,
    new Set([
      "claim",
      "kind",
      "scope",
      "scope_key",
      "confidence",
      "evidence",
      "last_validated_at",
    ]),
    "memory update",
  );
  return fields;
}

export function normalizeClaim(claim: string): string {
  if (typeof claim !== "string") {
    throw new Error("claim to normalize must be a string");
  }
  return claim
    .toLowerCase()
    .replace(/\p{P}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function claimHash(claim: string): string {
  return createHash("sha256").update(normalizeClaim(claim)).digest("hex");
}

export function renderMemoryMarkdown(row: MemoryRow): string {
  const validated = readMemoryRow({
    ...row,
    evidence: serializeEvidence(
      validateEvidence(row.evidence, `memory ${row.id} evidence`),
      `memory ${row.id} evidence`,
    ),
  });
  const lines = [
    "---",
    `id: ${JSON.stringify(validated.id)}`,
    `claim: ${JSON.stringify(validated.claim)}`,
    `kind: ${JSON.stringify(validated.kind)}`,
    `scope: ${JSON.stringify(validated.scope)}`,
    `scope_key: ${validated.scope_key === null ? "null" : JSON.stringify(validated.scope_key)}`,
    `confidence: ${validated.confidence}`,
    `status: ${JSON.stringify(validated.status)}`,
    `evidence: ${JSON.stringify(validated.evidence)}`,
    `source: ${JSON.stringify(validated.source)}`,
    `claim_hash: ${JSON.stringify(validated.claim_hash)}`,
    `created_at: ${JSON.stringify(validated.created_at)}`,
    `updated_at: ${JSON.stringify(validated.updated_at)}`,
    `last_validated_at: ${
      validated.last_validated_at === null
        ? "null"
        : JSON.stringify(validated.last_validated_at)
    }`,
    "---",
    "",
    "# Claim",
    "",
    validated.claim,
    "",
    "## Evidence",
    "",
  ];

  for (const evidence of validated.evidence) {
    lines.push(
      `- session_id: ${JSON.stringify(evidence.session_id)}; raw_ref: ${
        evidence.raw_ref === null ? "null" : JSON.stringify(evidence.raw_ref)
      }`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function memoryMarkdownPath(row: MemoryRow, memoryDir: string): string {
  const id = validateMemoryId(row.id, "memory mirror id");
  const scope = validateScope(row.scope, `memory ${id} mirror scope`);
  const scopeDirectory = resolve(memoryDir, scope);
  const path = resolve(scopeDirectory, `${id}.md`);
  if (!path.startsWith(`${scopeDirectory}${sep}`)) {
    throw new Error(`memory mirror path escaped scope directory: ${path}`);
  }
  return path;
}

function writeMemoryMirror(row: MemoryRow, memoryDir: string): void {
  const path = memoryMarkdownPath(row, memoryDir);
  const temporaryPath = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporaryPath, renderMemoryMarkdown(row), "utf8");
    renameSync(temporaryPath, path);
  } catch (error: unknown) {
    throw new Error(
      `failed to write memory mirror for ${row.id}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export function openMemoryStore(
  options: OpenMemoryStoreOptions = {},
): MemoryStore {
  if (!isPlainObject(options)) {
    throw new Error("memory store options must be an object");
  }
  assertOnlyKeys(
    options,
    new Set(["dbPath", "memoryDir", "now"]),
    "memory store options",
  );
  const validatedOptions = options as OpenMemoryStoreOptions;
  const dbPath = validatedOptions.dbPath
    ?? join(homedir(), ".hyperagent", "hyperagent.db");
  const memoryDir = validatedOptions.memoryDir
    ?? join(homedir(), ".hyperagent", "memory");
  const now = validatedOptions.now ?? ((): Date => new Date());
  validateNonEmptyString(dbPath, "memory store dbPath");
  validateNonEmptyString(memoryDir, "memory store memoryDir");
  if (typeof now !== "function") {
    throw new Error("memory store now must be a function");
  }

  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  try {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
    } catch (error: unknown) {
      if (dbPath !== ":memory:") {
        throw new Error(
          `failed to enable SQLite WAL mode for memory store: ${errorMessage(error)}`,
        );
      }
      // In-memory SQLite databases cannot use WAL; a failure is harmless here.
    }
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(MEMORY_DDL);

    const selectMemory = db.query<MemoryDatabaseRow, [string]>(`
      SELECT ${MEMORY_COLUMNS}
      FROM memories
      WHERE id = ?
    `);
    const insertMemory = db.query(`
      INSERT INTO memories (
        id, claim, kind, scope, scope_key, confidence, status, evidence, source,
        claim_hash, created_at, updated_at, last_validated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateMemory = db.query<
      MemoryDatabaseRow,
      [
        string,
        MemoryKind,
        MemoryScope,
        string | null,
        number,
        string,
        string,
        string,
        string | null,
        string,
      ]
    >(`
      UPDATE memories
      SET
        claim = ?,
        kind = ?,
        scope = ?,
        scope_key = ?,
        confidence = ?,
        evidence = ?,
        claim_hash = ?,
        updated_at = ?,
        last_validated_at = ?
      WHERE id = ?
      RETURNING ${MEMORY_COLUMNS}
    `);
    const transitionMemory = db.query<
      MemoryDatabaseRow,
      [MemoryStatus, string, string]
    >(`
      UPDATE memories
      SET status = ?, updated_at = ?
      WHERE id = ?
      RETURNING ${MEMORY_COLUMNS}
    `);

    function getMemory(id: string): MemoryRow | null {
      const validatedId = validateMemoryId(id, "memory id");
      const row = selectMemory.get(validatedId);
      return row === null ? null : readMemoryRow(row);
    }

    function requireMemory(id: string): MemoryRow {
      const memory = getMemory(id);
      if (memory === null) {
        throw new Error(`memory ${id} was not found`);
      }
      return memory;
    }

    function add(
      input: AddMemoryInput,
      status: MemoryStatus,
      defaultSource: MemorySource,
    ): MemoryRow {
      const prepared = prepareAddInput(input, defaultSource);
      const timestamp = currentTimestamp(now);
      const id = ulid(new Date(timestamp).getTime());
      const source = status === "approved" ? "manual" : prepared.source;
      try {
        insertMemory.run(
          id,
          prepared.claim,
          prepared.kind,
          prepared.scope,
          prepared.scopeKey,
          prepared.confidence,
          status,
          serializeEvidence(prepared.evidence, `memory ${id} evidence`),
          source,
          claimHash(prepared.claim),
          timestamp,
          timestamp,
          prepared.lastValidatedAt,
        );
      } catch (error: unknown) {
        throw new Error(
          `failed to add ${status} memory ${id}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      const memory = requireMemory(id);
      writeMemoryMirror(memory, memoryDir);
      return memory;
    }

    function addCandidate(input: AddMemoryInput): MemoryRow {
      return add(input, "candidate", "extraction");
    }

    function addManual(input: AddMemoryInput): MemoryRow {
      return add(input, "approved", "manual");
    }

    function transition(id: string, status: MemoryStatus): MemoryRow {
      const validatedId = validateMemoryId(id, "memory id");
      const timestamp = currentTimestamp(now);
      let row: MemoryDatabaseRow | null;
      try {
        row = transitionMemory.get(status, timestamp, validatedId);
      } catch (error: unknown) {
        throw new Error(
          `failed to change memory ${validatedId} status to ${status}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      if (row === null) {
        throw new Error(`memory ${validatedId} was not found`);
      }
      const memory = readMemoryRow(row);
      writeMemoryMirror(memory, memoryDir);
      return memory;
    }

    function approve(id: string): MemoryRow {
      return transition(id, "approved");
    }

    function reject(id: string): MemoryRow {
      return transition(id, "rejected");
    }

    function retire(id: string): MemoryRow {
      return transition(id, "retired");
    }

    function update(id: string, fields: MemoryUpdate): MemoryRow {
      const validatedId = validateMemoryId(id, "memory id");
      const supplied = validateUpdate(fields);
      const current = requireMemory(validatedId);

      const claim = Object.hasOwn(supplied, "claim")
        ? validateNonEmptyString(supplied.claim, "memory update claim")
        : current.claim;
      const kind = Object.hasOwn(supplied, "kind")
        ? validateKind(supplied.kind, "memory update kind")
        : current.kind;
      const scope = Object.hasOwn(supplied, "scope")
        ? validateScope(supplied.scope, "memory update scope")
        : current.scope;
      const suppliedScopeKey = Object.hasOwn(supplied, "scope_key")
        ? supplied.scope_key
        : current.scope_key;
      const scopeKey = validateScopeKey(
        scope,
        suppliedScopeKey,
        "memory update scope_key",
      );
      const confidence = Object.hasOwn(supplied, "confidence")
        ? validateConfidence(
          supplied.confidence,
          "memory update confidence",
        )
        : current.confidence;
      const evidence = Object.hasOwn(supplied, "evidence")
        ? validateEvidence(supplied.evidence, "memory update evidence")
        : current.evidence;
      const lastValidatedAt = Object.hasOwn(supplied, "last_validated_at")
        ? validateNullableTimestamp(
          supplied.last_validated_at,
          "memory update last_validated_at",
        )
        : current.last_validated_at;
      const timestamp = currentTimestamp(now);

      let row: MemoryDatabaseRow | null;
      try {
        row = updateMemory.get(
          claim,
          kind,
          scope,
          scopeKey,
          confidence,
          serializeEvidence(evidence, `memory ${validatedId} evidence`),
          claimHash(claim),
          timestamp,
          lastValidatedAt,
          validatedId,
        );
      } catch (error: unknown) {
        throw new Error(
          `failed to update memory ${validatedId}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      if (row === null) {
        throw new Error(`memory ${validatedId} was not found`);
      }
      const memory = readMemoryRow(row);
      writeMemoryMirror(memory, memoryDir);
      return memory;
    }

    function listMemories(filter: MemoryFilter = {}): MemoryRow[] {
      validateFilter(filter);
      const clauses: string[] = [];
      const parameters: Array<string> = [];

      if (filter.status !== undefined) {
        clauses.push("status = ?");
        parameters.push(filter.status);
      }
      if (filter.scope !== undefined) {
        clauses.push("scope = ?");
        parameters.push(filter.scope);
      }
      if (filter.scope_key !== undefined) {
        if (filter.scope_key === null) {
          clauses.push("scope_key IS NULL");
        } else {
          clauses.push("scope_key = ?");
          parameters.push(filter.scope_key);
        }
      }
      if (filter.kind !== undefined) {
        clauses.push("kind = ?");
        parameters.push(filter.kind);
      }
      if (filter.staleBefore !== undefined) {
        clauses.push(
          "(last_validated_at IS NULL OR last_validated_at < ?)",
        );
        parameters.push(filter.staleBefore);
      }

      const where = clauses.length === 0
        ? ""
        : ` WHERE ${clauses.join(" AND ")}`;
      let rows: MemoryDatabaseRow[];
      try {
        rows = db
          .query<MemoryDatabaseRow, string[]>(`
            SELECT ${MEMORY_COLUMNS}
            FROM memories${where}
            ORDER BY scope, id
          `)
          .all(...parameters);
      } catch (error: unknown) {
        throw new Error(
          `failed to list memories: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      return rows.map(readMemoryRow);
    }

    let closed = false;
    function close(): void {
      if (closed) {
        return;
      }
      db.close();
      closed = true;
    }

    return {
      addCandidate,
      addManual,
      approve,
      reject,
      retire,
      update,
      listMemories,
      getMemory,
      close,
    };
  } catch (error: unknown) {
    try {
      db.close();
    } catch (closeError: unknown) {
      throw new Error(
        `memory store open failed (${errorMessage(error)}) and closing it also failed: ${errorMessage(closeError)}`,
      );
    }
    throw error;
  }
}
