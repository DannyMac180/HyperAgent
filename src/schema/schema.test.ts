import { describe, expect, test } from "bun:test";

import {
  EVENT_TYPES,
  SCHEMA_VERSION,
  assertValidEnvelope,
  isEventType,
  validateEnvelope,
} from "./events.ts";
import { isUlid, ulid } from "./ulid.ts";

function validEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ulid(),
    ts: "2026-01-01T00:00:00.000Z",
    type: "tool_call",
    session_id: "session-1",
    vendor: "claude-code",
    adapter_version: "1.0.0",
    ...overrides,
  };
}

describe("ulid", (): void => {
  test("generates 26-character Crockford base32 ids", (): void => {
    const value = ulid();
    expect(value).toHaveLength(26);
    expect(isUlid(value)).toBe(true);
    expect(value).not.toMatch(/[ILOU]/);
  });

  test("is strictly increasing within a single millisecond", (): void => {
    const fixed = Date.parse("2026-01-01T00:00:00.000Z");
    const generated = Array.from({ length: 50 }, (): string => ulid(fixed));

    for (let index = 1; index < generated.length; index += 1) {
      const previous = generated[index - 1];
      const current = generated[index];
      if (previous === undefined || current === undefined) {
        throw new Error("expected a fully populated ulid sample");
      }
      expect(current > previous).toBe(true);
      expect(current.slice(0, 10)).toBe(previous.slice(0, 10));
    }
    expect(new Set(generated).size).toBe(generated.length);
  });

  test("sorts lexically in timestamp order", (): void => {
    const earlier = ulid(Date.parse("2026-01-01T00:00:00.000Z"));
    const later = ulid(Date.parse("2027-01-01T00:00:00.000Z"));
    expect(later > earlier).toBe(true);
  });

  test("never regresses when handed an earlier timestamp", (): void => {
    const later = ulid(Date.parse("2030-01-01T00:00:00.000Z"));
    const rewound = ulid(Date.parse("2020-01-01T00:00:00.000Z"));
    expect(rewound > later).toBe(true);
  });

  test("rejects timestamps beyond the 48-bit ceiling and invalid inputs", (): void => {
    expect((): string => ulid(0x1000000000000)).toThrow("48-bit maximum");
    expect((): string => ulid(-1)).toThrow("non-negative safe integer");
    expect((): string => ulid(1.5)).toThrow("non-negative safe integer");
  });

  test("isUlid rejects malformed ids", (): void => {
    expect(isUlid("")).toBe(false);
    expect(isUlid("not-a-ulid")).toBe(false);
    expect(isUlid("0".repeat(25))).toBe(false);
    expect(isUlid("0".repeat(27))).toBe(false);
    // I, L, O and U are excluded from the Crockford alphabet.
    expect(isUlid(`0${"I".repeat(25)}`)).toBe(false);
    // The first character must be 0-7 so the 48-bit timestamp cannot overflow.
    expect(isUlid(`8${"0".repeat(25)}`)).toBe(false);
  });
});

describe("schema constants", (): void => {
  test("declares the nine canonical event types in spec order", (): void => {
    expect(EVENT_TYPES).toEqual([
      "session_start",
      "session_end",
      "turn_start",
      "turn_end",
      "tool_call",
      "error",
      "retry",
      "completion_claim",
      "verification_event",
    ]);
    expect(SCHEMA_VERSION).toBe("0.2.0");
  });

  test("isEventType is closed over the canonical enum", (): void => {
    for (const type of EVENT_TYPES) {
      expect(isEventType(type)).toBe(true);
    }
    expect(isEventType("invented_type")).toBe(false);
    expect(isEventType(undefined)).toBe(false);
  });
});

describe("validateEnvelope", (): void => {
  test("accepts a well-formed envelope", (): void => {
    expect(validateEnvelope(validEnvelope())).toEqual([]);
  });

  test("accepts any vendor, including unknown ones", (): void => {
    for (const vendor of ["claude-code", "codex", "unknown:foo", "some-future-harness"]) {
      expect(validateEnvelope(validEnvelope({ vendor }))).toEqual([]);
    }
  });

  test("rejects non-object values", (): void => {
    for (const value of [null, undefined, 42, "event", [], true]) {
      expect(validateEnvelope(value)).toEqual([
        "event: expected a non-null, non-array plain object",
      ]);
    }
  });

  test("reports every missing required field at once", (): void => {
    const problems = validateEnvelope({});
    for (const field of ["id", "ts", "type", "session_id", "vendor", "adapter_version"]) {
      expect(problems).toContain(`${field}: field is required`);
    }
  });

  test("rejects ids that are not ULIDs", (): void => {
    const problems = validateEnvelope(validEnvelope({ id: "e1" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("id: expected a valid 26-character ULID");
  });

  test("requires ISO-8601 UTC timestamps with milliseconds", (): void => {
    for (const ts of ["2026-01-01", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000+01:00"]) {
      const problems = validateEnvelope(validEnvelope({ ts }));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("ts: expected ISO-8601 UTC with milliseconds");
    }
  });

  test("rejects calendar-impossible timestamps that Date would normalize", (): void => {
    const problems = validateEnvelope(validEnvelope({ ts: "2026-02-30T00:00:00.000Z" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ts: expected ISO-8601 UTC with milliseconds");
  });

  test("validates observed_at only when present", (): void => {
    expect(validateEnvelope(validEnvelope())).toEqual([]);
    const problems = validateEnvelope(validEnvelope({ observed_at: "yesterday" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("observed_at: expected ISO-8601 UTC with milliseconds");
  });

  test("rejects event types outside the closed enum and names the offender", (): void => {
    const problems = validateEnvelope(validEnvelope({ type: "invented_type" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('got "invented_type"');
    expect(problems[0]).toContain("session_start");
  });

  test("accepts raw_ref as a string, null, or absent, but nothing else", (): void => {
    expect(validateEnvelope(validEnvelope({ raw_ref: "transcript.jsonl#L12" }))).toEqual([]);
    expect(validateEnvelope(validEnvelope({ raw_ref: null }))).toEqual([]);
    const problems = validateEnvelope(validEnvelope({ raw_ref: 12 }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("raw_ref: expected a string, null, or absence");
  });

  test("requires payload to be a plain object when present", (): void => {
    expect(validateEnvelope(validEnvelope({ payload: {} }))).toEqual([]);
    for (const payload of [[], "text", 3, null]) {
      const problems = validateEnvelope(validEnvelope({ payload }));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("payload: expected a plain non-null, non-array object");
    }
  });

  test("requires a semver-shaped schema_version when present", (): void => {
    expect(validateEnvelope(validEnvelope({ schema_version: "0.1.0" }))).toEqual([]);
    const problems = validateEnvelope(validEnvelope({ schema_version: "v1" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("schema_version: expected a version beginning with");
  });

  test("rejects empty-string values for required fields", (): void => {
    const problems = validateEnvelope(validEnvelope({ session_id: "", vendor: "" }));
    expect(problems).toHaveLength(2);
    expect(problems.join("; ")).toContain("session_id: expected a non-empty string");
    expect(problems.join("; ")).toContain("vendor: expected a non-empty string");
  });
});

describe("assertValidEnvelope", (): void => {
  test("is silent for a valid envelope", (): void => {
    expect((): void => assertValidEnvelope(validEnvelope())).not.toThrow();
  });

  test("throws with every problem joined into one message", (): void => {
    expect((): void => assertValidEnvelope({ id: "e1" })).toThrow("invalid event envelope");
    expect((): void => assertValidEnvelope({ id: "e1" })).toThrow("ts: field is required");
  });
});
