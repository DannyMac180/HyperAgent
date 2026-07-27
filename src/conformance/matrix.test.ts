import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";

import {
  renderCapabilityMatrix,
} from "./matrix.ts";
import {
  ALL_CONFORMANCE_CHECKS,
  conformanceDescriptors,
} from "./registry.ts";
import { runConformance } from "./runner.ts";
import type { ConformanceReport } from "./types.ts";

const REGENERATION_COMMAND =
  "bun src/daemon/cli.ts conformance matrix --write";

async function liveReports(): Promise<ConformanceReport[]> {
  return Promise.all(
    conformanceDescriptors().map((descriptor) =>
      runConformance(descriptor, { checks: ALL_CONFORMANCE_CHECKS })
    ),
  );
}

test("generated capability matrix has not drifted", async () => {
  const reports = await liveReports();
  const generated = renderCapabilityMatrix(reports);
  const committed = await readFile(
    join(import.meta.dir, "..", "..", "docs", "capability-matrix.md"),
    "utf8",
  );
  if (generated !== committed) {
    throw new Error(
      `Capability matrix drifted; run: ${REGENERATION_COMMAND}`,
    );
  }
  expect(generated).toBe(committed);
});

test("only a passing report can render a verified row", () => {
  const failingVendor = "failing-harness";
  const failing: ConformanceReport = {
    vendor: failingVendor,
    adapterVersion: "1.0.0",
    dialectVersion: "fixture-v1",
    checks: [{
      id: "observe.failure",
      capability: "observe",
      status: "fail",
      detail: "deliberate failure",
    }],
    verifiedCapabilities: ["observe", "inject", "gate"],
    tier: 1,
    passed: false,
  };
  const rendered = renderCapabilityMatrix([failing]);
  const failingRow = rendered.split("\n").find((line) =>
    line.startsWith(`| ${failingVendor} |`)
  );

  expect(failingRow).toBeDefined();
  expect(failingRow).toContain("unverified (conformance failing)");
  expect(failingRow).not.toMatch(/\| [123] \|/);
  expect(failingRow).not.toContain("verified as of");
  expect(renderCapabilityMatrix([])).not.toMatch(
    /\| absent-harness \|.*verified as of/,
  );
});

test("capability matrix rendering is deterministic", async () => {
  const reports = await liveReports();
  expect(renderCapabilityMatrix(reports)).toBe(renderCapabilityMatrix(reports));
});
