import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/**
 * Remove one vendor's records from the store, at the pilot's instruction.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A CONTRADICTION.
 *
 * The event store is append-only: `events` carries BEFORE UPDATE and BEFORE
 * DELETE triggers that ABORT, and they stay armed here. Append-only is what
 * makes the record trustworthy — it is the guarantee that nothing *inside* the
 * loop, agent or daemon or judgment plane, can quietly rewrite what happened.
 * It was never a claim that the person whose machine this is cannot remove
 * their own data. The vision is explicit on the point: the pilot owns the
 * record.
 *
 * So this module honours the invariant literally rather than suspending it.
 * No DELETE is ever executed. A new database is written containing only the
 * rows that are being kept, it is verified, and only then does it replace the
 * old one — which is archived, not destroyed. The triggers are never dropped,
 * because nothing ever asks them to fire.
 *
 * WHY NOT `rebuild`. `scope set --exclude-vendors X` followed by
 * `rebuild --apply` composes into something that looks like a purge and is not
 * one. Rebuild discards the whole store and re-reads every transcript still on
 * disk, so it also silently drops sessions belonging to vendors the pilot is
 * KEEPING, whenever the harness has since rotated its transcripts away (Claude
 * Code's `cleanupPeriodDays` defaults to 30). Worse, it cannot warn about it:
 * after DAN-217 `raw_ref` holds a session id rather than a path, so the orphan
 * detector has nothing to check and reports zero by construction. A purge whose
 * blast radius reaches data the pilot did not consent to lose is not a purge.
 *
 * WHAT IS REMOVED (the ratified scope, 2026-08-20): the vendor's events and
 * sessions, and anything derived from those sessions — scores, policy
 * violations, and any future table keyed the same way. Lessons/memories are
 * KEPT: they are the pilot's own knowledge, vendor-neutral by design, and
 * detaching an agent should not cost what was learned from it. A lesson whose
 * evidence pointed only at purged sessions keeps its citation and that citation
 * stops resolving — which is the honest outcome, and is what
 * `docs/evidence-policy.md` already describes for a transcript deleted
 * out from under the store.
 */

/** How one table is affected. `rows` is the count on the relevant side. */
export interface PurgeTableEffect {
  name: string;
  rows: number;
}

export interface VendorPurgePlan {
  dbPath: string;
  /** Canonical vendor id, lower-cased. */
  vendor: string;
  /** Rows that will NOT be carried into the new store, per table. */
  removed: PurgeTableEffect[];
  /** Rows that WILL be carried, per table. */
  retained: PurgeTableEffect[];
  /** Surviving event counts per vendor — what the store looks like after. */
  retainedByVendor: Record<string, number>;
  /** Sessions belonging to the vendor; the key derived tables are filtered on. */
  sessionIds: string[];
  /** `ingest-state.json` resume entries that will be forgotten. */
  ingestStateEntries: number;
  /** True when this vendor has nothing in the store — a no-op purge. */
  empty: boolean;
}

export interface PurgePaths {
  archivedDb: string;
  archivedState: string | null;
}

/**
 * How a table relates to a vendor, decided by its columns rather than by a
 * hard-coded list. A derived table added later that is keyed on `session_id`
 * is filtered correctly without this module being told about it; the failure
 * mode of a name-based list is that such a table silently survives the purge
 * holding rows about sessions that no longer exist.
 */
type TableFilter =
  | { kind: "vendor" }
  | { kind: "session" }
  | { kind: "carry" };

function columnsOf(db: Database, table: string): Set<string> {
  const rows = db.query(
    `PRAGMA table_info("${table.replaceAll('"', '""')}")`,
  ).all() as { name: string }[];
  return new Set(rows.map((row): string => row.name));
}

function filterFor(db: Database, table: string): TableFilter {
  const columns = columnsOf(db, table);
  if (columns.has("vendor")) {
    return { kind: "vendor" };
  }
  if (columns.has("session_id")) {
    return { kind: "session" };
  }
  return { kind: "carry" };
}

function userTables(db: Database): string[] {
  const rows = db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' " +
      "AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[];
  return rows.map((row): string => row.name);
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * A SQL predicate selecting the rows to KEEP, plus its bound parameters.
 *
 * Session ids are bound as parameters rather than interpolated. They come from
 * the store rather than from user input, but a purge is exactly the operation
 * where a quoting mistake is unrecoverable, so it does not rely on their shape.
 */
function keepClause(
  filter: TableFilter,
  vendor: string,
  sessionIds: string[],
): { sql: string; params: string[] } {
  if (filter.kind === "carry") {
    return { sql: "", params: [] };
  }
  if (filter.kind === "vendor") {
    // `vendor IS NOT ?` rather than `<>` so a NULL vendor is kept rather than
    // silently dropped: `NULL <> 'codex'` is NULL, which SQLite treats as false.
    // A row whose vendor we cannot read is not evidence that it belongs to the
    // vendor being removed.
    return { sql: `WHERE vendor IS NOT ?1`, params: [vendor] };
  }
  if (sessionIds.length === 0) {
    return { sql: "", params: [] };
  }
  const placeholders = sessionIds.map((_, i): string => `?${i + 1}`).join(", ");
  return {
    sql: `WHERE session_id IS NULL OR session_id NOT IN (${placeholders})`,
    params: sessionIds,
  };
}

function countWhere(
  db: Database,
  table: string,
  clause: { sql: string; params: string[] },
): number {
  const query = db.query(
    `SELECT count(*) AS n FROM ${quote(table)} ${clause.sql}`,
  );
  const row = (clause.params.length === 0
    ? query.get()
    : query.get(...clause.params)) as { n: number };
  return row.n;
}

/**
 * Inspect without modifying. This is what makes the purge previewable, and it
 * is the same numbers the confirmation UI is required to show — a destructive
 * action the pilot cannot see the size of is not consented to.
 */
export function planVendorPurge(
  vendor: string,
  dataDir?: string,
): VendorPurgePlan {
  const dir: string = dataDir ?? join(homedir(), ".hyperagent");
  const dbPath: string = join(dir, "hyperagent.db");
  const canonical: string = vendor.trim().toLowerCase();
  if (canonical.length === 0) {
    throw new Error("a vendor is required");
  }
  if (!existsSync(dbPath)) {
    throw new Error(`no store to purge from: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const sessionIds = (db.query(
      "SELECT session_id FROM sessions WHERE vendor = ?1 ORDER BY session_id",
    ).all(canonical) as { session_id: string }[]).map(
      (row): string => row.session_id,
    );

    const removed: PurgeTableEffect[] = [];
    const retained: PurgeTableEffect[] = [];
    for (const table of userTables(db)) {
      const filter = filterFor(db, table);
      const clause = keepClause(filter, canonical, sessionIds);
      const total = countWhere(db, table, { sql: "", params: [] });
      const keep = countWhere(db, table, clause);
      retained.push({ name: table, rows: keep });
      if (total - keep > 0) {
        removed.push({ name: table, rows: total - keep });
      }
    }

    const retainedByVendor: Record<string, number> = {};
    for (
      const row of db.query(
        "SELECT vendor, count(*) AS n FROM events WHERE vendor IS NOT ?1 GROUP BY vendor",
      ).all(canonical) as { vendor: string; n: number }[]
    ) {
      retainedByVendor[row.vendor] = row.n;
    }

    return {
      dbPath,
      vendor: canonical,
      removed,
      retained,
      retainedByVendor,
      sessionIds,
      ingestStateEntries: countIngestState(dir, canonical),
      empty: removed.length === 0,
    };
  } finally {
    db.close();
  }
}

interface IngestStateFile {
  v?: number;
  sessions?: Record<string, { vendor?: string }>;
}

function readIngestState(dir: string): IngestStateFile | null {
  const path = join(dir, "ingest-state.json");
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as IngestStateFile;
  } catch {
    return null;
  }
}

function countIngestState(dir: string, vendor: string): number {
  const state = readIngestState(dir);
  if (state?.sessions === undefined) {
    return 0;
  }
  return Object.values(state.sessions).filter(
    (entry): boolean => entry?.vendor?.toLowerCase() === vendor,
  ).length;
}

/**
 * Carry out the purge.
 *
 * Ordering IS the safety property, and it is deliberately stricter than the
 * rebuild's (DAN-218 left a window where the new store was assembled in place).
 * Here the replacement is built at a temporary path and verified against the
 * plan BEFORE the original is touched at all. Every failure mode short of the
 * final rename leaves the live store exactly where it was, untouched and
 * complete; the temporary file is the only casualty.
 *
 * `stamp` is injected rather than read from the clock so tests are
 * deterministic and a caller can correlate the archive with a run log.
 */
export async function purgeVendor(
  plan: VendorPurgePlan,
  stamp: string,
  dataDir?: string,
): Promise<PurgePaths> {
  const dir: string = dataDir ?? join(homedir(), ".hyperagent");
  const temporaryDb: string = `${plan.dbPath}.purge-${stamp}`;
  if (existsSync(temporaryDb)) {
    throw new Error(`refusing to overwrite an existing file: ${temporaryDb}`);
  }

  const source = new Database(plan.dbPath, { readonly: true });
  try {
    // Written schema-verbatim from the source's own `sqlite_master`, never from
    // a DDL constant in this repo: a table some other engine created — the
    // judgment plane's scores, a future engine's own — must come through
    // byte-identical, including CHECK constraints this module has never heard
    // of. The same reasoning as DAN-218's carry-through.
    const target = new Database(temporaryDb);
    try {
      target.exec("PRAGMA busy_timeout = 5000;");
      target.exec(`ATTACH DATABASE '${plan.dbPath.replaceAll("'", "''")}' AS src`);

      const tables = userTables(source);
      for (const table of tables) {
        const ddl = (source.query(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
        ).get(table) as { sql: string } | null)?.sql;
        if (!ddl) {
          throw new Error(`no schema recorded for table "${table}"`);
        }
        target.exec(ddl);

        const clause = keepClause(
          filterFor(source, table),
          plan.vendor,
          plan.sessionIds,
        );
        const insert = `INSERT INTO main.${quote(table)} ` +
          `SELECT * FROM src.${quote(table)} ${clause.sql}`;
        if (clause.params.length === 0) {
          target.exec(insert);
        } else {
          target.query(insert).run(...clause.params);
        }
      }

      // Indexes and triggers last, and verbatim. The append-only triggers are
      // among them: the new store comes out of this armed exactly as the old
      // one was, which is the point — this operation removes rows without
      // weakening the guarantee that nothing else can.
      for (
        const row of source.query(
          "SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger') " +
            "AND sql IS NOT NULL ORDER BY type",
        ).all() as { sql: string }[]
      ) {
        target.exec(row.sql);
      }

      verifyAgainstPlan(target, plan);
      target.exec("DETACH DATABASE src");
    } finally {
      target.close();
    }
  } finally {
    source.close();
  }

  // Re-read the source AFTER the copy. If the daemon wrote to it while we were
  // building, the replacement is already stale and swapping it in would silently
  // discard those events. Cheaper and more portable than trying to detect the
  // daemon, and it fails closed.
  assertSourceUnchanged(plan);

  const archiveDir: string = join(dir, "archive");
  await mkdir(archiveDir, { recursive: true });
  const archivedDb: string = join(
    archiveDir,
    `hyperagent-${stamp}-pre-purge-${plan.vendor}.db`,
  );
  await rename(plan.dbPath, archivedDb);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${plan.dbPath}${suffix}`)) {
      await rename(`${plan.dbPath}${suffix}`, `${archivedDb}${suffix}`);
    }
  }
  await rename(temporaryDb, plan.dbPath);

  const archivedState = await forgetIngestState(dir, plan.vendor, stamp);
  return { archivedDb, archivedState };
}

/**
 * The new store must contain exactly what the plan promised. A mismatch means
 * the filter and the preview disagree, and the pilot consented to the preview —
 * so this aborts before anything is swapped rather than shipping a surprise.
 */
function verifyAgainstPlan(target: Database, plan: VendorPurgePlan): void {
  for (const expected of plan.retained) {
    const actual = (target.query(
      `SELECT count(*) AS n FROM main.${quote(expected.name)}`,
    ).get() as { n: number }).n;
    if (actual !== expected.rows) {
      throw new Error(
        `purge verification failed for "${expected.name}": kept ${actual} ` +
          `row(s), plan said ${expected.rows}. Nothing was changed — ` +
          `the live store is untouched.`,
      );
    }
  }
  const leftover = (target.query(
    "SELECT count(*) AS n FROM main.events WHERE vendor IS ?1",
  ).get(plan.vendor) as { n: number }).n;
  if (leftover !== 0) {
    throw new Error(
      `purge verification failed: ${leftover} ${plan.vendor} event(s) ` +
        `survived the filter. Nothing was changed.`,
    );
  }
}

function assertSourceUnchanged(plan: VendorPurgePlan): void {
  const db = new Database(plan.dbPath, { readonly: true });
  try {
    for (const table of ["events", "sessions"]) {
      const expected = plan.retained.find(
        (entry): boolean => entry.name === table,
      );
      const removed = plan.removed.find(
        (entry): boolean => entry.name === table,
      );
      const total = (db.query(
        `SELECT count(*) AS n FROM ${quote(table)}`,
      ).get() as { n: number }).n;
      const planned = (expected?.rows ?? 0) + (removed?.rows ?? 0);
      if (total !== planned) {
        throw new Error(
          `the store changed while the purge was being prepared ` +
            `("${table}": ${planned} row(s) when planned, ${total} now). ` +
            `Nothing was changed. Stop the daemon and re-run:\n` +
            `  launchctl bootout gui/$UID/com.hyperagent.hyperagentd`,
        );
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Drop the vendor's resume tokens.
 *
 * Without this the purge is undone in the worst possible way: the sessions are
 * gone from the store, but ingest still believes it has already read them to
 * byte N, so re-attaching the vendor later restores nothing and leaves a
 * permanent hole that looks like data loss rather than a choice.
 */
async function forgetIngestState(
  dir: string,
  vendor: string,
  stamp: string,
): Promise<string | null> {
  const path = join(dir, "ingest-state.json");
  const state = readIngestState(dir);
  if (state?.sessions === undefined) {
    return null;
  }

  const archiveDir = join(dir, "archive");
  await mkdir(archiveDir, { recursive: true });
  const archived = join(archiveDir, `ingest-state-${stamp}-pre-purge.json`);
  writeFileSync(archived, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const kept: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(state.sessions)) {
    if (entry?.vendor?.toLowerCase() !== vendor) {
      kept[key] = entry;
    }
  }
  const next = { ...state, sessions: kept };
  // tmp-then-rename for the same reason `scope.ts` does it: `watch` re-reads
  // this file on every pass, and a half-written one parses as "nothing ingested".
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  return archived;
}
