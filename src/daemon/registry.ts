import type { ObserveAdapter } from "../adapters/types.ts";
import { ClaudeCodeAdapter } from "../adapters/claude-code/adapter.ts";

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
