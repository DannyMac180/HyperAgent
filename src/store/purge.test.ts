import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { deterministicEventId } from "../schema/ids.ts";
import { openStore } from "./store.ts";
import { planVendorPurge, purgeVendor } from "./purge.ts";

function idFor(seed: string): string {
  return deterministicEventId({
    ts: "2026-08-20T00:00:00.000Z",
    sessionId: "fixture",
    rawRef: seed,
    type: "session_start",
  });
}

let dir: string;
const dbPath = (): string => join(dir, "hyperagent.db");

beforeEach(async (): Promise<void> => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "purge-")));
});

afterEach(async (): Promise<void> => {
  await rm(dir, { recursive: true, force: true });
});

function event(seed: string, vendor: string, session: string) {
  return {
    id: idFor(seed),
    ts: "2026-08-20T00:00:00.000Z",
    type: "session_start" as const,
    session_id: session,
    vendor,
    adapter_version: "0.1.0",
    schema_version: "0.1.0",
    raw_ref: `${session}#L1`,
    payload: {},
  };
}

/**
 * Two vendors, plus the two shapes of sibling table the purge has to tell
 * apart: one keyed on `session_id` (derived — must be filtered) and one keyed
 * on neither (durable — must survive untouched).
 */
function seed(): void {
  const store = openStore(dbPath());
  store.append([
    event("cc-1", "claude-code", "claude-code:keep-1"),
    event("cc-2", "claude-code", "claude-code:keep-2"),
    event("cx-1", "codex", "codex:go-1"),
    event("cx-2", "codex", "codex:go-2"),
    event("cx-3", "codex", "codex:go-3"),
  ]);
  store.close();

  const db = new Database(dbPath());
  db.exec(`CREATE TABLE session_scores (
    session_id TEXT PRIMARY KEY, turn_count INTEGER NOT NULL) STRICT`);
  db.exec(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, claim TEXT NOT NULL) STRICT`);
  for (
    const session of [
      "claude-code:keep-1",
      "claude-code:keep-2",
      "codex:go-1",
      "codex:go-2",
    ]
  ) {
    db.query("INSERT INTO session_scores VALUES (?1, 3)").run(session);
  }
  db.query("INSERT INTO memories VALUES ('m1', 'learned from codex')").run();
  db.close();
}

async function writeIngestState(): Promise<void> {
  await writeFile(
    join(dir, "ingest-state.json"),
    JSON.stringify({
      v: 1,
      sessions: {
        "claude-code:keep-1": { vendor: "claude-code", resumeToken: "a" },
        "codex:go-1": { vendor: "codex", resumeToken: "b" },
        "codex:go-2": { vendor: "codex", resumeToken: "c" },
      },
    }),
    "utf8",
  );
}

const counts = (table: string, where = ""): number => {
  const db = new Database(dbPath(), { readonly: true });
  try {
    return (db.query(`SELECT count(*) AS n FROM ${table} ${where}`).get() as {
      n: number;
    }).n;
  } finally {
    db.close();
  }
};

test("the plan names exactly what leaves, per table", (): void => {
  seed();
  const plan = planVendorPurge("codex", dir);
  const removed = Object.fromEntries(
    plan.removed.map((t): [string, number] => [t.name, t.rows]),
  );
  expect(removed.events).toBe(3);
  expect(removed.sessions).toBe(3);
  expect(removed.session_scores).toBe(2);
  // The durable table has no vendor and no session_id — nothing to remove.
  expect(removed.memories).toBeUndefined();
  expect(plan.retainedByVendor).toEqual({ "claude-code": 2 });
  expect(plan.empty).toBe(false);
});

test("a vendor with no records is a no-op, not an error", (): void => {
  seed();
  const plan = planVendorPurge("cursor", dir);
  expect(plan.empty).toBe(true);
  expect(plan.removed).toHaveLength(0);
});

test("the vendor is gone and the other vendor is untouched", async (): Promise<void> => {
  seed();
  const plan = planVendorPurge("codex", dir);
  await purgeVendor(plan, "stamp", dir);

  expect(counts("events", "WHERE vendor = 'codex'")).toBe(0);
  expect(counts("sessions", "WHERE vendor = 'codex'")).toBe(0);
  expect(counts("events", "WHERE vendor = 'claude-code'")).toBe(2);
  expect(counts("sessions", "WHERE vendor = 'claude-code'")).toBe(2);
});

test("derived rows keyed on the purged sessions go; the others stay", async (): Promise<void> => {
  seed();
  await purgeVendor(planVendorPurge("codex", dir), "stamp", dir);
  expect(counts("session_scores")).toBe(2);
  expect(counts("session_scores", "WHERE session_id LIKE 'codex:%'")).toBe(0);
});

test("lessons are kept — a purge is not a memory wipe", async (): Promise<void> => {
  seed();
  await purgeVendor(planVendorPurge("codex", dir), "stamp", dir);
  expect(counts("memories")).toBe(1);
});

test("the append-only triggers come back armed", async (): Promise<void> => {
  seed();
  await purgeVendor(planVendorPurge("codex", dir), "stamp", dir);
  const db = new Database(dbPath());
  try {
    expect((): void => {
      db.exec("DELETE FROM events");
    }).toThrow();
    expect((): void => {
      db.exec("UPDATE events SET vendor = 'x'");
    }).toThrow();
  } finally {
    db.close();
  }
});

test("the archive still holds everything that was removed", async (): Promise<void> => {
  seed();
  const paths = await purgeVendor(planVendorPurge("codex", dir), "stamp", dir);
  expect(existsSync(paths.archivedDb)).toBe(true);
  const archived = new Database(paths.archivedDb, { readonly: true });
  try {
    expect(
      (archived.query(
        "SELECT count(*) AS n FROM events WHERE vendor = 'codex'",
      ).get() as { n: number }).n,
    ).toBe(3);
  } finally {
    archived.close();
  }
});

test("resume tokens for the vendor are forgotten, others kept", async (): Promise<void> => {
  seed();
  await writeIngestState();
  const plan = planVendorPurge("codex", dir);
  expect(plan.ingestStateEntries).toBe(2);

  const paths = await purgeVendor(plan, "stamp", dir);
  const state = JSON.parse(
    await readFile(join(dir, "ingest-state.json"), "utf8"),
  ) as { sessions: Record<string, unknown> };
  expect(Object.keys(state.sessions)).toEqual(["claude-code:keep-1"]);
  expect(paths.archivedState).not.toBeNull();
});

test("a row with no vendor is kept — unknown is not evidence of belonging", async (): Promise<void> => {
  seed();
  const db = new Database(dbPath());
  db.exec(`CREATE TABLE odd (id TEXT PRIMARY KEY, vendor TEXT) STRICT`);
  db.query("INSERT INTO odd VALUES ('a', NULL)").run();
  db.query("INSERT INTO odd VALUES ('b', 'codex')").run();
  db.close();

  await purgeVendor(planVendorPurge("codex", dir), "stamp", dir);
  expect(counts("odd")).toBe(1);
  expect(counts("odd", "WHERE vendor IS NULL")).toBe(1);
});

/**
 * Two guards, two different drifts, and neither is redundant.
 *
 * A mid-flight write to a KEPT vendor changes what the copy contains, so the
 * plan-verification catches it while the replacement is still a temporary file.
 * A mid-flight write to the vendor being REMOVED leaves every kept count
 * identical — verification passes, and only the source re-read notices. Both
 * fail before the live store is touched.
 */
test("a write to a kept vendor mid-purge aborts before the swap", async (): Promise<void> => {
  seed();
  const plan = planVendorPurge("codex", dir);

  // The daemon's next pass, arriving between the preview and the apply.
  const store = openStore(dbPath());
  store.append([event("cc-late", "claude-code", "claude-code:late")]);
  store.close();

  await expect(purgeVendor(plan, "stamp", dir)).rejects.toThrow(
    /purge verification failed/,
  );
  // Untouched: the codex rows the purge was going to remove are all still here.
  expect(counts("events", "WHERE vendor = 'codex'")).toBe(3);
  expect(counts("events", "WHERE vendor = 'claude-code'")).toBe(3);
});

test("a write to the purged vendor mid-purge is caught by the source re-read", async (): Promise<void> => {
  seed();
  const plan = planVendorPurge("codex", dir);

  // Invisible to the kept-row counts — every retained total is unchanged.
  const store = openStore(dbPath());
  store.append([event("cx-late", "codex", "codex:go-4")]);
  store.close();

  await expect(purgeVendor(plan, "stamp", dir)).rejects.toThrow(
    /store changed while the purge was being prepared/,
  );
  expect(counts("events", "WHERE vendor = 'codex'")).toBe(4);
  expect(existsSync(dbPath())).toBe(true);
});
