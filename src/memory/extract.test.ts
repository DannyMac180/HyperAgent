import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventInput } from "../schema/events.ts";
import { ulid } from "../schema/ulid.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import {
  buildExtractionInput,
  buildExtractionPrompt,
  createExtractDeps,
  extractMemories,
  parseCandidates,
  storeCandidates,
} from "./extract.ts";
import type {
  ExtractionInput,
  MemoryCandidate,
} from "./extract.ts";
import { openMemoryStore } from "./store.ts";
import type {
  AddMemoryInput,
  MemoryRow,
  MemoryStore,
  MemoryStatus,
} from "./store.ts";

const memoryStores: MemoryStore[] = [];
const eventStores: Store[] = [];
const tempDirectories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "hyperagent-extract-"));
  tempDirectories.push(directory);
  return directory;
}

function memoryStore(): MemoryStore {
  const directory = tempDirectory();
  const store = openMemoryStore({
    dbPath: join(directory, "memory.db"),
    memoryDir: join(directory, "memory"),
  });
  memoryStores.push(store);
  return store;
}

function eventStore(): Store {
  const store = openStore(join(tempDirectory(), "events.db"));
  eventStores.push(store);
  return store;
}

function candidate(
  claim: string,
  confidence = 0.9,
  kind: MemoryCandidate["kind"] = "factual",
): MemoryCandidate {
  return { claim, kind, confidence, raw_ref: null };
}

function existingInput(claim: string): AddMemoryInput {
  return {
    claim,
    kind: "factual",
    scope: "global",
    scope_key: null,
    confidence: 0.9,
    evidence: [{ session_id: "prior-session", raw_ref: null }],
  };
}

function addWithStatus(
  store: MemoryStore,
  claim: string,
  status: MemoryStatus,
): MemoryRow {
  const row = store.addCandidate(existingInput(claim));
  if (status === "candidate") {
    return row;
  }
  if (status === "approved") {
    return store.approve(row.id);
  }
  if (status === "rejected") {
    return store.reject(row.id);
  }
  return store.retire(row.id);
}

function extractionInput(): ExtractionInput {
  return {
    sessionId: "pipeline-session",
    repo: null,
    vendor: "codex",
    agent: "test-agent",
    userTurns: [],
    toolUsage: {},
    errors: [],
    verifications: [],
    completionClaims: [],
  };
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

describe("memory extraction", (): void => {
  test("well-formed, fenced, and prose-wrapped JSON parse correctly", (): void => {
    const raw = JSON.stringify([{
      claim: "Use Bun for TypeScript.",
      kind: "gotcha",
      confidence: 0.91,
      raw_ref: "events#1",
    }]);
    expect(parseCandidates(raw)).toEqual([{
      claim: "Use Bun for TypeScript.",
      kind: "gotcha",
      confidence: 0.91,
      raw_ref: "events#1",
    }]);
    expect(parseCandidates(`\`\`\`json\n${raw}\n\`\`\``)).toHaveLength(1);
    expect(parseCandidates(`Here it is:\n${raw}\nDone.`)).toHaveLength(1);
    expect(parseCandidates('{"claim":"not an array"}')).toEqual([]);
    expect(typeof createExtractDeps({ cliPath: "/fake/cli" }).runModel).toBe(
      "function",
    );
  });

  test("parser is total for garbage and drops every invalid entry", (): void => {
    expect(parseCandidates("not remotely JSON")).toEqual([]);
    const invalid = [
      { claim: "Bad kind", kind: "temporary", confidence: 0.9, raw_ref: null },
      { claim: "Too high", kind: "factual", confidence: 1.1, raw_ref: null },
      { claim: "Too low", kind: "factual", confidence: -0.1, raw_ref: null },
      { claim: "NaN", kind: "factual", confidence: Number.NaN, raw_ref: null },
      { claim: " ", kind: "factual", confidence: 0.9, raw_ref: null },
      "non-object",
      { claim: "Valid", kind: "behavior", confidence: 0.8, raw_ref: 42 },
    ];
    expect(parseCandidates(JSON.stringify(invalid))).toEqual([
      { claim: "Valid", kind: "behavior", confidence: 0.8, raw_ref: null },
    ]);
  });

  test("more than five candidates are ordered and clamped deterministically", (): void => {
    const output = JSON.stringify([
      candidate("Zulu", 0.8),
      candidate("Bravo", 0.99),
      candidate("Alpha", 0.99),
      candidate("Echo", 0.7),
      candidate("Delta", 0.9),
      candidate("Charlie", 0.95),
      candidate("Foxtrot", 0.85),
    ]);
    expect(parseCandidates(output).map((item) => item.claim)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
      "Delta",
      "Foxtrot",
    ]);
  });

  test("runner failures and empty output return empty with captured reasons", async (): Promise<void> => {
    const reasons: string[] = [];
    for (const error of [
      new Error("ENOENT"),
      new Error("timeout"),
      new Error("non-zero exit"),
    ]) {
      expect(await extractMemories({
        runModel: (): Promise<string> => Promise.reject(error),
        onFailure: (reason): void => {
          reasons.push(reason);
        },
      }, extractionInput())).toEqual([]);
    }
    expect(await extractMemories({
      runModel: async (): Promise<string> => "",
      onFailure: (reason): void => {
        reasons.push(reason);
      },
    }, extractionInput())).toEqual([]);
    expect(await extractMemories({
      runModel: async (): Promise<string> => "garbage",
      onFailure: (reason): void => {
        reasons.push(reason);
      },
    }, extractionInput())).toEqual([]);
    expect(reasons).toHaveLength(5);
    expect(reasons.join(" ")).toContain("ENOENT");
    expect(reasons.join(" ")).toContain("empty output");
    expect(reasons.join(" ")).toContain("invalid candidate JSON");
  });

  test("runner failure leaves the store untouched", async (): Promise<void> => {
    const store = memoryStore();
    const parsed = await extractMemories({
      runModel: (): Promise<string> => Promise.reject(new Error("ENOENT")),
    }, extractionInput());
    expect(parsed).toEqual([]);
    expect(store.listMemories()).toEqual([]);
  });

  test("input builder uses only main-thread canonical events and prompt is stable", (): void => {
    const store = eventStore();
    const base = {
      session_id: "session-input",
      vendor: "codex" as const,
      adapter_version: "1.0.0",
    };
    const events: EventInput[] = [
      {
        ...base,
        id: ulid(),
        ts: "2026-01-01T00:00:00.000Z",
        type: "session_start",
        payload: { repo: "repo-a", agent: "codex" },
      },
      {
        ...base,
        id: ulid(),
        ts: "2026-01-01T00:00:01.000Z",
        type: "turn_start",
        payload: { turn_index: 1, text_digest: "durable request" },
      },
      {
        ...base,
        id: ulid(),
        ts: "2026-01-01T00:00:02.000Z",
        type: "tool_call",
        payload: { name: "shell", status: "ok" },
      },
      {
        ...base,
        id: ulid(),
        ts: "2026-01-01T00:00:03.000Z",
        type: "error",
        payload: {
          source: "tool",
          message_summary: "sidechain-only",
          is_sidechain: true,
        },
      },
      {
        ...base,
        id: ulid(),
        ts: "2026-01-01T00:00:04.000Z",
        type: "verification_event",
        payload: {
          kind: "test",
          command_summary: "bun test",
          result: "pass",
          stats: { passed: 1 },
        },
      },
      {
        ...base,
        id: ulid(),
        ts: "2026-01-01T00:00:05.000Z",
        type: "completion_claim",
        payload: { claim_text: "done", claim_kind: "done" },
      },
    ];
    store.append(events);

    const input = buildExtractionInput(store, "session-input");
    expect(input.repo).toBe("repo-a");
    expect(input.userTurns).toHaveLength(1);
    expect(input.toolUsage.shell?.count).toBe(1);
    expect(input.errors).toEqual([]);
    expect(input.verifications).toHaveLength(1);
    expect(input.completionClaims).toHaveLength(1);
    expect(buildExtractionPrompt(input)).toBe(buildExtractionPrompt(input));
    expect(buildExtractionPrompt(input)).toContain("MUST NOT emit session_id");
  });

  test("pipeline stamps session id and ignores a malicious model session_id", (): void => {
    const parsed = parseCandidates(JSON.stringify([{
      claim: "Canonical claim",
      kind: "factual",
      confidence: 0.9,
      raw_ref: "event#1",
      session_id: "malicious-model-session",
    }]));
    const store = memoryStore();
    const result = storeCandidates(parsed, {
      memoryStore: store,
      sessionId: "pipeline-session",
      repo: null,
    });
    expect(result.stored[0]?.evidence).toEqual([{
      session_id: "pipeline-session",
      raw_ref: "event#1",
    }]);
  });

  test("dedupe covers active statuses, rejected tombstones, retired relearning, and batches", (): void => {
    const store = memoryStore();
    addWithStatus(store, "Approved duplicate", "approved");
    addWithStatus(store, "Candidate duplicate", "candidate");
    addWithStatus(store, "Rejected tombstone", "rejected");
    addWithStatus(store, "Retired relearned", "retired");

    const result = storeCandidates([
      candidate("Approved duplicate"),
      candidate("Candidate duplicate"),
      candidate("Rejected tombstone"),
      candidate("Retired relearned"),
      candidate("Fresh duplicate"),
      candidate("fresh duplicate!"),
    ], {
      memoryStore: store,
      sessionId: "new-session",
      repo: null,
    });

    expect(result.stored.map((row) => row.claim)).toEqual([
      "Retired relearned",
      "Fresh duplicate",
    ]);
    expect(result.storedCount).toBe(2);
    expect(result.droppedAsDuplicateCount).toBe(4);
  });

  test("scope assignment uses repo presence and absence", (): void => {
    const store = memoryStore();
    const repoResult = storeCandidates([candidate("Repo claim")], {
      memoryStore: store,
      sessionId: "session-repo",
      repo: "org/repo",
    });
    const globalResult = storeCandidates([candidate("Global claim")], {
      memoryStore: store,
      sessionId: "session-global",
      repo: " ",
    });
    expect(repoResult.stored[0]?.scope).toBe("repo");
    expect(repoResult.stored[0]?.scope_key).toBe("org/repo");
    expect(globalResult.stored[0]?.scope).toBe("global");
    expect(globalResult.stored[0]?.scope_key).toBeNull();
  });
});
