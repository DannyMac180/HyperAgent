import { describe, expect, test } from "bun:test";

import {
  deriveTier,
  deriveVerifiedCapabilities,
} from "./tier.ts";
import type {
  CheckResult,
  ConformanceCapability,
  ConformanceDescriptor,
  ConformanceTier,
} from "./types.ts";

const SUBSET_LATTICE: ReadonlyArray<{
  verified: readonly ConformanceCapability[];
  tier: ConformanceTier;
}> = [
  { verified: [], tier: "below-tier" },
  { verified: ["observe"], tier: "below-tier" },
  { verified: ["inject"], tier: 3 },
  { verified: ["gate"], tier: "below-tier" },
  { verified: ["observe", "inject"], tier: 2 },
  { verified: ["observe", "gate"], tier: "below-tier" },
  { verified: ["inject", "gate"], tier: 3 },
  { verified: ["observe", "inject", "gate"], tier: 1 },
];

describe("deriveTier", (): void => {
  for (const entry of SUBSET_LATTICE) {
    test(
      `maps ${entry.verified.join("+") || "empty"} to ${String(entry.tier)}`,
      (): void => {
        expect(deriveTier(entry.verified)).toBe(entry.tier);
      },
    );
  }
});

describe("deriveVerifiedCapabilities", (): void => {
  const claimed: ConformanceDescriptor["claimed"] = {
    observe: true,
    inject: true,
    gate: false,
  };

  test("requires a pass and accepts not-applicable companion checks", (): void => {
    const checks: CheckResult[] = [
      {
        id: "observe.pass",
        capability: "observe",
        status: "pass",
        detail: "ok",
      },
      {
        id: "observe.truncation",
        capability: "observe",
        status: "not-applicable",
        detail: "not line-based",
      },
    ];

    expect(deriveVerifiedCapabilities(checks, claimed)).toEqual(["observe"]);
  });

  test("disqualifies fail and skipped statuses", (): void => {
    const checks: CheckResult[] = [
      {
        id: "observe.pass",
        capability: "observe",
        status: "pass",
        detail: "ok",
      },
      {
        id: "observe.fail",
        capability: "observe",
        status: "fail",
        detail: "bad",
      },
      {
        id: "inject.pass",
        capability: "inject",
        status: "pass",
        detail: "ok",
      },
      {
        id: "inject.skip",
        capability: "inject",
        status: "skipped",
        detail: "bad",
      },
    ];

    expect(deriveVerifiedCapabilities(checks, claimed)).toEqual([]);
  });

  test("does not verify unclaimed capabilities or a capability with no pass", (): void => {
    const checks: CheckResult[] = [
      {
        id: "gate.pass",
        capability: "gate",
        status: "pass",
        detail: "ok",
      },
      {
        id: "observe.na",
        capability: "observe",
        status: "not-applicable",
        detail: "not relevant",
      },
    ];

    expect(deriveVerifiedCapabilities(checks, claimed)).toEqual([]);
  });
});
