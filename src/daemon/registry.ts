import type {
  InjectAdapter,
  ObserveAdapter,
} from "../adapters/types.ts";
import { ClaudeCodeAdapter } from "../adapters/claude-code/adapter.ts";
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
