import {
  describe,
  expect,
  test,
} from "bun:test";

import {
  runConformance,
} from "../runner.ts";
import type {
  CheckResult,
  ConformanceReport,
} from "../types.ts";
import {
  createStubObserveDescriptor,
} from "../testing/stub-observe.ts";
import type {
  ObserveMutation,
} from "../testing/stub-observe.ts";
import {
  OBSERVE_CHECKS,
} from "./observe.ts";

type ObserveMutant = Exclude<ObserveMutation, "none">;
type ObserveCheckId = `observe.${ObserveMutant}`;

/**
 * The stub exports its mutation union but not its runtime mutation list. The
 * Record makes a new union member a compile failure, while this local list
 * gives the runtime guard a concrete, independently maintained inventory.
 */
const NON_CLEAN_MUTATIONS = [
  "discover",
  "schema",
  "golden",
  "determinism",
  "resume",
  "unknown-record",
  "truncation",
  "breakage-signal",
  "envelope",
] as const satisfies readonly ObserveMutant[];

const MUTANT_MATRIX = {
  "discover": ["observe.discover"],
  "schema": ["observe.schema"],
  "golden": ["observe.golden"],
  "determinism": ["observe.determinism"],
  "resume": ["observe.resume"],
  "unknown-record": ["observe.unknown-record"],
  "truncation": ["observe.truncation"],
  "breakage-signal": ["observe.breakage-signal"],
  "envelope": ["observe.envelope"],
} as const satisfies Record<
  ObserveMutant,
  readonly ObserveCheckId[]
>;

interface MutantOutcome {
  mutation: ObserveMutant;
  passed: boolean;
  observeVerified: boolean;
}

describe("observe check negative controls", (): void => {
  for (const mutation of NON_CLEAN_MUTATIONS) {
    test(
      `${mutation} mutant fails only ${MUTANT_MATRIX[mutation].join(", ")}`,
      async (): Promise<void> => {
        const report: ConformanceReport = await runConformance(
          createStubObserveDescriptor(mutation),
          { checks: OBSERVE_CHECKS },
        );
        const expectedFailingIds: readonly ObserveCheckId[] =
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
      },
    );
  }

  test(
    "every mutant invalidates the report and observe capability",
    async (): Promise<void> => {
      const outcomes: MutantOutcome[] = [];

      for (const mutation of NON_CLEAN_MUTATIONS) {
        const report: ConformanceReport = await runConformance(
          createStubObserveDescriptor(mutation),
          { checks: OBSERVE_CHECKS },
        );
        outcomes.push({
          mutation,
          passed: report.passed,
          observeVerified: report.verifiedCapabilities.includes("observe"),
        });
      }

      expect(outcomes).toEqual(
        NON_CLEAN_MUTATIONS.map(
          (mutation: ObserveMutant): MutantOutcome => ({
            mutation,
            passed: false,
            observeVerified: false,
          }),
        ),
      );
    },
  );

  test("matrix covers every non-clean observe mutation", (): void => {
    expect(Object.keys(MUTANT_MATRIX).sort()).toEqual(
      [...NON_CLEAN_MUTATIONS].sort(),
    );
    expect(NON_CLEAN_MUTATIONS).toHaveLength(9);
  });
});
