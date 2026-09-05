import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type {
  ConfigurationChange,
  ConfigurationChanges,
  ConfigurationEntry,
  ConfigurationScope,
  ConfigurationSnapshot,
  ConfigurationSnapshotReport,
  ConfigurationScopeReport,
} from "./types.ts";

const CONFIGURATION_STORE_DDL = `
CREATE TABLE IF NOT EXISTS configuration_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json))
) STRICT;

CREATE TABLE IF NOT EXISTS configuration_entries (
  snapshot_id INTEGER NOT NULL REFERENCES configuration_snapshots(id),
  entry_key TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json)),
  PRIMARY KEY (snapshot_id, entry_key)
) STRICT;

CREATE TABLE IF NOT EXISTS configuration_changes (
  snapshot_id INTEGER NOT NULL REFERENCES configuration_snapshots(id),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('added', 'removed', 'changed')),
  entry_key TEXT NOT NULL,
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json)),
  PRIMARY KEY (snapshot_id, change_kind, entry_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_configuration_entries_scope
  ON configuration_entries(scope_id, snapshot_id DESC);

CREATE TRIGGER IF NOT EXISTS configuration_snapshots_no_update
  BEFORE UPDATE ON configuration_snapshots
  BEGIN SELECT RAISE(ABORT, 'configuration_snapshots is append-only'); END;
CREATE TRIGGER IF NOT EXISTS configuration_snapshots_no_delete
  BEFORE DELETE ON configuration_snapshots
  BEGIN SELECT RAISE(ABORT, 'configuration_snapshots is append-only'); END;
CREATE TRIGGER IF NOT EXISTS configuration_entries_no_update
  BEFORE UPDATE ON configuration_entries
  BEGIN SELECT RAISE(ABORT, 'configuration_entries is append-only'); END;
CREATE TRIGGER IF NOT EXISTS configuration_entries_no_delete
  BEFORE DELETE ON configuration_entries
  BEGIN SELECT RAISE(ABORT, 'configuration_entries is append-only'); END;
CREATE TRIGGER IF NOT EXISTS configuration_changes_no_update
  BEFORE UPDATE ON configuration_changes
  BEGIN SELECT RAISE(ABORT, 'configuration_changes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS configuration_changes_no_delete
  BEFORE DELETE ON configuration_changes
  BEGIN SELECT RAISE(ABORT, 'configuration_changes is append-only'); END;
`;

interface SnapshotRow {
  id: number;
  observed_at: string;
  scopes_json: string;
}

interface EntryRow {
  entry_json: string;
}

interface ChangeRow {
  change_kind: ConfigurationChange["kind"];
  entry_json: string;
}

export interface ConfigurationStore {
  readonly db: Database;
  writeSnapshot(
    observedAt: string,
    scopes: readonly ConfigurationScope[],
    entries: readonly ConfigurationEntry[],
    changes: ConfigurationChanges,
  ): ConfigurationSnapshot;
  recordSnapshot(
    observedAt: string,
    scopes: readonly ConfigurationScope[],
    entries: readonly ConfigurationEntry[],
    calculateChanges: (previousByScope: ReadonlyMap<string, ConfigurationSnapshot | null>) => ConfigurationChanges,
  ): { snapshot: ConfigurationSnapshot; changes: ConfigurationChanges };
  latestBeforeScope(scopeId: string, beforeSnapshotId: number): ConfigurationSnapshot | null;
  getSnapshot(id: number): ConfigurationSnapshot | null;
  getChanges(snapshotId: number): ConfigurationChanges;
  recentReports(limit: number): ConfigurationSnapshotReport[];
  latestScopeReports(limit: number): ConfigurationScopeReport[];
  close(): void;
}

function parseJson<T>(text: string, context: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`configuration store contains invalid ${context}`);
  }
}

function emptyChanges(): ConfigurationChanges {
  return { added: [], removed: [], changed: [] };
}

function loadSnapshot(db: Database, row: SnapshotRow): ConfigurationSnapshot {
  const entries = db.query<EntryRow, [number]>(
    "SELECT entry_json FROM configuration_entries WHERE snapshot_id = ? ORDER BY entry_key",
  ).all(row.id).map((entry: EntryRow): ConfigurationEntry =>
    parseJson<ConfigurationEntry>(entry.entry_json, "entry JSON"),
  );
  return {
    id: row.id,
    observedAt: row.observed_at,
    scopes: parseJson<ConfigurationScope[]>(row.scopes_json, "scope JSON"),
    entries,
  };
}

export function openConfigurationStore(
  databasePath: string,
  options: { readOnly?: boolean } = {},
): ConfigurationStore {
  if (!options.readOnly) {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const db = new Database(databasePath, options.readOnly ? { readonly: true } : undefined);
  if (!options.readOnly) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(CONFIGURATION_STORE_DDL);
  }

  const insertSnapshot = db.query(
    "INSERT INTO configuration_snapshots (observed_at, scopes_json) VALUES (?, ?)",
  );
  const insertEntry = db.query(
    "INSERT INTO configuration_entries (snapshot_id, entry_key, scope_id, entry_json) VALUES (?, ?, ?, ?)",
  );
  const insertChange = db.query(
    "INSERT INTO configuration_changes (snapshot_id, change_kind, entry_key, entry_json) VALUES (?, ?, ?, ?)",
  );

  function getSnapshot(id: number): ConfigurationSnapshot | null {
    const row = db.query<SnapshotRow, [number]>(
      "SELECT id, observed_at, scopes_json FROM configuration_snapshots WHERE id = ?",
    ).get(id);
    return row === null ? null : loadSnapshot(db, row);
  }

  function getChanges(snapshotId: number): ConfigurationChanges {
    const changes = emptyChanges();
    const rows = db.query<ChangeRow, [number]>(
      "SELECT change_kind, entry_json FROM configuration_changes WHERE snapshot_id = ? ORDER BY change_kind, entry_key",
    ).all(snapshotId);
    for (const row of rows) {
      changes[row.change_kind].push(
        parseJson<ConfigurationEntry>(row.entry_json, "change JSON"),
      );
    }
    return changes;
  }

  function latestBeforeScope(scopeId: string, beforeSnapshotId: number): ConfigurationSnapshot | null {
    const row = db.query<SnapshotRow, [string, number]>(`
      SELECT s.id, s.observed_at, s.scopes_json
      FROM configuration_snapshots s
      JOIN configuration_entries e ON e.snapshot_id = s.id
      WHERE e.scope_id = ? AND s.id < ?
      GROUP BY s.id
      ORDER BY s.id DESC
      LIMIT 1
    `).get(scopeId, beforeSnapshotId);
    return row === null ? null : loadSnapshot(db, row);
  }

  function persistSnapshot(
    observedAt: string,
    scopes: readonly ConfigurationScope[],
    entries: readonly ConfigurationEntry[],
    changes: ConfigurationChanges,
  ): number {
    const result = insertSnapshot.run(observedAt, JSON.stringify(scopes));
    const snapshotId = Number(result.lastInsertRowid);
    for (const entry of entries) {
      insertEntry.run(snapshotId, entry.key, entry.scopeId, JSON.stringify(entry));
    }
    for (const kind of ["added", "removed", "changed"] as const) {
      for (const entry of changes[kind]) {
        insertChange.run(snapshotId, kind, entry.key, JSON.stringify(entry));
      }
    }
    return snapshotId;
  }

  return {
    db,
    writeSnapshot(
      observedAt: string,
      scopes: readonly ConfigurationScope[],
      entries: readonly ConfigurationEntry[],
      changes: ConfigurationChanges,
    ): ConfigurationSnapshot {
      const transaction = db.transaction((): number => persistSnapshot(observedAt, scopes, entries, changes));
      const snapshot = getSnapshot(transaction());
      if (snapshot === null) {
        throw new Error("configuration snapshot disappeared after insertion");
      }
      return snapshot;
    },
    recordSnapshot(
      observedAt: string,
      scopes: readonly ConfigurationScope[],
      entries: readonly ConfigurationEntry[],
      calculateChanges: (previousByScope: ReadonlyMap<string, ConfigurationSnapshot | null>) => ConfigurationChanges,
    ): { snapshot: ConfigurationSnapshot; changes: ConfigurationChanges } {
      let snapshotId: number | undefined;
      let changes: ConfigurationChanges | undefined;
      db.exec("BEGIN IMMEDIATE");
      try {
        const previousByScope = new Map<string, ConfigurationSnapshot | null>();
        for (const scope of scopes) {
          previousByScope.set(scope.id, latestBeforeScope(scope.id, Number.MAX_SAFE_INTEGER));
        }
        changes = calculateChanges(previousByScope);
        snapshotId = persistSnapshot(observedAt, scopes, entries, changes);
        db.exec("COMMIT");
      } catch (error: unknown) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The write may have failed before the transaction opened.
        }
        throw error;
      }
      const snapshot = getSnapshot(snapshotId);
      if (snapshot === null || changes === undefined) {
        throw new Error("configuration snapshot disappeared after insertion");
      }
      return { snapshot, changes };
    },
    latestBeforeScope,
    getSnapshot,
    getChanges,
    recentReports(limit: number): ConfigurationSnapshotReport[] {
      const rows = db.query<SnapshotRow, [number]>(
        "SELECT id, observed_at, scopes_json FROM configuration_snapshots ORDER BY id DESC LIMIT ?",
      ).all(limit);
      return rows.map((row: SnapshotRow): ConfigurationSnapshotReport => {
        const snapshot = loadSnapshot(db, row);
        return { snapshot, changes: getChanges(snapshot.id) };
      });
    },
    latestScopeReports(limit: number): ConfigurationScopeReport[] {
      const rows = db.query<{ scope_id: string; snapshot_id: number }, [number]>(`
        SELECT scope_id, MAX(snapshot_id) AS snapshot_id
        FROM configuration_entries
        GROUP BY scope_id
        ORDER BY snapshot_id DESC
        LIMIT ?
      `).all(limit);
      return rows.map((row): ConfigurationScopeReport => {
        const snapshot = getSnapshot(row.snapshot_id);
        if (snapshot === null) throw new Error("configuration scope snapshot disappeared");
        const scope = snapshot.scopes.find((candidate: ConfigurationScope): boolean => candidate.id === row.scope_id);
        if (scope === undefined) throw new Error("configuration scope entry has no selected scope");
        const allChanges = getChanges(snapshot.id);
        const onlyScope = (entries: ConfigurationEntry[]): ConfigurationEntry[] =>
          entries.filter((item: ConfigurationEntry): boolean => item.scopeId === scope.id);
        return {
          scope,
          snapshotId: snapshot.id,
          observedAt: snapshot.observedAt,
          entries: snapshot.entries.filter((item: ConfigurationEntry): boolean => item.scopeId === scope.id),
          changes: {
            added: onlyScope(allChanges.added),
            removed: onlyScope(allChanges.removed),
            changed: onlyScope(allChanges.changed),
          },
        };
      });
    },
    close(): void {
      db.close();
    },
  };
}
