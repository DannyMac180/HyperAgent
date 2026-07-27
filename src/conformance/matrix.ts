import type { ConformanceReport } from "./types.ts";

export interface UnverifiedHarness {
  vendor: string;
  observe: string;
  inject: string;
  gate: string;
  tier: string;
}

export const UNVERIFIED_HARNESSES: readonly UnverifiedHarness[] = [
  {
    vendor: "OpenClaw",
    observe: "Open-source, hackable",
    inject: "AGENTS.md-style, MCP",
    gate: "Likely achievable",
    tier: "1 — full suit",
  },
  {
    vendor: "Codex",
    observe: "Session rollouts",
    inject: "AGENTS.md, skills",
    gate: "Approval config only",
    tier: "2 — observe + inject",
  },
  {
    vendor: "Amp",
    observe: "Thread storage",
    inject: "AGENTS.md",
    gate: "No",
    tier: "2",
  },
  {
    vendor: "Cursor",
    observe: "Weak (app-internal)",
    inject: "Rules files",
    gate: "No",
    tier: "3 — inject-only",
  },
];

const REGENERATION_COMMAND =
  "bun src/daemon/cli.ts conformance matrix --write";

function verifiedRow(report: ConformanceReport): string {
  if (!report.passed) {
    return `| ${report.vendor} | unverified (conformance failing) | unverified (conformance failing) | unverified (conformance failing) | unverified (conformance failing) | adapter v${report.adapterVersion} / dialect v${report.dialectVersion} |`;
  }
  const capability = (name: "observe" | "inject" | "gate"): string =>
    report.verifiedCapabilities.includes(name) ? "verified" : "not claimed";
  return `| ${report.vendor} | ${capability("observe")} | ${capability("inject")} | ${capability("gate")} | ${String(report.tier)} | verified as of adapter v${report.adapterVersion} / dialect ${report.dialectVersion} |`;
}

/**
 * Claimed rows are deliberately built on a separate path from report-backed
 * rows. Architecture claims can never be promoted to verified by this builder.
 */
function claimedRow(harness: UnverifiedHarness): string {
  return `| ${harness.vendor} | ${harness.observe} | ${harness.inject} | ${harness.gate} | ${harness.tier} | claimed, unverified — architecture-v2 §6.3 |`;
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
  const claimedRows = UNVERIFIED_HARNESSES.map(claimedRow);

  return [
    "<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->",
    "",
    "# Capability Matrix",
    "",
    `Regenerate with \`${REGENERATION_COMMAND}\`. Generation runs the conformance suite LIVE against every registered descriptor; there is no cached-report path.`,
    "",
    "| Harness | Observe | Inject | Gate | Tier | Evidence |",
    "|---|---|---|---|---|---|",
    ...reportRows,
    ...claimedRows,
    "",
    "To earn a row, add a `ConformanceDescriptor` beside the adapter, register it in `src/conformance/registry.ts`, and pass the suite. A row is earned by a passing run, never by editing this table.",
    "",
  ].join("\n");
}
