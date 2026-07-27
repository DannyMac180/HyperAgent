import { describe, expect, test } from "bun:test";

import {
  buildAgentRunnerArgv,
} from "../missions/runner.ts";
import type { FrictionCluster } from "./friction.ts";
import {
  DEFAULT_DISALLOWED_DRAFT_TOOLS,
  HOW_TO_THINK_PATTERNS,
  WORKSHOP_DRAFTER_VERSION,
  buildProposalPrompt,
  buildProposalRunnerConfig,
  parseProposalResponse,
  proposeForCluster,
} from "./propose.ts";

function cluster(sessionIds: string[] = ["session-b", "session-a"]): FrictionCluster {
  return {
    signature: "tests were skipped",
    kind: "contract_check_failed",
    count: sessionIds.length,
    sessionIds,
    eventIds: sessionIds.map((id: string): string => `event-${id}`),
    repos: ["/repo"],
    agents: ["codex"],
    firstSeen: "2026-07-01T00:00:00.000Z",
    lastSeen: "2026-07-02T00:00:00.000Z",
    exemplars: ["Required test command did not run"],
  };
}

function candidate(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "memory",
    durability: "ground_truth",
    title: "Remember the repository test command",
    rationale: "Two stored sessions rediscovered the same command.",
    body: {
      type: "memory",
      content: "This repository verifies changes with bun test.",
    },
    ...overrides,
  };
}

describe("Workshop proposal runner boundary", () => {
  test("default config carries every disallowed draft tool", () => {
    const config = buildProposalRunnerConfig();
    expect(config.disallowedTools).toEqual([
      ...DEFAULT_DISALLOWED_DRAFT_TOOLS,
    ]);
    expect(config.timeoutMs).toBe(60_000);
  });

  test("runner argv is unchanged when tools are absent or empty", () => {
    const original = ["-p", "--model", "haiku", "--output-format", "text"];
    expect(buildAgentRunnerArgv()).toEqual(original);
    expect(buildAgentRunnerArgv({ disallowedTools: [] })).toEqual(original);
  });

  test("runner argv appends configured disallowed tools", () => {
    expect(buildAgentRunnerArgv({
      model: "sonnet",
      disallowedTools: ["Write", "Bash"],
    })).toEqual([
      "-p",
      "--model",
      "sonnet",
      "--output-format",
      "text",
      "--disallowedTools",
      "Write,Bash",
    ]);
  });

  test("runner rejects a disallowed tool containing a comma", () => {
    expect((): string[] =>
      buildAgentRunnerArgv({ disallowedTools: ["Write,Bash"] })
    ).toThrow("must not contain a comma");
  });
});

describe("parseProposalResponse", () => {
  const malformed: Array<{ name: string; raw: string }> = [
    { name: "non-JSON output", raw: "I suggest adding a memory." },
    { name: "wrong top-level JSON shape", raw: JSON.stringify(candidate()) },
    {
      name: "unknown type",
      raw: JSON.stringify([candidate({
        type: "workflow",
        body: { type: "workflow", content: "Do work." },
      })]),
    },
    {
      name: "unknown durability",
      raw: JSON.stringify([candidate({ durability: "temporary" })]),
    },
    {
      name: "missing required field",
      raw: JSON.stringify([{
        type: "memory",
        durability: "ground_truth",
        title: "Missing rationale",
        body: { type: "memory", content: "A fact." },
      }]),
    },
    {
      name: "invalid verification predicate",
      raw: JSON.stringify([candidate({
        type: "verification_check",
        durability: "measurement",
        title: "Run tests",
        body: {
          type: "verification_check",
          description: "Tests must run.",
          predicate: { type: "command_ran_matching", pattern: "[" },
        },
      })]),
    },
  ];

  for (const entry of malformed) {
    test(`${entry.name} degrades to zero proposals and a diagnostic`, () => {
      const result = parseProposalResponse(entry.raw, cluster());
      expect(result.proposals).toEqual([]);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });
  }

  test("extracts an array defensively from surrounding prose", () => {
    const raw = `Draft follows:\n\`\`\`json\n${JSON.stringify([candidate()])}\n\`\`\`\nDone.`;
    const result = parseProposalResponse(raw, cluster());
    expect(result.diagnostics).toEqual([]);
    expect(result.proposals).toHaveLength(1);
  });

  test("a factual memory proposal survives with schema-owned evidence", () => {
    const result = parseProposalResponse(
      JSON.stringify([candidate()]),
      cluster(),
    );
    expect(result.rejected).toEqual([]);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      type: "memory",
      durability: "ground_truth",
      evidence: {
        sessionIds: ["session-a", "session-b"],
        clusterSignature: "tests were skipped",
      },
      holdoutSessionIds: [],
      drafterVersion: WORKSHOP_DRAFTER_VERSION,
    });
  });

  test("a valid verification predicate survives", () => {
    const result = parseProposalResponse(
      JSON.stringify([candidate({
        type: "verification_check",
        durability: "measurement",
        title: "Require final tests",
        body: {
          type: "verification_check",
          description: "Require a passing test after mutations.",
          predicate: {
            type: "command_after_last_mutation",
            pattern: "^bun test",
          },
        },
      })]),
      cluster(),
    );
    expect(result.rejected).toEqual([]);
    expect(result.proposals[0]?.body).toEqual({
      type: "verification_check",
      description: "Require a passing test after mutations.",
      predicate: {
        type: "command_after_last_mutation",
        pattern: "^bun test",
      },
    });
  });

  test("an invalid predicate is rejected with a reason", () => {
    const result = parseProposalResponse(
      JSON.stringify([candidate({
        type: "verification_check",
        durability: "measurement",
        title: "Broken predicate",
        body: {
          type: "verification_check",
          description: "This predicate is invalid.",
          predicate: { type: "not_real" },
        },
      })]),
      cluster(),
    );
    expect(result.proposals).toEqual([]);
    expect(result.rejected[0]?.rule).toBe("verification-predicate");
    expect(result.rejected[0]?.reason).toContain("predicate is invalid");
  });
});

describe("durability admission", () => {
  const offendingContent: Record<string, string> = {
    "always-think": "Always think through every dependency before editing.",
    consider: "Consider the downstream effects before acting.",
    "be-careful-to": "Be careful to inspect every call site.",
    "approach-by": "Approach difficult changes by writing a plan first.",
    "remember-to-reason": "Remember to reason about hidden edge cases.",
    "make-sure-to-think": "Make sure to think through the architecture.",
    "keep-in-mind": "Keep in mind that tests can be incomplete.",
  };

  for (const heuristic of HOW_TO_THINK_PATTERNS) {
    test(`${heuristic.name} rejects instructional content and names the rule`, () => {
      const result = parseProposalResponse(
        JSON.stringify([candidate({
          type: "instruction_edit",
          durability: "persistence",
          title: `Bad instruction: ${heuristic.name}`,
          body: {
            type: "instruction_edit",
            content: offendingContent[heuristic.name],
          },
        })]),
        cluster(),
      );
      expect(result.proposals).toEqual([]);
      expect(result.rejected[0]?.rule).toBe(heuristic.name);
    });
  }

  test("the same durability test applies to skills", () => {
    const result = parseProposalResponse(
      JSON.stringify([candidate({
        type: "skill",
        durability: "persistence",
        title: "Planning skill",
        body: {
          type: "skill",
          content: "Always think about a plan before changing code.",
        },
      })]),
      cluster(),
    );
    expect(result.proposals).toEqual([]);
    expect(result.rejected[0]?.rule).toBe("always-think");
  });

  test("ordinary factual memory content is not falsely rejected", () => {
    const result = parseProposalResponse(
      JSON.stringify([candidate({
        title: "Repository fact",
        body: {
          type: "memory",
          content: "The release workflow reads fixtures from stored events.",
        },
      })]),
      cluster(),
    );
    expect(result.rejected).toEqual([]);
    expect(result.proposals).toHaveLength(1);
  });
});

describe("holdout and orchestration", () => {
  test("three or more sessions reserve a deterministic non-empty holdout", () => {
    const input = cluster(["session-d", "session-b", "session-a", "session-c"]);
    const result = parseProposalResponse(JSON.stringify([candidate()]), input);
    expect(result.proposals[0]?.evidence.sessionIds).toEqual([
      "session-a",
      "session-b",
      "session-c",
    ]);
    expect(result.proposals[0]?.holdoutSessionIds).toEqual(["session-d"]);

    const prompt = buildProposalPrompt(input, {
      sessionIds: result.proposals[0]?.evidence.sessionIds ?? [],
    });
    expect(prompt).toContain('"session-a"');
    expect(prompt).not.toContain('"session-d"');
    expect(prompt).toContain("Return JSON only");
    expect(prompt).toContain("Required test command did not run");
  });

  test("fewer than three sessions explicitly reserve no holdout", () => {
    const result = parseProposalResponse(
      JSON.stringify([candidate()]),
      cluster(["session-b", "session-a"]),
    );
    expect(result.proposals[0]?.holdoutSessionIds).toEqual([]);
  });

  test("proposeForCluster uses only the injected agent dependency", async () => {
    let calls = 0;
    let receivedPrompt = "";
    const result = await proposeForCluster(
      cluster(["session-c", "session-b", "session-a"]),
      {
        runAgent: async (prompt: string): Promise<string> => {
          calls += 1;
          receivedPrompt = prompt;
          return JSON.stringify([candidate()]);
        },
      },
    );
    expect(calls).toBe(1);
    expect(receivedPrompt).not.toContain('"session-c"');
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.holdoutSessionIds).toEqual(["session-c"]);
  });

  test("agent failures degrade to diagnostics without throwing", async () => {
    const result = await proposeForCluster(cluster(), {
      runAgent: async (): Promise<string> => {
        throw new Error("runner unavailable");
      },
    });
    expect(result.proposals).toEqual([]);
    expect(result.diagnostics[0]).toContain("runner unavailable");
  });
});
