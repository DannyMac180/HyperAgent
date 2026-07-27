import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  join,
  normalize,
  resolve,
} from "node:path";

export function defaultDataDir(): string {
  return join(homedir(), ".hyperagent");
}

export function gateDir(dataDir: string): string {
  return join(dataDir, "gate");
}

export function spoolPath(dataDir: string): string {
  return join(gateDir(dataDir), "outcomes.jsonl");
}

export function rotatedSpoolPath(dataDir: string): string {
  return join(gateDir(dataDir), "outcomes.1.jsonl");
}

export function bounceDir(dataDir: string): string {
  return join(gateDir(dataDir), "sessions");
}

export function bounceCounterPath(
  dataDir: string,
  sessionId: string,
): string {
  const sanitizedSessionId = sessionId.replace(/[^A-Za-z0-9._-]/gu, "_");
  const digestPrefix = createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 12);
  return join(
    bounceDir(dataDir),
    `${sanitizedSessionId}-${digestPrefix}.bounce`,
  );
}

export function policyPath(dataDir: string): string {
  return join(dataDir, "policy.json");
}

export function contractPath(repoPath: string): string {
  return join(repoPath, ".hyperagent", "contract.json");
}

/**
 * Runtime-write exemptions stay deliberately narrow so configuration edits
 * remain visible to gate-disarm detection.
 */
export function isSuitRuntimeWritePath(
  candidate: string,
  dataDir: string,
): boolean {
  const canonicalCandidate = normalize(resolve(candidate));
  const canonicalDataDir = normalize(resolve(dataDir));
  const databasePath = join(canonicalDataDir, "hyperagent.db");
  const exactRuntimePaths = new Set<string>([
    normalize(spoolPath(canonicalDataDir)),
    normalize(rotatedSpoolPath(canonicalDataDir)),
    normalize(databasePath),
    normalize(`${databasePath}-wal`),
    normalize(`${databasePath}-shm`),
  ]);

  if (exactRuntimePaths.has(canonicalCandidate)) {
    return true;
  }

  const canonicalBounceDir = normalize(bounceDir(canonicalDataDir));
  return (
    dirname(canonicalCandidate) === canonicalBounceDir
    && basename(canonicalCandidate).endsWith(".bounce")
  );
}
