/**
 * Session → repo attribution (DAN-225).
 *
 * schema.md defines `session_start.repo` as the git ROOT path, distinct from
 * `cwd` — but a session launched from the home directory (skill-driven work,
 * ad-hoc chats) has a cwd that names no repo at all, while its actual subject
 * is visible in the evidence: the working directory the harness moved into
 * mid-session and the files its tools touched. This module turns that
 * evidence into an honest attribution.
 *
 * Honesty contract: a wrong repo is worse than no repo. The derivation picks
 * a repo only when one git root holds a strict majority of the weighted
 * evidence; otherwise it falls back to the git root of the session's own cwd;
 * otherwise it returns null, and downstream surfaces render a deliberate
 * "no repo" state instead of a home-directory name.
 *
 * Git-root resolution touches the live filesystem, so it is injected: the
 * daemon uses `defaultGitRootResolver`, tests and conformance pass a stub —
 * fixture parses must stay byte-deterministic on any machine.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Maps an absolute directory to its git root, or null when outside any repo. */
export type GitRootResolver = (dir: string) => string | null;

const WEIGHT_MUTATION = 3;
const WEIGHT_READ = 1;
const WEIGHT_CWD = 2;

/**
 * Walk up from `dir` looking for a `.git` entry (directory for a normal
 * checkout, file for a worktree/submodule). Memoize per instance — a session
 * touches the same few directories thousands of times.
 */
export function makeDefaultGitRootResolver(): GitRootResolver {
  const cache = new Map<string, string | null>();
  return (dir: string): string | null => {
    const start: string = resolve(dir);
    const hit: string | null | undefined = cache.get(start);
    if (hit !== undefined) {
      return hit;
    }
    const visited: string[] = [];
    let current: string = start;
    let root: string | null = null;
    for (;;) {
      const cached: string | null | undefined = cache.get(current);
      if (cached !== undefined) {
        root = cached;
        break;
      }
      visited.push(current);
      if (existsSync(`${current}/.git`)) {
        root = current;
        break;
      }
      const parent: string = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    for (const dir of visited) {
      cache.set(dir, root);
    }
    return root;
  };
}

/**
 * Evidence accumulated over one full parse pass. Weighted scores per resolved
 * git root; cwds are counted once per distinct value so a long session in one
 * directory doesn't drown its file-touch signal.
 */
export class AttributionEvidence {
  private readonly resolver: GitRootResolver;
  private readonly scores = new Map<string, number>();
  private readonly seenCwds = new Set<string>();
  private firstCwd: string | undefined;

  constructor(resolver: GitRootResolver) {
    this.resolver = resolver;
  }

  /** Record a working directory the session occupied (absolute path). */
  addCwd(cwd: string): void {
    if (this.firstCwd === undefined) {
      this.firstCwd = cwd;
    }
    if (this.seenCwds.has(cwd)) {
      return;
    }
    this.seenCwds.add(cwd);
    const root: string | null = this.resolver(cwd);
    if (root !== null) {
      this.scores.set(root, (this.scores.get(root) ?? 0) + WEIGHT_CWD);
    }
  }

  /**
   * Record a file the session touched (absolute path). Mutations (write/edit)
   * weigh 3× reads: what a session changed is a far stronger subject signal
   * than what it merely looked at — skill-driven sessions read doctrine files
   * far from the repo they are actually working on.
   */
  addTouch(absolutePath: string, mutation: boolean): void {
    const root: string | null = this.resolver(dirname(resolve(absolutePath)));
    if (root === null) {
      return;
    }
    const weight: number = mutation ? WEIGHT_MUTATION : WEIGHT_READ;
    this.scores.set(root, (this.scores.get(root) ?? 0) + weight);
  }

  /**
   * The honest derivation. A root wins only with a strict majority of the
   * weighted evidence — a session split between two repos names neither and
   * falls back. Fallback is the git root of the session's own first cwd;
   * when that resolves to nothing, null is the truthful answer.
   */
  deriveRepo(): string | null {
    let best: string | null = null;
    let bestScore = 0;
    let total = 0;
    for (const [root, score] of this.scores) {
      total += score;
      if (
        score > bestScore ||
        (score === bestScore && best !== null && root < best)
      ) {
        best = root;
        bestScore = score;
      }
    }
    if (best !== null && bestScore * 2 > total) {
      return best;
    }
    if (this.firstCwd !== undefined) {
      return this.resolver(this.firstCwd);
    }
    return null;
  }
}
