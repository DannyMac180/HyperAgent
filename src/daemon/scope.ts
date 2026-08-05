import { readFileSync, writeFileSync } from "node:fs";
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
  return { v: 1, excludeProjects };
}

export function readScope(dataDir: string): ReadScope {
  try {
    return parseScope(JSON.parse(readFileSync(scopePath(dataDir), "utf8")));
  } catch {
    return emptyScope();
  }
}

export function writeScope(dataDir: string, scope: ReadScope): void {
  const normalized = parseScope(scope);
  writeFileSync(
    scopePath(dataDir),
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8",
  );
}
