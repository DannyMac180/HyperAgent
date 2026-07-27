import type { InjectAdapter } from "../adapters/types.ts";
import {
  computeTargetRepos,
  selectMemoriesForRepo,
  syncTargets,
} from "../memory/inject.ts";
import type { InjectionResult } from "../memory/inject.ts";
import type { MemoryStore } from "../memory/store.ts";
import { builtinInjectAdapters } from "./registry.ts";

export interface MemorySyncOptions {
  memoryStore: MemoryStore;
  explicitRepo?: string;
  adapters?: InjectAdapter[];
}

export async function syncMemoryTargets(
  options: MemorySyncOptions,
): Promise<InjectionResult[]> {
  const all = options.memoryStore.listMemories();
  const targets = computeTargetRepos(all, options.explicitRepo);
  const adapters = options.adapters ?? builtinInjectAdapters();

  const results = await Promise.all(
    adapters.map((adapter: InjectAdapter): Promise<InjectionResult[]> =>
      syncTargets(
        targets,
        async (repo: string): Promise<InjectionResult> => {
          const selected = selectMemoriesForRepo(all, repo, adapter.vendor);
          return adapter.renderInjection(repo, selected);
        },
      )
    ),
  );
  return results.flat();
}
