import { describe, expect, test } from "bun:test";

import { renderConformanceReport } from "./render.ts";
import type { ConformanceReport } from "./types.ts";

function report(): ConformanceReport {
  return {
    vendor: "fake-harness",
    adapterVersion: "1.2.3",
    dialectVersion: "4.5.6",
    checks: [
      {
        id: "observe.clean",
        capability: "observe",
        status: "pass",
        detail: "read /private/tmp/conformance/session.jsonl",
      },
      {
        id: "gate.unclaimed",
        capability: "gate",
        status: "skipped",
        detail: "capability not claimed",
      },
    ],
    verifiedCapabilities: ["observe"],
    tier: "below-tier",
    passed: true,
  };
}

describe("renderConformanceReport", (): void => {
  test("is byte-stable and removes absolute paths", (): void => {
    const input = report();
    const first: string = renderConformanceReport(input);
    const second: string = renderConformanceReport(input);

    expect(first).toBe(second);
    expect(first).not.toContain("/private/tmp");
    expect(first).toBe([
      "PASS observe.clean: read <path>",
      "SKIP gate.unclaimed: capability not claimed",
      "VERIFIED CAPABILITIES: observe",
      "TIER: below-tier",
      "SUMMARY: PASS",
    ].join("\n"));
  });
});
