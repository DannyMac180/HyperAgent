import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import type { EventInput } from "../schema/events.ts";
import { deterministicEventId } from "../schema/ids.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import {
  detectViolations,
  listViolations,
  rebuildViolations,
} from "./detect.ts";
import type { PolicyViolation } from "./detect.ts";
import { POLICY_SCHEMA_VERSION } from "./policy.ts";
import type { PolicyDoc, PolicyRule } from "./policy.ts";

interface SeedToolCall {
  name?: string;
  command?: string;
  filesTouched?: string[];
}

interface SeedSessionOptions {
  sessionId: string;
  repo?: string;
  toolCalls?: SeedToolCall[];
}

const stores: Store[] = [];

function trackedStore(): Store {
  const store = openStore(":memory:");
  stores.push(store);
  return store;
}

function eventInput(
  sessionId: string,
  index: number,
  type: EventInput["type"],
  payload: Record<string, unknown>,
): EventInput {
  const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  const rawRef = `${sessionId}.jsonl#${index}`;
  return {
    id: deterministicEventId({
      ts,
      sessionId,
      rawRef,
      type,
    }),
    ts,
    type,
    session_id: sessionId,
    vendor: "codex",
    adapter_version: "0.1.0",
    raw_ref: rawRef,
    payload,
  } as EventInput;
}

function seedSession(store: Store, options: SeedSessionOptions): EventInput[] {
  const startPayload: Record<string, unknown> = {};
  if (options.repo !== undefined) {
    startPayload.repo = options.repo;
  }
  const events: EventInput[] = [
    eventInput(options.sessionId, 0, "session_start", startPayload),
    ...(options.toolCalls ?? []).map(
      (toolCall: SeedToolCall, index: number): EventInput => {
        const payload: Record<string, unknown> = {};
        if (toolCall.name !== undefined) {
          payload.name = toolCall.name;
        }
        if (toolCall.command !== undefined) {
          payload.input_summary = toolCall.command;
        }
        if (toolCall.filesTouched !== undefined) {
          payload.files_touched = toolCall.filesTouched;
        }
        return eventInput(options.sessionId, index + 1, "tool_call", payload);
      },
    ),
  ];
  const inserted = store.append(events);
  if (inserted !== events.length) {
    throw new Error(
      `fixture inserted ${inserted} of ${events.length} events for ${options.sessionId}`,
    );
  }
  return events;
}

function rule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: "flag-command",
    description: "Flag a matching command.",
    action: "flag",
    enabled: true,
    match: { commandPattern: "publish" },
    ...overrides,
  };
}

function policy(rules: PolicyRule[] = [rule()]): PolicyDoc {
  return {
    schema_version: POLICY_SCHEMA_VERSION,
    rules,
  };
}

function fixedClock(iso: string): () => number {
  const milliseconds = Date.parse(iso);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`invalid fixture clock timestamp: ${iso}`);
  }
  return (): number => milliseconds;
}

afterEach((): void => {
  for (const store of stores.splice(0).reverse()) {
    store.close();
  }
});

describe("post-hoc policy violation detection", (): void => {
  test("records flag matches with an event evidence link and resolved repo path", (): void => {
    const store = trackedStore();
    const repo = "/workspace/hyperagent";
    const events = seedSession(store, {
      sessionId: "flagged",
      repo,
      toolCalls: [{
        name: "Write",
        filesTouched: ["src/secret.env"],
      }],
    });
    const matchingPolicy = policy([
      rule({
        id: "flag-secret-path",
        match: {
          pathPattern: "**/src/secret.env",
          pathAccess: "write",
        },
      }),
    ]);

    const detected = detectViolations(
      store,
      "flagged",
      matchingPolicy,
      { now: fixedClock("2026-01-10T00:00:00.000Z") },
    );
    const stored = listViolations(store);
    const toolCall = events[1];
    if (toolCall === undefined) {
      throw new Error("expected a tool_call fixture event");
    }

    expect(detected).toEqual(stored);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.action).toBe("flag");
    expect(stored[0]?.event_id).toBe(toolCall.id);
    expect(store.getEvents("flagged").some(
      (event): boolean => event.id === stored[0]?.event_id,
    )).toBe(true);
    expect(stored[0]?.evidence).toContain(resolve(repo, "src/secret.env"));
  });

  test("matches disabled rules for the universal post-hoc floor", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "disabled-rule",
      toolCalls: [{ command: "dangerous operation" }],
    });
    const matchingPolicy = policy([
      rule({
        id: "disabled-block",
        action: "block",
        enabled: false,
        match: { commandPattern: "dangerous" },
      }),
    ]);

    const violations = detectViolations(store, "disabled-rule", matchingPolicy);

    expect(violations.map((violation): string => violation.rule_id)).toEqual([
      "disabled-block",
    ]);
    expect(violations[0]?.action).toBe("block");
  });

  test("a clean session produces no violations", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "clean",
      toolCalls: [{ command: "bun test" }],
    });

    expect(detectViolations(store, "clean", policy())).toEqual([]);
    expect(listViolations(store)).toEqual([]);
  });

  test("rebuilds are byte-identical with the same events, version, and clock", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "rebuild-a",
      toolCalls: [{ command: "publish package" }],
    });
    seedSession(store, {
      sessionId: "rebuild-b",
      toolCalls: [{ command: "bun test" }],
    });
    const now = fixedClock("2026-01-10T12:34:56.789Z");

    const firstCount = rebuildViolations(store, policy(), { now });
    const firstRows = listViolations(store);
    const secondCount = rebuildViolations(store, policy(), { now });
    const secondRows = listViolations(store);

    expect(firstCount).toBe(2);
    expect(secondCount).toBe(2);
    expect(secondRows).toEqual(firstRows);
  });

  test("detecting the same session twice upserts instead of duplicating", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "idempotent",
      toolCalls: [{ command: "publish package" }],
    });
    const now = fixedClock("2026-01-10T00:00:00.000Z");

    detectViolations(store, "idempotent", policy(), { now });
    detectViolations(store, "idempotent", policy(), { now });

    expect(listViolations(store)).toHaveLength(1);
  });

  test("detection leaves the append-only event log protections intact", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "append-only",
      toolCalls: [{ command: "publish package" }],
    });
    detectViolations(store, "append-only", policy());

    expect((): void => {
      store.db.run("UPDATE events SET ts = ts");
    }).toThrow("events is append-only");
    expect((): void => {
      store.db.run("DELETE FROM events");
    }).toThrow("events is append-only");
    expect(store.getEvents("append-only")).toHaveLength(2);
  });

  test("lists violations by session and detection-day window", (): void => {
    const store = trackedStore();
    seedSession(store, {
      sessionId: "old",
      toolCalls: [{ command: "publish old" }],
    });
    seedSession(store, {
      sessionId: "recent",
      toolCalls: [{ command: "publish recent" }],
    });
    detectViolations(
      store,
      "old",
      policy(),
      { now: fixedClock("2026-01-01T00:00:00.000Z") },
    );
    detectViolations(
      store,
      "recent",
      policy(),
      { now: fixedClock("2026-01-09T00:00:00.000Z") },
    );

    expect(
      listViolations(store, { sessionId: "old" }).map(
        (violation: PolicyViolation): string => violation.session_id,
      ),
    ).toEqual(["old"]);
    expect(
      listViolations(store, {
        days: 2,
        now: fixedClock("2026-01-10T00:00:00.000Z"),
      }).map((violation: PolicyViolation): string => violation.session_id),
    ).toEqual(["recent"]);
  });
});
