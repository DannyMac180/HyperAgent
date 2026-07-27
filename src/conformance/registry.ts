import { claudeCodeConformanceDescriptor } from "../adapters/claude-code/conformance.ts";
import {
  GATE_CHECKS,
} from "./checks/gate.ts";
import {
  INJECT_CHECKS,
} from "./checks/inject.ts";
import {
  OBSERVE_CHECKS,
} from "./checks/observe.ts";
import type { ConformanceCheck } from "./runner.ts";
import type { ConformanceDescriptor } from "./types.ts";

/**
 * This is the sole vendor-aware conformance registry. Adding a harness means
 * adding its descriptor here; the runner, CLI, and matrix generator stay
 * vendor-blind.
 */
export function conformanceDescriptors(): readonly ConformanceDescriptor[] {
  return [claudeCodeConformanceDescriptor];
}

export function descriptorForVendor(
  vendor: string,
): ConformanceDescriptor | undefined {
  return conformanceDescriptors().find(
    (descriptor: ConformanceDescriptor): boolean =>
      descriptor.vendor === vendor,
  );
}

export function conformanceVendorNames(): string[] {
  return conformanceDescriptors().map(
    (descriptor: ConformanceDescriptor): string => descriptor.vendor,
  );
}

export const ALL_CONFORMANCE_CHECKS: readonly ConformanceCheck[] = [
  ...OBSERVE_CHECKS,
  ...INJECT_CHECKS,
  ...GATE_CHECKS,
];
