import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { deterministicEventId } from "../schema/ids.ts";
import { openStore } from "./store.ts";
import {
  archiveForRebuild,
  carryDurableTables,
  classifyTable,
  DERIVED_TABLES,
  EVENT_STORE_TABLES,
  planRebuild,
} from "./rebuild.ts";

/** Store ids must be real ULIDs; derive stable ones for fixtures. */
function idFor(seed: string): string {
  return deterministicEventId({
    ts: "2026-07-27T00:00:00.000Z",
    sessionId: "fixture",
    rawRef: seed,
    type: "session_start",
  });
}

let dir: string;
let present: string;

beforeEach(async (): Promise<void> => {
  // realpath: macOS hands out /var/... symlinks while existsSync resolves to
  // /private/var, which would make the present-artifact check spuriously fail.
  dir = await realpath(await mkdtemp(join(tmpdir(), "rebuild-")));
  present = join(dir, "present.jsonl");
  await writeFile(present, "{}\n", "utf8");
});

afterEach(async (): Promise<void> => {
  await rm(dir, { recursive: true, force: true });
});

function seed(): void {
  const store = openStore(join(dir, "hyperagent.db"));
  store.append([
    {
      id: idFor("keep-1"),
      ts: "2026-07-27T00:00:00.000Z",
      type: "session_start",
      session_id: "claude-code:alive",
      vendor: "claude-code",
      adapter_version: "0.1.0",
      schema_version: "0.1.0",
      raw_ref: `${present}#L1`,
      payload: {},
    },
    {
      id: idFor("orphan-1"),
      ts: "2026-07-27T00:00:01.000Z",
      type: "session_start",
      session_id: "claude-code:gone",
      vendor: "claude-code",
      adapter_version: "0.1.0",
      schema_version: "0.1.0",
      raw_ref: `${join(dir, "vanished.jsonl")}#L1`,
      payload: { note: "source deleted" },
    },
    {
      id: idFor("orphan-2"),
      ts: "2026-07-27T00:00:02.000Z",
      type: "session_end",
      session_id: "claude-code:gone",
      vendor: "claude-code",
      adapter_version: "0.1.0",
      schema_version: "0.1.0",
      raw_ref: `${join(dir, "vanished.jsonl")}#quiesce`,
      payload: {},
    },
  ]);
  store.close();
}

test("planRebuild identifies only events whose artifact is gone", (): void => {
  seed();
  const plan = planRebuild(dir);

  expect(plan.sourceArtifacts).toBe(2);
  expect(plan.missingArtifacts).toEqual([join(dir, "vanished.jsonl")]);
  expect(plan.orphans.map((o): string => o.id).sort()).toEqual(
    [idFor("orphan-1"), idFor("orphan-2")].sort(),
  );
  expect(plan.eventsByVendor).toEqual({ "claude-code": 3 });
});

test("planRebuild matches the quiesce fragment, not just #L refs", (): void => {
  seed();
  const plan = planRebuild(dir);
  const refs = plan.orphans.map((o): string | null => o.raw_ref);
  expect(refs.some((r): boolean => r?.endsWith("#quiesce") === true)).toBe(true);
});

test("session-scoped raw_refs are never mistaken for missing files", (): void => {
  // Regression: post-DAN-217 rows carry "<session-id>#L<n>", not a path. An
  // earlier planner treated those as filenames, so existsSync failed for every
  // corrected row and it reported 21,314 orphans on the real store instead of
  // 25 — i.e. it would have declared most of the database unreconstructible.
  const store = openStore(join(dir, "hyperagent.db"));
  store.append([
    {
      id: idFor("codex-1"),
      ts: "2026-07-27T00:00:00.000Z",
      type: "session_start",
      session_id: "codex:019fa5c0",
      vendor: "codex",
      adapter_version: "0.1.0",
      schema_version: "0.1.0",
      raw_ref: "codex:019fa5c0#L1",
      payload: {},
    },
    {
      id: idFor("codex-2"),
      ts: "2026-07-27T00:00:01.000Z",
      type: "session_end",
      session_id: "codex:019fa5c0",
      vendor: "codex",
      adapter_version: "0.1.0",
      schema_version: "0.1.0",
      raw_ref: "codex:019fa5c0#quiesce",
      payload: {},
    },
  ]);
  store.close();

  const plan = planRebuild(dir);
  expect(plan.sourceArtifacts).toBe(0);
  expect(plan.missingArtifacts).toEqual([]);
  expect(plan.orphans).toHaveLength(0);
});

test("planRebuild does not modify the store", (): void => {
  seed();
  planRebuild(dir);
  const store = openStore(join(dir, "hyperagent.db"));
  expect(store.getEvents("claude-code:gone")).toHaveLength(2);
  store.close();
});

test("archiveForRebuild writes orphans before moving the db, and deletes nothing", async (): Promise<void> => {
  seed();
  const plan = planRebuild(dir);
  const paths = await archiveForRebuild(plan, "20260728T000000Z", dir);

  // The live path is cleared for a fresh ingest...
  expect(existsSync(join(dir, "hyperagent.db"))).toBe(false);
  // ...but nothing was destroyed.
  expect(existsSync(paths.archivedDb)).toBe(true);
  expect(existsSync(paths.orphanArchive)).toBe(true);

  const archive = JSON.parse(await readFile(paths.orphanArchive, "utf8")) as {
    events: { id: string }[];
    missing_artifacts: string[];
  };
  expect(archive.events.map((e): string => e.id).sort()).toEqual(
    [idFor("orphan-1"), idFor("orphan-2")].sort(),
  );
  expect(archive.missing_artifacts).toEqual([join(dir, "vanished.jsonl")]);

  // The archived database is still readable and still holds everything.
  const archived = openStore(paths.archivedDb);
  expect(archived.getEvents("claude-code:gone")).toHaveLength(2);
  expect(archived.getEvents("claude-code:alive")).toHaveLength(1);
  archived.close();
});

test("archiveForRebuild moves ingest state so the rebuild cannot skip artifacts", async (): Promise<void> => {
  seed();
  await writeFile(
    join(dir, "ingest-state.json"),
    JSON.stringify({ sessions: {} }),
    "utf8",
  );
  const paths = await archiveForRebuild(planRebuild(dir), "s", dir);

  expect(existsSync(join(dir, "ingest-state.json"))).toBe(false);
  expect(paths.archivedState).not.toBeNull();
  expect(existsSync(paths.archivedState as string)).toBe(true);
});

test("archiveForRebuild tolerates an absent ingest state", async (): Promise<void> => {
  seed();
  const paths = await archiveForRebuild(planRebuild(dir), "s", dir);
  expect(paths.archivedState).toBeNull();
});

test("a store with no orphans still archives cleanly", async (): Promise<void> => {
  const store = openStore(join(dir, "hyperagent.db"));
  store.append([
    {
      id: idFor("keep-1"),
      ts: "2026-07-27T00:00:00.000Z",
      type: "session_start",
      session_id: "claude-code:alive",
      vendor: "claude-code",
      adapter_version: "0.1.0",
      schema_version: "0.1.0",
      raw_ref: `${present}#L1`,
      payload: {},
    },
  ]);
  store.close();

  const plan = planRebuild(dir);
  expect(plan.orphans).toHaveLength(0);

  const paths = await archiveForRebuild(plan, "s", dir);
  const archive = JSON.parse(await readFile(paths.orphanArchive, "utf8")) as {
    events: unknown[];
  };
  expect(archive.events).toHaveLength(0);
});

test("the archived database still enforces append-only", async (): Promise<void> => {
  // Behavioural, not textual: assert the triggers actually ABORT rather than
  // grepping the source for scary words. (A grep for "writable_schema" tripped
  // on this module's own doc comment explaining that it never uses it — the
  // same self-match that broke CI's privacy guard on DAN-205.)
  seed();
  const paths = await archiveForRebuild(planRebuild(dir), "s", dir);
  const archived = openStore(paths.archivedDb);
  const db = (archived as unknown as { db: import("bun:sqlite").Database }).db;

  expect((): void => {
    db.query("UPDATE events SET vendor = 'x'").run();
  }).toThrow(/append-only/);
  expect((): void => {
    db.query("DELETE FROM events").run();
  }).toThrow(/append-only/);

  archived.close();
});

// --- DAN-218: sibling tables sharing hyperagent.db ---------------------------

/**
 * Stand-in for another engine's durable table. Deliberately NOT the real
 * memory-store DDL: the rebuild must preserve a table it has never heard of,
 * and importing `memory/store.ts` here would test a name rather than the rule.
 */
function seedDurableTable(rows: number): void {
  const db = new Database(join(dir, "hyperagent.db"));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id     TEXT PRIMARY KEY,
        claim  TEXT NOT NULL,
        status TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
    `);
    const insert = db.query(
      "INSERT INTO memories (id, claim, status) VALUES (?1, ?2, ?3)",
    );
    for (let index = 0; index < rows; index += 1) {
      insert.run(`mem-${index}`, `claim number ${index}`, "approved");
    }
  } finally {
    db.close();
  }
}

function seedDerivedTable(): void {
  const db = new Database(join(dir, "hyperagent.db"));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS policy_violations (
        session_id TEXT NOT NULL,
        event_id   TEXT NOT NULL,
        rule_id    TEXT NOT NULL,
        PRIMARY KEY (session_id, event_id, rule_id)
      ) STRICT;
    `);
    db.query(
      "INSERT INTO policy_violations (session_id, event_id, rule_id) VALUES (?1, ?2, ?3)",
    ).run("claude-code:alive", idFor("keep-1"), "no-secrets");
  } finally {
    db.close();
  }
}

function tableNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[]).map((row): string => row.name);
  } finally {
    db.close();
  }
}

function allRows(dbPath: string, table: string): Record<string, unknown>[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<
      string,
      unknown
    >[];
  } finally {
    db.close();
  }
}

/**
 * The reproduction, inverted (ISC-21). Before the fix, the rebuilt database had
 * no `memories` table at all and this asserted zero rows against a missing one.
 */
test("carries a durable sibling table through a rebuild", async (): Promise<void> => {
  seed();
  seedDurableTable(3);
  const before = allRows(join(dir, "hyperagent.db"), "memories");

  const plan = planRebuild(dir);
  const paths = await archiveForRebuild(plan, "STAMP", dir);
  // Stands in for the fresh ingest: a new database with event-store DDL only.
  openStore(join(dir, "hyperagent.db")).close();

  expect(tableNames(join(dir, "hyperagent.db"))).not.toContain("memories");

  const result = carryDurableTables(paths.archivedDb, join(dir, "hyperagent.db"));

  expect(result.carried).toEqual([{ name: "memories", rows: 3 }]);
  expect(tableNames(join(dir, "hyperagent.db"))).toContain("memories");
  // Contents, not merely counts — a table of three empty rows would pass a
  // count check and still be data loss.
  expect(allRows(join(dir, "hyperagent.db"), "memories")).toEqual(before);
});

test("carried table keeps its exact schema text and indexes", async (): Promise<void> => {
  seed();
  seedDurableTable(1);

  const schemaOf = (dbPath: string): { table: string | null; indexes: string[] } => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const table = (db.query(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'",
      ).get() as { sql: string } | null)?.sql ?? null;
      const indexes = (db.query(
        "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='memories' AND sql IS NOT NULL ORDER BY name",
      ).all() as { sql: string }[]).map((row): string => row.sql);
      return { table, indexes };
    } finally {
      db.close();
    }
  };

  const before = schemaOf(join(dir, "hyperagent.db"));
  const plan = planRebuild(dir);
  const paths = await archiveForRebuild(plan, "STAMP", dir);
  openStore(join(dir, "hyperagent.db")).close();
  carryDurableTables(paths.archivedDb, join(dir, "hyperagent.db"));

  expect(schemaOf(join(dir, "hyperagent.db"))).toEqual(before);
  expect(before.indexes).toHaveLength(1);
});

test("derived tables are dropped, not carried", async (): Promise<void> => {
  seed();
  seedDerivedTable();

  const plan = planRebuild(dir);
  const paths = await archiveForRebuild(plan, "STAMP", dir);
  openStore(join(dir, "hyperagent.db")).close();
  const result = carryDurableTables(paths.archivedDb, join(dir, "hyperagent.db"));

  expect(result.droppedDerived).toEqual(["policy_violations"]);
  expect(result.carried).toEqual([]);
  // The whole point: rows keyed to pre-rebuild event ids must not resurface.
  expect(tableNames(join(dir, "hyperagent.db"))).not.toContain("policy_violations");
});

test("event-store tables are never carried", async (): Promise<void> => {
  seed();
  seedDurableTable(1);

  const plan = planRebuild(dir);
  const paths = await archiveForRebuild(plan, "STAMP", dir);
  openStore(join(dir, "hyperagent.db")).close();
  const result = carryDurableTables(paths.archivedDb, join(dir, "hyperagent.db"));

  const carriedNames = result.carried.map((table): string => table.name);
  for (const name of EVENT_STORE_TABLES) {
    expect(carriedNames).not.toContain(name);
  }
  // Carry-through must not have smuggled the old events back in.
  expect(allRows(join(dir, "hyperagent.db"), "events")).toHaveLength(0);
});

test("carry-through is a no-op when no durable tables exist", async (): Promise<void> => {
  seed();

  const plan = planRebuild(dir);
  const paths = await archiveForRebuild(plan, "STAMP", dir);
  openStore(join(dir, "hyperagent.db")).close();
  const result = carryDurableTables(paths.archivedDb, join(dir, "hyperagent.db"));

  expect(result).toEqual({ carried: [], droppedDerived: [] });
});

test("carry-through fails loudly and names the archive", async (): Promise<void> => {
  seed();
  seedDurableTable(2);

  const plan = planRebuild(dir);
  const paths = await archiveForRebuild(plan, "STAMP", dir);
  openStore(join(dir, "hyperagent.db")).close();

  // An engine reopened the fresh database and already wrote its own rows.
  // Merging two versions of one table would silently pick a winner.
  const db = new Database(join(dir, "hyperagent.db"));
  db.exec(
    "CREATE TABLE memories (id TEXT PRIMARY KEY, claim TEXT NOT NULL, status TEXT NOT NULL) STRICT",
  );
  db.query("INSERT INTO memories (id, claim, status) VALUES ('x','y','approved')").run();
  db.close();

  expect((): void => {
    carryDurableTables(paths.archivedDb, join(dir, "hyperagent.db"));
  }).toThrow(/no data was lost/);
  expect((): void => {
    carryDurableTables(paths.archivedDb, join(dir, "hyperagent.db"));
  }).toThrow(paths.archivedDb);
});

test("a missing archive is an error, never a silent skip", (): void => {
  expect((): void => {
    carryDurableTables(join(dir, "does-not-exist.db"), join(dir, "hyperagent.db"));
  }).toThrow(/archived database not found/);
});

test("plan inventories and classifies every table", (): void => {
  seed();
  seedDurableTable(4);
  seedDerivedTable();

  const plan = planRebuild(dir);
  const byName = new Map(
    plan.tables.map((entry): [string, typeof entry] => [entry.name, entry]),
  );

  expect(byName.get("events")?.bucket).toBe("event_store");
  expect(byName.get("sessions")?.bucket).toBe("event_store");
  expect(byName.get("meta")?.bucket).toBe("event_store");
  expect(byName.get("policy_violations")?.bucket).toBe("derived");
  expect(byName.get("memories")?.bucket).toBe("durable");
  expect(byName.get("memories")?.rows).toBe(4);
  expect(byName.get("events")?.rows).toBe(3);
  // SQLite's own bookkeeping tables are nobody's data.
  expect([...byName.keys()].some((name): boolean => name.startsWith("sqlite_")))
    .toBe(false);
});

test("an unknown table defaults to durable", (): void => {
  expect(classifyTable("some_future_engine_state")).toBe("durable");
  expect(classifyTable("memories")).toBe("durable");
});

/**
 * Membership of the derived list is asserted exactly. Adding a name here turns a
 * preserved table into a destroyed one, so widening it must break the suite
 * rather than pass quietly.
 */
test("the derived denylist has exactly the two known recomputable tables", (): void => {
  expect([...DERIVED_TABLES].sort()).toEqual([
    "policy_violations",
    "session_scores",
  ]);
  expect([...EVENT_STORE_TABLES].sort()).toEqual(["events", "meta", "sessions"]);
});

test("planRebuild does not mutate the store", (): void => {
  seed();
  seedDurableTable(2);
  const before = allRows(join(dir, "hyperagent.db"), "memories");
  const eventsBefore = allRows(join(dir, "hyperagent.db"), "events");

  planRebuild(dir);
  planRebuild(dir);

  expect(allRows(join(dir, "hyperagent.db"), "memories")).toEqual(before);
  expect(allRows(join(dir, "hyperagent.db"), "events")).toEqual(eventsBefore);
});
