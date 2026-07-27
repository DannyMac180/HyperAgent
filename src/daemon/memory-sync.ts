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
  /**
   * Target set captured BEFORE the mutation that triggered this sync.
   *
   * Global-scoped memories render into every target but never create or
   * sustain one. So retiring or rejecting a repo's last approved repo-scoped
   * memory drops that repo out of the target set entirely — and without this,
   * its managed block would keep whatever global bullets it last rendered,
   * forever, because no later sync would ever visit it again. Repos in
   * before-but-not-after are re-rendered to an empty block on this same
   * mutation.
   */
  previousTargets?: string[];
}

export async function syncMemoryTargets(
  options: MemorySyncOptions,
): Promise<InjectionResult[]> {
  const all = options.memoryStore.listMemories();
  const currentTargets = computeTargetRepos(all, options.explicitRepo);
  const currentTargetSet = new Set(currentTargets);

  // Repos that were targets before the mutation but are not any longer.
  const orphanedTargets = (options.previousTargets ?? [])
    .filter((repo: string): boolean => !currentTargetSet.has(repo))
    .sort();
  const orphanedTargetSet = new Set(orphanedTargets);

  const adapters = options.adapters ?? builtinInjectAdapters();

  const results = await Promise.all(
    adapters.map((adapter: InjectAdapter): Promise<InjectionResult[]> =>
      syncTargets(
        [...currentTargets, ...orphanedTargets],
        async (repo: string): Promise<InjectionResult> => {
          // An orphaned repo renders an EMPTY block — never the globals it
          // would otherwise still select. The file is kept, not deleted.
          const selected = orphanedTargetSet.has(repo)
            ? []
            : selectMemoriesForRepo(all, repo, adapter.vendor);
          return adapter.renderInjection(repo, selected);
        },
      )
    ),
  );
  return results.flat();
}
