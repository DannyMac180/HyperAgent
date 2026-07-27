import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  GateInstallResult,
  GateInstallState,
  GateStatus,
} from "../../adapters/types.ts";
import type {
  GateDecision,
  GateDecisionKind,
  GateHookInput,
  GateHookKind,
} from "../../gate/eval.ts";
import {
  NotApplicableError,
} from "../runner.ts";
import type {
  ConformanceCheck,
  ConformanceCheckDependencies,
  GateCheckDependencies,
} from "../runner.ts";

const ALL_HOOK_KINDS: readonly GateHookKind[] = [
  "pre_tool_use",
  "post_tool_use",
  "stop",
];
const INSTALL_STATES: readonly GateInstallState[] = [
  "installed",
  "stale",
  "not-installed",
  "foreign",
  "refused",
];
const DECISION_KINDS: readonly GateDecisionKind[] = [
  "allow",
  "deny",
  "block",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
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

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const candidate: string = requireString(value, label);
  if (candidate.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return candidate;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((candidate: unknown, index: number): string =>
    requireString(candidate, `${label}[${index}]`));
}

function isAtOrUnder(candidate: string, root: string): boolean {
  const pathFromRoot: string = relative(resolve(root), resolve(candidate));
  return (
    pathFromRoot === ""
    || (
      pathFromRoot !== ".."
      && !pathFromRoot.startsWith(`..${sep}`)
      && !isAbsolute(pathFromRoot)
    )
  );
}

function requirePathUnder(
  value: unknown,
  root: string,
  label: string,
): string {
  const candidate: string = requireNonEmptyString(value, label);
  if (!isAbsolute(candidate)) {
    throw new Error(`${label} must be absolute, got ${JSON.stringify(candidate)}`);
  }
  if (!isAtOrUnder(candidate, root)) {
    throw new Error(
      `${label} must stay under ${JSON.stringify(resolve(root))}, got `
      + JSON.stringify(resolve(candidate)),
    );
  }
  return resolve(candidate);
}

function requireHookKind(value: unknown, label: string): GateHookKind {
  if (
    typeof value !== "string"
    || !ALL_HOOK_KINDS.includes(value as GateHookKind)
  ) {
    throw new Error(`${label} must be a supported gate hook kind`);
  }
  return value as GateHookKind;
}

function requireDecisionKind(value: unknown, label: string): GateDecisionKind {
  if (
    typeof value !== "string"
    || !DECISION_KINDS.includes(value as GateDecisionKind)
  ) {
    throw new Error(`${label} must be allow, deny, or block`);
  }
  return value as GateDecisionKind;
}

function validateInstallResult(
  value: unknown,
  repoPath: string,
  label: string,
): GateInstallResult {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must return a plain object`);
  }
  const targetPath: string = requirePathUnder(
    value.targetPath,
    repoPath,
    `${label}.targetPath`,
  );
  if (typeof value.changed !== "boolean") {
    throw new Error(`${label}.changed must be a boolean`);
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    throw new Error(`${label}.reason must be a string when supplied`);
  }
  return {
    targetPath,
    changed: value.changed,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  };
}

function validateStatus(
  value: unknown,
  repoPath: string,
  label: string,
): GateStatus {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must return a plain object`);
  }
  if (
    typeof value.state !== "string"
    || !INSTALL_STATES.includes(value.state as GateInstallState)
  ) {
    throw new Error(`${label}.state must be a supported gate install state`);
  }
  const targetPath: string = requirePathUnder(
    value.targetPath,
    repoPath,
    `${label}.targetPath`,
  );
  if (
    !Number.isSafeInteger(value.ownedEntries)
    || (value.ownedEntries as number) < 0
  ) {
    throw new Error(
      `${label}.ownedEntries must be a non-negative safe integer`,
    );
  }
  return {
    state: value.state as GateInstallState,
    targetPath,
    ownedEntries: value.ownedEntries as number,
    detail: requireString(value.detail, `${label}.detail`),
  };
}

function validateDecision(value: unknown, label: string): GateDecision {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must return a plain object`);
  }
  const decision: GateDecision = {
    kind: requireDecisionKind(value.kind, `${label}.kind`),
    matchedRules: requireStringArray(
      value.matchedRules,
      `${label}.matchedRules`,
    ),
    failedChecks: requireStringArray(
      value.failedChecks,
      `${label}.failedChecks`,
    ),
  };
  if (value.reason !== undefined) {
    decision.reason = requireString(value.reason, `${label}.reason`);
  }
  if (value.failedOpen !== undefined) {
    if (typeof value.failedOpen !== "boolean") {
      throw new Error(`${label}.failedOpen must be a boolean when supplied`);
    }
    decision.failedOpen = value.failedOpen;
  }
  if (value.gaveUp !== undefined) {
    if (typeof value.gaveUp !== "boolean") {
      throw new Error(`${label}.gaveUp must be a boolean when supplied`);
    }
    decision.gaveUp = value.gaveUp;
  }
  return decision;
}

function validateHookInput(
  value: unknown,
  expectedKind: GateHookKind,
  label: string,
): GateHookInput {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must return a non-null plain object`);
  }
  const hook: GateHookKind = requireHookKind(value.hook, `${label}.hook`);
  if (hook !== expectedKind) {
    throw new Error(
      `${label}.hook expected ${JSON.stringify(expectedKind)}, got `
      + JSON.stringify(hook),
    );
  }
  const input: GateHookInput = {
    hook,
    harness: requireString(value.harness, `${label}.harness`),
    sessionId: requireNonEmptyString(value.sessionId, `${label}.sessionId`),
    cwd: requireNonEmptyString(value.cwd, `${label}.cwd`),
    toolName: requireString(value.toolName, `${label}.toolName`),
    command: requireString(value.command, `${label}.command`),
    readPaths: requireStringArray(value.readPaths, `${label}.readPaths`),
    writePaths: requireStringArray(value.writePaths, `${label}.writePaths`),
  };
  if (value.toolPassed !== undefined) {
    if (typeof value.toolPassed !== "boolean") {
      throw new Error(`${label}.toolPassed must be a boolean when supplied`);
    }
    input.toolPassed = value.toolPassed;
  }
  if (value.stopHookActive !== undefined) {
    if (typeof value.stopHookActive !== "boolean") {
      throw new Error(
        `${label}.stopHookActive must be a boolean when supplied`,
      );
    }
    input.stopHookActive = value.stopHookActive;
  }
  return input;
}

/**
 * Adapter calls intentionally have no wrapper timeout. The ConformanceCheck
 * contract assigns bounding and cancellation to descriptor implementations
 * because the vendor-blind core cannot safely cancel arbitrary filesystem IO.
 */
async function install(
  deps: GateCheckDependencies,
  repoPath: string,
  label: string,
): Promise<GateInstallResult> {
  try {
    return validateInstallResult(
      await deps.fixtures.adapter.install(repoPath),
      repoPath,
      `${label}.install()`,
    );
  } catch (error: unknown) {
    throw new Error(`${label} install failed: ${errorMessage(error)}`);
  }
}

async function uninstall(
  deps: GateCheckDependencies,
  repoPath: string,
  label: string,
): Promise<GateInstallResult> {
  try {
    return validateInstallResult(
      await deps.fixtures.adapter.uninstall(repoPath),
      repoPath,
      `${label}.uninstall()`,
    );
  } catch (error: unknown) {
    throw new Error(`${label} uninstall failed: ${errorMessage(error)}`);
  }
}

async function status(
  deps: GateCheckDependencies,
  repoPath: string,
  label: string,
): Promise<GateStatus> {
  try {
    return validateStatus(
      await deps.fixtures.adapter.status(repoPath),
      repoPath,
      `${label}.status()`,
    );
  } catch (error: unknown) {
    throw new Error(`${label} status failed: ${errorMessage(error)}`);
  }
}

async function createRepo(
  contextRoot: string,
  label: string,
  withGit = true,
): Promise<string> {
  const tempRoot: string = requirePathUnder(
    contextRoot,
    contextRoot,
    "context.tempRoot",
  );
  try {
    const repoPath: string = await mkdtemp(join(tempRoot, `${label}-`));
    if (withGit) {
      await mkdir(join(repoPath, ".git"));
    }
    return repoPath;
  } catch (error: unknown) {
    throw new Error(`${label} repo creation failed: ${errorMessage(error)}`);
  }
}

function artifactPath(
  deps: GateCheckDependencies,
  repoPath: string,
  label: string,
): string {
  let candidate: unknown;
  try {
    candidate = deps.fixtures.managedArtifactPath(repoPath);
  } catch (error: unknown) {
    throw new Error(`${label} path resolution failed: ${errorMessage(error)}`);
  }
  return requirePathUnder(candidate, repoPath, `${label} path`);
}

async function readArtifact(path: string, label: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    throw new Error(
      `${label} could not read ${JSON.stringify(path)}: ${errorMessage(error)}`,
    );
  }
}

function fixtureHookStdin(
  deps: GateCheckDependencies,
  kind: GateHookKind,
  label: string,
): unknown {
  try {
    return deps.fixtures.hookStdin(kind);
  } catch (error: unknown) {
    throw new Error(`${label} hookStdin failed: ${errorMessage(error)}`);
  }
}

function fixtureDecision(
  deps: GateCheckDependencies,
  kind: GateHookKind,
  label: string,
): GateDecision {
  try {
    return validateDecision(
      deps.fixtures.decisionFor(kind),
      `${label}.decisionFor(${JSON.stringify(kind)})`,
    );
  } catch (error: unknown) {
    throw new Error(`${label} decision fixture failed: ${errorMessage(error)}`);
  }
}

function parseHookInput(
  deps: GateCheckDependencies,
  kind: GateHookKind,
  raw: unknown,
  label: string,
): GateHookInput {
  try {
    const parsed: GateHookInput | null = deps.fixtures.adapter.parseHookStdin(
      kind,
      raw,
    );
    if (parsed === null) {
      throw new Error("returned null for canonical hook input");
    }
    return validateHookInput(
      parsed,
      kind,
      `${label}.parseHookStdin(${JSON.stringify(kind)})`,
    );
  } catch (error: unknown) {
    throw new Error(`${label} hook parse failed: ${errorMessage(error)}`);
  }
}

function renderHookOutput(
  deps: GateCheckDependencies,
  kind: GateHookKind,
  decision: GateDecision,
  label: string,
): string {
  try {
    return requireString(
      deps.fixtures.adapter.renderHookOutput(kind, decision),
      `${label}.renderHookOutput(${JSON.stringify(kind)})`,
    );
  } catch (error: unknown) {
    throw new Error(`${label} hook render failed: ${errorMessage(error)}`);
  }
}

function validateRenderedOutput(
  deps: GateCheckDependencies,
  kind: GateHookKind,
  decision: GateDecision,
  rendered: string,
  label: string,
): void {
  let problem: unknown;
  try {
    problem = deps.fixtures.validateHookOutput(kind, decision, rendered);
  } catch (error: unknown) {
    throw new Error(
      `${label} hook output validation threw: ${errorMessage(error)}`,
    );
  }
  if (problem !== null && typeof problem !== "string") {
    throw new Error(
      `${label} validateHookOutput must return a string or null`,
    );
  }
  if (problem !== null) {
    throw new Error(
      `${label} rendered hook output was invalid: `
      + (problem.trim() || "unspecified problem"),
    );
  }
}

function malformedPayloads(deps: GateCheckDependencies): readonly unknown[] {
  let payloads: unknown;
  try {
    payloads = deps.fixtures.malformedHookStdin();
  } catch (error: unknown) {
    throw new Error(
      `gate malformedHookStdin fixture failed: ${errorMessage(error)}`,
    );
  }
  if (!Array.isArray(payloads)) {
    throw new Error("gate malformedHookStdin fixture must return an array");
  }
  return payloads;
}

function gateCheck(
  id: string,
  run: (deps: GateCheckDependencies) => Promise<string>,
): ConformanceCheck {
  return {
    id,
    capability: "gate",
    async run(deps: ConformanceCheckDependencies): Promise<string> {
      if (deps.capability !== "gate") {
        throw new Error(`${id} requires gate dependencies`);
      }
      return run(deps);
    },
  };
}

const installCheck: ConformanceCheck = gateCheck(
  "gate.install",
  async (deps): Promise<string> => {
    const repoPath: string = await createRepo(
      deps.context.tempRoot,
      "gate-install",
    );
    await install(deps, repoPath, "gate install");
    const installedStatus: GateStatus = await status(
      deps,
      repoPath,
      "gate install",
    );
    if (installedStatus.state !== "installed") {
      throw new Error(
        `gate install status expected "installed", got `
        + JSON.stringify(installedStatus.state),
      );
    }
    if (installedStatus.ownedEntries < 1) {
      throw new Error(
        `gate install status expected at least one owned entry, got `
        + installedStatus.ownedEntries,
      );
    }
    return `${installedStatus.ownedEntries} owned hook entry(s) installed`;
  },
);

const installIdempotentCheck: ConformanceCheck = gateCheck(
  "gate.install-idempotent",
  async (deps): Promise<string> => {
    const repoPath: string = await createRepo(
      deps.context.tempRoot,
      "gate-install-idempotent",
    );
    await install(deps, repoPath, "gate idempotency pass 1");
    const firstStatus: GateStatus = await status(
      deps,
      repoPath,
      "gate idempotency pass 1",
    );
    const secondResult: GateInstallResult = await install(
      deps,
      repoPath,
      "gate idempotency pass 2",
    );
    if (secondResult.changed) {
      throw new Error("gate idempotency pass 2 reported changed=true");
    }
    const secondStatus: GateStatus = await status(
      deps,
      repoPath,
      "gate idempotency pass 2",
    );
    if (secondStatus.state !== "installed") {
      throw new Error(
        `gate idempotency status expected "installed", got `
        + JSON.stringify(secondStatus.state),
      );
    }
    if (secondStatus.ownedEntries < 1) {
      throw new Error(
        `gate idempotency expected at least one owned entry, got `
        + secondStatus.ownedEntries,
      );
    }
    if (secondStatus.ownedEntries !== firstStatus.ownedEntries) {
      throw new Error(
        `gate idempotency owned entry count changed from `
        + `${firstStatus.ownedEntries} to ${secondStatus.ownedEntries}`,
      );
    }
    return `${secondStatus.ownedEntries} owned hook entry(s) remained stable`;
  },
);

const uninstallCheck: ConformanceCheck = gateCheck(
  "gate.uninstall",
  async (deps): Promise<string> => {
    const foreignContent: string = requireNonEmptyString(
      deps.fixtures.foreignContent,
      "gate fixture foreignContent",
    );
    const repoPath: string = await createRepo(
      deps.context.tempRoot,
      "gate-uninstall",
    );
    const path: string = artifactPath(deps, repoPath, "gate uninstall artifact");
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, foreignContent, "utf8");
    } catch (error: unknown) {
      throw new Error(
        `gate uninstall fixture setup failed for ${JSON.stringify(path)}: `
        + errorMessage(error),
      );
    }
    const originalBytes: Buffer = await readArtifact(
      path,
      "gate uninstall pre-install read",
    );
    await install(deps, repoPath, "gate uninstall install pass");
    await uninstall(deps, repoPath, "gate uninstall removal pass");
    const finalBytes: Buffer = await readArtifact(
      path,
      "gate uninstall final read",
    );
    const finalStatus: GateStatus = await status(
      deps,
      repoPath,
      "gate uninstall final",
    );
    if (finalStatus.ownedEntries !== 0) {
      throw new Error(
        `gate uninstall expected zero owned entries, got `
        + finalStatus.ownedEntries,
      );
    }
    if (finalBytes.equals(originalBytes)) {
      return `${originalBytes.length} foreign byte(s) restored exactly`;
    }
    if (!finalBytes.toString("utf8").includes(foreignContent)) {
      throw new Error(
        `gate uninstall changed foreign bytes and did not preserve the foreign `
        + `content verbatim: ${originalBytes.length} byte(s) became `
        + `${finalBytes.length} byte(s)`,
      );
    }
    return `${foreignContent.length} foreign byte(s) preserved verbatim after formatting normalization`;
  },
);

const refuseNonGitCheck: ConformanceCheck = gateCheck(
  "gate.refuse-non-git",
  async (deps): Promise<string> => {
    const repoPath: string = await createRepo(
      deps.context.tempRoot,
      "gate-refuse-non-git",
      false,
    );
    const refusedStatus: GateStatus = await status(
      deps,
      repoPath,
      "gate non-git target",
    );
    if (refusedStatus.state !== "refused") {
      throw new Error(
        `gate non-git status expected "refused", got `
        + JSON.stringify(refusedStatus.state),
      );
    }
    return "target without .git reported terminal refused state";
  },
);

const failOpenCheck: ConformanceCheck = gateCheck(
  "gate.fail-open",
  async (deps): Promise<string> => {
    const repoPath: string = await createRepo(
      deps.context.tempRoot,
      "gate-fail-open",
    );
    const payloads: readonly unknown[] = malformedPayloads(deps);
    for (const kind of deps.descriptor.claimedHookKinds) {
      requireHookKind(kind, "descriptor.claimedHookKinds entry");
      payloads.forEach((payload: unknown, index: number): void => {
        let parsed: GateHookInput | null;
        try {
          parsed = deps.fixtures.adapter.parseHookStdin(kind, payload);
        } catch (error: unknown) {
          throw new Error(
            `gate fail-open parse threw for ${kind} malformed payload `
            + `${index}: ${errorMessage(error)}`,
          );
        }
        if (parsed !== null) {
          throw new Error(
            `gate fail-open parse returned non-null for ${kind} malformed `
            + `payload ${index}`,
          );
        }
      });
    }
    return `${payloads.length} malformed payload(s) failed open across `
      + `${deps.descriptor.claimedHookKinds.length} hook kind(s) in ${repoPath}`;
  },
);

export function gateHookChecks(
  kinds: readonly GateHookKind[],
): readonly ConformanceCheck[] {
  if (!Array.isArray(kinds)) {
    throw new Error("gate hook kinds must be an array");
  }
  return kinds.map((candidate: GateHookKind): ConformanceCheck => {
    const kind: GateHookKind = requireHookKind(candidate, "gate hook kind");
    return gateCheck(
      `gate.hook-round-trip:${kind}`,
      async (deps): Promise<string> => {
        if (!deps.descriptor.claimedHookKinds.includes(kind)) {
          throw new NotApplicableError(
            `gate hook kind ${JSON.stringify(kind)} is unclaimed`,
          );
        }
        const repoPath: string = await createRepo(
          deps.context.tempRoot,
          `gate-hook-round-trip-${kind}`,
        );
        const raw: unknown = fixtureHookStdin(
          deps,
          kind,
          `gate ${kind}`,
        );
        const parsed: GateHookInput = parseHookInput(
          deps,
          kind,
          raw,
          `gate ${kind}`,
        );
        const decision: GateDecision = fixtureDecision(
          deps,
          kind,
          `gate ${kind}`,
        );
        const rendered: string = renderHookOutput(
          deps,
          kind,
          decision,
          `gate ${kind}`,
        );
        validateRenderedOutput(
          deps,
          kind,
          decision,
          rendered,
          `gate ${kind}`,
        );
        return `${parsed.hook} hook round-tripped in ${repoPath}`;
      },
    );
  });
}

export const GATE_CHECKS: readonly ConformanceCheck[] = [
  installCheck,
  installIdempotentCheck,
  uninstallCheck,
  refuseNonGitCheck,
  failOpenCheck,
  ...gateHookChecks(ALL_HOOK_KINDS),
];
