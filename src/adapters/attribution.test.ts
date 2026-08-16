import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AttributionEvidence,
  makeDefaultGitRootResolver,
  type GitRootResolver,
} from "./attribution.ts";

/** Stub resolver: any path under a listed root maps to that root. */
function stubResolver(roots: string[]): GitRootResolver {
  return (dir: string): string | null => {
    for (const root of roots) {
      if (dir === root || dir.startsWith(`${root}/`)) {
        return root;
      }
    }
    return null;
  };
}

const VIDEOEDIT = "/home/u/dev/videoedit";
const PAI = "/home/u/.claude";

describe("AttributionEvidence.deriveRepo", () => {
  test("home-launched session attributes to the dominant mutation root", () => {
    // The f95444fa shape: cwd = home (no repo), doctrine reads in ~/.claude,
    // the real work mutating files in videoedit.
    const evidence = new AttributionEvidence(stubResolver([VIDEOEDIT, PAI]));
    evidence.addCwd("/home/u");
    evidence.addTouch(`${PAI}/PAI/ALGORITHM/LATEST`, false);
    evidence.addTouch(`${PAI}/PAI/ALGORITHM/v6.md`, false);
    for (let i = 0; i < 5; i++) {
      evidence.addTouch(`${VIDEOEDIT}/src/file${i}.ts`, true);
    }
    expect(evidence.deriveRepo()).toBe(VIDEOEDIT);
  });

  test("cwd inside a repo, no touches, resolves to the git root", () => {
    const evidence = new AttributionEvidence(stubResolver([VIDEOEDIT]));
    evidence.addCwd(`${VIDEOEDIT}/packages/overlay`);
    expect(evidence.deriveRepo()).toBe(VIDEOEDIT);
  });

  test("no derivable root returns null, never the cwd", () => {
    const evidence = new AttributionEvidence(stubResolver([]));
    evidence.addCwd("/home/u");
    evidence.addTouch("/tmp/scratch/notes.md", false);
    expect(evidence.deriveRepo()).toBeNull();
  });

  test("split evidence with no majority falls back to the cwd root", () => {
    const other = "/home/u/dev/other";
    const evidence = new AttributionEvidence(
      stubResolver([VIDEOEDIT, other, PAI]),
    );
    evidence.addCwd(`${PAI}/somewhere`);
    // Equal mutation weight in two repos — neither holds a strict majority
    // once the cwd weight is counted; guessing either would be a lie.
    evidence.addTouch(`${VIDEOEDIT}/a.ts`, true);
    evidence.addTouch(`${other}/b.ts`, true);
    expect(evidence.deriveRepo()).toBe(PAI);
  });

  test("split evidence with no majority and no cwd root returns null", () => {
    const other = "/home/u/dev/other";
    const evidence = new AttributionEvidence(stubResolver([VIDEOEDIT, other]));
    evidence.addCwd("/home/u");
    evidence.addTouch(`${VIDEOEDIT}/a.ts`, true);
    evidence.addTouch(`${other}/b.ts`, true);
    expect(evidence.deriveRepo()).toBeNull();
  });

  test("mid-session cwd move into a repo counts as evidence", () => {
    const evidence = new AttributionEvidence(stubResolver([VIDEOEDIT]));
    evidence.addCwd("/home/u");
    evidence.addCwd(VIDEOEDIT);
    evidence.addTouch(`${VIDEOEDIT}/src/edl.ts`, true);
    expect(evidence.deriveRepo()).toBe(VIDEOEDIT);
  });

  test("repeated identical cwd lines count once", () => {
    // A thousand lines sitting in ~/.claude must not outweigh real mutations.
    const evidence = new AttributionEvidence(stubResolver([VIDEOEDIT, PAI]));
    for (let i = 0; i < 1000; i++) {
      evidence.addCwd(PAI);
    }
    evidence.addTouch(`${VIDEOEDIT}/a.ts`, true);
    evidence.addTouch(`${VIDEOEDIT}/b.ts`, true);
    expect(evidence.deriveRepo()).toBe(VIDEOEDIT);
  });

  test("read-heavy noise does not outvote mutations", () => {
    const evidence = new AttributionEvidence(stubResolver([VIDEOEDIT, PAI]));
    evidence.addCwd("/home/u");
    for (let i = 0; i < 4; i++) {
      evidence.addTouch(`${PAI}/doc${i}.md`, false);
    }
    for (let i = 0; i < 2; i++) {
      evidence.addTouch(`${VIDEOEDIT}/src/f${i}.ts`, true);
    }
    expect(evidence.deriveRepo()).toBe(VIDEOEDIT);
  });

  test("empty evidence returns null", () => {
    const evidence = new AttributionEvidence(stubResolver([VIDEOEDIT]));
    expect(evidence.deriveRepo()).toBeNull();
  });
});

describe("AttributionEvidence honesty guards", () => {
  test("unattributed evidence votes in the denominator, so a lone stray write cannot win", () => {
    // The advisor's case: forty reads outside any repo, one mutation inside
    // one. Counting only resolved evidence would make that single write 100%
    // of the vote; counting the unattributed side keeps it honest.
    const evidence = new AttributionEvidence(stubResolver([PAI]));
    evidence.addCwd("/home/u/Documents");
    for (let i = 0; i < 40; i++) {
      evidence.addTouch(`/home/u/Documents/note${i}.md`, false);
    }
    evidence.addTouch(`${PAI}/settings.json`, true);
    expect(evidence.deriveRepo()).toBeNull();
  });

  test("one file hammered repeatedly votes once, at its strongest weight", () => {
    const other = "/home/u/dev/other";
    const evidence = new AttributionEvidence(stubResolver([VIDEOEDIT, other]));
    // 25 edits to a single file must not outweigh broader work elsewhere.
    for (let i = 0; i < 25; i++) {
      evidence.addTouch(`${VIDEOEDIT}/src/hot.ts`, true);
    }
    for (let i = 0; i < 5; i++) {
      evidence.addTouch(`${other}/src/f${i}.ts`, true);
    }
    expect(evidence.deriveRepo()).toBe(other);
  });

  test("a path read then mutated upgrades rather than double-counting", () => {
    const evidence = new AttributionEvidence(stubResolver([VIDEOEDIT]));
    evidence.addTouch(`${VIDEOEDIT}/a.ts`, false);
    evidence.addTouch(`${VIDEOEDIT}/a.ts`, true);
    // Weight 3 (mutation), not 1 + 3: one path, one vote.
    const single = new AttributionEvidence(stubResolver([VIDEOEDIT]));
    single.addTouch(`${VIDEOEDIT}/a.ts`, true);
    expect(evidence.deriveRepo()).toBe(single.deriveRepo());
  });

  test("excluded agent-state paths are instrument noise, not evidence", () => {
    // A version-controlled ~/.claude would otherwise win the majority on
    // every read-heavy session and attribute them all to the dotfiles repo.
    const evidence = new AttributionEvidence(stubResolver([PAI, VIDEOEDIT]), [
      PAI,
    ]);
    evidence.addCwd("/home/u");
    for (let i = 0; i < 10; i++) {
      evidence.addTouch(`${PAI}/PAI/MEMORY/WORK/isa${i}.md`, true);
    }
    evidence.addTouch(`${VIDEOEDIT}/src/a.ts`, true);
    evidence.addTouch(`${VIDEOEDIT}/src/b.ts`, true);
    expect(evidence.deriveRepo()).toBe(VIDEOEDIT);
  });
});

describe("makeDefaultGitRootResolver against a real filesystem", () => {
  const roots: string[] = [];
  const makeRoot = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "attribution-fs-"));
    roots.push(dir);
    return realpathSync(dir);
  };

  afterAll((): void => {
    for (const dir of roots.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("finds the root from a nested directory via a .git directory", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    expect(makeDefaultGitRootResolver()(join(root, "src", "deep"))).toBe(root);
  });

  test("accepts a .git FILE, so a submodule attributes to itself", () => {
    // Submodules and worktrees carry a gitdir pointer file, not a directory.
    // Rejecting it would silently attribute submodule work to the superproject.
    const root = makeRoot();
    mkdirSync(join(root, ".git"));
    const sub = join(root, "open");
    mkdirSync(join(sub, "src"), { recursive: true });
    writeFileSync(join(sub, ".git"), "gitdir: ../.git/modules/open\n");
    expect(makeDefaultGitRootResolver()(join(sub, "src"))).toBe(sub);
  });

  test("returns null outside any repo", () => {
    const root = makeRoot();
    mkdirSync(join(root, "plain"), { recursive: true });
    expect(makeDefaultGitRootResolver()(join(root, "plain"))).toBeNull();
  });

  test("a symlinked path resolves to the same root as the real path", () => {
    // Without canonicalization the repo splits its own vote across two names
    // and can lose the majority it should have won.
    const root = makeRoot();
    mkdirSync(join(root, "repo", "src"), { recursive: true });
    mkdirSync(join(root, "repo", ".git"));
    const link = join(root, "link");
    symlinkSync(join(root, "repo"), link);
    const resolver = makeDefaultGitRootResolver();
    expect(resolver(join(link, "src"))).toBe(resolver(join(root, "repo", "src")));
  });

  test("a missing directory degrades to lexical resolution, never throws", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".git"));
    expect(makeDefaultGitRootResolver()(join(root, "gone", "deeper"))).toBe(root);
  });
});
