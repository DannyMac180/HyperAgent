import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import type { DraftedProposal } from "./propose.ts";
import {
  humanApprovalFromCli,
  openWorkshopQueue,
  type HumanApproval,
  type WorkshopProposalRow,
  type WorkshopQueue,
  verifyContentHash,
} from "./queue.ts";

const queues: WorkshopQueue[] = [];
const tempDirectories: string[] = [];

async function trackedQueue(options: {
  fileBacked?: boolean;
  retries?: number;
} = {}): Promise<{ dataDir: string; queue: WorkshopQueue }> {
  const dataDir = await mkdtemp(join(tmpdir(), "hyperagent-workshop-"));
  tempDirectories.push(dataDir);
  const queue = openWorkshopQueue({
    dataDir,
    dbPath: options.fileBacked === true
      ? join(dataDir, "workshop.db")
      : ":memory:",
    retries: options.retries,
    retryDelayMs: 0,
  });
  queues.push(queue);
  return { dataDir, queue };
}

function draft(title = "Remember durable queue authority"): DraftedProposal {
  return {
    type: "memory",
    durability: "ground_truth",
    title,
    rationale: "The queue must remain the source of truth.",
    body: {
      type: "memory",
      content: "SQLite owns proposal state; Markdown is a derived mirror.",
    },
    evidence: {
      sessionIds: ["session-1"],
      eventIds: ["event-1"],
      clusterSignature: `cluster:${title}`,
    },
    holdoutSessionIds: ["holdout-1"],
    drafterVersion: "queue-test-v1",
  };
}

function addOne(queue: WorkshopQueue, value = draft()): WorkshopProposalRow {
  const rows = queue.addDrafts([value]);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("expected one workshop proposal");
  }
  return row;
}

function cachedStatus(
  queue: WorkshopQueue,
  id: string,
): WorkshopProposalRow["status"] {
  const row = queue.get(id);
  if (row === null) {
    throw new Error(`missing workshop proposal ${id}`);
  }
  return row.status;
}

afterEach(async (): Promise<void> => {
  for (const queue of queues.splice(0).reverse()) {
    queue.close();
  }
  for (const directory of tempDirectories.splice(0).reverse()) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Workshop queue authority boundary", (): void => {
  test("rejects a runtime-forged approval object", async (): Promise<void> => {
    const { queue } = await trackedQueue();
    const row = addOne(queue);
    queue.promoteToPending(row.id);

    // @ts-expect-error HumanApproval's module-private brand prevents bare literals.
    const forged: HumanApproval = { actor: "human", proposalId: row.id };

    expect(
      (): WorkshopProposalRow =>
        queue.approve(row.id, forged, row.contentHash),
    ).toThrow("approval token was not issued by humanApprovalFromCli");
  });

  test("rejects an issued token for a different proposal", async (): Promise<void> => {
    const { queue } = await trackedQueue();
    const first = addOne(queue, draft("First proposal"));
    const second = addOne(queue, draft("Second proposal"));
    queue.promoteToPending(first.id);
    const wrongToken = humanApprovalFromCli({
      proposalId: second.id,
      confirmed: true,
    });

    expect(
      (): WorkshopProposalRow =>
        queue.approve(first.id, wrongToken, first.contentHash),
    ).toThrow(
      `approval token proposal mismatch: token is for ${second.id}, requested ${first.id}`,
    );
  });

  test("requires explicit true confirmation", (): void => {
    expect(
      (): HumanApproval =>
        humanApprovalFromCli({
          proposalId: "proposal-id",
          confirmed: false,
        } as unknown as { proposalId: string; confirmed: true }),
    ).toThrow("human approval requires confirmed === true");
  });
});

describe("Workshop transition log", (): void => {
  test("refuses direct updates and deletes", async (): Promise<void> => {
    const { queue } = await trackedQueue();
    const row = addOne(queue);

    expect(
      () =>
        queue.db.exec(
          `UPDATE workshop_proposal_transitions SET actor = 'forged' WHERE proposal_id = '${row.id}'`,
        ),
    ).toThrow("workshop_proposal_transitions is append-only");
    expect(
      () =>
        queue.db.exec(
          `DELETE FROM workshop_proposal_transitions WHERE proposal_id = '${row.id}'`,
        ),
    ).toThrow("workshop_proposal_transitions is append-only");
    expect(queue.transitions(row.id)).toHaveLength(1);
  });

  test("derives every cached status and records the complete lifecycle", async (): Promise<void> => {
    const { queue } = await trackedQueue();
    const draftRow = addOne(queue);
    const id = draftRow.id;

    expect(queue.statusFromTransitions(id)).toBe(cachedStatus(queue, id));
    queue.promoteToPending(id, "ready for review");
    expect(queue.statusFromTransitions(id)).toBe(cachedStatus(queue, id));
    const approval = humanApprovalFromCli({ proposalId: id, confirmed: true });
    queue.approve(id, approval, draftRow.contentHash);
    expect(queue.statusFromTransitions(id)).toBe(cachedStatus(queue, id));
    queue.markInstalled(id, { path: "AGENTS.md", applied: true });
    expect(queue.statusFromTransitions(id)).toBe(cachedStatus(queue, id));

    const transitions = queue.transitions(id);
    expect(
      transitions.map(
        ({ fromStatus, toStatus, actor }): [string | null, string, string] =>
          [fromStatus, toStatus, actor],
      ),
    ).toEqual([
      [null, "draft", "workshop"],
      ["draft", "pending", "agent"],
      ["pending", "approved", "human"],
      ["approved", "installed", "installer"],
    ]);
    expect(transitions[1]?.note).toBe("ready for review");
    for (const transition of transitions) {
      expect(Number.isNaN(Date.parse(transition.ts))).toBeFalse();
    }
  });

  test("names every refused lifecycle edge", async (): Promise<void> => {
    const { queue } = await trackedQueue();
    const draftRow = addOne(queue, draft("Cannot skip review"));
    expect(
      (): WorkshopProposalRow =>
        queue.markInstalled(draftRow.id, { applied: false }),
    ).toThrow("invalid workshop proposal transition: draft -> installed");

    queue.promoteToPending(draftRow.id);
    expect(
      (): WorkshopProposalRow =>
        queue.markInstalled(draftRow.id, { applied: false }),
    ).toThrow("invalid workshop proposal transition: pending -> installed");

    const rejectedRow = addOne(queue, draft("Rejected stays rejected"));
    queue.promoteToPending(rejectedRow.id);
    queue.reject(rejectedRow.id, "human", "not suitable");
    const approval = humanApprovalFromCli({
      proposalId: rejectedRow.id,
      confirmed: true,
    });
    expect(
      (): WorkshopProposalRow =>
        queue.approve(rejectedRow.id, approval, rejectedRow.contentHash),
    ).toThrow("invalid workshop proposal transition: rejected -> approved");
  });
});

describe("Workshop content integrity", (): void => {
  test("refuses approval with an incorrect expected content hash", async (): Promise<void> => {
    const { queue } = await trackedQueue();
    const row = addOne(queue);
    queue.promoteToPending(row.id);
    const approval = humanApprovalFromCli({
      proposalId: row.id,
      confirmed: true,
    });
    const incorrectHash = row.contentHash === "0".repeat(64)
      ? "1".repeat(64)
      : "0".repeat(64);

    expect(
      (): WorkshopProposalRow =>
        queue.approve(row.id, approval, incorrectHash),
    ).toThrow(
      `proposal content hash mismatch: expected ${incorrectHash}, actual ${row.contentHash}`,
    );
    expect(cachedStatus(queue, row.id)).toBe("pending");
  });

  test("keeps hashes stable across reads and independent of row metadata", async (): Promise<void> => {
    const { queue } = await trackedQueue();
    const inserted = addOne(queue);
    const reread = queue.get(inserted.id);
    expect(reread).not.toBeNull();
    expect(reread?.contentHash).toBe(inserted.contentHash);
    expect(verifyContentHash(inserted)).toEqual({ ok: true });
    expect(verifyContentHash(reread as WorkshopProposalRow)).toEqual({ ok: true });

    const metadataChanged: WorkshopProposalRow = {
      ...inserted,
      id: "not-the-content-id",
      createdAt: "1999-01-01T00:00:00.000Z",
      updatedAt: "2099-01-01T00:00:00.000Z",
      installedAt: "2099-01-02T00:00:00.000Z",
    };
    expect(verifyContentHash(metadataChanged)).toEqual({ ok: true });
  });
});

describe("Workshop persistence", (): void => {
  test("reports real SQLite contention and retry attempts", async (): Promise<void> => {
    const { dataDir, queue } = await trackedQueue({
      fileBacked: true,
      retries: 1,
    });
    queue.db.exec("PRAGMA busy_timeout = 0;");
    const holder = new Database(join(dataDir, "workshop.db"));
    holder.exec("PRAGMA busy_timeout = 0;");
    holder.exec("BEGIN IMMEDIATE;");
    try {
      expect((): WorkshopProposalRow[] => queue.addDrafts([draft()])).toThrow(
        /SQLite contention persisted after 2 attempts:.*(?:SQLITE_BUSY|database is locked)/i,
      );
      expect(queue.list()).toHaveLength(0);
    } finally {
      holder.exec("ROLLBACK;");
      holder.close();
    }
  });

  test("rebuilds and restores the Markdown mirror from SQLite", async (): Promise<void> => {
    const { dataDir, queue } = await trackedQueue();
    const row = addOne(queue);
    const mirrorPath = join(dataDir, "workshop", `${row.id}.md`);
    const original = await readFile(mirrorPath, "utf8");
    expect(original).toContain(`id: "${row.id}"`);
    expect(original).toContain(`content_hash: "${row.contentHash}"`);
    expect(original).toContain(`# ${row.title}`);

    await unlink(mirrorPath);
    expect(queue.rebuildMirror()).toBe(1);
    const rebuilt = await readFile(mirrorPath, "utf8");
    expect(rebuilt).toBe(original);
  });

  test("adds duplicate drafts idempotently with one initial transition", async (): Promise<void> => {
    const { queue } = await trackedQueue();
    const value = draft();
    const returned = queue.addDrafts([value, value]);

    expect(returned).toHaveLength(2);
    expect(returned[0]?.id).toBe(returned[1]?.id);
    expect(queue.list()).toHaveLength(1);
    const onlyRow = queue.list()[0];
    if (onlyRow === undefined) {
      throw new Error("expected the idempotently inserted proposal");
    }
    expect(
      queue.transitions(onlyRow.id).map(
        ({ fromStatus, toStatus }): [string | null, string] =>
          [fromStatus, toStatus],
      ),
    ).toEqual([[null, "draft"]]);
  });
});
