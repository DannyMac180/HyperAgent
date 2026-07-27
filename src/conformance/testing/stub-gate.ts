import {
  mkdir,
  readFile,
  stat,
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
  GateAdapter,
  GateInstallResult,
  GateStatus,
} from "../../adapters/types.ts";
import type {
  GateDecision,
  GateDecisionKind,
  GateHookInput,
  GateHookKind,
} from "../../gate/eval.ts";
import type {
  ConformanceContext,
  ConformanceDescriptor,
  GateFixtureSet,
} from "../types.ts";

export type GateMutation =
  | "none"
  | "install"
  | "install-idempotent"
  | "uninstall"
  | "refuse-non-git"
  | "hook-round-trip"
  | "fail-open";

const GATE_MUTATIONS: readonly GateMutation[] = [
  "none",
  "install",
  "install-idempotent",
  "uninstall",
  "refuse-non-git",
  "hook-round-trip",
  "fail-open",
];
const ALL_HOOK_KINDS: readonly GateHookKind[] = [
  "pre_tool_use",
  "post_tool_use",
  "stop",
];
const DECISION_KINDS: readonly GateDecisionKind[] = [
  "allow",
  "deny",
  "block",
];
const STUB_VENDOR = "stub";
const STUB_ADAPTER_VERSION = "1.0.0";
const STUB_DIALECT_VERSION = "1";
const STUB_ARTIFACT_PATH = [".stub", "gate.json"] as const;
const STUB_HOOKS_KEY = "stubGateHooks";
const STUB_HOOK_OWNER = "hyperagent-stub";
const STUB_FOREIGN_CONTENT = "{\"foreign\":\"preserve-me\"}";
const IO_TIMEOUT_MS = 2_000;

interface StubHookEntry {
  owner: typeof STUB_HOOK_OWNER;
  kind: GateHookKind;
}

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

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
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

function validateDecision(value: unknown, label: string): GateDecision {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be a plain object`);
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

/**
 * Stub IO is deadline-bounded because the conformance core intentionally
 * cannot cancel arbitrary adapter work on behalf of a descriptor.
 */
async function boundedIo<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject): void => {
    timer = setTimeout((): void => {
      reject(new Error(`${label} exceeded ${IO_TIMEOUT_MS}ms`));
    }, IO_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } catch (error: unknown) {
    throw new Error(`${label} failed: ${errorMessage(error)}`);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function pathExists(path: string, label: string): Promise<boolean> {
  try {
    await boundedIo(label, async (): Promise<void> => {
      await stat(path);
    });
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT" || errorMessage(error).includes("ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function readSettings(
  path: string,
): Promise<Record<string, unknown> | null> {
  let contents: string;
  try {
    contents = await boundedIo(
      `stub gate read ${JSON.stringify(path)}`,
      async (): Promise<string> => readFile(path, "utf8"),
    );
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT" || errorMessage(error).includes("ENOENT")) {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error: unknown) {
    throw new Error(
      `stub gate artifact ${JSON.stringify(path)} is invalid JSON: `
      + errorMessage(error),
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `stub gate artifact ${JSON.stringify(path)} must contain a JSON object`,
    );
  }
  return parsed;
}

function isOwnedHookEntry(value: unknown): value is StubHookEntry {
  return (
    isPlainObject(value)
    && value.owner === STUB_HOOK_OWNER
    && typeof value.kind === "string"
    && ALL_HOOK_KINDS.includes(value.kind as GateHookKind)
  );
}

function hookEntries(settings: Record<string, unknown>): unknown[] {
  const value: unknown = settings[STUB_HOOKS_KEY];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`stub gate ${STUB_HOOKS_KEY} must be an array`);
  }
  return [...value];
}

function ownedEntryCount(settings: Record<string, unknown> | null): number {
  if (settings === null) {
    return 0;
  }
  return hookEntries(settings).filter(isOwnedHookEntry).length;
}

function expectedEntry(kind: GateHookKind): StubHookEntry {
  return { owner: STUB_HOOK_OWNER, kind };
}

function hasExpectedEntry(entries: readonly unknown[], kind: GateHookKind): boolean {
  return entries.some(
    (entry: unknown): boolean =>
      isOwnedHookEntry(entry) && entry.kind === kind,
  );
}

async function writeSettings(
  path: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await boundedIo(
    `stub gate mkdir ${JSON.stringify(dirname(path))}`,
    async (): Promise<void> => {
      await mkdir(dirname(path), { recursive: true });
    },
  );
  await boundedIo(
    `stub gate write ${JSON.stringify(path)}`,
    async (): Promise<void> => {
      await writeFile(path, JSON.stringify(settings), "utf8");
    },
  );
}

function parseCanonicalHookInput(
  expectedKind: GateHookKind,
  raw: unknown,
): GateHookInput {
  if (!isPlainObject(raw)) {
    throw new Error("hook stdin must be a plain object");
  }
  const hook: GateHookKind = requireHookKind(raw.hook, "hook stdin hook");
  if (hook !== expectedKind) {
    throw new Error(
      `hook stdin hook expected ${JSON.stringify(expectedKind)}, got `
      + JSON.stringify(hook),
    );
  }
  const input: GateHookInput = {
    hook,
    harness: requireString(raw.harness, "hook stdin harness"),
    sessionId: requireNonEmptyString(raw.sessionId, "hook stdin sessionId"),
    cwd: requireNonEmptyString(raw.cwd, "hook stdin cwd"),
    toolName: requireString(raw.toolName, "hook stdin toolName"),
    command: requireString(raw.command, "hook stdin command"),
    readPaths: requireStringArray(raw.readPaths, "hook stdin readPaths"),
    writePaths: requireStringArray(raw.writePaths, "hook stdin writePaths"),
  };
  if (raw.toolPassed !== undefined) {
    if (typeof raw.toolPassed !== "boolean") {
      throw new Error("hook stdin toolPassed must be a boolean when supplied");
    }
    input.toolPassed = raw.toolPassed;
  }
  if (raw.stopHookActive !== undefined) {
    if (typeof raw.stopHookActive !== "boolean") {
      throw new Error(
        "hook stdin stopHookActive must be a boolean when supplied",
      );
    }
    input.stopHookActive = raw.stopHookActive;
  }
  return input;
}

class StubGateAdapter implements GateAdapter {
  public readonly vendor = STUB_VENDOR;
  private suppressNextInstall: boolean;

  public constructor(
    private readonly tempRoot: string,
    private readonly mutation: GateMutation,
  ) {
    /**
     * Install and idempotency both call install. Consuming this mutation once
     * keeps the negative control specific to the first fixed install check.
     */
    this.suppressNextInstall = mutation === "install";
  }

  private repoPath(value: unknown): string {
    return requirePathUnder(value, this.tempRoot, "stub gate repoPath");
  }

  private artifactPath(repoPath: string): string {
    return join(repoPath, ...STUB_ARTIFACT_PATH);
  }

  private async hasGit(repoPath: string): Promise<boolean> {
    return pathExists(
      join(repoPath, ".git"),
      `stub gate inspect .git under ${JSON.stringify(repoPath)}`,
    );
  }

  public async install(targetRepo: string): Promise<GateInstallResult> {
    const repoPath: string = this.repoPath(targetRepo);
    const targetPath: string = this.artifactPath(repoPath);
    if (!(await this.hasGit(repoPath))) {
      return {
        targetPath,
        changed: false,
        reason: "Refused target without a .git entry.",
      };
    }
    if (this.suppressNextInstall) {
      this.suppressNextInstall = false;
      return { targetPath, changed: false };
    }

    const settings: Record<string, unknown> =
      (await readSettings(targetPath)) ?? {};
    const entries: unknown[] = hookEntries(settings);
    if (
      this.mutation === "install-idempotent"
      && entries.some(isOwnedHookEntry)
    ) {
      settings[STUB_HOOKS_KEY] = [
        ...entries,
        expectedEntry("pre_tool_use"),
      ];
      await writeSettings(targetPath, settings);
      return { targetPath, changed: true };
    }

    const nextEntries: unknown[] = [...entries];
    for (const kind of ALL_HOOK_KINDS) {
      if (!hasExpectedEntry(nextEntries, kind)) {
        nextEntries.push(expectedEntry(kind));
      }
    }
    const changed: boolean = nextEntries.length !== entries.length;
    if (changed) {
      settings[STUB_HOOKS_KEY] = nextEntries;
      await writeSettings(targetPath, settings);
    }
    return { targetPath, changed };
  }

  public async uninstall(targetRepo: string): Promise<GateInstallResult> {
    const repoPath: string = this.repoPath(targetRepo);
    const targetPath: string = this.artifactPath(repoPath);
    const settings: Record<string, unknown> | null =
      await readSettings(targetPath);
    if (settings === null) {
      return { targetPath, changed: false };
    }
    if (this.mutation === "uninstall") {
      await boundedIo(
        `stub gate truncate ${JSON.stringify(targetPath)}`,
        async (): Promise<void> => {
          await writeFile(targetPath, "", "utf8");
        },
      );
      return { targetPath, changed: true };
    }

    const entries: unknown[] = hookEntries(settings);
    const foreignEntries: unknown[] = entries.filter(
      (entry: unknown): boolean => !isOwnedHookEntry(entry),
    );
    const changed: boolean = foreignEntries.length !== entries.length;
    if (changed) {
      if (foreignEntries.length === 0) {
        delete settings[STUB_HOOKS_KEY];
      } else {
        settings[STUB_HOOKS_KEY] = foreignEntries;
      }
      await writeSettings(targetPath, settings);
    }
    return { targetPath, changed };
  }

  public async status(targetRepo: string): Promise<GateStatus> {
    const repoPath: string = this.repoPath(targetRepo);
    const targetPath: string = this.artifactPath(repoPath);
    if (!(await this.hasGit(repoPath))) {
      return {
        state: this.mutation === "refuse-non-git"
          ? "not-installed"
          : "refused",
        targetPath,
        ownedEntries: 0,
        detail: "Target has no .git entry.",
      };
    }

    const settings: Record<string, unknown> | null =
      await readSettings(targetPath);
    const ownedEntries: number = ownedEntryCount(settings);
    return {
      state: ownedEntries > 0
        ? "installed"
        : settings === null
        ? "not-installed"
        : "foreign",
      targetPath,
      ownedEntries,
      detail: ownedEntries > 0
        ? `${ownedEntries} stub-owned hook entry(s).`
        : "No stub-owned hook entries.",
    };
  }

  public parseHookStdin(
    hook: GateHookKind,
    raw: unknown,
  ): GateHookInput | null {
    let kind: GateHookKind;
    try {
      kind = requireHookKind(hook, "stub gate hook");
      return parseCanonicalHookInput(kind, raw);
    } catch (error: unknown) {
      if (this.mutation === "fail-open") {
        throw new Error(
          `fail-open mutant rejected malformed hook stdin: `
          + errorMessage(error),
        );
      }
      return null;
    }
  }

  public renderHookOutput(
    hook: GateHookKind,
    rawDecision: GateDecision,
  ): string {
    const kind: GateHookKind = requireHookKind(hook, "stub gate hook");
    const decision: GateDecision = validateDecision(
      rawDecision,
      "stub gate decision",
    );
    /**
     * The hook-round-trip mutant is intentionally limited to post_tool_use so
     * exactly that per-kind conformance row fails.
     */
    if (this.mutation === "hook-round-trip" && kind === "post_tool_use") {
      return JSON.stringify({ wrongShape: true });
    }
    return JSON.stringify({
      stubGate: {
        hook: kind,
        decision,
      },
    });
  }
}

function hookStdin(
  kind: GateHookKind,
  tempRoot: string,
): GateHookInput {
  const input: GateHookInput = {
    hook: kind,
    harness: STUB_VENDOR,
    sessionId: "stub:gate-session",
    cwd: join(tempRoot, "fixture-repo"),
    toolName: kind === "stop" ? "" : "Bash",
    command: kind === "stop" ? "" : "printf stub",
    readPaths: [join(tempRoot, "fixture-repo", "input.txt")],
    writePaths: [join(tempRoot, "fixture-repo", "output.txt")],
  };
  if (kind === "post_tool_use") {
    input.toolPassed = true;
  }
  if (kind === "stop") {
    input.stopHookActive = false;
  }
  return input;
}

function decisionFor(kind: GateHookKind): GateDecision {
  if (kind === "pre_tool_use") {
    return {
      kind: "deny",
      reason: "Stub pre-tool policy denied the command.",
      matchedRules: ["stub.pre"],
      failedChecks: ["stub-pre-check"],
    };
  }
  if (kind === "stop") {
    return {
      kind: "block",
      reason: "Stub stop policy requires another pass.",
      matchedRules: ["stub.stop"],
      failedChecks: ["stub-stop-check"],
    };
  }
  return {
    kind: "allow",
    matchedRules: [],
    failedChecks: [],
  };
}

function validateHookOutput(
  expectedKind: GateHookKind,
  expectedDecision: GateDecision,
  rendered: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered) as unknown;
  } catch (error: unknown) {
    return `output was not JSON: ${errorMessage(error)}`;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.stubGate)) {
    return "output must contain a stubGate object";
  }
  if (parsed.stubGate.hook !== expectedKind) {
    return `stubGate.hook did not equal ${JSON.stringify(expectedKind)}`;
  }
  try {
    const actualDecision: GateDecision = validateDecision(
      parsed.stubGate.decision,
      "rendered stubGate.decision",
    );
    if (
      JSON.stringify(actualDecision)
      !== JSON.stringify(validateDecision(expectedDecision, "expected decision"))
    ) {
      return "stubGate.decision did not preserve the supplied decision";
    }
  } catch (error: unknown) {
    return errorMessage(error);
  }
  return null;
}

function validateClaimedHookKinds(
  kinds: readonly GateHookKind[],
): readonly GateHookKind[] {
  if (!Array.isArray(kinds)) {
    throw new Error("stub gate claimed hook kinds must be an array");
  }
  const validated: GateHookKind[] = kinds.map(
    (kind: GateHookKind, index: number): GateHookKind =>
      requireHookKind(kind, `stub gate claimed hook kinds[${index}]`),
  );
  if (new Set(validated).size !== validated.length) {
    throw new Error("stub gate claimed hook kinds must not contain duplicates");
  }
  return validated;
}

function createGateFixtures(
  context: ConformanceContext,
  mutation: GateMutation,
): GateFixtureSet {
  const tempRoot: string = requirePathUnder(
    context.tempRoot,
    context.tempRoot,
    "context.tempRoot",
  );
  return {
    adapter: new StubGateAdapter(tempRoot, mutation),
    managedArtifactPath(repoPath: string): string {
      const validatedRepoPath: string = requirePathUnder(
        repoPath,
        tempRoot,
        "managedArtifactPath repoPath",
      );
      return join(validatedRepoPath, ...STUB_ARTIFACT_PATH);
    },
    foreignContent: STUB_FOREIGN_CONTENT,
    hookStdin(kind: GateHookKind): unknown {
      return hookStdin(requireHookKind(kind, "fixture hook kind"), tempRoot);
    },
    decisionFor(kind: GateHookKind): GateDecision {
      return decisionFor(requireHookKind(kind, "fixture decision kind"));
    },
    validateHookOutput(
      kind: GateHookKind,
      decision: GateDecision,
      rendered: string,
    ): string | null {
      return validateHookOutput(
        requireHookKind(kind, "fixture validation kind"),
        validateDecision(decision, "fixture validation decision"),
        requireString(rendered, "fixture rendered output"),
      );
    },
    malformedHookStdin(): readonly unknown[] {
      return [
        null,
        [],
        {},
        {
          hook: "pre_tool_use",
          harness: STUB_VENDOR,
          sessionId: "",
          cwd: tempRoot,
          toolName: "Bash",
          command: "printf stub",
          readPaths: [],
          writePaths: [],
        },
      ];
    },
  };
}

export function createStubGateDescriptorWithHookKinds(
  kinds: readonly GateHookKind[],
  mutation: GateMutation = "none",
): ConformanceDescriptor {
  if (!GATE_MUTATIONS.includes(mutation)) {
    throw new Error(`unsupported gate mutation: ${String(mutation)}`);
  }
  const claimedHookKinds: readonly GateHookKind[] =
    validateClaimedHookKinds(kinds);
  return {
    vendor: STUB_VENDOR,
    adapterVersion: STUB_ADAPTER_VERSION,
    dialectVersion: STUB_DIALECT_VERSION,
    claimed: {
      observe: false,
      inject: false,
      gate: true,
    },
    storageTraits: { appendOnlyLines: false },
    claimedHookKinds,
    forbiddenTargetPatterns: [],
    factories: {
      async gate(context: ConformanceContext): Promise<GateFixtureSet> {
        return createGateFixtures(context, mutation);
      },
    },
  };
}

export function createStubGateDescriptor(
  mutation: GateMutation,
): ConformanceDescriptor {
  return createStubGateDescriptorWithHookKinds(ALL_HOOK_KINDS, mutation);
}
