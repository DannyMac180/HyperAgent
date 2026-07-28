/**
 * Store rebuild (DAN-217).
 *
 * Event ids used to hash the absolute artifact path, so the same session
 * ingested from a moved/restored directory produced different ids and the
 * append-only log silently accumulated duplicates. The derivation is fixed;
 * this rebuilds the existing store under the corrected scheme.
 *
 * The events table enforces append-only with ABORT triggers on UPDATE and
 * DELETE, so ids cannot be rewritten in place — by design. A rebuild is
 * therefore a *fresh database* re-ingested from the source artifacts, and
 * this module never drops a trigger or touches `writable_schema`.
 *
 * Two things are preserved rather than destroyed, always before any
 * irreversible step:
 *   1. Orphaned events — those whose source artifact no longer exists on
 *      disk and so cannot be re-derived — are exported to a JSON archive.
 *      They become non-queryable, never deleted.
 *   2. The previous database file is moved to a timestamped archive.
 *
 * Deliberately NOT carried into the new database: the orphaned rows. Inserting
 * them would reintroduce the very second id scheme the rebuild exists to
 * eliminate.
 *
 * Sibling tables (DAN-218). Other engines park their tables in this same file —
 * the memory store's `memories`, scoring's `session_scores`, the gate's
 * `policy_violations`. A fresh database gets the event-store DDL and nothing
 * else, so before this every one of them was silently destroyed. Each table is
 * now classified and handled explicitly:
 *
 *   event_store — rebuilt from the transcripts by ingest.
 *   derived     — recomputable from events, and keyed to event ids or offsets
 *                 that the rebuild deliberately changes. Dropped; carrying them
 *                 would resurrect rows pointing at the old id scheme.
 *   durable     — everything else. Carried through verbatim.
 *
 * The default is DURABLE, and the exception list is the derived one. For a
 * data-loss defect that is the only safe direction: an engine that adds a table
 * tomorrow gets preservation without touching this file, and the failure mode of
 * a misclassification is a stale table a human can drop, not lost data.
 *
 * Classification reads the database's own schema. This module imports no engine
 * module and knows no engine's DDL — that is what keeps it engine-blind.
 */

import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { openStore } from "./store.ts";

/**
 * Tables the event store itself owns. Recreated by `openStore`'s DDL and
 * repopulated by ingest, so carrying them would fight the rebuild.
 */
export const EVENT_STORE_TABLES: readonly string[] = [
  "events",
  "meta",
  "sessions",
];

/**
 * Tables that are pure functions of the event log AND are keyed to values the
 * rebuild changes — `policy_violations.event_id` holds event ids, and
 * `session_scores.event_watermark` is an offset into the old log. Recomputing
 * them is correct; copying them is not.
 *
 * Membership is asserted by test. Adding a name here converts a table from
 * preserved to destroyed, so it must be a deliberate, reviewed act.
 */
export const DERIVED_TABLES: readonly string[] = [
  "policy_violations",
  "session_scores",
];

export type TableBucket = "event_store" | "derived" | "durable";

export interface TableInventoryEntry {
  name: string;
  bucket: TableBucket;
  rows: number;
}

export function classifyTable(name: string): TableBucket {
  if (EVENT_STORE_TABLES.includes(name)) {
    return "event_store";
  }
  if (DERIVED_TABLES.includes(name)) {
    return "derived";
  }
  return "durable";
}

/** An event whose source artifact is gone, so it cannot be re-derived. */
export interface OrphanedEvent {
  id: string;
  ts: string;
  type: string;
  session_id: string;
  vendor: string;
  raw_ref: string | null;
  payload: string;
}

export interface RebuildPlan {
  /** Absolute path of the database that will be archived. */
  dbPath: string;
  /** Distinct source artifacts referenced by the current store. */
  sourceArtifacts: number;
  /** Referenced artifacts no longer present on disk. */
  missingArtifacts: string[];
  /** Events belonging to those missing artifacts. */
  orphans: OrphanedEvent[];
  /** Event counts per vendor, before the rebuild. */
  eventsByVendor: Record<string, number>;
  /**
   * Every table in the store, classified. This is the rebuild's blast radius,
   * stated before anything irreversible happens (DAN-218).
   */
  tables: TableInventoryEntry[];
}

export interface RebuildPaths {
  archivedDb: string;
  orphanArchive: string;
  archivedState: string | null;
}

/**
 * Extract the artifact path a raw_ref points at, or null when it doesn't
 * point at a file at all.
 *
 * Load-bearing: raw_ref means two different things either side of the DAN-217
 * fix. Pre-fix rows carry `<absolute-path>#L<n>`; post-fix rows carry
 * `<canonical-session-id>#L<n>`, which is deliberately NOT a path. Treating
 * the latter as a filename makes `existsSync` fail for every corrected row and
 * reports the whole store as orphaned — caught in rehearsal, where this said
 * 21,314 orphans instead of 25.
 *
 * Only absolute paths are artifact-backed; anything else is a session-scoped
 * ref whose events are re-derivable and therefore never an orphan.
 */
function artifactOf(rawRef: string): string | null {
  if (!rawRef.startsWith("/")) {
    return null;
  }
  const hash: number = rawRef.lastIndexOf("#");
  return hash === -1 ? rawRef : rawRef.slice(0, hash);
}

/**
 * Read every user table out of a live database handle and classify it.
 *
 * `sqlite_%` is excluded because those are SQLite's own bookkeeping tables
 * (`sqlite_sequence`, `sqlite_stat1`); SQLite recreates them as needed and they
 * are not anybody's data.
 */
function inventoryTables(db: Database): TableInventoryEntry[] {
  const rows = db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' " +
      "AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[];

  return rows.map((row): TableInventoryEntry => ({
    name: row.name,
    bucket: classifyTable(row.name),
    // The name comes from sqlite_master, never from caller input, so it cannot
    // be an injection vector; quoting still guards against odd identifiers.
    rows: (db.query(
      `SELECT count(*) AS n FROM "${row.name.replaceAll('"', '""')}"`,
    ).get() as { n: number }).n,
  }));
}

/**
 * Inspect the store without modifying it. Safe to run at any time — this is
 * what makes the rebuild previewable before anything irreversible happens.
 */
export function planRebuild(dataDir?: string): RebuildPlan {
  const dir: string = dataDir ?? join(homedir(), ".hyperagent");
  const dbPath: string = join(dir, "hyperagent.db");
  const store = openStore(dbPath);
  try {
    // openStore exposes no raw query surface by design; the rebuild is the one
    // caller that legitimately needs whole-table reads, so it reaches for the
    // underlying handle rather than widening the Store interface for everyone.
    const db = (store as unknown as { db: import("bun:sqlite").Database }).db;

    const eventsByVendor: Record<string, number> = {};
    for (
      const row of db.query(
        "SELECT vendor, count(*) AS n FROM events GROUP BY vendor",
      ).all() as { vendor: string; n: number }[]
    ) {
      eventsByVendor[row.vendor] = row.n;
    }

    const refs = db.query(
      "SELECT DISTINCT raw_ref FROM events WHERE raw_ref IS NOT NULL",
    ).all() as { raw_ref: string }[];

    const artifacts = new Set<string>();
    for (const row of refs) {
      const artifact: string | null = artifactOf(row.raw_ref);
      if (artifact !== null) {
        artifacts.add(artifact);
      }
    }

    const missingArtifacts: string[] = [];
    for (const artifact of artifacts) {
      if (!existsSync(artifact)) {
        missingArtifacts.push(artifact);
      }
    }
    missingArtifacts.sort();

    const orphans: OrphanedEvent[] = [];
    for (const artifact of missingArtifacts) {
      const rows = db.query(
        "SELECT id, ts, type, session_id, vendor, raw_ref, payload " +
          "FROM events WHERE raw_ref = ?1 OR raw_ref LIKE ?2",
      ).all(artifact, `${artifact}#%`) as OrphanedEvent[];
      orphans.push(...rows);
    }

    return {
      dbPath,
      sourceArtifacts: artifacts.size,
      missingArtifacts,
      orphans,
      eventsByVendor,
      tables: inventoryTables(db),
    };
  } finally {
    store.close();
  }
}

/**
 * Archive the orphans and the current database, leaving `dataDir` ready for a
 * fresh ingest. Ordering is the safety property: the orphan export is written
 * and verified BEFORE the database is moved, so a failure at any point leaves
 * the original store exactly where it was.
 *
 * Returns the archive paths. Nothing is ever deleted.
 *
 * `stamp` is injected rather than read from the clock so tests are
 * deterministic and a caller can correlate the archive with a run log.
 */
export async function archiveForRebuild(
  plan: RebuildPlan,
  stamp: string,
  dataDir?: string,
): Promise<RebuildPaths> {
  const dir: string = dataDir ?? join(homedir(), ".hyperagent");
  const archiveDir: string = join(dir, "archive");
  await mkdir(archiveDir, { recursive: true });

  const orphanArchive: string = join(
    archiveDir,
    `orphaned-events-${stamp}.json`,
  );
  await writeFile(
    orphanArchive,
    `${JSON.stringify(
      {
        exported_at: stamp,
        reason:
          "source artifact no longer on disk; not re-derivable by ingest (DAN-217 rebuild)",
        missing_artifacts: plan.missingArtifacts,
        events: plan.orphans,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (!existsSync(orphanArchive)) {
    throw new Error(`orphan archive was not written: ${orphanArchive}`);
  }

  const archivedDb: string = join(archiveDir, `hyperagent-${stamp}.db`);
  await rename(plan.dbPath, archivedDb);
  // WAL/SHM siblings are checkpointed state for a database that no longer sits
  // at that path; moving them keeps the archived copy self-consistent.
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${plan.dbPath}${suffix}`)) {
      await rename(`${plan.dbPath}${suffix}`, `${archivedDb}${suffix}`);
    }
  }

  // Resume tokens describe byte offsets already ingested. Left in place they
  // would make the fresh database skip every artifact and rebuild to nothing.
  let archivedState: string | null = null;
  const statePath: string = join(dir, "ingest-state.json");
  if (existsSync(statePath)) {
    archivedState = join(archiveDir, `ingest-state-${stamp}.json`);
    await rename(statePath, archivedState);
  }

  return { archivedDb, orphanArchive, archivedState };
}

export interface CarriedTable {
  name: string;
  rows: number;
}

export interface CarryThroughResult {
  carried: CarriedTable[];
  /** Derived tables that were present and are being left to be recomputed. */
  droppedDerived: string[];
}

/**
 * Copy durable sibling tables out of the archived database into the rebuilt one
 * (DAN-218).
 *
 * Runs AFTER the fresh ingest, deliberately: if ingest fails the new database is
 * incomplete and gets re-run, and a half-carried table would then be copied on
 * top of itself. Running last means carry-through either completes against a
 * finished database or does not run at all.
 *
 * Schema text is taken verbatim from the archive's `sqlite_master` rather than
 * from any engine's DDL constant, so a table this module has never heard of is
 * reproduced exactly — including its indexes and triggers.
 *
 * Failure is loud. A silent carry failure is indistinguishable from the defect
 * this function exists to fix, so any error propagates with the archive path
 * attached; the archive still holds every row and nothing has been deleted.
 */
export function carryDurableTables(
  archivedDb: string,
  rebuiltDb: string,
): CarryThroughResult {
  if (!existsSync(archivedDb)) {
    throw new Error(`archived database not found for carry-through: ${archivedDb}`);
  }

  const source = new Database(archivedDb, { readonly: true });
  try {
    const inventory = inventoryTables(source);
    const durable = inventory.filter(
      (entry): boolean => entry.bucket === "durable",
    );
    const droppedDerived = inventory
      .filter((entry): boolean => entry.bucket === "derived")
      .map((entry): string => entry.name);

    if (durable.length === 0) {
      return { carried: [], droppedDerived };
    }

    const target = new Database(rebuiltDb);
    try {
      target.exec("PRAGMA busy_timeout = 5000;");
      const carried: CarriedTable[] = [];

      for (const entry of durable) {
        try {
          carried.push(carryOneTable(source, target, archivedDb, entry));
        } catch (error: unknown) {
          throw new Error(
            `failed to carry table "${entry.name}" into the rebuilt store; ` +
              `no data was lost — every row is still in ${archivedDb}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return { carried, droppedDerived };
    } finally {
      target.close();
    }
  } finally {
    source.close();
  }
}

/**
 * Recreate one table (schema, rows, then its indexes and triggers) in the
 * rebuilt database.
 *
 * Order matters: indexes are created AFTER the rows are inserted, which is both
 * faster and avoids a partially-built index if an insert fails.
 */
function carryOneTable(
  source: Database,
  target: Database,
  archivedDb: string,
  entry: TableInventoryEntry,
): CarriedTable {
  const quoted = `"${entry.name.replaceAll('"', '""')}"`;

  const tableSql = (source.query(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
  ).get(entry.name) as { sql: string | null } | null)?.sql ?? null;
  if (tableSql === null) {
    throw new Error(`no CREATE TABLE statement recorded for ${entry.name}`);
  }

  // A table of this name in the rebuilt store would only exist if some engine
  // opened the fresh database and created an empty one before carry-through
  // ran. Its own DDL made it, so the schema matches; the rows are what matter.
  const existing = (target.query(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?1",
  ).get(entry.name) as { n: number }).n;
  if (existing === 0) {
    target.exec(tableSql);
  } else {
    const targetRows = (target.query(
      `SELECT count(*) AS n FROM ${quoted}`,
    ).get() as { n: number }).n;
    if (targetRows > 0) {
      throw new Error(
        `${entry.name} already holds ${targetRows} row(s) in the rebuilt store; ` +
          "refusing to merge two versions of the same table",
      );
    }
  }

  const rows = source.query(`SELECT * FROM ${quoted}`).all() as Record<
    string,
    unknown
  >[];

  if (rows.length > 0) {
    const columns = Object.keys(rows[0] as Record<string, unknown>);
    const columnList = columns
      .map((column): string => `"${column.replaceAll('"', '""')}"`)
      .join(", ");
    const placeholders = columns
      .map((_column, index): string => `?${index + 1}`)
      .join(", ");
    const insert = target.query(
      `INSERT INTO ${quoted} (${columnList}) VALUES (${placeholders})`,
    );
    target.transaction((): void => {
      for (const row of rows) {
        insert.run(
          ...columns.map((column): unknown => row[column]) as never[],
        );
      }
    })();
  }

  for (
    const object of source.query(
      "SELECT sql FROM sqlite_master WHERE tbl_name = ?1 " +
        "AND type IN ('index', 'trigger') AND sql IS NOT NULL",
    ).all(entry.name) as { sql: string }[]
  ) {
    try {
      target.exec(object.sql);
    } catch (error: unknown) {
      // An index that already exists is not a failure — the engine's own DDL
      // created it when it opened the fresh database. Anything else is.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("already exists")) {
        throw new Error(`${message} (archive retained at ${archivedDb})`);
      }
    }
  }

  const carriedRows = (target.query(
    `SELECT count(*) AS n FROM ${quoted}`,
  ).get() as { n: number }).n;
  if (carriedRows !== rows.length) {
    throw new Error(
      `expected ${rows.length} row(s) after carry, found ${carriedRows}`,
    );
  }

  return { name: entry.name, rows: carriedRows };
}
