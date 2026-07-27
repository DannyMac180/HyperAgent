import type {
  CheckResult,
  CheckStatus,
  ConformanceReport,
} from "./types.ts";

const STATUS_LABELS: Record<CheckStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  skipped: "SKIP",
  "not-applicable": "N/A",
};

function withoutAbsolutePaths(detail: string): string {
  return detail
    .replace(
      /(^|[\s("'`=])\/[^\s"'`)]+/gu,
      (_match: string, prefix: string): string => `${prefix}<path>`,
    )
    .replace(
      /(^|[\s("'`=])[A-Za-z]:[\\/][^\s"'`)]+/gu,
      (_match: string, prefix: string): string => `${prefix}<path>`,
    );
}

export function renderConformanceReport(report: ConformanceReport): string {
  const checkLines: string[] = report.checks.map(
    (check: CheckResult): string =>
      `${STATUS_LABELS[check.status]} ${check.id}: ${withoutAbsolutePaths(check.detail)}`,
  );
  const verified: string = report.verifiedCapabilities.length > 0
    ? report.verifiedCapabilities.join(", ")
    : "none";
  return [
    ...checkLines,
    `VERIFIED CAPABILITIES: ${verified}`,
    `TIER: ${String(report.tier)}`,
    `SUMMARY: ${report.passed ? "PASS" : "FAIL"}`,
  ].join("\n");
}
