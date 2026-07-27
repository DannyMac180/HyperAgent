import {
  describe,
  expect,
  test,
} from "bun:test";

import type { GateHookKind } from "../../gate/eval.ts";
import {
  runConformance,
} from "../runner.ts";
import type {
  CheckResult,
  ConformanceReport,
} from "../types.ts";
import {
  createStubGateDescriptor,
  createStubGateDescriptorWithHookKinds,
} from "../testing/stub-gate.ts";
import type {
  GateMutation,
} from "../testing/stub-gate.ts";
import {
  GATE_CHECKS,
} from "./gate.ts";

type GateMutant = Exclude<GateMutation, "none">;
type GateCheckId =
  | "gate.install"
  | "gate.install-idempotent"
  | "gate.uninstall"
  | "gate.refuse-non-git"
  | "gate.fail-open"
  | `gate.hook-round-trip:${GateHookKind}`;

/**
 * The Record makes a new mutation a compile failure, while this independent
 * runtime inventory guards against accidentally weakening the test loop.
 */
const NON_CLEAN_MUTATIONS = [
  "install",
  "install-idempotent",
  "uninstall",
  "refuse-non-git",
  "hook-round-trip",
  "fail-open",
] as const satisfies readonly GateMutant[];

const MUTANT_MATRIX = {
  "install": ["gate.install"],
  "install-idempotent": ["gate.install-idempotent"],
  "uninstall": ["gate.uninstall"],
  "refuse-non-git": ["gate.refuse-non-git"],
  "hook-round-trip": ["gate.hook-round-trip:post_tool_use"],
  "fail-open": ["gate.fail-open"],
} as const satisfies Record<
  GateMutant,
  readonly GateCheckId[]
>;

describe("gate check negative controls", (): void => {
  test("clean stub verifies the gate capability", async (): Promise<void> => {
    const report: ConformanceReport = await runConformance(
      createStubGateDescriptor("none"),
      { checks: GATE_CHECKS },
    );

    expect(report.checks).toHaveLength(8);
    expect(report.checks.map(
      ({ status }: CheckResult): string => status,
    )).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(report.passed).toBe(true);
    expect(report.verifiedCapabilities).toContain("gate");
  });

  for (const mutation of NON_CLEAN_MUTATIONS) {
    test(
      `${mutation} mutant fails only ${MUTANT_MATRIX[mutation].join(", ")}`,
      async (): Promise<void> => {
        const report: ConformanceReport = await runConformance(
          createStubGateDescriptor(mutation),
          { checks: GATE_CHECKS },
        );
        const expectedFailingIds: readonly GateCheckId[] =
          MUTANT_MATRIX[mutation];

        for (const expectedId of expectedFailingIds) {
          const expectedCheck: CheckResult | undefined = report.checks.find(
            ({ id }: CheckResult): boolean => id === expectedId,
          );
          expect(expectedCheck?.status).toBe("fail");
        }

        const failingIds: string[] = report.checks
          .filter(
            ({ status }: CheckResult): boolean => status === "fail",
          )
          .map(({ id }: CheckResult): string => id);
        expect(failingIds).toEqual([...expectedFailingIds]);
        expect(report.passed).toBe(false);
        expect(report.verifiedCapabilities).not.toContain("gate");
      },
    );
  }

  test(
    "unclaimed hook kinds are not applicable without disqualifying gate",
    async (): Promise<void> => {
      const report: ConformanceReport = await runConformance(
        createStubGateDescriptorWithHookKinds(["pre_tool_use"]),
        { checks: GATE_CHECKS },
      );
      const hookStatuses = Object.fromEntries(
        report.checks
          .filter(({ id }: CheckResult): boolean =>
            id.startsWith("gate.hook-round-trip:"))
          .map(({ id, status }: CheckResult): [string, string] => [id, status]),
      );

      expect(hookStatuses).toEqual({
        "gate.hook-round-trip:pre_tool_use": "pass",
        "gate.hook-round-trip:post_tool_use": "not-applicable",
        "gate.hook-round-trip:stop": "not-applicable",
      });
      expect(report.passed).toBe(true);
      expect(report.verifiedCapabilities).toContain("gate");
    },
  );

  test("matrix covers every non-clean gate mutation", (): void => {
    expect(Object.keys(MUTANT_MATRIX).sort()).toEqual(
      [...NON_CLEAN_MUTATIONS].sort(),
    );
    expect(NON_CLEAN_MUTATIONS).toHaveLength(6);
  });
});
