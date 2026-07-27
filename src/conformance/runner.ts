import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
} from "node:path";

import type {
  ConformanceCapability,
  ConformanceContext,
  ConformanceDescriptor,
  ConformanceReport,
  GateFixtureSet,
  InjectFixtureSet,
  ObserveFixtureSet,
} from "./types.ts";
import {
  deriveTier,
  deriveVerifiedCapabilities,
} from "./tier.ts";

export interface ObserveCheckDependencies {
  capability: "observe";
  descriptor: ConformanceDescriptor;
  context: ConformanceContext;
  fixtures: ObserveFixtureSet;
}

export interface InjectCheckDependencies {
  capability: "inject";
  descriptor: ConformanceDescriptor;
  context: ConformanceContext;
  fixtures: InjectFixtureSet;
}

export interface GateCheckDependencies {
  capability: "gate";
  descriptor: ConformanceDescriptor;
  context: ConformanceContext;
  fixtures: GateFixtureSet;
}

export type ConformanceCheckDependencies =
  | ObserveCheckDependencies
  | InjectCheckDependencies
  | GateCheckDependencies;

export interface ConformanceCheck {
  id: string;
  capability: ConformanceCapability;
  /**
   * Checks resolve with pass detail and throw with failure context. The core
   * cannot safely cancel arbitrary fixture filesystem work, so descriptors
   * must bound or cancel their own asynchronous adapter operations.
   */
  run(deps: ConformanceCheckDependencies): Promise<string>;
}

export interface RunConformanceOptions {
  checks?: readonly ConformanceCheck[];
  tempRoot?: string;
}

export class NotApplicableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NotApplicableError";
  }
}

type FixtureState =
  | { capability: "observe"; fixtures: ObserveFixtureSet }
  | { capability: "inject"; fixtures: InjectFixtureSet }
  | { capability: "gate"; fixtures: GateFixtureSet }
  | { capability: ConformanceCapability; error: string };

const CAPABILITIES: readonly ConformanceCapability[] = [
  "observe",
  "inject",
  "gate",
];
const HOOK_KINDS = new Set(["pre_tool_use", "post_tool_use", "stop"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function requireNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function validateBooleanRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): void {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of keys) {
    if (typeof value[key] !== "boolean") {
      throw new Error(`${label}.${key} must be a boolean`);
    }
  }
}

function validateFactories(value: unknown): void {
  if (!isPlainObject(value)) {
    throw new Error("descriptor.factories must be an object");
  }
  for (const capability of CAPABILITIES) {
    const factory: unknown = value[capability];
    if (factory !== undefined && typeof factory !== "function") {
      throw new Error(
        `descriptor.factories.${capability} must be a function when supplied`,
      );
    }
  }
}

function validateDescriptor(descriptor: ConformanceDescriptor): void {
  if (!isPlainObject(descriptor)) {
    throw new Error("descriptor must be an object");
  }
  requireNonEmptyString(descriptor.vendor, "descriptor.vendor");
  requireNonEmptyString(
    descriptor.adapterVersion,
    "descriptor.adapterVersion",
  );
  requireNonEmptyString(
    descriptor.dialectVersion,
    "descriptor.dialectVersion",
  );
  validateBooleanRecord(
    descriptor.claimed,
    "descriptor.claimed",
    CAPABILITIES,
  );
  validateBooleanRecord(
    descriptor.storageTraits,
    "descriptor.storageTraits",
    ["appendOnlyLines"],
  );
  if (!Array.isArray(descriptor.claimedHookKinds)) {
    throw new Error("descriptor.claimedHookKinds must be an array");
  }
  for (const kind of descriptor.claimedHookKinds) {
    if (typeof kind !== "string" || !HOOK_KINDS.has(kind)) {
      throw new Error(
        `descriptor.claimedHookKinds contains unsupported kind ${String(kind)}`,
      );
    }
  }
  if (!Array.isArray(descriptor.forbiddenTargetPatterns)) {
    throw new Error("descriptor.forbiddenTargetPatterns must be an array");
  }
  descriptor.forbiddenTargetPatterns.forEach(
    (pattern: unknown, index: number): void => {
      requireNonEmptyString(
        pattern,
        `descriptor.forbiddenTargetPatterns[${index}]`,
      );
    },
  );
  validateFactories(descriptor.factories);
}

function validateOptions(options: RunConformanceOptions): void {
  if (!isPlainObject(options)) {
    throw new Error("conformance options must be an object");
  }
  // Runtime shape narrowing erases the declared field types, so validation
  // reads through the typed alias after proving the object boundary.
  const typedOptions: RunConformanceOptions = options;
  if (typedOptions.tempRoot !== undefined) {
    requireNonEmptyString(typedOptions.tempRoot, "options.tempRoot");
    if (!isAbsolute(typedOptions.tempRoot)) {
      throw new Error("options.tempRoot must be an absolute path");
    }
  }
  if (
    typedOptions.checks !== undefined
    && !Array.isArray(typedOptions.checks)
  ) {
    throw new Error("options.checks must be an array");
  }
}

function validateChecks(checks: readonly ConformanceCheck[]): void {
  checks.forEach((check: ConformanceCheck, index: number): void => {
    if (!isPlainObject(check)) {
      throw new Error(`checks[${index}] must be an object`);
    }
    requireNonEmptyString(check.id, `checks[${index}].id`);
    if (!CAPABILITIES.includes(check.capability)) {
      throw new Error(
        `checks[${index}].capability must be observe, inject, or gate`,
      );
    }
    if (typeof check.run !== "function") {
      throw new Error(`checks[${index}].run must be a function`);
    }
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    return "unknown thrown value";
  }
}

async function buildFixtureState(
  capability: ConformanceCapability,
  descriptor: ConformanceDescriptor,
  context: ConformanceContext,
): Promise<FixtureState> {
  const factory = descriptor.factories[capability];
  if (factory === undefined) {
    return {
      capability,
      error: `claimed ${capability} capability has no factory`,
    };
  }

  try {
    if (capability === "observe") {
      return {
        capability,
        fixtures: await descriptor.factories.observe!(context),
      };
    }
    if (capability === "inject") {
      return {
        capability,
        fixtures: await descriptor.factories.inject!(context),
      };
    }
    return {
      capability,
      fixtures: await descriptor.factories.gate!(context),
    };
  } catch (error: unknown) {
    return {
      capability,
      error: `${capability} factory failed: ${errorMessage(error)}`,
    };
  }
}

async function runCheck(
  check: ConformanceCheck,
  descriptor: ConformanceDescriptor,
  context: ConformanceContext,
  state: FixtureState,
): Promise<ConformanceReport["checks"][number]> {
  if ("error" in state) {
    return {
      id: check.id,
      capability: check.capability,
      status: "fail",
      detail: state.error,
    };
  }

  let dependencies: ConformanceCheckDependencies;
  if (state.capability === "observe") {
    dependencies = {
      capability: "observe",
      descriptor,
      context,
      fixtures: state.fixtures,
    };
  } else if (state.capability === "inject") {
    dependencies = {
      capability: "inject",
      descriptor,
      context,
      fixtures: state.fixtures,
    };
  } else {
    dependencies = {
      capability: "gate",
      descriptor,
      context,
      fixtures: state.fixtures,
    };
  }

  try {
    const detail: string = await check.run(dependencies);
    if (typeof detail !== "string") {
      throw new Error("check resolved without a string detail");
    }
    return {
      id: check.id,
      capability: check.capability,
      status: "pass",
      detail,
    };
  } catch (error: unknown) {
    return {
      id: check.id,
      capability: check.capability,
      status: error instanceof NotApplicableError
        ? "not-applicable"
        : "fail",
      detail: errorMessage(error),
    };
  }
}

export async function runConformance(
  descriptor: ConformanceDescriptor,
  options: RunConformanceOptions = {},
): Promise<ConformanceReport> {
  validateDescriptor(descriptor);
  validateOptions(options);
  const checks: readonly ConformanceCheck[] = options.checks ?? [];
  validateChecks(checks);

  /**
   * Temp-root ownership follows creation: the runner removes only roots it
   * creates. A supplied root remains caller-owned even when a run fails.
   */
  const ownsTempRoot: boolean = options.tempRoot === undefined;
  const tempRoot: string = options.tempRoot
    ?? mkdtempSync(join(tmpdir(), "hyperagent-conformance-"));
  const context: ConformanceContext = { tempRoot };
  const states = new Map<ConformanceCapability, FixtureState>();

  try {
    mkdirSync(tempRoot, { recursive: true });
    for (const capability of CAPABILITIES) {
      const hasRegisteredCheck: boolean = checks.some(
        (check: ConformanceCheck): boolean =>
          check.capability === capability,
      );
      if (descriptor.claimed[capability] && hasRegisteredCheck) {
        states.set(
          capability,
          await buildFixtureState(capability, descriptor, context),
        );
      }
      // Unclaimed capabilities and capabilities without checks need no fixture.
    }

    const results: ConformanceReport["checks"] = [];
    for (const check of checks) {
      if (!descriptor.claimed[check.capability]) {
        results.push({
          id: check.id,
          capability: check.capability,
          status: "skipped",
          detail: "capability not claimed",
        });
        continue;
      }

      const state: FixtureState | undefined = states.get(check.capability);
      if (state === undefined) {
        results.push({
          id: check.id,
          capability: check.capability,
          status: "fail",
          detail: `claimed ${check.capability} capability was not initialized`,
        });
        continue;
      }
      results.push(await runCheck(check, descriptor, context, state));
    }

    const verifiedCapabilities = deriveVerifiedCapabilities(
      results,
      descriptor.claimed,
    );
    return {
      vendor: descriptor.vendor,
      adapterVersion: descriptor.adapterVersion,
      dialectVersion: descriptor.dialectVersion,
      checks: results,
      verifiedCapabilities,
      tier: deriveTier(verifiedCapabilities),
      passed: results.every(
        (result): boolean => result.status !== "fail",
      ),
    };
  } finally {
    if (ownsTempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}
