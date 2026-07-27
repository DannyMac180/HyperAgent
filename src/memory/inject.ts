import {
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  join,
  resolve,
  sep,
} from "node:path";

import type { MemoryRow } from "./store.ts";

export const MEMORY_BLOCK_BEGIN = "<!-- hyperagent:memory:begin -->";
export const MEMORY_BLOCK_END = "<!-- hyperagent:memory:end -->";

const MEMORY_BLOCK_WARNING =
  "<!-- managed by hyperagent — edits here are overwritten -->";

export interface InjectionResult {
  targetPath: string;
  changed: boolean;
  /** Populated when injection was refused, failed, or intentionally skipped. */
  reason?: string;
}

export type BlockEditResult =
  | { ok: true; content: string }
  | { ok: false; reason: string };

export type TargetValidation =
  | { ok: true; repoPath: string }
  | { ok: false; reason: string };

interface MarkerLine {
  kind: "begin" | "end";
  start: number;
  contentEnd: number;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

export function selectMemoriesForRepo(
  all: MemoryRow[],
  repoPath: string,
  vendor: string,
): MemoryRow[] {
  return all
    .filter((memory: MemoryRow): boolean => {
      if (memory.status !== "approved") {
        return false;
      }
      if (memory.scope === "global") {
        return true;
      }
      if (memory.scope === "repo") {
        return memory.scope_key === repoPath;
      }
      return memory.scope === "agent" && memory.scope_key === vendor;
    })
    .sort((left: MemoryRow, right: MemoryRow): number => {
      const scopeOrder = compareText(left.scope, right.scope);
      return scopeOrder !== 0 ? scopeOrder : compareText(left.id, right.id);
    });
}

export function computeTargetRepos(
  all: MemoryRow[],
  explicitRepo?: string,
): string[] {
  const targets = new Set<string>();

  for (const memory of all) {
    if (
      memory.status === "approved"
      && memory.scope === "repo"
      && typeof memory.scope_key === "string"
      && memory.scope_key.length > 0
    ) {
      targets.add(memory.scope_key);
    }
  }

  if (explicitRepo !== undefined) {
    targets.add(explicitRepo);
  }

  // Global memories join each target's block but deliberately do not create
  // targets: without a repo-scoped memory or explicit repo there is no fanout.
  return [...targets].sort(compareText);
}

function findMarkerLines(content: string): MarkerLine[] {
  const markers: MarkerLine[] = [];
  let lineStart = 0;

  while (lineStart <= content.length) {
    const newlineIndex = content.indexOf("\n", lineStart);
    const contentEnd = newlineIndex === -1 ? content.length : newlineIndex;
    const rawLine = content.slice(lineStart, contentEnd);
    const comparableLine = rawLine.trimEnd();

    if (comparableLine === MEMORY_BLOCK_BEGIN) {
      markers.push({ kind: "begin", start: lineStart, contentEnd });
    } else if (comparableLine === MEMORY_BLOCK_END) {
      markers.push({ kind: "end", start: lineStart, contentEnd });
    }

    if (newlineIndex === -1) {
      break;
    }
    lineStart = newlineIndex + 1;
  }

  return markers;
}

function renderManagedBlock(blockBody: string): string {
  const normalizedBody = blockBody.replace(/\r\n?/gu, "\n").replace(/\n+$/u, "");
  const lines = [
    MEMORY_BLOCK_BEGIN,
    MEMORY_BLOCK_WARNING,
  ];
  if (normalizedBody.length > 0) {
    lines.push(normalizedBody);
  }
  lines.push(MEMORY_BLOCK_END);
  return lines.join("\n");
}

export function applyManagedBlock(
  existingContent: string,
  blockBody: string,
): BlockEditResult {
  const markers = findMarkerLines(existingContent);
  const begins = markers.filter(
    (marker: MarkerLine): boolean => marker.kind === "begin",
  );
  const ends = markers.filter(
    (marker: MarkerLine): boolean => marker.kind === "end",
  );

  if (begins.length === 0 && ends.length === 0) {
    const managedBlock = renderManagedBlock(blockBody);
    if (existingContent.length === 0) {
      return { ok: true, content: managedBlock };
    }

    const hasTrailingBlankLine = /(?:\r?\n){2}$/u.test(existingContent);
    const endsInNewline = existingContent.endsWith("\n");
    const separator = hasTrailingBlankLine ? "" : endsInNewline ? "\n" : "\n\n";
    return { ok: true, content: `${existingContent}${separator}${managedBlock}` };
  }

  if (begins.length === 0) {
    if (ends.length > 1) {
      return {
        ok: false,
        reason: "Refused managed-block edit: duplicate end markers found.",
      };
    }
    return {
      ok: false,
      reason: "Refused managed-block edit: end marker appears before any begin marker.",
    };
  }

  if (ends.length === 0) {
    if (begins.length > 1) {
      return {
        ok: false,
        reason: "Refused managed-block edit: duplicate begin markers found.",
      };
    }
    return {
      ok: false,
      reason: "Refused managed-block edit: begin marker has no matching end marker.",
    };
  }

  const firstBegin = begins[0];
  const firstEnd = ends[0];
  if (firstBegin === undefined || firstEnd === undefined) {
    return {
      ok: false,
      reason: "Refused managed-block edit: marker classification was inconsistent.",
    };
  }

  if (firstEnd.start < firstBegin.start) {
    return {
      ok: false,
      reason: "Refused managed-block edit: end marker appears before begin marker.",
    };
  }

  const secondBegin = begins[1];
  if (secondBegin !== undefined && secondBegin.start < firstEnd.start) {
    return {
      ok: false,
      reason: "Refused managed-block edit: nested begin marker found.",
    };
  }

  if (begins.length > 1) {
    return {
      ok: false,
      reason: "Refused managed-block edit: duplicate begin markers found.",
    };
  }

  if (ends.length > 1) {
    return {
      ok: false,
      reason: "Refused managed-block edit: duplicate end markers found.",
    };
  }

  const before = existingContent.slice(0, firstBegin.start);
  const afterStart =
    existingContent[firstEnd.contentEnd - 1] === "\r"
    && existingContent[firstEnd.contentEnd] === "\n"
      ? firstEnd.contentEnd - 1
      : firstEnd.contentEnd;
  const after = existingContent.slice(afterStart);
  return {
    ok: true,
    content: `${before}${renderManagedBlock(blockBody)}${after}`,
  };
}

export function renderMemoryBlockBody(memories: MemoryRow[]): string {
  return memories
    .filter((memory: MemoryRow): boolean => memory.status === "approved")
    .sort((left: MemoryRow, right: MemoryRow): number => {
      const scopeOrder = compareText(left.scope, right.scope);
      return scopeOrder !== 0 ? scopeOrder : compareText(left.id, right.id);
    })
    .map((memory: MemoryRow): string => {
      const terseClaim = memory.claim.replace(/\s+/gu, " ").trim();
      return `- ${terseClaim}`;
    })
    .join("\n");
}

function isAtOrUnder(candidate: string, directory: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}${sep}`);
}

function canonicalHomeRelativeDirectory(
  homePath: string,
  directoryName: string,
): string {
  const protectedPath = join(homePath, directoryName);
  try {
    return realpathSync(protectedPath);
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
    // An absent protected directory cannot contain the existing candidate.
    // Resolve it against the canonical home so separator-aware checks remain
    // correct without creating infrastructure as a side effect.
    return resolve(realpathSync(homePath), directoryName);
  }
}

export function validateTargetRepo(
  candidate: string,
  options: { homeDir?: string } = {},
): TargetValidation {
  let repoPath: string;
  try {
    repoPath = realpathSync(candidate);
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `Target repo cannot be canonicalized: ${errorMessage(error)}`,
    };
  }

  let targetStats: ReturnType<typeof statSync>;
  try {
    targetStats = statSync(repoPath);
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `Canonical target cannot be inspected: ${errorMessage(error)}`,
    };
  }

  if (!targetStats.isDirectory()) {
    return {
      ok: false,
      reason: `Target repo is not a directory: ${repoPath}`,
    };
  }

  if (!existsSync(join(repoPath, ".git"))) {
    return {
      ok: false,
      reason: `Target repo does not contain a .git entry: ${repoPath}`,
    };
  }

  const homePath = options.homeDir ?? homedir();
  let claudeDirectory: string;
  let hyperagentDirectory: string;
  try {
    claudeDirectory = canonicalHomeRelativeDirectory(homePath, ".claude");
    hyperagentDirectory = canonicalHomeRelativeDirectory(homePath, ".hyperagent");
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `Protected target directories cannot be canonicalized: ${errorMessage(error)}`,
    };
  }

  if (isAtOrUnder(repoPath, claudeDirectory)) {
    return {
      ok: false,
      reason: `Refused target at or under PAI infrastructure directory ${claudeDirectory}.`,
    };
  }

  if (isAtOrUnder(repoPath, hyperagentDirectory)) {
    return {
      ok: false,
      reason: `Refused target at or under HyperAgent data directory ${hyperagentDirectory}.`,
    };
  }

  return { ok: true, repoPath };
}

export async function syncTargets(
  targets: string[],
  render: (repo: string) => Promise<InjectionResult>,
): Promise<InjectionResult[]> {
  const results: InjectionResult[] = [];

  for (const repo of targets) {
    try {
      results.push(await render(repo));
    } catch (error: unknown) {
      results.push({
        targetPath: repo,
        changed: false,
        reason: `Injection failed for target ${repo}: ${errorMessage(error)}`,
      });
    }
  }

  return results;
}
