import { describe, expect, test } from "bun:test";

import {
  CONTRACT_SCHEMA_VERSION,
  evaluateContract,
  validateContractDoc,
  type VerificationContract,
} from "../gate/contract.ts";
import type {
  EventType,
  HyperEvent,
} from "../schema/events.ts";
import {
  buildPredicateContext,
  evaluatePredicate,
  renderPredicateForContract,
  validatePredicate,
  type PredicateEvalContext,
  type PredicateRender,
  type VerificationPredicate,
} from "./predicates.ts";

function canonicalEvent(
  id: string,
  type: EventType,
  payload: Record<string, unknown>,
): HyperEvent {
  return {
    id,
    ts: "2026-07-27T12:00:00.000Z",
    observed_at: "2026-07-27T12:00:00.000Z",
    type,
    session_id: "session-1",
    vendor: "codex",
    adapter_version: "0.1.0",
    schema_version: "0.1.0",
    raw_ref: null,
    payload,
  } as HyperEvent;
}

function context(
  overrides: Partial<PredicateEvalContext> = {},
): PredicateEvalContext {
  return {
    commands: [],
    touchedFiles: [],
    events: [],
    ...overrides,
  };
}

describe("evaluatePredicate", (): void => {
  test("command_ran_matching reports matching and missing commands", (): void => {
    const predicate: VerificationPredicate = {
      type: "command_ran_matching",
      pattern: "bun test",
    };
    const satisfied = evaluatePredicate(
      predicate,
      context({
        commands: [
          { command: "bun test src/unit.test.ts", passed: false, sequence: 2 },
        ],
      }),
    );
    expect(satisfied.satisfied).toBe(true);
    expect(satisfied.reason).toContain("bun test src/unit.test.ts");

    const unsatisfied = evaluatePredicate(
      predicate,
      context({
        commands: [
          { command: "bunx tsc --noEmit", passed: true, sequence: 3 },
        ],
      }),
    );
    expect(unsatisfied.satisfied).toBe(false);
    expect(unsatisfied.reason).toContain('pattern "bun test"');
  });

  test("command_after_last_mutation requires a passing later command", (): void => {
    const predicate: VerificationPredicate = {
      type: "command_after_last_mutation",
      pattern: "bun test",
    };
    const satisfiedContext = context({
      commands: [
        { command: "bun test", passed: true, sequence: 4 },
      ],
      touchedFiles: [
        { path: "/repo/src/index.ts", sequence: 3 },
      ],
    });
    const satisfied = evaluatePredicate(predicate, satisfiedContext);
    expect(satisfied.satisfied).toBe(true);
    expect(satisfied.reason).toContain('"bun test"');
    expect(satisfied.reason).toContain("sequence 4");

    const unsatisfiedContext = context({
      commands: [
        { command: "bun test", passed: false, sequence: 5 },
      ],
      touchedFiles: [
        { path: "/repo/src/index.ts", sequence: 3 },
      ],
    });
    const unsatisfied = evaluatePredicate(predicate, unsatisfiedContext);
    expect(unsatisfied.satisfied).toBe(false);
    expect(unsatisfied.reason).toContain("did not pass");
    expect(unsatisfied.reason).toContain("sequence 3");
  });

  test("command_after_last_mutation is vacuously satisfied without mutations", (): void => {
    const predicate: VerificationPredicate = {
      type: "command_after_last_mutation",
      pattern: "bun test",
    };
    const predicateVerdict = evaluatePredicate(
      predicate,
      context({
        commands: [],
        touchedFiles: [],
      }),
    );
    expect(predicateVerdict.satisfied).toBe(true);
    expect(predicateVerdict.reason).toContain("vacuously satisfied");

    const contract: VerificationContract = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      requiredChecks: [
        {
          id: "tests",
          description: "Tests pass.",
          commandPattern: "bun test",
        },
      ],
      protectedPaths: [],
    };
    expect(evaluateContract(contract, {
      commands: [],
      touchedFiles: [],
    })).toEqual([]);
  });

  test("a passing command before the last mutation does not count", (): void => {
    const predicate: VerificationPredicate = {
      type: "command_after_last_mutation",
      pattern: "bun test",
    };
    const gateContext = {
      commands: [
        { command: "bun test", passed: true, sequence: 2 },
      ],
      touchedFiles: [
        { path: "/repo/src/index.ts", sequence: 3 },
      ],
    };
    const predicateVerdict = evaluatePredicate(
      predicate,
      context(gateContext),
    );
    expect(predicateVerdict.satisfied).toBe(false);
    expect(predicateVerdict.reason).toContain("sequence 2");
    expect(predicateVerdict.reason).toContain("last mutation at sequence 3");

    const contract: VerificationContract = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      requiredChecks: [
        {
          id: "tests",
          description: "Tests pass.",
          commandPattern: "bun test",
        },
      ],
      protectedPaths: [],
    };
    expect(evaluateContract(contract, gateContext)).toHaveLength(1);
  });

  test("event_present reports present and missing canonical events", (): void => {
    const event = canonicalEvent("event-1", "verification_event", {
      kind: "test",
      result: "pass",
    });
    const predicate: VerificationPredicate = {
      type: "event_present",
      eventType: "verification_event",
      payloadMatch: { kind: "test", result: "pass" },
    };
    const satisfied = evaluatePredicate(
      predicate,
      context({ events: [event] }),
    );
    expect(satisfied.satisfied).toBe(true);
    expect(satisfied.reason).toContain("event-1");

    const unsatisfied = evaluatePredicate(
      predicate,
      context({ events: [] }),
    );
    expect(unsatisfied.satisfied).toBe(false);
    expect(unsatisfied.reason).toContain("verification_event");
  });

  test("event_absent reports absent and forbidden canonical events", (): void => {
    const event = canonicalEvent("event-2", "error", {
      source: "tool",
    });
    const predicate: VerificationPredicate = {
      type: "event_absent",
      eventType: "error",
      payloadMatch: { source: "tool" },
    };
    const satisfied = evaluatePredicate(
      predicate,
      context({ events: [] }),
    );
    expect(satisfied.satisfied).toBe(true);
    expect(satisfied.reason).toContain('No "error" event');

    const unsatisfied = evaluatePredicate(
      predicate,
      context({ events: [event] }),
    );
    expect(unsatisfied.satisfied).toBe(false);
    expect(unsatisfied.reason).toContain("event-2");
  });

  test("path_untouched reports clear and touched paths", (): void => {
    const predicate: VerificationPredicate = {
      type: "path_untouched",
      glob: "docs/**",
    };
    const satisfied = evaluatePredicate(
      predicate,
      context({
        touchedFiles: [
          { path: "/repo/src/index.ts", sequence: 1 },
        ],
      }),
      { repoRoot: "/repo" },
    );
    expect(satisfied.satisfied).toBe(true);
    expect(satisfied.reason).toContain('glob "docs/**"');

    const unsatisfied = evaluatePredicate(
      predicate,
      context({
        touchedFiles: [
          { path: "/repo/docs/gates.md", sequence: 2 },
        ],
      }),
      { repoRoot: "/repo" },
    );
    expect(unsatisfied.satisfied).toBe(false);
    expect(unsatisfied.reason).toContain("/repo/docs/gates.md");
  });
});

describe("validatePredicate", (): void => {
  test("accepts every predicate type", (): void => {
    const predicates: VerificationPredicate[] = [
      { type: "command_ran_matching", pattern: "bun test" },
      { type: "command_after_last_mutation", pattern: "bun test" },
      { type: "event_present", eventType: "error" },
      {
        type: "event_absent",
        eventType: "error",
        payloadMatch: { source: "tool" },
      },
      { type: "path_untouched", glob: "docs/**" },
    ];
    for (const predicate of predicates) {
      expect(validatePredicate(predicate)).toEqual([]);
    }
  });

  test("rejects unknown types and extra keys", (): void => {
    const unknownType = validatePredicate({ type: "shell_command" });
    expect(unknownType.join(" ")).toContain("PREDICATE_KIND_ERROR");

    const extraKey = validatePredicate({
      type: "path_untouched",
      glob: "docs/**",
      command: "rm",
    });
    expect(extraKey.join(" ")).toContain("PREDICATE_UNKNOWN_KEY_ERROR");
  });

  test("rejects empty and invalid patterns", (): void => {
    const empty = validatePredicate({
      type: "command_ran_matching",
      pattern: " ",
    });
    expect(empty.join(" ")).toContain("PREDICATE_PATTERN_ERROR");

    const invalid = validatePredicate({
      type: "command_after_last_mutation",
      pattern: "[",
    });
    expect(invalid.join(" ")).toContain("PREDICATE_REGEX_ERROR");
  });

  test("rejects malformed payloadMatch values", (): void => {
    const nonObject = validatePredicate({
      type: "event_present",
      eventType: "error",
      payloadMatch: "tool",
    });
    expect(nonObject.join(" ")).toContain(
      "PREDICATE_PAYLOAD_MATCH_TYPE_ERROR",
    );

    const nonString = validatePredicate({
      type: "event_absent",
      eventType: "error",
      payloadMatch: { attempt: 2 },
    });
    expect(nonString.join(" ")).toContain(
      "PREDICATE_PAYLOAD_MATCH_VALUE_ERROR",
    );
  });

  test("invalid regex is a validation problem and never throws in evaluation", (): void => {
    const invalid = {
      type: "command_ran_matching",
      pattern: "[",
    } as VerificationPredicate;
    expect(validatePredicate(invalid).join(" ")).toContain(
      "PREDICATE_REGEX_ERROR",
    );
    expect(
      (): void => {
        evaluatePredicate(invalid, context());
      },
    ).not.toThrow();
    const verdict = evaluatePredicate(invalid, context());
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toContain("Invalid command pattern");
  });
});

describe("renderPredicateForContract", (): void => {
  test("renders both lossless mappings into a valid contract", (): void => {
    const check = renderPredicateForContract(
      { type: "command_after_last_mutation", pattern: "bun test" },
      "tests",
      "Tests pass.",
    );
    const protectedPath = renderPredicateForContract(
      { type: "path_untouched", glob: "docs/**" },
      "unused",
      "Docs stay untouched.",
    );
    expect(check.kind).toBe("required_check");
    expect(protectedPath.kind).toBe("protected_path");
    if (check.kind !== "required_check") {
      throw new Error("expected required_check render");
    }
    if (protectedPath.kind !== "protected_path") {
      throw new Error("expected protected_path render");
    }
    const contract: VerificationContract = {
      schema_version: CONTRACT_SCHEMA_VERSION,
      requiredChecks: [check.check],
      protectedPaths: [protectedPath.path],
    };
    expect(validateContractDoc(contract)).toEqual([]);
  });

  test("returns precise unrenderable results for the other predicates", (): void => {
    const predicates: VerificationPredicate[] = [
      { type: "command_ran_matching", pattern: "bun test" },
      { type: "event_present", eventType: "error" },
      { type: "event_absent", eventType: "error" },
    ];
    const renders: PredicateRender[] = predicates.map(
      (predicate: VerificationPredicate): PredicateRender =>
        renderPredicateForContract(predicate, "id", "description"),
    );
    for (const render of renders) {
      expect(render.kind).toBe("unrenderable");
      if (render.kind !== "unrenderable") {
        throw new Error("expected unrenderable predicate");
      }
      expect(render.reason.length).toBeGreaterThan(20);
      expect(render.reason).toContain("VerificationContract");
    }
  });
});

describe("buildPredicateContext", (): void => {
  test("derives gate-shaped context from tool calls", (): void => {
    const events: HyperEvent[] = [
      canonicalEvent("event-1", "session_start", {}),
      canonicalEvent("event-2", "tool_call", {
        input_summary: "bun test",
        status: "ok",
        files_touched: ["/repo/src/index.ts"],
      }),
      canonicalEvent("event-3", "tool_call", {
        input_summary: "bunx tsc --noEmit",
        status: "error",
        files_touched: [],
      }),
    ];
    const built = buildPredicateContext(events);
    expect(built.commands).toEqual([
      { command: "bun test", passed: true, sequence: 1 },
      { command: "bunx tsc --noEmit", passed: false, sequence: 2 },
    ]);
    expect(built.touchedFiles).toEqual([
      { path: "/repo/src/index.ts", sequence: 1 },
    ]);
    expect(built.events).toEqual(events);
  });

  test("skips malformed event shapes without throwing", (): void => {
    const malformedEvents = [
      null,
      { type: "tool_call", payload: "bad" },
      {
        type: "tool_call",
        payload: {
          input_summary: 42,
          status: "ok",
          files_touched: ["/repo/good.ts", 42],
        },
      },
    ] as unknown as HyperEvent[];
    expect(
      (): void => {
        buildPredicateContext(malformedEvents);
      },
    ).not.toThrow();
    const built = buildPredicateContext(malformedEvents);
    expect(built.commands).toEqual([]);
    expect(built.touchedFiles).toEqual([
      { path: "/repo/good.ts", sequence: 2 },
    ]);
  });
});
