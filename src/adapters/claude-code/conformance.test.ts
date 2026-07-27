import { describe, expect, test } from "bun:test";

import { OBSERVE_CHECKS } from "../../conformance/checks/observe.ts";
import { runConformance } from "../../conformance/runner.ts";
import type {
  CheckResult,
  ConformanceReport,
} from "../../conformance/types.ts";
import goldenEvents from "./conformance-golden.json" with { type: "json" };
import {
  CLAUDE_CODE_DIALECT_VERSION,
  claudeCodeConformanceDescriptor,
} from "./conformance.ts";

describe("Claude Code observe conformance", (): void => {
  test("passes every vendor-blind observe check", async (): Promise<void> => {
    expect(goldenEvents.length).toBeGreaterThan(0);

    const report: ConformanceReport = await runConformance(
      claudeCodeConformanceDescriptor,
      { checks: OBSERVE_CHECKS },
    );

    expect(report.checks.map((check): string => check.id)).toEqual(
      OBSERVE_CHECKS.map((check): string => check.id),
    );
    expect(report.checks).toHaveLength(9);
    const nonPassChecks: CheckResult[] = report.checks.filter(
      (check: CheckResult): boolean => check.status !== "pass",
    );
    const nonPassDetail: string = nonPassChecks
      .map(
        (check: CheckResult): string =>
          `${check.id}: ${check.status} — ${check.detail}`,
      )
      .join("\n");
    expect(
      nonPassChecks,
      `expected all observe checks to pass${
        nonPassDetail.length > 0 ? `:\n${nonPassDetail}` : ""
      }`,
    ).toEqual([]);
    expect(report.checks.find(
      (check): boolean => check.id === "observe.truncation",
    )?.status).toBe("pass");
    expect(report.verifiedCapabilities).toContain("observe");
    expect(report.adapterVersion).toBe(
      claudeCodeConformanceDescriptor.adapterVersion,
    );
    expect(report.dialectVersion).toBe(CLAUDE_CODE_DIALECT_VERSION);
  });
});
