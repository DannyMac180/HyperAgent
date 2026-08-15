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

import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Maps an absolute directory to its git root, or null when outside any repo. */
export type GitRootResolver = (dir: string) => string | null;

const WEIGHT_MUTATION = 3;
const WEIGHT_READ = 1;
const WEIGHT_CWD = 2;

/**
 * Walk up from `dir` looking for a `.git` entry, and stop at the FIRST one.
 * A worktree or submodule checkout has a `.git` *file* (a gitdir pointer)
 * rather than a directory, and this accepts both — so a session working
 * inside a submodule attributes to the submodule, not to the superproject.
 * That is the deliberate choice: the submodule is a different repository with
 * its own history and, in this codebase's case, its own licence.
 *
 * Paths are canonicalized through realpath first: the same repo reached via a
 * symlink and via its real path would otherwise split its own vote and lose
 * the majority it should have won. Memoized per instance — a session touches
 * the same few directories thousands of times.
 */
export function makeDefaultGitRootResolver(): GitRootResolver {
  const cache = new Map<string, string | null>();
  return (dir: string): string | null => {
    let start: string;
    try {
      start = realpathSync(dir);
    } catch {
      // The directory may be gone by the time we look (temp dirs, deleted
      // checkouts). Fall back to lexical resolution rather than losing the
      // evidence entirely.
      start = resolve(dir);
    }
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
  private readonly excludedPrefixes: readonly string[];
  private readonly scores = new Map<string, number>();
  private readonly seenCwds = new Set<string>();
  /**
   * Weight of TOUCH evidence that resolved to no git root. It votes in the
   * majority denominator rather than being discarded: a session reading forty
   * files outside any repo and mutating one file inside one must not have that
   * single mutation crowned as 100% of the evidence. Ignoring the unattributed
   * side is what turns a lone stray write into a confident wrong answer.
   *
   * A repo-less *cwd* is deliberately NOT counted here. Work outside a repo is
   * a competing signal; launching from the home directory is the absence of a
   * signal — and attributing those sessions by their other evidence is the
   * whole point of this module. Counting the home cwd against the tally would
   * re-strand exactly the sessions it exists to rescue.
   */
  private unattributed = 0;
  /** Distinct paths already counted, so one file edited 25 times votes once. */
  private readonly seenTouches = new Map<string, number>();
  private firstCwd: string | undefined;

  constructor(resolver: GitRootResolver, excludedPrefixes: readonly string[] = []) {
    this.resolver = resolver;
    this.excludedPrefixes = excludedPrefixes;
  }

  /**
   * Instrument noise, not subject: the harness's own state directory (and the
   * suit's data dir) receive writes on every session regardless of what the
   * session was about — todos, memory files, settings. Left in the tally, a
   * version-controlled `~/.claude` would win the majority on read-heavy
   * sessions and attribute them all to the dotfiles repo.
   */
  private excluded(path: string): boolean {
    return this.excludedPrefixes.some(
      (prefix: string): boolean =>
        path === prefix || path.startsWith(`${prefix}/`),
    );
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
    if (this.excluded(resolve(cwd))) {
      return;
    }
    const root: string | null = this.resolver(cwd);
    if (root === null) {
      // Absence of a signal, not a competing one — see `unattributed`.
      return;
    }
    this.scores.set(root, (this.scores.get(root) ?? 0) + WEIGHT_CWD);
  }

  /**
   * Record a file the session touched (absolute path). Mutations (write/edit)
   * weigh 3× reads: what a session changed is a far stronger subject signal
   * than what it merely looked at — skill-driven sessions read doctrine files
   * far from the repo they are actually working on. Each distinct path votes
   * once, at its strongest observed weight, so hammering one file cannot
   * outweigh broader work elsewhere.
   */
  addTouch(absolutePath: string, mutation: boolean): void {
    const full: string = resolve(absolutePath);
    if (this.excluded(full)) {
      return;
    }
    const weight: number = mutation ? WEIGHT_MUTATION : WEIGHT_READ;
    const previous: number = this.seenTouches.get(full) ?? 0;
    if (weight <= previous) {
      return;
    }
    this.seenTouches.set(full, weight);
    // Only the increment lands, so a path already counted as a read and later
    // mutated is upgraded rather than double-counted.
    const delta: number = weight - previous;
    const root: string | null = this.resolver(dirname(full));
    if (root === null) {
      this.unattributed += delta;
      return;
    }
    this.scores.set(root, (this.scores.get(root) ?? 0) + delta);
  }

  /**
   * The honest derivation. A root wins only with a strict majority of ALL
   * weighted evidence, including evidence that belongs to no repo — a session
   * split between two repos, or mostly spent outside any repo, names neither
   * and falls back. Fallback is the git root of the session's own first cwd;
   * when that resolves to nothing, null is the truthful answer.
   */
  deriveRepo(): string | null {
    let best: string | null = null;
    let bestScore = 0;
    let total = this.unattributed;
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
