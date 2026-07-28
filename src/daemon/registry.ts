import type {
  GateAdapter,
  InjectAdapter,
  ObserveAdapter,
} from "../adapters/types.ts";
import { ClaudeCodeAdapter } from "../adapters/claude-code/adapter.ts";
import { ClaudeCodeGateAdapter } from "../adapters/claude-code/gate.ts";
import { ClaudeCodeInjectAdapter } from "../adapters/claude-code/inject.ts";
import { CodexAdapter } from "../adapters/codex/adapter.ts";
import { CodexInjectAdapter } from "../adapters/codex/inject.ts";

export interface BuiltinAdapterOptions {
  claudeProjectsRoot?: string;
}

export function builtinAdapters(
  options?: BuiltinAdapterOptions,
): ObserveAdapter[] {
  return [
    new ClaudeCodeAdapter({
      projectsRoot: options?.claudeProjectsRoot,
    }),
    new CodexAdapter(),
  ];
}

export function builtinAdaptersForProjectsRoot(
  projectsRoot?: string,
): ObserveAdapter[] {
  return builtinAdapters({ claudeProjectsRoot: projectsRoot });
}

export function builtinInjectAdapters(): InjectAdapter[] {
  return [
    new ClaudeCodeInjectAdapter(),
    new CodexInjectAdapter(),
  ];
}

export interface BuiltinGateAdapterOptions {
  dataDir?: string;
  /** Overrides the home directory used for refusal checks (tests). */
  homeDir?: string;
}

/**
 * Gate adapters are constructed here for the same reason observe and inject
 * adapters are: the daemon and the CLI must never name a vendor. Adding a
 * harness means adding a line to this registry, not editing the daemon.
 */
export function builtinGateAdapters(
  options: BuiltinGateAdapterOptions = {},
): GateAdapter[] {
  return [
    new ClaudeCodeGateAdapter({
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    }),
  ];
}

/** The gate adapter a `--harness` value selects, or undefined when unknown. */
export function gateAdapterForHarness(
  harness: string,
  options: BuiltinGateAdapterOptions = {},
): GateAdapter | undefined {
  return builtinGateAdapters(options).find(
    (adapter: GateAdapter): boolean => adapter.vendor === harness,
  );
}

/** Vendor slugs a `--harness` flag accepts, for usage and error text. */
export function gateHarnessNames(): string[] {
  return builtinGateAdapters().map(
    (adapter: GateAdapter): string => adapter.vendor,
  );
}
