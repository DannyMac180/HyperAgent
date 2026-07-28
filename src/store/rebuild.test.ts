import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deterministicEventId } from "../schema/ids.ts";
import { openStore } from "./store.ts";
import { archiveForRebuild, planRebuild } from "./rebuild.ts";

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
