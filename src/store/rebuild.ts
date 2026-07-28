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
 */

import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { openStore } from "./store.ts";

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
