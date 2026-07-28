import { describe, expect, test } from "bun:test";

import { GATE_CHECKS } from "../../conformance/checks/gate.ts";
import { INJECT_CHECKS } from "../../conformance/checks/inject.ts";
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
  test("pins real path-independent ids for the richer tool fixture", (): void => {
    expect(goldenEvents).toHaveLength(10);
    expect(
      goldenEvents.every(
        (event): boolean =>
          event.id !== "<ID>"
          && event.raw_ref.startsWith("claude-code:")
          && !event.raw_ref.startsWith("/"),
      ),
    ).toBe(true);
    expect(
      goldenEvents.some((event): boolean => event.type === "tool_call"),
    ).toBe(true);
    expect(
      goldenEvents.some(
        (event): boolean =>
          event.type === "error"
          && typeof event.payload.tool_call_id === "string",
      ),
    ).toBe(true);
  });

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

  test("passes the full tier 1 conformance suite", async (): Promise<void> => {
    const expectedChecks = [
      ...OBSERVE_CHECKS,
      ...INJECT_CHECKS,
      ...GATE_CHECKS,
    ];
    const report: ConformanceReport = await runConformance(
      claudeCodeConformanceDescriptor,
      { checks: expectedChecks },
    );

    expect(report.checks.map((check): string => check.id)).toEqual(
      expectedChecks.map((check): string => check.id),
    );
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
      `expected all tier 1 checks to pass${
        nonPassDetail.length > 0 ? `:\n${nonPassDetail}` : ""
      }`,
    ).toEqual([]);
    expect(report.verifiedCapabilities).toEqual([
      "observe",
      "inject",
      "gate",
    ]);
    expect(report.tier).toBe(1);
    expect(report.passed).toBe(true);
  });
});
