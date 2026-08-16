import type { ConformanceReport } from "./types.ts";

/**
 * A harness nobody has run the conformance suite against yet.
 *
 * These rows carry no tier and no capability verdicts, only a note on where
 * the surface is expected to be. Tier is a claim about verified capability
 * (§6.3 derivation: at least one real passing check per capability), so
 * asserting one here would be asserting evidence that does not exist — which
 * is the exact thing this file's footer says cannot happen.
 */
export interface UnverifiedHarness {
  vendor: string;
  expectedSurface: string;
}

export const UNVERIFIED_HARNESSES: readonly UnverifiedHarness[] = [
  {
    vendor: "OpenClaw",
    expectedSurface: "open-source and hackable; AGENTS.md-style injection, MCP",
  },
  { vendor: "Amp", expectedSurface: "thread storage; AGENTS.md injection" },
  {
    vendor: "Cursor",
    expectedSurface: "app-internal state; rules-file injection",
  },
];

const REGENERATION_COMMAND =
  "bun src/daemon/cli.ts conformance matrix --write";

/**
 * Correction detection (DAN-224) is a per-vendor signal inside the observe
 * capability. It gets its own honest column because a harness can be fully
 * observable yet unable to support adapter-time correction detection — that
 * reads "not applicable", never a silent pass.
 */
function correctionCell(report: ConformanceReport): string {
  const check = report.checks.find(
    ({ id }): boolean => id === "observe.correction",
  );
  if (check === undefined) {
    return "not measured";
  }
  switch (check.status) {
    case "pass":
      return "verified";
    case "not-applicable":
      return "not applicable";
    case "skipped":
      return "not claimed";
    default:
      return "failing";
  }
}

function verifiedRow(report: ConformanceReport): string {
  if (!report.passed) {
    return `| ${report.vendor} | unverified (conformance failing) | unverified (conformance failing) | unverified (conformance failing) | unverified (conformance failing) | unverified (conformance failing) | adapter v${report.adapterVersion} / dialect v${report.dialectVersion} |`;
  }
  const capability = (name: "observe" | "inject" | "gate"): string =>
    report.verifiedCapabilities.includes(name) ? "verified" : "not claimed";
  return `| ${report.vendor} | ${capability("observe")} | ${capability("inject")} | ${capability("gate")} | ${correctionCell(report)} | ${String(report.tier)} | verified as of adapter v${report.adapterVersion} / dialect ${report.dialectVersion} |`;
}

/**
 * Not-yet-measured rows are deliberately built on a separate path from
 * report-backed rows, in a separate table with a different column set.
 * Architecture claims can never be promoted to verified by this builder, and
 * the two tables cannot be confused for one another by a skimming reader.
 */
function unmeasuredRow(harness: UnverifiedHarness): string {
  return `| ${harness.vendor} | ${harness.expectedSurface} |`;
}

export function renderCapabilityMatrix(
  reports: readonly ConformanceReport[],
): string {
  const reportRows = [...reports]
    .sort((left: ConformanceReport, right: ConformanceReport): number => {
      if (left.vendor < right.vendor) {
        return -1;
      }
      return left.vendor > right.vendor ? 1 : 0;
    })
    .map(verifiedRow);
  const unmeasuredRows = UNVERIFIED_HARNESSES.map(unmeasuredRow);

  return [
    "<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->",
    "",
    "# Capability Matrix",
    "",
    `Regenerate with \`${REGENERATION_COMMAND}\`. Generation runs the conformance suite LIVE against every registered descriptor; there is no cached-report path.`,
    "",
    "## Measured",
    "",
    "Every row below is the output of a conformance run against a registered adapter. This is the authority on what HyperAgent can actually do.",
    "",
    "| Harness | Observe | Inject | Gate | Correction detection | Tier | Evidence |",
    "|---|---|---|---|---|---|---|",
    ...reportRows,
    "",
    "## Not yet measured",
    "",
    "No adapter, no conformance run, no evidence. These rows carry **no tier and no capability verdicts** — only where the surface is expected to be, from the fleet assessment in `architecture-v2.md` §6.3. Nothing here is a claim about what HyperAgent supports today.",
    "",
    "| Harness | Expected surface (unverified) |",
    "|---|---|",
    ...unmeasuredRows,
    "",
    "To earn a row in **Measured**, add a `ConformanceDescriptor` beside the adapter, register it in `src/conformance/registry.ts`, and pass the suite. A row is earned by a passing run, never by editing this table.",
    "",
  ].join("\n");
}
