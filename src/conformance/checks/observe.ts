import { isAbsolute } from "node:path";
import {
  inspect,
  isDeepStrictEqual,
} from "node:util";

import type {
  DiscoveredSession,
  ObserveAdapter,
  ParseResult,
} from "../../adapters/types.ts";
import {
  validateEnvelope,
} from "../../schema/events.ts";
import type { EventInput } from "../../schema/events.ts";
import {
  NotApplicableError,
} from "../runner.ts";
import type {
  ConformanceCheck,
  ConformanceCheckDependencies,
  ObserveCheckDependencies,
} from "../runner.ts";

interface ParsedSessions {
  events: EventInput[];
  parseFailures: number;
  skippedUnknown: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    return "unknown thrown value";
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function validateSessions(value: unknown, label: string): DiscoveredSession[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must return an array`);
  }
  return value.map((candidate: unknown, index: number): DiscoveredSession => {
    const itemLabel = `${label}[${index}]`;
    if (!isPlainObject(candidate)) {
      throw new Error(`${itemLabel} must be a plain object`);
    }
    const sessionId: string = requireNonEmptyString(
      candidate.sessionId,
      `${itemLabel}.sessionId`,
    );
    const path: string = requireNonEmptyString(
      candidate.path,
      `${itemLabel}.path`,
    );
    if (!Number.isFinite(candidate.mtimeMs)) {
      throw new Error(`${itemLabel}.mtimeMs must be a finite number`);
    }
    if (!Number.isFinite(candidate.sizeBytes)) {
      throw new Error(`${itemLabel}.sizeBytes must be a finite number`);
    }
    return {
      sessionId,
      path,
      mtimeMs: candidate.mtimeMs as number,
      sizeBytes: candidate.sizeBytes as number,
    };
  });
}

function validateParseResult(value: unknown, label: string): ParseResult {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must return a plain object`);
  }
  if (!Array.isArray(value.events)) {
    throw new Error(`${label}.events must be an array`);
  }
  const resumeToken: string = typeof value.resumeToken === "string"
    ? value.resumeToken
    : (() => {
      throw new Error(`${label}.resumeToken must be a string`);
    })();
  return {
    events: value.events as EventInput[],
    resumeToken,
    skippedUnknown: requireCount(
      value.skippedUnknown,
      `${label}.skippedUnknown`,
    ),
    parseFailures: requireCount(
      value.parseFailures,
      `${label}.parseFailures`,
    ),
  };
}

/**
 * Adapter calls intentionally have no wrapper timeout. The ConformanceCheck
 * contract assigns bounding and cancellation to descriptor implementations
 * because the vendor-blind core cannot safely cancel arbitrary filesystem IO.
 */
async function discover(
  adapter: ObserveAdapter,
  label: string,
): Promise<DiscoveredSession[]> {
  try {
    return validateSessions(
      await adapter.discoverSessions(),
      `${label}.discoverSessions()`,
    );
  } catch (error: unknown) {
    throw new Error(`${label} discovery failed: ${errorMessage(error)}`);
  }
}

async function parse(
  adapter: ObserveAdapter,
  session: DiscoveredSession,
  resumeToken: string,
  label: string,
): Promise<ParseResult> {
  try {
    return validateParseResult(
      await adapter.parseSession(session, resumeToken),
      `${label}.parseSession(${JSON.stringify(session.sessionId)})`,
    );
  } catch (error: unknown) {
    throw new Error(
      `${label} parse failed for ${JSON.stringify(session.sessionId)}: `
      + errorMessage(error),
    );
  }
}

async function parseAll(
  adapter: ObserveAdapter,
  label: string,
): Promise<ParsedSessions> {
  const sessions: DiscoveredSession[] = (await discover(adapter, label))
    .slice()
    .sort(
      (left: DiscoveredSession, right: DiscoveredSession): number =>
        left.sessionId.localeCompare(right.sessionId),
    );
  const parsed: ParsedSessions = {
    events: [],
    parseFailures: 0,
    skippedUnknown: 0,
  };
  for (const session of sessions) {
    const result: ParseResult = await parse(adapter, session, "", label);
    parsed.events.push(...result.events);
    parsed.parseFailures += result.parseFailures;
    parsed.skippedUnknown += result.skippedUnknown;
  }
  return parsed;
}

async function singleSession(
  adapter: ObserveAdapter,
  label: string,
): Promise<DiscoveredSession> {
  const sessions: DiscoveredSession[] = await discover(adapter, label);
  if (sessions.length !== 1) {
    throw new Error(
      `${label} must expose exactly one session, found ${sessions.length}`,
    );
  }
  return sessions[0]!;
}

function eventId(event: EventInput, label: string): string {
  if (!isPlainObject(event)) {
    throw new Error(`${label} must be a plain object`);
  }
  return requireNonEmptyString(event.id, `${label}.id`);
}

function eventIds(events: readonly EventInput[], label: string): string[] {
  return events.map((event: EventInput, index: number): string =>
    eventId(event, `${label}[${index}]`));
}

function compact(value: unknown): string {
  const rendered: string = inspect(value, {
    breakLength: 100,
    compact: true,
    depth: 4,
    maxArrayLength: 10,
    maxStringLength: 240,
    sorted: true,
  });
  return rendered.length <= 600 ? rendered : `${rendered.slice(0, 597)}...`;
}

function deterministicJson(value: unknown): string {
  const serialized: string | undefined = JSON.stringify(
    value,
    (_key: string, candidate: unknown): unknown => {
      if (!isPlainObject(candidate)) {
        return candidate;
      }
      return Object.fromEntries(
        Object.keys(candidate)
          .sort()
          .map((key: string): [string, unknown] => [key, candidate[key]]),
      );
    },
  );
  return serialized ?? "undefined";
}

/**
 * The canonical event schema does not guarantee ordering among events that
 * share a timestamp. Pinning that arbitrary tie-break would make the golden
 * check assert behavior outside the contract and would be flaky for adapters
 * whose ids are derived from absolute artifact paths. Sorting normalized
 * events by recursively key-sorted JSON keeps event count and content fully
 * pinned while normalizing away only that unsupported ordering distinction.
 */
function canonicalGoldenOrder(events: readonly unknown[]): unknown[] {
  return events
    .map((event: unknown): { event: unknown; key: string } => ({
      event,
      key: deterministicJson(event),
    }))
    .sort(
      (
        left: { event: unknown; key: string },
        right: { event: unknown; key: string },
      ): number => {
        if (left.key === right.key) {
          return 0;
        }
        return left.key < right.key ? -1 : 1;
      },
    )
    .map(({ event }: { event: unknown; key: string }): unknown => event);
}

function sameStringSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function observeCheck(
  id: string,
  run: (deps: ObserveCheckDependencies) => Promise<string>,
): ConformanceCheck {
  return {
    id,
    capability: "observe",
    async run(deps: ConformanceCheckDependencies): Promise<string> {
      if (deps.capability !== "observe") {
        throw new Error(`${id} requires observe dependencies`);
      }
      return run(deps);
    },
  };
}

const discoverCheck: ConformanceCheck = observeCheck(
  "observe.discover",
  async ({ fixtures }): Promise<string> => {
    const sessions: DiscoveredSession[] = await discover(
      fixtures.adapter,
      "observe fixture",
    );
    if (sessions.length === 0) {
      throw new Error("discoverSessions() returned no sessions");
    }
    const problems: string[] = [];
    sessions.forEach((session: DiscoveredSession, index: number): void => {
      if (!session.sessionId.startsWith(fixtures.expectedSessionIdPrefix)) {
        problems.push(
          `session[${index}].sessionId ${JSON.stringify(session.sessionId)} `
          + `does not start with ${JSON.stringify(fixtures.expectedSessionIdPrefix)}`,
        );
      }
      if (!isAbsolute(session.path)) {
        problems.push(
          `session[${index}].path is not absolute: ${JSON.stringify(session.path)}`,
        );
      }
      if (session.sizeBytes <= 0) {
        problems.push(
          `session[${index}].sizeBytes must be > 0, got ${session.sizeBytes}`,
        );
      }
    });
    if (problems.length > 0) {
      throw new Error(`invalid discovery metadata: ${problems.join("; ")}`);
    }
    return `${sessions.length} session(s) discovered`;
  },
);

const schemaCheck: ConformanceCheck = observeCheck(
  "observe.schema",
  async ({ fixtures }): Promise<string> => {
    const parsed: ParsedSessions = await parseAll(
      fixtures.adapter,
      "observe fixture",
    );
    const problems: string[] = [];
    if (parsed.parseFailures !== 0) {
      problems.push(`parseFailures expected 0, got ${parsed.parseFailures}`);
    }
    parsed.events.forEach((event: EventInput, index: number): void => {
      const eventProblems: string[] = validateEnvelope(event);
      eventProblems.forEach((problem: string): void => {
        problems.push(`event[${index}]: ${problem}`);
      });
    });
    if (problems.length > 0) {
      throw new Error(
        `schema validation found ${problems.length} problem(s): `
        + problems.join("; "),
      );
    }
    return `${parsed.events.length} event(s) valid; parseFailures=0`;
  },
);

const goldenCheck: ConformanceCheck = observeCheck(
  "observe.golden",
  async ({ context, fixtures }): Promise<string> => {
    const parsed: ParsedSessions = await parseAll(
      fixtures.adapter,
      "observe fixture",
    );
    const actual: unknown[] = parsed.events.map(
      (event: EventInput): unknown => fixtures.normalizeEvent(event, context),
    );
    const expected: readonly unknown[] = fixtures.goldenEvents;
    const canonicalActual: unknown[] = canonicalGoldenOrder(actual);
    const canonicalExpected: unknown[] = canonicalGoldenOrder(expected);
    if (!isDeepStrictEqual(canonicalActual, canonicalExpected)) {
      const sharedLength: number = Math.min(
        canonicalActual.length,
        canonicalExpected.length,
      );
      let firstDifference: number = sharedLength;
      for (let index = 0; index < sharedLength; index += 1) {
        if (
          !isDeepStrictEqual(canonicalActual[index], canonicalExpected[index])
        ) {
          firstDifference = index;
          break;
        }
      }
      throw new Error(
        `golden mismatch at index ${firstDifference}; `
        + `expected=${compact(canonicalExpected[firstDifference])}; `
        + `actual=${compact(canonicalActual[firstDifference])}; `
        + `lengths=${canonicalExpected.length}/${canonicalActual.length}`,
      );
    }
    return `${actual.length} normalized event(s) matched`;
  },
);

const determinismCheck: ConformanceCheck = observeCheck(
  "observe.determinism",
  async ({ fixtures }): Promise<string> => {
    const first: ParsedSessions = await parseAll(
      fixtures.adapter,
      "determinism pass 1",
    );
    const second: ParsedSessions = await parseAll(
      fixtures.adapter,
      "determinism pass 2",
    );
    const firstIds: string[] = eventIds(first.events, "pass 1 events");
    const secondIds: string[] = eventIds(second.events, "pass 2 events");
    if (!isDeepStrictEqual(firstIds, secondIds)) {
      const sharedLength: number = Math.min(firstIds.length, secondIds.length);
      let firstDifference: number = sharedLength;
      for (let index = 0; index < sharedLength; index += 1) {
        if (firstIds[index] !== secondIds[index]) {
          firstDifference = index;
          break;
        }
      }
      throw new Error(
        `event id sequences differ at index ${firstDifference}: `
        + `${JSON.stringify(firstIds[firstDifference])} vs `
        + `${JSON.stringify(secondIds[firstDifference])}; `
        + `lengths=${firstIds.length}/${secondIds.length}`,
      );
    }
    return `${firstIds.length} event id(s) deterministic`;
  },
);

const resumeCheck: ConformanceCheck = observeCheck(
  "observe.resume",
  async ({ fixtures }): Promise<string> => {
    const resume = fixtures.resume;
    const prefixSession: DiscoveredSession = await singleSession(
      resume.adapter,
      "resume fixture",
    );
    const first: ParseResult = await parse(
      resume.adapter,
      prefixSession,
      "",
      "resume pass 1",
    );
    try {
      await resume.completeArtifact();
    } catch (error: unknown) {
      throw new Error(
        `resume fixture completion failed: ${errorMessage(error)}`,
      );
    }
    const second: ParseResult = await parse(
      resume.adapter,
      prefixSession,
      first.resumeToken,
      "resume pass 2",
    );
    if (second.events.length === 0) {
      throw new Error("resume pass 2 emitted no events; fixture proves nothing");
    }

    const full: ParsedSessions = await parseAll(
      resume.fullAdapter,
      "resume full pass",
    );
    const firstIds: string[] = eventIds(first.events, "resume pass 1 events");
    const secondIds: string[] = eventIds(second.events, "resume pass 2 events");
    const fullIds: string[] = eventIds(full.events, "resume full-pass events");
    const combinedIds = new Set<string>([...firstIds, ...secondIds]);
    const expectedIds = new Set<string>(fullIds);
    if (!sameStringSet(combinedIds, expectedIds)) {
      throw new Error(
        `resume union differs from full pass: `
        + `combined=${compact([...combinedIds].sort())}; `
        + `full=${compact([...expectedIds].sort())}`,
      );
    }

    // This is the adapter-level contract: store-side dedupe is explicitly not
    // the safety net under test, so pass 2 must not replay pass-1 ids.
    const firstIdSet = new Set<string>(firstIds);
    const replayed: string[] = secondIds.filter(
      (id: string): boolean => firstIdSet.has(id),
    );
    if (replayed.length > 0) {
      throw new Error(
        `resume pass 2 re-emitted ${replayed.length} pass-1 event id(s): `
        + compact(replayed),
      );
    }
    return `${firstIds.length}+${secondIds.length} event(s) matched full pass`;
  },
);

const unknownRecordCheck: ConformanceCheck = observeCheck(
  "observe.unknown-record",
  async ({ fixtures }): Promise<string> => {
    const parsed: ParsedSessions = await parseAll(
      fixtures.unknownRecord.adapter,
      fixtures.unknownRecord.label,
    );
    if (parsed.skippedUnknown < 1) {
      throw new Error(
        `unknown record was not counted: skippedUnknown=${parsed.skippedUnknown}`,
      );
    }
    if (parsed.parseFailures !== 0) {
      throw new Error(
        `unknown record caused parseFailures=${parsed.parseFailures}; expected 0`,
      );
    }
    return `skippedUnknown=${parsed.skippedUnknown}; parseFailures=0`;
  },
);

const truncationCheck: ConformanceCheck = observeCheck(
  "observe.truncation",
  async ({ descriptor, fixtures }): Promise<string> => {
    if (!descriptor.storageTraits.appendOnlyLines) {
      throw new NotApplicableError(
        "storage trait appendOnlyLines=false; truncation check does not apply",
      );
    }
    const truncation = fixtures.truncation;
    if (truncation === undefined) {
      throw new Error(
        "descriptor claims appendOnlyLines=true but provides no truncation fixture",
      );
    }
    const session: DiscoveredSession = await singleSession(
      truncation.adapter,
      "truncation fixture",
    );
    const first: ParseResult = await parse(
      truncation.adapter,
      session,
      "",
      "truncation pass 1",
    );
    if (first.parseFailures !== 0) {
      throw new Error(
        `truncated trailing line caused parseFailures=${first.parseFailures}; `
        + "expected 0",
      );
    }
    try {
      await truncation.completeLine();
    } catch (error: unknown) {
      throw new Error(
        `truncation fixture completion failed: ${errorMessage(error)}`,
      );
    }
    const second: ParseResult = await parse(
      truncation.adapter,
      session,
      first.resumeToken,
      "truncation pass 2",
    );
    if (second.events.length !== 1) {
      throw new Error(
        `completed trailing line must emit exactly one event, got `
        + `${second.events.length}`,
      );
    }
    const completedId: string = eventId(
      second.events[0]!,
      "completed trailing event",
    );
    const combinedIds: string[] = eventIds(
      [...first.events, ...second.events],
      "truncation events",
    );
    const occurrences: number = combinedIds.filter(
      (id: string): boolean => id === completedId,
    ).length;
    if (occurrences !== 1) {
      throw new Error(
        `completed event ${JSON.stringify(completedId)} appeared `
        + `${occurrences} times across both passes`,
      );
    }
    return `completed event ${completedId} emitted exactly once`;
  },
);

const breakageSignalCheck: ConformanceCheck = observeCheck(
  "observe.breakage-signal",
  async ({ fixtures }): Promise<string> => {
    const parsed: ParsedSessions = await parseAll(
      fixtures.corrupted.adapter,
      fixtures.corrupted.label,
    );
    if (parsed.parseFailures < 1) {
      throw new Error(
        `corrupted known record was silent: parseFailures=${parsed.parseFailures}`,
      );
    }
    return `parseFailures=${parsed.parseFailures}`;
  },
);

const envelopeCheck: ConformanceCheck = observeCheck(
  "observe.envelope",
  async ({ descriptor, fixtures }): Promise<string> => {
    const parsed: ParsedSessions = await parseAll(
      fixtures.adapter,
      "observe fixture",
    );
    const problems: string[] = [];
    parsed.events.forEach((event: EventInput, index: number): void => {
      if (!isPlainObject(event)) {
        problems.push(`event[${index}] is not a plain object`);
        return;
      }
      if (event.vendor !== descriptor.vendor) {
        problems.push(
          `event[${index}].vendor expected ${JSON.stringify(descriptor.vendor)}, `
          + `got ${compact(event.vendor)}`,
        );
      }
      if (
        typeof event.adapter_version !== "string"
        || event.adapter_version.length === 0
      ) {
        problems.push(`event[${index}].adapter_version must be non-empty`);
      } else if (event.adapter_version !== descriptor.adapterVersion) {
        problems.push(
          `event[${index}].adapter_version expected `
          + `${JSON.stringify(descriptor.adapterVersion)}, got `
          + `${JSON.stringify(event.adapter_version)}`,
        );
      }
    });
    if (problems.length > 0) {
      throw new Error(`envelope mismatch: ${problems.join("; ")}`);
    }
    return `${parsed.events.length} event envelope(s) matched descriptor`;
  },
);

const CORRECTION_BASIS_VALUES: ReadonlySet<string> = new Set([
  "explicit_phrase",
  "after_completion_claim",
  "interrupt",
]);

interface CorrectionTally {
  userTurns: number;
  flagged: number;
  problems: string[];
}

/**
 * Real user turn = the pilot's own prose. Sidechain "user" turns are
 * agent-authored subagent traffic; detection must not apply there, so their
 * honest is_correction stays null.
 */
function tallyCorrections(parsed: ParsedSessions, label: string): CorrectionTally {
  const tally: CorrectionTally = { userTurns: 0, flagged: 0, problems: [] };
  parsed.events.forEach((event: EventInput, index: number): void => {
    if (!isPlainObject(event) || event.type !== "turn_start") {
      return;
    }
    const payload: Record<string, unknown> = isPlainObject(event.payload)
      ? event.payload
      : {};
    if (payload.role !== "user") {
      return;
    }
    if (payload.is_sidechain === true) {
      if (payload.is_correction !== null && payload.is_correction !== undefined) {
        tally.problems.push(
          `${label} event[${index}] is a sidechain turn but carries `
          + `is_correction ${compact(payload.is_correction)} (must stay null)`,
        );
      }
      return;
    }
    tally.userTurns += 1;
    if (typeof payload.is_correction !== "boolean") {
      tally.problems.push(
        `${label} event[${index}].payload.is_correction must be a boolean on `
        + `real user turns, got ${compact(payload.is_correction)}`,
      );
      return;
    }
    const basis: unknown = payload.correction_basis;
    if (payload.is_correction === true) {
      tally.flagged += 1;
      if (
        !Array.isArray(basis)
        || basis.length === 0
        || basis.some((value: unknown): boolean =>
          typeof value !== "string" || !CORRECTION_BASIS_VALUES.has(value),
        )
      ) {
        tally.problems.push(
          `${label} event[${index}].payload.correction_basis must be a non-empty `
          + `array drawn from the closed basis enum, got ${compact(basis)}`,
        );
      }
    } else if (basis !== undefined) {
      tally.problems.push(
        `${label} event[${index}] carries correction_basis on an unflagged turn`,
      );
    }
  });
  return tally;
}

const correctionCheck: ConformanceCheck = observeCheck(
  "observe.correction",
  async ({ fixtures }): Promise<string> => {
    const correction = fixtures.correction;
    if (correction === undefined) {
      throw new NotApplicableError(
        "adapter does not claim adapter-time correction detection",
      );
    }
    const positive: ParsedSessions = await parseAll(
      correction.positive.adapter,
      correction.positive.label,
    );
    const negative: ParsedSessions = await parseAll(
      correction.negative.adapter,
      correction.negative.label,
    );
    const positiveTally: CorrectionTally = tallyCorrections(
      positive,
      correction.positive.label,
    );
    const negativeTally: CorrectionTally = tallyCorrections(
      negative,
      correction.negative.label,
    );
    const problems: string[] = [
      ...positiveTally.problems,
      ...negativeTally.problems,
    ];
    if (positiveTally.flagged === 0) {
      problems.push(
        `${correction.positive.label} must flag at least one correction turn`,
      );
    }
    if (negativeTally.flagged > 0) {
      problems.push(
        `${correction.negative.label} is a negative control but flagged `
        + `${negativeTally.flagged} turn(s)`,
      );
    }
    if (problems.length > 0) {
      throw new Error(`correction detection mismatch: ${problems.join("; ")}`);
    }
    return `${positiveTally.flagged} correction(s) flagged across `
      + `${positiveTally.userTurns} user turn(s); negative control clean `
      + `(${negativeTally.userTurns} user turn(s), 0 flagged)`;
  },
);

export const OBSERVE_CHECKS: readonly ConformanceCheck[] = [
  discoverCheck,
  schemaCheck,
  goldenCheck,
  determinismCheck,
  resumeCheck,
  unknownRecordCheck,
  truncationCheck,
  breakageSignalCheck,
  envelopeCheck,
  correctionCheck,
];
