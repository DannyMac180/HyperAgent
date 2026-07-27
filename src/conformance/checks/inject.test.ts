import {
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  runConformance,
} from "../runner.ts";
import type {
  CheckResult,
  ConformanceContext,
  ConformanceDescriptor,
  ConformanceReport,
  InjectFixtureSet,
} from "../types.ts";
import {
  createStubInjectDescriptor,
} from "../testing/stub-inject.ts";
import type {
  InjectMutation,
} from "../testing/stub-inject.ts";
import {
  INJECT_CHECKS,
} from "./inject.ts";

type InjectMutant = Exclude<InjectMutation, "none">;
type InjectCheckId = `inject.${InjectMutant}`;

const NON_CLEAN_MUTATIONS = [
  "round-trip",
  "idempotency",
  "removal",
  "refusal",
] as const satisfies readonly InjectMutant[];

const MUTANT_MATRIX = {
  "round-trip": ["inject.round-trip"],
  "idempotency": ["inject.idempotency"],
  "removal": ["inject.removal"],
  "refusal": ["inject.refusal"],
} as const satisfies Record<
  InjectMutant,
  readonly InjectCheckId[]
>;

function isAtOrUnder(candidate: string, root: string): boolean {
  const pathFromRoot: string = relative(resolve(root), resolve(candidate));
  return (
    pathFromRoot === ""
    || (
      pathFromRoot !== ".."
      && !pathFromRoot.startsWith(`..${sep}`)
      && !isAbsolute(pathFromRoot)
    )
  );
}

describe("inject check negative controls", (): void => {
  test("clean stub verifies the inject capability", async (): Promise<void> => {
    const report: ConformanceReport = await runConformance(
      createStubInjectDescriptor("none"),
      { checks: INJECT_CHECKS },
    );

    expect(report.checks.map(
      ({ status }: CheckResult): string => status,
    )).toEqual(["pass", "pass", "pass", "pass"]);
    expect(report.passed).toBe(true);
    expect(report.verifiedCapabilities).toContain("inject");
  });

  for (const mutation of NON_CLEAN_MUTATIONS) {
    test(
      `${mutation} mutant fails only ${MUTANT_MATRIX[mutation].join(", ")}`,
      async (): Promise<void> => {
        const report: ConformanceReport = await runConformance(
          createStubInjectDescriptor(mutation),
          { checks: INJECT_CHECKS },
        );
        const failingIds: string[] = report.checks
          .filter(
            ({ status }: CheckResult): boolean => status === "fail",
          )
          .map(({ id }: CheckResult): string => id);

        expect(failingIds).toEqual([...MUTANT_MATRIX[mutation]]);
        expect(report.passed).toBe(false);
        expect(report.verifiedCapabilities).not.toContain("inject");
      },
    );
  }

  test("matrix covers every non-clean inject mutation", (): void => {
    expect(Object.keys(MUTANT_MATRIX).sort()).toEqual(
      [...NON_CLEAN_MUTATIONS].sort(),
    );
    expect(NON_CLEAN_MUTATIONS).toHaveLength(4);
  });

  test(
    "refusal fixtures stay wholly beneath the caller temp root",
    async (): Promise<void> => {
      const tempRoot: string = mkdtempSync(
        join(tmpdir(), "hyperagent-inject-safety-"),
      );
      try {
        const descriptor: ConformanceDescriptor =
          createStubInjectDescriptor("none");
        const factory = descriptor.factories.inject;
        if (factory === undefined) {
          throw new Error("clean inject descriptor has no inject factory");
        }
        const context: ConformanceContext = { tempRoot };
        const fixtures: InjectFixtureSet = await factory(context);

        expect(isAtOrUnder(fixtures.refusalRoot, tempRoot)).toBe(true);
        for (const pattern of descriptor.forbiddenTargetPatterns) {
          const targetPath: string = resolve(
            fixtures.refusalRoot,
            pattern,
            "repo",
          );
          expect(isAtOrUnder(targetPath, tempRoot)).toBe(true);
          expect(
            isAtOrUnder(fixtures.managedArtifactPath(targetPath), tempRoot),
          ).toBe(true);
        }

        const report: ConformanceReport = await runConformance(
          descriptor,
          {
            checks: INJECT_CHECKS.filter(
              ({ id }): boolean => id === "inject.refusal",
            ),
            tempRoot,
          },
        );
        expect(report.checks).toHaveLength(1);
        expect(report.checks[0]?.status).toBe("pass");
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );
});
