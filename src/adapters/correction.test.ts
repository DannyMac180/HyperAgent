import { describe, expect, test } from "bun:test";

import { detectCorrection } from "./correction.ts";
import type { CorrectionContext } from "./correction.ts";

const COLD: CorrectionContext = {
  afterCompletionClaim: false,
  interrupted: false,
};
const AFTER_CLAIM: CorrectionContext = {
  afterCompletionClaim: true,
  interrupted: false,
};

describe("detectCorrection — explicit phrases", () => {
  const explicit: string[] = [
    "No, use the queue instead.",
    "nope — same failure",
    "Nope still got the same load failed error",
    "Stop. That file was fine before.",
    "Wait, that deleted the wrong rows.",
    "Wrong file, the config lives in etc/",
    "That's wrong — the cutoff is 30 days.",
    "that's not what I asked for",
    "Not what I meant, I wanted the dark variant.",
    "You broke the sidebar layout.",
    "you ignored the second requirement",
    "Why did you delete the fixtures?",
    "undo that last edit please",
    "Revert this commit and start from the plan.",
    "Please put it back the way it was.",
    "It's still broken after your change.",
    "the login still fails on submit",
    "That didn't work, same stack trace.",
    "it doesn't work on the settings page",
    "This is not fixed, the badge is missing.",
    "I already said the copy must stay verbatim.",
    "I told you to keep the schema unchanged.",
    "I asked you to run the tests first.",
  ];

  for (const text of explicit) {
    test(`flags: ${JSON.stringify(text)}`, () => {
      const result = detectCorrection(text, COLD);
      expect(result.isCorrection).toBe(true);
      expect(result.basis).toContain("explicit_phrase");
    });
  }
});

describe("detectCorrection — negative controls (benign prompts stay silent)", () => {
  const benign: string[] = [
    "Please add a retry to the fetch helper.",
    "Great, now add dark mode support to the settings page too.",
    "Thanks — please update the README with the new options as well.",
    "Looks good, ship it.",
    "Can you also write a test for the empty case?",
    "Now let's tackle the second ticket.",
    "Add logging around the retry loop.",
    "What does the scheduler do when the queue is empty?",
    "Let's plan the migration next.",
    "Run the full suite and paste the summary.",
    "The design calls for a wider sidebar on desktop.",
    "yes",
    "proceed",
    "ok do the same for the other adapters",
    "I want a summary of yesterday's sessions.",
    // Words like "no"/"wrong"/"stop" in non-corrective positions.
    "There is no rush on this one.",
    "Add a stop button to the player.",
    "Document the wrong-password flow in the auth guide.",
    // Cross-vendor review shapes (Grok, 2026-08-15): benign prompts that a
    // looser pattern list flagged. Each stays a permanent negative control.
    "No worries if not, tomorrow is fine.",
    "No rush — after the deploy is fine.",
    "Stop the dev server and rerun the build.",
    "wait: before you start, read the docs directory.",
    "Wait until CI finishes before merging.",
    "Why did you choose this library over the built-in?",
    "The previous version didn't work for them, so they upgraded.",
    "Wrong-endian bytes are expected here per the spec.",
    "I asked for access yesterday, still waiting on IT.",
  ];

  for (const text of benign) {
    test(`stays silent: ${JSON.stringify(text)}`, () => {
      expect(detectCorrection(text, COLD).isCorrection).toBe(false);
      // Benign wording must stay silent even right after a completion claim.
      expect(detectCorrection(text, AFTER_CLAIM).isCorrection).toBe(false);
    });
  }
});

describe("detectCorrection — after-completion-claim context", () => {
  const contextual: string[] = [
    "I'm still seeing the same error when it runs.",
    "still getting a 500 from the endpoint",
    "Not quite — the footer overlaps the list.",
    "try again with the cache disabled",
    "it didn't change anything on my end",
    "Actually, the modal never opened.",
    "are you sure the migration ran?",
  ];

  for (const text of contextual) {
    test(`flags only after a claim: ${JSON.stringify(text)}`, () => {
      const after = detectCorrection(text, AFTER_CLAIM);
      expect(after.isCorrection).toBe(true);
      expect(after.basis).toContain("after_completion_claim");
      // The same words cold are a status report, not a correction — unless an
      // explicit phrase independently fires (none of these contain one).
      expect(detectCorrection(text, COLD).isCorrection).toBe(false);
    });
  }
});

describe("detectCorrection — interrupt context", () => {
  test("interrupt evidence flags regardless of wording", () => {
    const result = detectCorrection("continue with the queue approach", {
      afterCompletionClaim: false,
      interrupted: true,
    });
    expect(result.isCorrection).toBe(true);
    expect(result.basis).toEqual(["interrupt"]);
  });

  test("interrupt + explicit phrase records both bases", () => {
    const result = detectCorrection("No, revert that change.", {
      afterCompletionClaim: false,
      interrupted: true,
    });
    expect(result.isCorrection).toBe(true);
    expect(result.basis).toEqual(["interrupt", "explicit_phrase"]);
  });

  test("empty text with interrupt evidence still flags", () => {
    const result = detectCorrection("", {
      afterCompletionClaim: true,
      interrupted: true,
    });
    expect(result.isCorrection).toBe(true);
    expect(result.basis).toEqual(["interrupt"]);
  });
});

describe("detectCorrection — leading scan window", () => {
  test("a correction phrase buried past the window does not flag", () => {
    const preamble: string =
      "Analyze the following transcript excerpt for factual accuracy. ".repeat(
        8,
      );
    expect(preamble.length).toBeGreaterThan(300);
    const result = detectCorrection(
      `${preamble} The reviewer wrote: that's wrong — revert that change.`,
      COLD,
    );
    expect(result.isCorrection).toBe(false);
  });

  test("a correction phrase inside the window flags", () => {
    const result = detectCorrection(
      "That's wrong — revert that change. " + "Context follows. ".repeat(40),
      COLD,
    );
    expect(result.isCorrection).toBe(true);
  });
});

describe("detectCorrection — property sweep", () => {
  test("texts built from a trigger-free vocabulary never flag", () => {
    const vocabulary: string[] = [
      "please",
      "add",
      "the",
      "helper",
      "component",
      "test",
      "schema",
      "update",
      "build",
      "deploy",
      "summary",
      "queue",
      "adapter",
      "session",
      "record",
      "review",
      "plan",
      "next",
      "great",
      "thanks",
    ];
    // Deterministic pseudo-random walk (no Date/Math.random in tests that
    // must reproduce): a simple LCG seeded constant.
    let seed = 42;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    for (let round = 0; round < 500; round += 1) {
      const words: string[] = [];
      const length: number = 1 + next(20);
      for (let index = 0; index < length; index += 1) {
        words.push(vocabulary[next(vocabulary.length)]!);
      }
      const text: string = words.join(" ");
      const result = detectCorrection(text, AFTER_CLAIM);
      if (result.isCorrection) {
        throw new Error(
          `trigger-free text flagged: ${JSON.stringify(text)} `
          + `(basis ${JSON.stringify(result.basis)})`,
        );
      }
    }
  });
});
