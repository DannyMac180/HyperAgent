import {
  describe,
  expect,
  test,
} from "bun:test";

import {
  OBSERVE_CHECKS,
} from "../checks/observe.ts";
import {
  runConformance,
} from "../runner.ts";
import {
  createStubObserveDescriptor,
  createStubObserveDescriptorWithoutAppendOnlyLines,
} from "./stub-observe.ts";

describe("stub observe conformance fixtures", (): void => {
  test("the clean stub verifies all observe checks", async (): Promise<void> => {
    const report = await runConformance(
      createStubObserveDescriptor("none"),
      { checks: OBSERVE_CHECKS },
    );

    expect(report.checks).toHaveLength(OBSERVE_CHECKS.length);
    expect(
      report.checks.every(({ status }): boolean => status === "pass"),
    ).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.verifiedCapabilities).toContain("observe");
  });

  test(
    "truncation is not applicable without append-only lines",
    async (): Promise<void> => {
      const report = await runConformance(
        createStubObserveDescriptorWithoutAppendOnlyLines(),
        { checks: OBSERVE_CHECKS },
      );
      const truncation = report.checks.find(
        ({ id }): boolean => id === "observe.truncation",
      );
      const otherChecks = report.checks.filter(
        ({ id }): boolean => id !== "observe.truncation",
      );

      expect(truncation?.status).toBe("not-applicable");
      expect(otherChecks).toHaveLength(OBSERVE_CHECKS.length - 1);
      expect(
        otherChecks.every(({ status }): boolean => status === "pass"),
      ).toBe(true);
      expect(report.passed).toBe(true);
      expect(report.verifiedCapabilities).toContain("observe");
    },
  );
});
