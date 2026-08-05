import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Persisted read scope — which projects never enter the record.
 *
 * Why a FILE and not just a caller-supplied option: the scope choice is made
 * once, interactively (the Cockpit's first-run flow), but it has to be honored
 * by every later read — including the launchd daemon, which runs `watch` with
 * fixed arguments and never sees that interaction. A choice held only in the
 * process that took it silently expires the next time something else ingests,
 * which turns a privacy control into a lie by expiry. The file is the shared
 * truth both readers consult; a CLI flag is a per-run override of it.
 *
 * Scope is PROSPECTIVE: it decides what future reads take in. Sessions already
 * in the record are removal's job, not scope's.
 */
export interface ReadScope {
  v: 1;
  /**
   * Vendor-native project directory names (claude-code's per-project
   * transcript directory, e.g. `-Users-dan-dev-repo`). Sessions the vendor
   * doesn't attribute to a project — Codex's date-bucketed rollouts — have no
   * project identity and cannot be excluded this way.
   */
  excludeProjects: string[];
  /**
   * Absolute cut-off in ms epoch — the record never goes back further than
   * this, on any later read.
   *
   * Absolute rather than a rolling window on purpose: "last 30 days" chosen
   * once means "don't go back before that day", not "keep forgetting the
   * thirty-first day". A rolling window would delete nothing (scope is
   * prospective) while progressively refusing to read what it already read.
   *
   * It has to be persisted for the same reason the exclusions do, and more
   * urgently: a session skipped for being too old leaves NO ingest-state
   * entry, so to a later flagless pass it looks simply unseen and gets
   * ingested. A cut-off held only in the process that chose it is undone by
   * the daemon's next scan.
   */
  sinceMs?: number;
}

export const emptyScope = (): ReadScope => ({ v: 1, excludeProjects: [] });

export const scopePath = (dataDir: string): string =>
  join(dataDir, "scope.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parse defensively. A corrupt or hand-mangled scope file must not widen the
 * scope silently, but it also must not wedge the daemon — so an unreadable
 * file yields the empty scope and the caller decides whether that is loud.
 */
export function parseScope(value: unknown): ReadScope {
  if (!isRecord(value) || value.v !== 1) {
    return emptyScope();
  }
  const raw = value.excludeProjects;
  if (!Array.isArray(raw)) {
    return emptyScope();
  }
  const excludeProjects = raw
    .filter((name: unknown): name is string => typeof name === "string")
    .map((name: string): string => name.trim())
    .filter((name: string): boolean => name.length > 0);
  const sinceMs = value.sinceMs;
  return {
    v: 1,
    excludeProjects,
    ...(typeof sinceMs === "number" && Number.isFinite(sinceMs)
      ? { sinceMs }
      : {}),
  };
}

export class ScopeReadError extends Error {}

/**
 * No file means no scope, which is the honest default — nothing was ever
 * excluded. But a file that EXISTS and won't parse is different in kind: the
 * pilot narrowed the scope and we can no longer tell how, and every failure
 * mode of guessing here widens the record. So that case throws instead of
 * quietly reading as empty. Fail closed, and loudly.
 */
export function readScope(dataDir: string): ReadScope {
  const path = scopePath(dataDir);
  if (!existsSync(path)) {
    return emptyScope();
  }
  try {
    return parseScope(JSON.parse(readFileSync(path, "utf8")));
  } catch (error: unknown) {
    throw new ScopeReadError(
      `${path} exists but could not be read (${
        error instanceof Error ? error.message : String(error)
      }). Refusing to read with an unknown scope — fix or delete the file.`,
    );
  }
}

/**
 * Written tmp-then-rename, because `watch` re-reads this file on every pass:
 * a partial write read mid-flight would parse as empty scope, and an empty
 * scope WIDENS what gets recorded. The atomic swap means a reader sees either
 * the old scope or the new one, never a half-written one.
 */
export function writeScope(dataDir: string, scope: ReadScope): void {
  const normalized = parseScope(scope);
  const target = scopePath(dataDir);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}
