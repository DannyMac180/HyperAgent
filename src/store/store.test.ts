import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventInput } from "../schema/events.ts";
import { SCHEMA_VERSION } from "../schema/events.ts";
import { ulid } from "../schema/ulid.ts";
import { openStore } from "./store.ts";
import type { Store } from "./store.ts";

const stores: Store[] = [];
const rawDatabases: Database[] = [];
const tempDirectories: string[] = [];

function tempStorePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "hyperagent-store-"));
  tempDirectories.push(directory);
  return join(directory, "hyperagent.db");
}

function trackedStore(path: string = tempStorePath()): Store {
  const store = openStore(path);
  stores.push(store);
  return store;
}

function makeEvent(overrides: Partial<EventInput> = {}): EventInput {
  return {
    id: ulid(),
    ts: "2026-01-01T00:00:00.000Z",
    type: "tool_call",
    session_id: "session-1",
    vendor: "codex",
    adapter_version: "1.0.0",
    payload: {},
    ...overrides,
  } as EventInput;
}

function rowCount(store: Store): number {
  const row = store.db
    .query<{ count: number }, []>("SELECT count(*) AS count FROM events")
    .get();
  if (row === null) {
    throw new Error("events count query returned no row");
  }
  return row.count;
}

function only<T>(items: T[]): T {
  expect(items).toHaveLength(1);
  const item = items[0];
  if (item === undefined) {
    throw new Error("expected exactly one item");
  }
  return item;
}

afterEach((): void => {
  for (const store of stores.splice(0).reverse()) {
    store.close();
  }
  for (const database of rawDatabases.splice(0).reverse()) {
    try {
      database.close();
    } catch {
      // A test may already have closed the direct handle.
    }
  }
  for (const directory of tempDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("store contract", (): void => {
  test("opening the same store twice is idempotent", (): void => {
    const path = tempStorePath();
    const first = trackedStore(path);
    const second = trackedStore(path);

    expect(first.db.query("SELECT 1 FROM events LIMIT 1").all()).toEqual([]);
    expect(second.db.query("SELECT 1 FROM meta LIMIT 1").all()).toHaveLength(1);
    expect(
      first.db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'events'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(existsSync(path)).toBe(true);
  });

  test("events read back in timestamp and id order", (): void => {
    const store = trackedStore();
    const early = makeEvent({
      ts: "2026-01-01T00:00:01.000Z",
      session_id: "ordered",
    });
    const sameTimestampLowId = makeEvent({
      ts: "2026-01-01T00:00:02.000Z",
      session_id: "ordered",
    });
    const sameTimestampHighId = makeEvent({
      ts: "2026-01-01T00:00:02.000Z",
      session_id: "ordered",
    });
    const late = makeEvent({
      ts: "2026-01-01T00:00:03.000Z",
      session_id: "ordered",
    });
    const tied = [sameTimestampLowId, sameTimestampHighId].sort(
      (left, right): number => left.id.localeCompare(right.id),
    );
    const tiedLow = tied[0];
    const tiedHigh = tied[1];
    if (tiedLow === undefined || tiedHigh === undefined) {
      throw new Error("expected two tied events");
    }

    expect(
      store.append([late, tiedHigh, early, tiedLow]),
    ).toBe(4);
    expect(store.getEvents("ordered").map((event): string => event.id)).toEqual([
      early.id,
      tiedLow.id,
      tiedHigh.id,
      late.id,
    ]);
  });

  test("duplicate event ids are a no-op and never overwrite stored data", (): void => {
    const store = trackedStore();
    const original = makeEvent({
      session_id: "duplicate",
      payload: { marker: "original" },
    });
    const duplicate = makeEvent({
      ...original,
      ts: "2026-01-02T00:00:00.000Z",
      payload: { marker: "replacement" },
    });

    expect(store.append(original)).toBe(1);
    expect(store.append(duplicate)).toBe(0);
    expect(rowCount(store)).toBe(1);
    const stored = only(store.getEvents("duplicate"));
    expect(stored.ts).toBe(original.ts);
    expect(stored.payload).toEqual({ marker: "original" });
  });

  test("array append is transactional when an event is invalid", (): void => {
    const store = trackedStore();
    expect(store.append(makeEvent({ session_id: "existing" }))).toBe(1);
    const before = rowCount(store);
    const invalid = {
      ...makeEvent({ session_id: "batch" }),
      ts: "2026-01-01T00:00:00Z",
    } as unknown as EventInput;

    expect((): number =>
      store.append([
        makeEvent({ session_id: "batch" }),
        invalid,
        makeEvent({ session_id: "batch" }),
      ])
    ).toThrow("invalid event at index 1");
    expect(rowCount(store)).toBe(before);
    expect(store.getEvents("batch")).toEqual([]);
  });

  test("raw updates and deletes trigger append-only protection", (): void => {
    const store = trackedStore();
    const event = makeEvent({ session_id: "protected" });
    store.append(event);

    expect(() =>
      store.db
        .query("UPDATE events SET ts = ? WHERE id = ?")
        .run("2026-02-01T00:00:00.000Z", event.id)
    ).toThrow("events is append-only");
    expect(() => store.db.run("DELETE FROM events")).toThrow("events is append-only");
    expect(rowCount(store)).toBe(1);
    expect(only(store.getEvents("protected")).id).toBe(event.id);
  });

  test("unknown vendors and payload keys round-trip without loss", (): void => {
    const store = trackedStore();
    const payload = {
      future_extension: {
        enabled: true,
        values: [1, "two", null],
      },
    };
    const event = makeEvent({
      type: "session_start",
      session_id: "unknown-vendor",
      vendor: "unknown:foo",
      payload,
    });

    expect(store.append(event)).toBe(1);
    const stored = only(store.getEvents("unknown-vendor"));
    expect(stored.vendor).toBe("unknown:foo");
    expect(stored.payload).toEqual(payload);
    expect(store.getSessions({ vendor: "unknown:foo" }).map(
      (session): string => session.session_id,
    )).toEqual(["unknown-vendor"]);
  });

  test("session start and end events materialize a reproducible session index", (): void => {
    const store = trackedStore();
    const start = makeEvent({
      type: "session_start",
      session_id: "materialized",
      vendor: "cursor",
      ts: "2026-01-03T10:00:00.000Z",
      payload: {
        repo: "hyperagent",
        agent: "forge",
        model: "gpt-5",
      },
    });
    const end = makeEvent({
      type: "session_end",
      session_id: "materialized",
      vendor: "cursor",
      ts: "2026-01-03T10:30:00.000Z",
      payload: { outcome: "completed" },
    });

    expect(store.append([start, end])).toBe(2);
    const before = store.getSessions();
    expect(before).toEqual([
      {
        session_id: "materialized",
        vendor: "cursor",
        started_at: start.ts,
        ended_at: end.ts,
        outcome: "completed",
        repo: "hyperagent",
        agent: "forge",
        model: "gpt-5",
      },
    ]);

    store.db.run("DELETE FROM sessions");
    expect(store.getSessions()).toEqual([]);
    expect(store.rebuildSessions()).toBe(1);
    expect(store.getSessions()).toEqual(before);
  });

  test("open sessions become closed when a session end arrives", (): void => {
    const store = trackedStore();
    const start = makeEvent({
      type: "session_start",
      session_id: "open-then-closed",
      ts: "2026-01-04T10:00:00.000Z",
    });
    const end = makeEvent({
      type: "session_end",
      session_id: "open-then-closed",
      ts: "2026-01-04T11:00:00.000Z",
      payload: { outcome: "abandoned" },
    });

    store.append(start);
    const openSession = only(store.getSessions());
    expect(openSession.ended_at).toBeNull();
    expect(openSession.outcome).toBeNull();
    expect(store.getSessions({ open: true })).toEqual([openSession]);
    expect(store.getSessions({ open: false })).toEqual([]);

    store.append(end);
    const closedSession = only(store.getSessions());
    expect(closedSession.ended_at).toBe(end.ts);
    expect(closedSession.outcome).toBe("abandoned");
    expect(store.getSessions({ open: true })).toEqual([]);
    expect(store.getSessions({ open: false })).toEqual([closedSession]);
  });

  test("opening refuses newer major schema versions but accepts supported majors", (): void => {
    const newerPath = tempStorePath();
    trackedStore(newerPath).close();
    const newerDatabase = new Database(newerPath);
    rawDatabases.push(newerDatabase);
    newerDatabase
      .query("UPDATE meta SET value = ? WHERE key = 'schema_version'")
      .run("99.0.0");
    newerDatabase.close();

    expect(() => openStore(newerPath)).toThrow("store schema version 99.0.0");

    const compatiblePath = tempStorePath();
    trackedStore(compatiblePath).close();
    const compatibleDatabase = new Database(compatiblePath);
    rawDatabases.push(compatibleDatabase);
    compatibleDatabase
      .query("UPDATE meta SET value = ? WHERE key = 'schema_version'")
      .run("0.0.0");
    compatibleDatabase.close();

    const reopened = openStore(compatiblePath);
    stores.push(reopened);
    expect(
      reopened.db
        .query<{ value: string }, []>(
          "SELECT value FROM meta WHERE key = 'schema_version'",
        )
        .get(),
    ).toEqual({ value: "0.0.0" });
  });

  test("appending an empty batch writes nothing and returns zero", (): void => {
    const store = trackedStore();
    expect(store.append([])).toBe(0);
    expect(rowCount(store)).toBe(0);
  });

  test("append fills observed_at, schema_version, raw_ref and payload defaults", (): void => {
    const store = trackedStore();
    const event = makeEvent({ session_id: "defaults" });
    // Omit the store-filled fields entirely so the defaults are exercised.
    delete (event as { payload?: unknown }).payload;

    expect(store.append(event)).toBe(1);
    const stored = only(store.getEvents("defaults"));
    expect(stored.payload).toEqual({});
    expect(stored.raw_ref).toBeNull();
    expect(stored.schema_version).toBe(SCHEMA_VERSION);
    expect(stored.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("explicit observed_at, schema_version and raw_ref are preserved", (): void => {
    const store = trackedStore();
    const event = makeEvent({
      session_id: "explicit",
      observed_at: "2026-01-05T00:00:00.000Z",
      schema_version: "0.1.0",
      raw_ref: "transcript.jsonl#L42",
    });

    store.append(event);
    const stored = only(store.getEvents("explicit"));
    expect(stored.observed_at).toBe("2026-01-05T00:00:00.000Z");
    expect(stored.schema_version).toBe("0.1.0");
    expect(stored.raw_ref).toBe("transcript.jsonl#L42");
  });

  test("a session_end without a start creates a placeholder the rebuild reproduces", (): void => {
    const store = trackedStore();
    const end = makeEvent({
      type: "session_end",
      session_id: "orphan-end",
      vendor: "amp",
      ts: "2026-01-06T12:00:00.000Z",
      payload: { outcome: "crashed" },
    });

    expect(store.append(end)).toBe(1);
    const placeholder = only(store.getSessions());
    // started_at is NOT NULL, so the end timestamp stands in until a start arrives.
    expect(placeholder.started_at).toBe(end.ts);
    expect(placeholder.ended_at).toBe(end.ts);
    expect(placeholder.outcome).toBe("crashed");

    store.db.run("DELETE FROM sessions");
    expect(store.rebuildSessions()).toBe(1);
    expect(store.getSessions()).toEqual([placeholder]);
  });

  test("a late-arriving session_start backfills the placeholder start time", (): void => {
    const store = trackedStore();
    const sessionId = "late-start";
    store.append(
      makeEvent({
        type: "session_end",
        session_id: sessionId,
        ts: "2026-01-07T12:00:00.000Z",
        payload: { outcome: "completed" },
      }),
    );
    store.append(
      makeEvent({
        type: "session_start",
        session_id: sessionId,
        ts: "2026-01-07T11:00:00.000Z",
        payload: { repo: "hyperagent" },
      }),
    );

    const session = only(store.getSessions());
    expect(session.started_at).toBe("2026-01-07T11:00:00.000Z");
    expect(session.ended_at).toBe("2026-01-07T12:00:00.000Z");
    expect(session.outcome).toBe("completed");
    expect(session.repo).toBe("hyperagent");
  });

  test("getSessions honours since, limit and repo filters", (): void => {
    const store = trackedStore();
    for (const [index, day] of ["10", "11", "12"].entries()) {
      store.append(
        makeEvent({
          type: "session_start",
          session_id: `session-${day}`,
          ts: `2026-01-${day}T00:00:00.000Z`,
          payload: { repo: index === 0 ? "other" : "hyperagent" },
        }),
      );
    }

    expect(
      store.getSessions({ since: "2026-01-11T00:00:00.000Z" }).map(
        (session): string => session.session_id,
      ),
    ).toEqual(["session-12", "session-11"]);
    // Ordering is started_at DESC, so the limit takes the most recent session.
    expect(store.getSessions({ limit: 1 }).map((session): string => session.session_id))
      .toEqual(["session-12"]);
    expect(
      store.getSessions({ repo: "hyperagent" }).map((session): string => session.session_id),
    ).toEqual(["session-12", "session-11"]);
    expect(store.getSessions({ limit: 0 })).toEqual([]);
  });

  test("getSessions rejects malformed filters", (): void => {
    const store = trackedStore();
    expect(() => store.getSessions({ limit: -1 })).toThrow(
      "session filter limit must be a non-negative safe integer",
    );
    expect(() =>
      store.getSessions({ vendor: 1 as unknown as string })
    ).toThrow("session filter vendor must be a string");
  });

  test("closing the store twice is safe", (): void => {
    const store = openStore(tempStorePath());
    store.close();
    expect((): void => store.close()).not.toThrow();
  });

  test("events from other sessions are not returned", (): void => {
    const store = trackedStore();
    store.append(makeEvent({ session_id: "mine" }));
    store.append(makeEvent({ session_id: "theirs" }));

    expect(store.getEvents("mine")).toHaveLength(1);
    expect(only(store.getEvents("mine")).session_id).toBe("mine");
    expect(store.getEvents("nobody")).toEqual([]);
  });
});
