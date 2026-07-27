import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NotApplicableError,
  runConformance,
} from "./runner.ts";
import type {
  ConformanceCheck,
  ConformanceCheckDependencies,
} from "./runner.ts";
import type {
  ConformanceDescriptor,
  InjectFixtureSet,
} from "./types.ts";

function descriptor(
  overrides: Partial<ConformanceDescriptor> = {},
): ConformanceDescriptor {
  return {
    vendor: "fake-harness",
    adapterVersion: "1.2.3",
    dialectVersion: "4.5.6",
    claimed: { observe: false, inject: false, gate: false },
    storageTraits: { appendOnlyLines: false },
    claimedHookKinds: [],
    forbiddenTargetPatterns: [],
    factories: {},
    ...overrides,
  };
}

function injectFixtures(): InjectFixtureSet {
  return {} as InjectFixtureSet;
}

function check(
  id: string,
  capability: ConformanceCheck["capability"],
  run: (
    deps: ConformanceCheckDependencies,
  ) => Promise<string>,
): ConformanceCheck {
  return { id, capability, run };
}

describe("runConformance", (): void => {
  test("skips every unclaimed check without invoking its factory", async (): Promise<void> => {
    let factoryCalls = 0;
    const report = await runConformance(
      descriptor({
        factories: {
          inject: async (): Promise<InjectFixtureSet> => {
            factoryCalls += 1;
            return injectFixtures();
          },
        },
      }),
      {
        checks: [
          check("inject.first", "inject", async (): Promise<string> => "first"),
          check("inject.second", "inject", async (): Promise<string> => "second"),
        ],
      },
    );

    expect(factoryCalls).toBe(0);
    expect(report.checks).toEqual([
      {
        id: "inject.first",
        capability: "inject",
        status: "skipped",
        detail: "capability not claimed",
      },
      {
        id: "inject.second",
        capability: "inject",
        status: "skipped",
        detail: "capability not claimed",
      },
    ]);
  });

  test("fails checks when a claimed capability has no factory", async (): Promise<void> => {
    const report = await runConformance(
      descriptor({
        claimed: { observe: false, inject: true, gate: false },
      }),
      {
        checks: [
          check("inject.roundtrip", "inject", async (): Promise<string> => "ok"),
        ],
      },
    );

    expect(report.checks[0]).toEqual({
      id: "inject.roundtrip",
      capability: "inject",
      status: "fail",
      detail: "claimed inject capability has no factory",
    });
  });

  test("runs a claimed capability factory once and fans its error to every check", async (): Promise<void> => {
    let factoryCalls = 0;
    const report = await runConformance(
      descriptor({
        claimed: { observe: false, inject: true, gate: false },
        factories: {
          inject: async (): Promise<InjectFixtureSet> => {
            factoryCalls += 1;
            throw new Error("fixture exploded");
          },
        },
      }),
      {
        checks: [
          check("inject.first", "inject", async (): Promise<string> => "first"),
          check("inject.second", "inject", async (): Promise<string> => "second"),
        ],
      },
    );

    expect(factoryCalls).toBe(1);
    expect(report.checks.map((result): string => result.status)).toEqual([
      "fail",
      "fail",
    ]);
    expect(report.checks.map((result): string => result.detail)).toEqual([
      "inject factory failed: fixture exploded",
      "inject factory failed: fixture exploded",
    ]);
  });

  test("captures a thrown check and continues with later checks", async (): Promise<void> => {
    const executionOrder: string[] = [];
    const report = await runConformance(
      descriptor({
        claimed: { observe: false, inject: true, gate: false },
        factories: {
          inject: async (): Promise<InjectFixtureSet> => injectFixtures(),
        },
      }),
      {
        checks: [
          check("inject.bad", "inject", async (): Promise<string> => {
            executionOrder.push("bad");
            throw new Error("check exploded");
          }),
          check("inject.after", "inject", async (): Promise<string> => {
            executionOrder.push("after");
            return "still ran";
          }),
        ],
      },
    );

    expect(executionOrder).toEqual(["bad", "after"]);
    expect(report.checks).toEqual([
      {
        id: "inject.bad",
        capability: "inject",
        status: "fail",
        detail: "check exploded",
      },
      {
        id: "inject.after",
        capability: "inject",
        status: "pass",
        detail: "still ran",
      },
    ]);
    expect(report.passed).toBe(false);
  });

  test("maps NotApplicableError without disqualifying a passing capability", async (): Promise<void> => {
    const report = await runConformance(
      descriptor({
        claimed: { observe: false, inject: true, gate: false },
        factories: {
          inject: async (): Promise<InjectFixtureSet> => injectFixtures(),
        },
      }),
      {
        checks: [
          check("inject.roundtrip", "inject", async (): Promise<string> => "ok"),
          check("inject.trait", "inject", async (): Promise<string> => {
            throw new NotApplicableError("trait does not apply");
          }),
        ],
      },
    );

    expect(report.checks[1]?.status).toBe("not-applicable");
    expect(report.verifiedCapabilities).toEqual(["inject"]);
    expect(report.tier).toBe(3);
    expect(report.passed).toBe(true);
  });

  // Temp-root ownership: the runner cleans up only what it created. A
  // caller-supplied root belongs to the caller (the CLI may want to inspect
  // fixtures after a failing run), so deleting it would destroy their data.
  test("leaves a caller-supplied temp root in place after the run", async (): Promise<void> => {
    const tempRoot: string = mkdtempSync(
      join(tmpdir(), "hyperagent-conformance-test-"),
    );

    try {
      await runConformance(descriptor(), { tempRoot });

      expect(existsSync(tempRoot)).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("preserves registration order", async (): Promise<void> => {
    const report = await runConformance(descriptor(), {
      checks: [
        check("gate.third", "gate", async (): Promise<string> => "third"),
        check("observe.first", "observe", async (): Promise<string> => "first"),
        check("inject.second", "inject", async (): Promise<string> => "second"),
      ],
    });

    expect(report.checks.map((result): string => result.id)).toEqual([
      "gate.third",
      "observe.first",
      "inject.second",
    ]);
  });

  test("stamps descriptor metadata into the report", async (): Promise<void> => {
    const report = await runConformance(descriptor());

    expect(report.vendor).toBe("fake-harness");
    expect(report.adapterVersion).toBe("1.2.3");
    expect(report.dialectVersion).toBe("4.5.6");
  });

  test("validates structural inputs before creating fixtures", async (): Promise<void> => {
    let factoryCalls = 0;
    const invalid = descriptor({
      vendor: "",
      factories: {
        inject: async (): Promise<InjectFixtureSet> => {
          factoryCalls += 1;
          return injectFixtures();
        },
      },
    });

    expect(runConformance(invalid)).rejects.toThrow(
      "descriptor.vendor must be a non-empty string",
    );
    expect(factoryCalls).toBe(0);
  });
});
