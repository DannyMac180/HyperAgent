import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "bun:test";

import type { EventInput } from "../schema/events.ts";
import { openStore } from "../store/store.ts";
import type { DraftedProposal } from "../workshop/propose.ts";
import {
  openWorkshopQueue,
  type WorkshopProposalRow,
} from "../workshop/queue.ts";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const tempDirectories: string[] = [];
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

afterEach((): void => {
  for (const directory of tempDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function runCli(args: string[]): Promise<CliResult> {
  const subprocess = Bun.spawn(
    [process.execPath, cliPath, ...args],
    {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdoutPromise = new Response(subprocess.stdout).text();
  const stderrPromise = new Response(subprocess.stderr).text();
  return {
    exitCode: await subprocess.exited,
    stdout: await stdoutPromise,
    stderr: await stderrPromise,
  };
}

function workshopArgs(
  dataDir: string,
  ...args: string[]
): string[] {
  return ["workshop", ...args, "--data-dir", dataDir];
}

function draft(title: string): DraftedProposal {
  return {
    type: "memory",
    durability: "persistence",
    title,
    rationale: "This behavior must persist across sessions.",
    body: {
      type: "memory",
      content: `Durable Workshop CLI behavior for ${title}.`,
    },
    evidence: {
      sessionIds: ["workshop-cli-evidence-session"],
      eventIds: ["workshop-cli-evidence-event"],
      clusterSignature: `cluster:${title}`,
    },
    holdoutSessionIds: ["workshop-cli-holdout-session"],
    drafterVersion: "workshop-cli-test-v1",
    repo: "/repo",
    agent: null,
  };
}

function seedPendingProposal(
  dataDir: string,
  title: string,
): WorkshopProposalRow {
  const queue = openWorkshopQueue({ dataDir });
  try {
    const rows = queue.addDrafts([draft(title)]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) {
      throw new Error("expected one Workshop proposal");
    }
    return queue.promoteToPending(row.id, "ready for CLI review");
  } finally {
    queue.close();
  }
}

function readProposal(
  dataDir: string,
  id: string,
): WorkshopProposalRow {
  const queue = openWorkshopQueue({ dataDir });
  try {
    const row = queue.get(id);
    if (row === null) {
      throw new Error(`missing Workshop proposal ${id}`);
    }
    return row;
  } finally {
    queue.close();
  }
}

function readTransitions(
  dataDir: string,
  id: string,
): string[] {
  const queue = openWorkshopQueue({ dataDir });
  try {
    return queue.transitions(id).map(
      (transition): string => transition.toStatus,
    );
  } finally {
    queue.close();
  }
}

function seedFrictionStore(dataDir: string): void {
  const store = openStore(join(dataDir, "hyperagent.db"));
  let eventIndex = 0;
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const eventId = (): string => {
    const suffix = alphabet[eventIndex] ?? "0";
    eventIndex += 1;
    return `01ARZ3NDEKTSV4RRFFQ69G5FA${suffix}`;
  };
  try {
    for (const sessionId of ["workshop-cli-one", "workshop-cli-two"]) {
      const events: EventInput[] = [
        {
          id: eventId(),
          ts: "2026-07-27T10:00:00.000Z",
          type: "session_start",
          session_id: sessionId,
          vendor: "test",
          adapter_version: "1.0.0",
          schema_version: "1.0.0",
          payload: { repo: "/workshop-cli-test", agent: "test" },
        },
        {
          id: eventId(),
          ts: "2026-07-27T10:00:01.000Z",
          type: "error",
          session_id: sessionId,
          vendor: "test",
          adapter_version: "1.0.0",
          schema_version: "1.0.0",
          payload: {
            message_summary: "permission denied while writing workshop cache",
          },
        },
      ];
      expect(store.append(events)).toBe(events.length);
    }
  } finally {
    store.close();
  }
}

describe("workshop run", (): void => {
  test("cluster-only prints seeded analysis without creating a queue database", async (): Promise<void> => {
    const dataDir = makeTempDir("hyperagent-workshop-cli-run-");
    seedFrictionStore(dataDir);

    const result = await runCli(
      workshopArgs(dataDir, "run", "--until", "cluster"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Clusters:");
    expect(result.stdout).toContain(
      "permission denied while writing workshop cache",
    );
    expect(result.stdout).toContain("Fragmentation report:");
    const fragmentationOutput = result.stdout.split(
      "Fragmentation report:\n",
    )[1];
    expect(fragmentationOutput).toContain('"totalSignals": 2');
    expect(fragmentationOutput).not.toContain('"clusters"');
    expect(existsSync(join(dataDir, "queue.db"))).toBeFalse();
    expect(existsSync(join(dataDir, "workshop", "queue.db"))).toBeFalse();
    expect(existsSync(join(dataDir, "workshop.db"))).toBeFalse();
  });
});

describe("workshop proposal commands", (): void => {
  test("approve without --yes prints a plan and leaves the proposal pending", async (): Promise<void> => {
    const dataDir = makeTempDir("hyperagent-workshop-cli-plan-");
    const proposal = seedPendingProposal(dataDir, "Preview install plan");

    const result = await runCli(
      workshopArgs(dataDir, "approve", proposal.id),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Proposal: ${proposal.id}`);
    expect(result.stdout).toContain(
      `Target store: ${join(dataDir, "hyperagent.db")}`,
    );
    expect(result.stdout).toContain("What will be written:");
    expect(result.stdout).toContain(
      "Refusing to proceed without explicit confirmation.",
    );
    expect(result.stdout).toContain("Re-run with --yes");
    expect(existsSync(join(dataDir, "hyperagent.db"))).toBeFalse();
    const unchanged = readProposal(dataDir, proposal.id);
    expect(unchanged.status).toBe("pending");
    expect(unchanged.receipt).toBeNull();
  });

  test("approve --yes installs and records the complete lifecycle and receipt", async (): Promise<void> => {
    const dataDir = makeTempDir("hyperagent-workshop-cli-approve-");
    const proposal = seedPendingProposal(dataDir, "Install durable memory");

    const result = await runCli(
      workshopArgs(dataDir, "approve", proposal.id, "--yes"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const receipt: unknown = JSON.parse(result.stdout);
    expect(receipt).toMatchObject({
      proposalId: proposal.id,
      contentHash: proposal.contentHash,
      mode: "automatic",
      renderedArtifact: null,
    });
    expect(receipt).toHaveProperty("writes");
    const installed = readProposal(dataDir, proposal.id);
    expect(installed.status).toBe("installed");
    expect(installed.installedAt).not.toBeNull();
    expect(installed.receipt).toEqual(receipt);
    expect(readTransitions(dataDir, proposal.id)).toEqual([
      "draft",
      "pending",
      "approved",
      "installed",
    ]);
    expect(existsSync(join(dataDir, "hyperagent.db"))).toBeTrue();
  });

  test("reject transitions a pending proposal to rejected", async (): Promise<void> => {
    const dataDir = makeTempDir("hyperagent-workshop-cli-reject-");
    const proposal = seedPendingProposal(dataDir, "Reject this proposal");

    const result = await runCli(
      workshopArgs(dataDir, "reject", proposal.id),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`rejected\t${proposal.id}\n`);
    expect(readProposal(dataDir, proposal.id).status).toBe("rejected");
  });

  test("list and show render proposal identity, type, status, and content", async (): Promise<void> => {
    const dataDir = makeTempDir("hyperagent-workshop-cli-render-");
    const proposal = seedPendingProposal(dataDir, "Render key fields");

    const listed = await runCli(workshopArgs(dataDir, "list"));
    expect(listed.exitCode).toBe(0);
    expect(listed.stderr).toBe("");
    expect(listed.stdout).toContain("ID");
    expect(listed.stdout).toContain("STATUS");
    expect(listed.stdout).toContain(proposal.id);
    expect(listed.stdout).toContain("pending");
    expect(listed.stdout).toContain("memory");
    expect(listed.stdout).toContain("persistence");
    expect(listed.stdout).toContain("Render key fields");

    const shown = await runCli(
      workshopArgs(dataDir, "show", proposal.id),
    );
    expect(shown.exitCode).toBe(0);
    expect(shown.stderr).toBe("");
    expect(shown.stdout).toContain(`ID: ${proposal.id}`);
    expect(shown.stdout).toContain("Title: Render key fields");
    expect(shown.stdout).toContain("Type: memory");
    expect(shown.stdout).toContain("Durability: persistence");
    expect(shown.stdout).toContain("Status: pending");
    expect(shown.stdout).toContain(`Content hash: ${proposal.contentHash}`);
    expect(shown.stdout).toContain("ready for CLI review");
    expect(shown.stdout).toContain(
      "Durable Workshop CLI behavior for Render key fields.",
    );
  });

  test("measure reports an honest insufficient_data row after installation", async (): Promise<void> => {
    const dataDir = makeTempDir("hyperagent-workshop-cli-measure-");
    const proposal = seedPendingProposal(dataDir, "Measure fresh install");
    const approved = await runCli(
      workshopArgs(dataDir, "approve", proposal.id, "--yes"),
    );
    expect(approved.exitCode).toBe(0);

    const result = await runCli(workshopArgs(dataDir, "measure"));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "PROPOSAL  STATUS             BEFORE  AFTER  DELTA  REASON",
    );
    const row = result.stdout.split("\n").find(
      (line): boolean => line.startsWith(proposal.id),
    );
    expect(row).toBeDefined();
    expect(row).toContain("insufficient_data");
    expect(row).toContain("  0  0  n/a  ");
    expect(row).toContain("Insufficient data:");
  });
});

describe("workshop argument errors", (): void => {
  test("unknown subcommands fail clearly", async (): Promise<void> => {
    const result = await runCli(["workshop", "unknown"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Unknown workshop subcommand: unknown",
    );
  });

  test.each(["show", "approve", "reject"])(
    "%s requires a proposal id",
    async (subcommand: string): Promise<void> => {
      const result = await runCli(["workshop", subcommand]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Missing workshop proposal id.");
    },
  );
});
