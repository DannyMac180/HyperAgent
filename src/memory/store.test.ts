import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventInput } from "../schema/events.ts";
import { ulid } from "../schema/ulid.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import {
  claimHash,
  normalizeClaim,
  openMemoryStore,
  renderMemoryMarkdown,
} from "./store.ts";
import type {
  AddMemoryInput,
  MemoryRow,
  MemoryStore,
  OpenMemoryStoreOptions,
} from "./store.ts";

const memoryStores: MemoryStore[] = [];
const eventStores: Store[] = [];
const tempDirectories: string[] = [];

interface TempPaths {
  dbPath: string;
  memoryDir: string;
}

function tempPaths(): TempPaths {
  const directory = mkdtempSync(join(tmpdir(), "hyperagent-memory-store-"));
  tempDirectories.push(directory);
  return {
    dbPath: join(directory, "hyperagent.db"),
    memoryDir: join(directory, "memory"),
  };
}

function trackedMemoryStore(
  options: OpenMemoryStoreOptions = {},
): MemoryStore {
  const store = openMemoryStore(options);
  memoryStores.push(store);
  return store;
}

function trackedEventStore(path: string): Store {
  const store = openStore(path);
  eventStores.push(store);
  return store;
}

function input(
  overrides: Partial<AddMemoryInput> = {},
): AddMemoryInput {
  return {
    claim: "Prefer deterministic verification.",
    kind: "preference",
    scope: "global",
    scope_key: null,
    confidence: 0.9,
    evidence: [{ session_id: "session-1", raw_ref: null }],
    ...overrides,
  };
}

function mirrorPath(memoryDir: string, row: MemoryRow): string {
  return join(memoryDir, row.scope, `${row.id}.md`);
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
  for (const store of memoryStores.splice(0).reverse()) {
    store.close();
  }
  for (const store of eventStores.splice(0).reverse()) {
    store.close();
  }
  for (const directory of tempDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("memory store", (): void => {
  test("CRUD round-trips through addCandidate, getMemory, and listMemories", (): void => {
    const paths = tempPaths();
    const store = trackedMemoryStore(paths);
    const added = store.addCandidate(input());

    expect(store.getMemory(added.id)).toEqual(added);
    expect(store.listMemories()).toEqual([added]);
  });

  test("manual memories are approved and candidates remain candidates", (): void => {
    const paths = tempPaths();
    const store = trackedMemoryStore(paths);
    const candidate = store.addCandidate(input({ claim: "Candidate claim." }));
    const manual = store.addManual(input({ claim: "Manual claim." }));

    expect(candidate.status).toBe("candidate");
    expect(candidate.source).toBe("extraction");
    expect(manual.status).toBe("approved");
    expect(manual.source).toBe("manual");
  });

  test("approve, reject, and retire transition status; missing ids fail; repeated status bumps updated_at", (): void => {
    const paths = tempPaths();
    const timestamps = [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
      "2026-01-01T00:00:03.000Z",
      "2026-01-01T00:00:04.000Z",
    ];
    let clockIndex = 0;
    const store = trackedMemoryStore({
      ...paths,
      now: (): Date =>
        new Date(timestamps[clockIndex++] ?? timestamps.at(-1)!),
    });
    const added = store.addCandidate(input());

    expect(store.approve(added.id).status).toBe("approved");
    expect(store.reject(added.id).status).toBe("rejected");
    const retired = store.retire(added.id);
    expect(retired.status).toBe("retired");

    const retiredAgain = store.retire(added.id);
    expect(retiredAgain.status).toBe("retired");
    expect(retiredAgain.updated_at).not.toBe(retired.updated_at);

    const missingId = ulid(new Date("2027-01-01T00:00:00.000Z").getTime());
    expect((): MemoryRow => store.approve(missingId)).toThrow(missingId);
  });

  test("AUTHORITY BOUNDARY: update cannot change status", (): void => {
    const paths = tempPaths();
    const store = trackedMemoryStore(paths);
    const added = store.addCandidate(input());

    expect(
      (): MemoryRow =>
        store.update(added.id, { status: "approved" } as never),
    ).toThrow("status cannot be changed via update()");
    expect(store.getMemory(added.id)?.status).toBe("candidate");
  });

  test("update recomputes claim_hash and bumps updated_at when claim changes", (): void => {
    const paths = tempPaths();
    const timestamps = [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
    ];
    let clockIndex = 0;
    const store = trackedMemoryStore({
      ...paths,
      now: (): Date =>
        new Date(timestamps[clockIndex++] ?? timestamps.at(-1)!),
    });
    const added = store.addCandidate(input({ claim: "Original claim." }));
    const updated = store.update(added.id, { claim: "Replacement claim!" });

    expect(updated.claim_hash).toBe(claimHash("Replacement claim!"));
    expect(updated.claim_hash).not.toBe(added.claim_hash);
    expect(updated.updated_at).not.toBe(added.updated_at);
  });

  test("evidence must be non-empty and well-formed", (): void => {
    const paths = tempPaths();
    const store = trackedMemoryStore(paths);

    expect((): MemoryRow =>
      store.addCandidate(input({ evidence: [] }))
    ).toThrow("at least one entry");
    expect((): MemoryRow =>
      store.addCandidate(input({
        evidence: [{ raw_ref: null } as never],
      }))
    ).toThrow("session_id");
    expect((): MemoryRow =>
      store.addCandidate(input({
        evidence: [{ session_id: "", raw_ref: null }],
      }))
    ).toThrow("session_id");

    const valid = store.addCandidate(input({
      evidence: [{ session_id: "session-valid", raw_ref: "events.jsonl#L1" }],
    }));
    expect(valid.evidence).toEqual([
      { session_id: "session-valid", raw_ref: "events.jsonl#L1" },
    ]);
  });

  test("scope and scope_key pairings are enforced", (): void => {
    const paths = tempPaths();
    const store = trackedMemoryStore(paths);

    expect((): MemoryRow =>
      store.addCandidate(input({ scope: "global", scope_key: "repo-name" }))
    ).toThrow("must be null when scope is global");
    for (const scope of ["repo", "agent"] as const) {
      expect((): MemoryRow =>
        store.addCandidate(input({ scope, scope_key: null }))
      ).toThrow(`when scope is ${scope}`);
      expect((): MemoryRow =>
        store.addCandidate(input({ scope, scope_key: "" }))
      ).toThrow(`when scope is ${scope}`);
    }

    expect(store.addCandidate(input({
      claim: "Global pairing.",
      scope: "global",
      scope_key: null,
    })).scope_key).toBeNull();
    expect(store.addCandidate(input({
      claim: "Repo pairing.",
      scope: "repo",
      scope_key: "hyperagent",
    })).scope_key).toBe("hyperagent");
    expect(store.addCandidate(input({
      claim: "Agent pairing.",
      scope: "agent",
      scope_key: "forge",
    })).scope_key).toBe("forge");
  });

  test("confidence must be finite and within zero and one", (): void => {
    const paths = tempPaths();
    const store = trackedMemoryStore(paths);

    for (const confidence of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((): MemoryRow =>
        store.addCandidate(input({ confidence }))
      ).toThrow("finite number between 0 and 1");
    }

    expect(store.addCandidate(input({ claim: "Zero.", confidence: 0 })).confidence)
      .toBe(0);
    expect(store.addCandidate(input({ claim: "One.", confidence: 1 })).confidence)
      .toBe(1);
  });

  test("normalizeClaim and claimHash are deterministic across superficial variants", (): void => {
    const variants = [
      "Ship fast, please!",
      "  ship   fast please  ",
      "SHIP—FAST... PLEASE???",
    ];

    expect(variants.map(normalizeClaim)).toEqual([
      "ship fast please",
      "ship fast please",
      "ship fast please",
    ]);
    expect(new Set(variants.map(claimHash)).size).toBe(1);
    expect(claimHash(variants[0]!)).toBe(claimHash(variants[0]!));
  });

  test("listMemories filters fields, treats null validation as stale, and orders by scope then id", (): void => {
    const paths = tempPaths();
    const timestamps = [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
      "2026-01-01T00:00:03.000Z",
    ];
    let clockIndex = 0;
    const store = trackedMemoryStore({
      ...paths,
      now: (): Date =>
        new Date(timestamps[clockIndex++] ?? timestamps.at(-1)!),
    });
    const globalNull = store.addCandidate(input({
      claim: "Global null validation.",
      kind: "factual",
      last_validated_at: null,
    }));
    const repoOld = store.addCandidate(input({
      claim: "Repo old validation.",
      kind: "gotcha",
      scope: "repo",
      scope_key: "hyperagent",
      last_validated_at: "2025-01-01T00:00:00.000Z",
    }));
    const repoRecent = store.addManual(input({
      claim: "Repo recent validation.",
      kind: "behavior",
      scope: "repo",
      scope_key: "other",
      last_validated_at: "2027-01-01T00:00:00.000Z",
    }));
    const agent = store.addCandidate(input({
      claim: "Agent memory.",
      kind: "preference",
      scope: "agent",
      scope_key: "forge",
      last_validated_at: "2024-01-01T00:00:00.000Z",
    }));

    expect(store.listMemories({ status: "approved" }).map((row): string => row.id))
      .toEqual([repoRecent.id]);
    expect(store.listMemories({ scope: "repo" }).map((row): string => row.id))
      .toEqual([repoOld.id, repoRecent.id]);
    expect(store.listMemories({ scope_key: "hyperagent" }).map((row): string => row.id))
      .toEqual([repoOld.id]);
    expect(store.listMemories({ scope_key: null }).map((row): string => row.id))
      .toEqual([globalNull.id]);
    expect(store.listMemories({ kind: "preference" }).map((row): string => row.id))
      .toEqual([agent.id]);
    expect(
      store.listMemories({
        staleBefore: "2026-01-01T00:00:00.000Z",
      }).map((row): string => row.id),
    ).toEqual([agent.id, globalNull.id, repoOld.id]);

    const all = store.listMemories();
    const expectedOrder = [globalNull, repoOld, repoRecent, agent]
      .sort((left, right): number =>
        left.scope.localeCompare(right.scope) || left.id.localeCompare(right.id)
      )
      .map((row): string => `${row.scope}:${row.id}`);
    expect(all.map((row): string => `${row.scope}:${row.id}`))
      .toEqual(expectedOrder);
  });

  test("every mutation writes the expected Markdown mirror deterministically", (): void => {
    const paths = tempPaths();
    const timestamps = [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
      "2026-01-01T00:00:03.000Z",
      "2026-01-01T00:00:04.000Z",
    ];
    let clockIndex = 0;
    const store = trackedMemoryStore({
      ...paths,
      now: (): Date =>
        new Date(timestamps[clockIndex++] ?? timestamps.at(-1)!),
    });

    function expectMirror(row: MemoryRow): void {
      const path = mirrorPath(paths.memoryDir, row);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(renderMemoryMarkdown(row));
      expect(renderMemoryMarkdown(row)).toBe(renderMemoryMarkdown(row));
    }

    const added = store.addCandidate(input());
    expectMirror(added);
    expectMirror(store.approve(added.id));
    expectMirror(store.update(added.id, { confidence: 0.75 }));
    expectMirror(store.reject(added.id));
    expectMirror(store.retire(added.id));
  });

  test("memory DDL leaves the events append-only trigger intact", (): void => {
    const paths = tempPaths();
    const eventStore = trackedEventStore(paths.dbPath);
    const event: EventInput = {
      id: ulid(),
      ts: "2026-01-01T00:00:00.000Z",
      type: "tool_call",
      session_id: "append-only-proof",
      vendor: "codex",
      adapter_version: "1.0.0",
      payload: {},
    };
    expect(eventStore.append(event)).toBe(1);

    trackedMemoryStore(paths);

    expect(() =>
      eventStore.db
        .query("UPDATE events SET ts = ? WHERE id = ?")
        .run("2026-02-01T00:00:00.000Z", event.id)
    ).toThrow("events is append-only");
  });
});
