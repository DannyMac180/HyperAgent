import type {
  CheckResult,
  ConformanceCapability,
  ConformanceDescriptor,
  ConformanceTier,
} from "./types.ts";

const CAPABILITIES: readonly ConformanceCapability[] = [
  "observe",
  "inject",
  "gate",
];

export function deriveVerifiedCapabilities(
  checks: readonly CheckResult[],
  claimed: ConformanceDescriptor["claimed"],
): ConformanceCapability[] {
  return CAPABILITIES.filter(
    (capability: ConformanceCapability): boolean => {
      if (!claimed[capability]) {
        return false;
      }
      const capabilityChecks: CheckResult[] = checks.filter(
        (check: CheckResult): boolean => check.capability === capability,
      );
      const hasPassingCheck: boolean = capabilityChecks.some(
        (check: CheckResult): boolean => check.status === "pass",
      );
      const allChecksQualify: boolean = capabilityChecks.every(
        (check: CheckResult): boolean =>
          check.status === "pass" || check.status === "not-applicable",
      );
      return hasPassingCheck && allChecksQualify;
    },
  );
}

export function deriveTier(
  verified: readonly ConformanceCapability[],
): ConformanceTier {
  const capabilities = new Set(verified);
  if (
    capabilities.has("observe")
    && capabilities.has("inject")
    && capabilities.has("gate")
  ) {
    return 1;
  }
  if (capabilities.has("observe") && capabilities.has("inject")) {
    return 2;
  }
  if (capabilities.has("inject")) {
    return 3;
  }
  // Observe without inject is deliberately below-tier: a suit that cannot
  // deliver anything into the agent is not a suit.
  return "below-tier";
}
