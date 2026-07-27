import type {
  GateAdapter,
  InjectAdapter,
  ObserveAdapter,
} from "../adapters/types.ts";
import { ClaudeCodeAdapter } from "../adapters/claude-code/adapter.ts";
import { ClaudeCodeGateAdapter } from "../adapters/claude-code/gate.ts";
import { ClaudeCodeInjectAdapter } from "../adapters/claude-code/inject.ts";

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
  ];
}

export function builtinAdaptersForProjectsRoot(
  projectsRoot?: string,
): ObserveAdapter[] {
  return builtinAdapters({ claudeProjectsRoot: projectsRoot });
}

export function builtinInjectAdapters(): InjectAdapter[] {
  return [new ClaudeCodeInjectAdapter()];
}

export interface BuiltinGateAdapterOptions {
  dataDir?: string;
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
    new ClaudeCodeGateAdapter(
      options.dataDir === undefined ? {} : { dataDir: options.dataDir },
    ),
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
