import { describe, expect, test } from "bun:test";

import {
  AttributionEvidence,
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
