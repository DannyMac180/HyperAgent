import type {
  RequiredCheck,
  SessionGateContext,
} from "../gate/contract.ts";
import { pathMatchesGlob } from "../gate/policy.ts";
import type { HyperEvent } from "../schema/events.ts";

export type VerificationPredicate =
  | { type: "command_ran_matching"; pattern: string }
  | { type: "command_after_last_mutation"; pattern: string }
  | {
    type: "event_present";
    eventType: string;
    payloadMatch?: Record<string, string>;
  }
  | {
    type: "event_absent";
    eventType: string;
    payloadMatch?: Record<string, string>;
  }
  | { type: "path_untouched"; glob: string };

export const PREDICATE_TYPES = [
  "command_ran_matching",
  "command_after_last_mutation",
  "event_present",
  "event_absent",
  "path_untouched",
] as const satisfies readonly VerificationPredicate["type"][];

export interface PredicateEvalContext extends SessionGateContext {
  events: HyperEvent[];
}

export interface PredicateVerdict {
  satisfied: boolean;
  reason: string;
}

export type PredicateRender =
  | { kind: "required_check"; check: RequiredCheck }
  | { kind: "protected_path"; path: string }
  | { kind: "unrenderable"; reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validateAllowedKeys(
  candidate: Record<string, unknown>,
  allowedKeys: readonly string[],
  problems: string[],
): void {
  for (const key of Object.keys(candidate)) {
    if (!allowedKeys.includes(key)) {
      problems.push(
        `PREDICATE_UNKNOWN_KEY_ERROR: "${key}" is not allowed for predicate type "${String(candidate.type)}".`,
      );
    }
  }
}

function validatePattern(
  value: unknown,
  problems: string[],
): void {
  if (!isNonEmptyString(value)) {
    problems.push(
      "PREDICATE_PATTERN_ERROR: pattern must be a non-empty string.",
    );
    return;
  }
  try {
    new RegExp(value, "i");
  } catch (error: unknown) {
    problems.push(
      `PREDICATE_REGEX_ERROR: pattern is not a valid regular expression: ${errorMessage(error)}`,
    );
  }
}

function validatePayloadMatch(
  value: unknown,
  problems: string[],
): void {
  if (!isPlainObject(value)) {
    problems.push(
      "PREDICATE_PAYLOAD_MATCH_TYPE_ERROR: payloadMatch must be an object.",
    );
    return;
  }
  for (const [key, expected] of Object.entries(value)) {
    if (typeof expected !== "string") {
      problems.push(
        `PREDICATE_PAYLOAD_MATCH_VALUE_ERROR: payloadMatch.${key} must be a string.`,
      );
    }
  }
}

export function validatePredicate(candidate: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(candidate)) {
    return ["PREDICATE_TYPE_ERROR: predicate must be an object."];
  }
  if (
    typeof candidate.type !== "string"
    || !(PREDICATE_TYPES as readonly string[]).includes(candidate.type)
  ) {
    problems.push(
      `PREDICATE_KIND_ERROR: type must be one of ${PREDICATE_TYPES.join(", ")}.`,
    );
    validateAllowedKeys(candidate, ["type"], problems);
    return problems;
  }

  switch (candidate.type) {
    case "command_ran_matching":
    case "command_after_last_mutation":
      validateAllowedKeys(candidate, ["type", "pattern"], problems);
      validatePattern(candidate.pattern, problems);
      break;
    case "event_present":
    case "event_absent":
      validateAllowedKeys(
        candidate,
        ["type", "eventType", "payloadMatch"],
        problems,
      );
      if (!isNonEmptyString(candidate.eventType)) {
        problems.push(
          "PREDICATE_EVENT_TYPE_ERROR: eventType must be a non-empty string.",
        );
      }
      if (hasOwn(candidate, "payloadMatch")) {
        validatePayloadMatch(candidate.payloadMatch, problems);
      }
      break;
    case "path_untouched":
      validateAllowedKeys(candidate, ["type", "glob"], problems);
      if (!isNonEmptyString(candidate.glob)) {
        problems.push(
          "PREDICATE_GLOB_ERROR: glob must be a non-empty string.",
        );
      }
      break;
  }
  return problems;
}

export function buildPredicateContext(
  events: HyperEvent[],
): PredicateEvalContext {
  const context: PredicateEvalContext = {
    commands: [],
    touchedFiles: [],
    events: [...events],
  };

  events.forEach((event: HyperEvent, sequence: number): void => {
    if (!isPlainObject(event) || event.type !== "tool_call") {
      return;
    }
    const payload: unknown = event.payload;
    if (!isPlainObject(payload)) {
      return;
    }

    if (typeof payload.input_summary === "string") {
      context.commands.push({
        command: payload.input_summary,
        passed: payload.status === "ok",
        sequence,
      });
    }
    if (!Array.isArray(payload.files_touched)) {
      return;
    }
    for (const path of payload.files_touched) {
      if (typeof path === "string") {
        context.touchedFiles.push({ path, sequence });
      }
    }
  });

  return context;
}

function compilePattern(pattern: string): RegExp | string {
  try {
    return new RegExp(pattern, "i");
  } catch (error: unknown) {
    return errorMessage(error);
  }
}

function lastMutationSequence(context: SessionGateContext): number {
  let lastSequence = Number.NEGATIVE_INFINITY;
  for (const touchedFile of context.touchedFiles) {
    if (touchedFile.sequence > lastSequence) {
      lastSequence = touchedFile.sequence;
    }
  }
  return lastSequence;
}

function payloadMatches(
  event: HyperEvent,
  expected: Record<string, string> | undefined,
): boolean {
  if (expected === undefined) {
    return true;
  }
  const payload: unknown = isPlainObject(event) ? event.payload : undefined;
  if (!isPlainObject(payload)) {
    return false;
  }
  return Object.entries(expected).every(
    ([key, value]: [string, string]): boolean =>
      hasOwn(payload, key) && String(payload[key]) === value,
  );
}

function matchingEvents(
  predicate: Extract<
    VerificationPredicate,
    { type: "event_present" | "event_absent" }
  >,
  events: HyperEvent[],
): HyperEvent[] {
  return events.filter(
    (event: HyperEvent): boolean =>
      isPlainObject(event)
      && event.type === predicate.eventType
      && payloadMatches(event, predicate.payloadMatch),
  );
}

function evaluateCommandRanMatching(
  pattern: string,
  context: PredicateEvalContext,
): PredicateVerdict {
  const expression: RegExp | string = compilePattern(pattern);
  if (typeof expression === "string") {
    return {
      satisfied: false,
      reason: `Invalid command pattern "${pattern}": ${expression}`,
    };
  }
  const matchedCommand = context.commands.find(
    (command): boolean => expression.test(command.command),
  );
  if (matchedCommand === undefined) {
    return {
      satisfied: false,
      reason: `No recorded command matched pattern "${pattern}".`,
    };
  }
  return {
    satisfied: true,
    reason: `Command "${matchedCommand.command}" matched pattern "${pattern}" at sequence ${matchedCommand.sequence}.`,
  };
}

function evaluateCommandAfterLastMutation(
  pattern: string,
  context: PredicateEvalContext,
): PredicateVerdict {
  const expression: RegExp | string = compilePattern(pattern);
  if (typeof expression === "string") {
    return {
      satisfied: false,
      reason: `Invalid command pattern "${pattern}": ${expression}`,
    };
  }
  // This deliberately parallels evaluateContract: when no mutation occurred,
  // there is no final changed state to verify, so the check is vacuously true.
  if (context.touchedFiles.length === 0) {
    return {
      satisfied: true,
      reason: `No files were mutated; command pattern "${pattern}" is vacuously satisfied.`,
    };
  }

  const requiredAfterSequence: number = lastMutationSequence(context);
  const matchedCommand = context.commands.find(
    (command): boolean =>
      command.passed
      && command.sequence > requiredAfterSequence
      && expression.test(command.command),
  );
  if (matchedCommand !== undefined) {
    return {
      satisfied: true,
      reason: `Passing command "${matchedCommand.command}" matched pattern "${pattern}" at sequence ${matchedCommand.sequence}, after the last mutation at sequence ${requiredAfterSequence}.`,
    };
  }

  const latestMatchingCommand = [...context.commands].reverse().find(
    (command): boolean => expression.test(command.command),
  );
  if (latestMatchingCommand !== undefined) {
    const status: string = latestMatchingCommand.passed ? "passed" : "did not pass";
    return {
      satisfied: false,
      reason: `Matching command "${latestMatchingCommand.command}" ${status} at sequence ${latestMatchingCommand.sequence}; it must pass strictly after the last mutation at sequence ${requiredAfterSequence}.`,
    };
  }
  return {
    satisfied: false,
    reason: `No command matching pattern "${pattern}" passed strictly after the last mutation at sequence ${requiredAfterSequence}.`,
  };
}

export function evaluatePredicate(
  predicate: VerificationPredicate,
  context: PredicateEvalContext,
  options: { repoRoot?: string } = {},
): PredicateVerdict {
  switch (predicate.type) {
    case "command_ran_matching":
      return evaluateCommandRanMatching(predicate.pattern, context);
    case "command_after_last_mutation":
      return evaluateCommandAfterLastMutation(predicate.pattern, context);
    case "event_present": {
      const matches: HyperEvent[] = matchingEvents(predicate, context.events);
      if (matches.length === 0) {
        return {
          satisfied: false,
          reason: `No "${predicate.eventType}" event matched the requested payload.`,
        };
      }
      return {
        satisfied: true,
        reason: `Event "${matches[0]?.id}" of type "${predicate.eventType}" matched the requested payload.`,
      };
    }
    case "event_absent": {
      const matches: HyperEvent[] = matchingEvents(predicate, context.events);
      if (matches.length === 0) {
        return {
          satisfied: true,
          reason: `No "${predicate.eventType}" event matched the requested payload.`,
        };
      }
      return {
        satisfied: false,
        reason: `Event "${matches[0]?.id}" of type "${predicate.eventType}" matched the payload that must be absent.`,
      };
    }
    case "path_untouched": {
      const matchedFile = context.touchedFiles.find(
        (touchedFile): boolean =>
          pathMatchesGlob(
            predicate.glob,
            touchedFile.path,
            options.repoRoot,
          ),
      );
      if (matchedFile === undefined) {
        return {
          satisfied: true,
          reason: `No touched file matched glob "${predicate.glob}".`,
        };
      }
      return {
        satisfied: false,
        reason: `Touched file "${matchedFile.path}" matched glob "${predicate.glob}" at sequence ${matchedFile.sequence}.`,
      };
    }
  }
}

export function renderPredicateForContract(
  predicate: VerificationPredicate,
  id: string,
  description: string,
): PredicateRender {
  switch (predicate.type) {
    case "command_after_last_mutation":
      return {
        kind: "required_check",
        check: {
          id,
          description,
          commandPattern: predicate.pattern,
        },
      };
    case "path_untouched":
      return { kind: "protected_path", path: predicate.glob };
    // Do not approximate command_ran_matching as a required check: a contract
    // requires a passing command after the last mutation, which is stronger and
    // different from the reviewed predicate's any-matching-command semantics.
    case "command_ran_matching":
      return {
        kind: "unrenderable",
        reason: "VerificationContract cannot express any matching command regardless of pass status or mutation sequence.",
      };
    case "event_present":
      return {
        kind: "unrenderable",
        reason: "VerificationContract cannot require the presence of a canonical event or match its payload.",
      };
    case "event_absent":
      return {
        kind: "unrenderable",
        reason: "VerificationContract cannot require the absence of a canonical event or match its payload.",
      };
  }
}
