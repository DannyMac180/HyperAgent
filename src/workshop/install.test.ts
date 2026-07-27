import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
} from "node:path";

import {
  CONTRACT_SCHEMA_VERSION,
  type VerificationContract,
  validateContractDoc,
} from "../gate/contract.ts";
import { claimHash, openMemoryStore } from "../memory/store.ts";
import type { MemoryStore } from "../memory/store.ts";
import {
  installProposal,
  type InstallOutcome,
  type InstallReceipt,
} from "./install.ts";
import type { VerificationPredicate } from "./predicates.ts";
import type { DraftedProposal } from "./propose.ts";
import {
  humanApprovalFromCli,
  openWorkshopQueue,
  type WorkshopProposalRow,
  type WorkshopQueue,
} from "./queue.ts";

const FIXED_NOW = new Date("2026-07-27T12:00:00.000Z");
const queues: WorkshopQueue[] = [];
const memoryStores: MemoryStore[] = [];
const tempDirectories: string[] = [];

async function trackedDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return realpath(directory);
}

async function trackedQueue(): Promise<WorkshopQueue> {
  const dataDir = await trackedDirectory("hyperagent-install-queue-");
  const queue = openWorkshopQueue({ dataDir, dbPath: ":memory:" });
  queues.push(queue);
  return queue;
}

async function trackedRepo(git = true): Promise<string> {
  const repo = await trackedDirectory("hyperagent-install-repo-");
  if (git) {
    await mkdir(join(repo, ".git"));
  }
  return repo;
}

function evidence(clusterSignature: string): DraftedProposal["evidence"] {
  return {
    sessionIds: ["session-1", "session-2"],
    eventIds: ["event-1", "event-2"],
    clusterSignature,
  };
}

function verificationDraft(
  predicate: VerificationPredicate = {
    type: "command_after_last_mutation",
    pattern: "bun test",
  },
  title = "Require the focused test command",
  description = "Run the focused test command after the last mutation.",
): DraftedProposal {
  return {
    type: "verification_check",
    durability: "measurement",
    title,
    rationale: "The repository needs durable verification evidence.",
    body: {
      type: "verification_check",
      description,
      predicate,
    },
    evidence: evidence(`cluster:${title}`),
    holdoutSessionIds: ["holdout-1"],
    drafterVersion: "install-test-v1",
  };
}

function memoryDraft(
  claim: string,
  title = "Remember the durable behavior",
  proposalEvidence = evidence("cluster:memory"),
): DraftedProposal {
  return {
    type: "memory",
    durability: "persistence",
    title,
    rationale: "This behavior must persist across sessions.",
    body: { type: "memory", content: claim },
    evidence: proposalEvidence,
    holdoutSessionIds: ["holdout-1"],
    drafterVersion: "install-test-v1",
  };
}

function manualDraft(
  type: "instruction_edit" | "skill",
  content: string,
): DraftedProposal {
  return {
    type,
    durability: "actuation",
    title: `Render a ${type} artifact`,
    rationale: "A human must review and place this artifact.",
    body: { type, content },
    evidence: evidence(`cluster:${type}`),
    holdoutSessionIds: ["holdout-1"],
    drafterVersion: "install-test-v1",
  };
}

function addOne(
  queue: WorkshopQueue,
  draft: DraftedProposal,
): WorkshopProposalRow {
  const rows = queue.addDrafts([draft]);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("expected one workshop proposal");
  }
  return row;
}

function approve(
  queue: WorkshopQueue,
  draft: DraftedProposal,
): WorkshopProposalRow {
  const row = addOne(queue, draft);
  queue.promoteToPending(row.id);
  return queue.approve(
    row.id,
    humanApprovalFromCli({ proposalId: row.id, confirmed: true }),
    row.contentHash,
  );
}

function expectSuccess(outcome: InstallOutcome): InstallReceipt {
  expect(outcome.ok).toBeTrue();
  if (!outcome.ok) {
    throw new Error(`expected install success, received ${outcome.code}`);
  }
  return outcome.receipt;
}

function expectFailure(
  outcome: InstallOutcome,
  code: Extract<InstallOutcome, { ok: false }>["code"],
): void {
  expect(outcome.ok).toBeFalse();
  if (outcome.ok) {
    throw new Error(`expected ${code}, received install success`);
  }
  expect(outcome.code).toBe(code);
  expect(outcome.reason.length).toBeGreaterThan(0);
}

async function writeContract(
  repo: string,
  contract: VerificationContract,
): Promise<{ path: string; raw: string }> {
  const directory = join(repo, ".hyperagent");
  const path = join(directory, "contract.json");
  const raw = `${JSON.stringify(contract, null, 2)}\n`;
  await mkdir(directory);
  await writeFile(path, raw, "utf8");
  return { path, raw };
}

afterEach(async (): Promise<void> => {
  for (const queue of queues.splice(0).reverse()) {
    queue.close();
  }
  for (const store of memoryStores.splice(0).reverse()) {
    store.close();
  }
  for (const directory of tempDirectories.splice(0).reverse()) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Workshop install approval and integrity boundary", (): void => {
  test("refuses draft, pending, and rejected proposals without writing", async (): Promise<void> => {
    const queue = await trackedQueue();
    const repo = await trackedRepo();

    const draftRow = addOne(
      queue,
      verificationDraft(undefined, "Draft proposal"),
    );
    const pendingDraft = addOne(
      queue,
      verificationDraft(undefined, "Pending proposal"),
    );
    const pendingRow = queue.promoteToPending(pendingDraft.id);
    const rejectedDraft = addOne(
      queue,
      verificationDraft(undefined, "Rejected proposal"),
    );
    queue.promoteToPending(rejectedDraft.id);
    const rejectedRow = queue.reject(
      rejectedDraft.id,
      "human",
      "not approved",
    );

    for (const row of [draftRow, pendingRow, rejectedRow]) {
      expectFailure(installProposal(row, {}, { targetRepo: repo }), "not_approved");
      expect(existsSync(join(repo, ".hyperagent"))).toBeFalse();
    }
  });

  test("detects a TOCTOU content change before any write", async (): Promise<void> => {
    const queue = await trackedQueue();
    const repo = await trackedRepo();
    const approved = approve(queue, verificationDraft());
    const changed: WorkshopProposalRow = {
      ...approved,
      body: {
        type: "verification_check",
        description: "This content was changed after approval.",
        predicate: {
          type: "command_after_last_mutation",
          pattern: "bun test",
        },
      },
    };

    expectFailure(
      installProposal(changed, {}, { targetRepo: repo }),
      "hash_mismatch",
    );
    expect(existsSync(join(repo, ".hyperagent"))).toBeFalse();
  });

  test("installs the same contract check twice without a second write or duplicate", async (): Promise<void> => {
    const queue = await trackedQueue();
    const repo = await trackedRepo();
    const approved = approve(queue, verificationDraft());
    let writeCount = 0;
    const deps = {
      now: (): Date => FIXED_NOW,
      writeContractAtomically: (target: string, content: string): void => {
        writeCount += 1;
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
      },
    };

    const firstReceipt = expectSuccess(
      installProposal(approved, deps, { targetRepo: repo }),
    );
    const secondReceipt = expectSuccess(
      installProposal(approved, deps, { targetRepo: repo }),
    );
    const contract = JSON.parse(
      await readFile(join(repo, ".hyperagent", "contract.json"), "utf8"),
    ) as VerificationContract;

    expect(writeCount).toBe(1);
    expect(firstReceipt.writes).toHaveLength(1);
    expect(secondReceipt.writes).toEqual([]);
    expect(contract.requiredChecks).toHaveLength(1);
    expect(contract.requiredChecks[0]?.id).toBe(approved.id);
  });
});

describe("Workshop memory installs", (): void => {
  test("carries evidence into one approved memory row and deduplicates by claim hash", async (): Promise<void> => {
    const queue = await trackedQueue();
    const dataDir = await trackedDirectory("hyperagent-install-memory-");
    const memoryDir = join(dataDir, "memory");
    const store = openMemoryStore({
      dbPath: join(dataDir, "memory.db"),
      memoryDir,
      now: (): Date => FIXED_NOW,
    });
    memoryStores.push(store);
    const claim = "Workshop installs approved durable memories.";
    const first = approve(queue, memoryDraft(claim));
    const duplicateEvidence = {
      sessionIds: ["session-3"],
      eventIds: ["event-3"],
      clusterSignature: "cluster:duplicate-memory",
    };
    const duplicate = approve(
      queue,
      memoryDraft(claim, "Same claim from another proposal", duplicateEvidence),
    );

    const firstReceipt = expectSuccess(
      installProposal(first, { memoryStore: store, now: (): Date => FIXED_NOW }),
    );
    const memoriesAfterFirst = store.listMemories();
    expect(memoriesAfterFirst).toHaveLength(1);
    const installed = memoriesAfterFirst[0];
    if (installed === undefined) {
      throw new Error("expected the installed memory");
    }
    expect(installed.status).toBe("approved");
    expect(installed.claim_hash).toBe(claimHash(claim));
    expect(installed.evidence).toEqual([
      {
        session_id: "session-1",
        raw_ref: JSON.stringify({
          clusterSignature: "cluster:memory",
          eventIds: ["event-1", "event-2"],
        }),
      },
      {
        session_id: "session-2",
        raw_ref: JSON.stringify({
          clusterSignature: "cluster:memory",
          eventIds: ["event-1", "event-2"],
        }),
      },
    ]);
    expect(firstReceipt.writes).toEqual([
      {
        target: `memory:${claimHash(claim)}`,
        description: "Added an approved memory and its managed mirror.",
      },
    ]);
    const mirrorPath = join(memoryDir, "global", `${installed.id}.md`);
    const mirrorBeforeRetry = await readFile(mirrorPath, "utf8");

    const duplicateReceipt = expectSuccess(
      installProposal(duplicate, {
        memoryStore: store,
        now: (): Date => FIXED_NOW,
      }),
    );

    expect(duplicateReceipt.writes).toEqual([]);
    expect(store.listMemories()).toHaveLength(1);
    expect(await readFile(mirrorPath, "utf8")).toBe(mirrorBeforeRetry);
    expect(await readdir(join(memoryDir, "global"))).toEqual([
      `${installed.id}.md`,
    ]);
  });
});

describe("Workshop verification contract installs", (): void => {
  test("merges with existing checks and protected paths, writes a valid JSON contract, and records the exact receipt", async (): Promise<void> => {
    const queue = await trackedQueue();
    const repo = await trackedRepo();
    const existing: VerificationContract = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      requiredChecks: [{
        id: "existing-check",
        description: "Keep the existing check.",
        commandPattern: "bun test existing",
      }],
      protectedPaths: ["src/protected/**"],
    };
    const { path } = await writeContract(repo, existing);
    const approved = approve(
      queue,
      verificationDraft(
        {
          type: "command_after_last_mutation",
          pattern: "bunx tsc --noEmit",
        },
        "Require TypeScript verification",
        "Run TypeScript verification after the last mutation.",
      ),
    );

    const receipt = expectSuccess(
      installProposal(
        approved,
        { now: (): Date => FIXED_NOW },
        { targetRepo: repo },
      ),
    );
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as VerificationContract;

    expect(validateContractDoc(parsed)).toEqual([]);
    expect(parsed).toEqual({
      schema_version: CONTRACT_SCHEMA_VERSION,
      requiredChecks: [
        existing.requiredChecks[0]!,
        {
          id: approved.id,
          description: "Run TypeScript verification after the last mutation.",
          commandPattern: "bunx tsc --noEmit",
        },
      ],
      protectedPaths: ["src/protected/**"],
    });
    expect(receipt).toEqual({
      proposalId: approved.id,
      contentHash: approved.contentHash,
      mode: "automatic",
      installedAt: FIXED_NOW.toISOString(),
      writes: [{
        target: path,
        description: `Appended required check "${approved.id}".`,
      }],
      renderedArtifact: null,
      notes: [],
    });
  });

  test("rejects a duplicate check id with different content and leaves the contract untouched", async (): Promise<void> => {
    const queue = await trackedQueue();
    const repo = await trackedRepo();
    const approved = approve(queue, verificationDraft());
    const { path, raw } = await writeContract(repo, {
      schema_version: CONTRACT_SCHEMA_VERSION,
      requiredChecks: [{
        id: approved.id,
        description: "Different existing content.",
        commandPattern: "bun test",
      }],
      protectedPaths: ["keep/**"],
    });

    expectFailure(
      installProposal(approved, {}, { targetRepo: repo }),
      "duplicate_check_id",
    );
    expect(await readFile(path, "utf8")).toBe(raw);
  });

  test("treats an identical duplicate check id as crash-safe idempotent success", async (): Promise<void> => {
    const queue = await trackedQueue();
    const repo = await trackedRepo();
    const approved = approve(queue, verificationDraft());
    const description = approved.body.type === "verification_check"
      ? approved.body.description
      : "";
    const pattern = approved.body.type === "verification_check"
      && approved.body.predicate.type === "command_after_last_mutation"
      ? approved.body.predicate.pattern
      : "";
    const { path, raw } = await writeContract(repo, {
      schema_version: CONTRACT_SCHEMA_VERSION,
      requiredChecks: [{
        id: approved.id,
        description,
        commandPattern: pattern,
      }],
      protectedPaths: ["keep/**"],
    });
    let writeCount = 0;

    const receipt = expectSuccess(
      installProposal(
        approved,
        {
          writeContractAtomically: (): void => {
            writeCount += 1;
          },
        },
        { targetRepo: repo },
      ),
    );

    expect(writeCount).toBe(0);
    expect(receipt.writes).toEqual([]);
    expect(receipt.notes).toEqual([
      `Required check "${approved.id}" already matches the approved proposal; no write was needed.`,
    ]);
    expect(await readFile(path, "utf8")).toBe(raw);
  });

  test("refuses every unrenderable predicate without widening or changing the contract", async (): Promise<void> => {
    const queue = await trackedQueue();
    const repo = await trackedRepo();
    const existing: VerificationContract = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      requiredChecks: [{
        id: "existing-check",
        description: "Preserve this check.",
        commandPattern: "bun test",
      }],
      protectedPaths: ["keep/**"],
    };
    const { path, raw } = await writeContract(repo, existing);
    const predicates: VerificationPredicate[] = [
      { type: "command_ran_matching", pattern: "bun test" },
      { type: "event_present", eventType: "tool_call" },
      { type: "event_absent", eventType: "error" },
    ];

    for (const predicate of predicates) {
      const approved = approve(
        queue,
        verificationDraft(
          predicate,
          `Unrenderable ${predicate.type}`,
          `Do not widen ${predicate.type}.`,
        ),
      );
      expectFailure(
        installProposal(approved, {}, { targetRepo: repo }),
        "unrenderable",
      );
      expect(await readFile(path, "utf8")).toBe(raw);
    }
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(existing);
  });

  test("refuses a gate-ineligible repo without writing", async (): Promise<void> => {
    const queue = await trackedQueue();
    const ineligibleRepo = await trackedRepo(false);
    const approved = approve(queue, verificationDraft());

    expectFailure(
      installProposal(approved, {}, { targetRepo: ineligibleRepo }),
      "repo_ineligible",
    );
    expect(await readdir(ineligibleRepo)).toEqual([]);
  });
});

describe("Workshop manual installs", (): void => {
  test("renders instruction edits and skills without writing files", async (): Promise<void> => {
    const queue = await trackedQueue();
    const target = await trackedDirectory("hyperagent-install-manual-");
    const cases: Array<{
      type: "instruction_edit" | "skill";
      content: string;
    }> = [
      {
        type: "instruction_edit",
        content: "Add this reviewed instruction to the approved target.",
      },
      {
        type: "skill",
        content: "# Reviewed Skill\n\nPlace this skill manually.",
      },
    ];

    for (const item of cases) {
      const approved = approve(queue, manualDraft(item.type, item.content));
      const receipt = expectSuccess(
        installProposal(
          approved,
          { now: (): Date => FIXED_NOW },
          { targetRepo: target },
        ),
      );

      expect(receipt.mode).toBe("manual");
      expect(receipt.writes).toEqual([]);
      expect(receipt.renderedArtifact).toBe(item.content);
      expect(receipt.renderedArtifact?.length).toBeGreaterThan(0);
      expect(await readdir(target)).toEqual([]);
    }
  });
});
