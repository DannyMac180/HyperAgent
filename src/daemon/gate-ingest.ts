import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";

import type { GateInstallState } from "../adapters/types.ts";
import {
  gateDir,
  policyPath,
  spoolPath,
} from "../gate/paths.ts";
import {
  loadPolicy,
  type PolicyLoadState,
} from "../gate/policy.ts";
import {
  discardRotatedSpool,
  readSpool,
  rotateSpool,
  spoolBacklogBytes,
  type GateOutcome,
} from "../gate/spool.ts";
import type {
  VerificationEventInput,
  VerificationEventPayload,
} from "../schema/events.ts";
import { deterministicEventId } from "../schema/ids.ts";
import type { Store } from "../store/store.ts";
import { builtinGateAdapters } from "./registry.ts";

export const GATE_ADAPTER_VERSION = "0.1.0";

export interface GateIngestResult {
  outcomesRead: number;
  eventsAppended: number;
  parkedUnknownSession: number;
  malformedLines: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function outcomeStableKey(outcome: GateOutcome): string {
  const stableContent: Record<string, unknown> = {
    v: outcome.v,
    kind: outcome.kind,
    ts: outcome.ts,
    harness: outcome.harness,
    sessionId: outcome.sessionId,
    cwd: outcome.cwd,
    decision: outcome.decision,
    summary: outcome.summary,
    matchedRules: outcome.matchedRules,
    failedChecks: outcome.failedChecks,
    command: outcome.command ?? null,
    passed: outcome.passed ?? null,
    touchedFiles: outcome.touchedFiles ?? null,
    error: outcome.error ?? null,
  };
  return sha256Hex(JSON.stringify(stableContent));
}

function vendorFromSessionId(sessionId: string): string {
  const separatorIndex: number = sessionId.indexOf(":");
  return separatorIndex < 0 ? sessionId : sessionId.slice(0, separatorIndex);
}

function verificationEvent(
  dataDir: string,
  outcome: GateOutcome,
): VerificationEventInput {
  const stableKey: string = outcomeStableKey(outcome);
  // DAN-217: the spool's absolute path used to prefix this ref, which made the
  // id depend on $HOME — the same defect as the transcript adapters, found by
  // the post-rebuild sweep for absolute paths. `gate-spool` is a stable
  // logical source name; identity already lives in the content-derived
  // stableKey, so dropping the path loses nothing.
  const rawRef: string = `gate-spool#${stableKey}`;
  const payload: VerificationEventPayload = {
    kind: "gate",
    command_digest: sha256Hex(outcome.summary),
    command_summary: outcome.summary,
    result: outcome.decision === "allow" ? "pass" : "fail",
    stats: {
      outcome_kind: outcome.kind,
      matched_rule_ids: outcome.matchedRules,
      failed_check_ids: outcome.failedChecks,
    },
    initiated_by: "suit",
  };
  return {
    id: deterministicEventId({
      ts: outcome.ts,
      sessionId: outcome.sessionId,
      rawRef,
      type: "verification_event",
      discriminator: stableKey,
    }),
    ts: outcome.ts,
    type: "verification_event",
    session_id: outcome.sessionId,
    vendor: vendorFromSessionId(outcome.sessionId),
    adapter_version: GATE_ADAPTER_VERSION,
    raw_ref: rawRef,
    payload,
  };
}

function serializeOutcomes(outcomes: GateOutcome[]): string {
  if (outcomes.length === 0) {
    return "";
  }
  return `${outcomes.map(
    (outcome: GateOutcome): string => JSON.stringify(outcome),
  ).join("\n")}\n`;
}

async function rewriteLiveSpool(
  dataDir: string,
  outcomes: GateOutcome[],
): Promise<void> {
  await mkdir(gateDir(dataDir), { recursive: true });
  const livePath: string = spoolPath(dataDir);
  const temporaryPath: string = `${livePath}.ingest.tmp`;
  await writeFile(temporaryPath, serializeOutcomes(outcomes), "utf8");
  await rename(temporaryPath, livePath);
}

/** Daemon-only. Rotates before reading both generations, converts outcomes
 * into canonical verification events, and retains every outcome that is not
 * yet safe to remove from the spool. */
export async function ingestGateSpool(options: {
  store: Store;
  dataDir: string;
}): Promise<GateIngestResult> {
  await rotateSpool(options.dataDir);
  const spoolRead = await readSpool(options.dataDir);
  const retainedOutcomes: GateOutcome[] = [];
  let eventsAppended = 0;
  let parkedUnknownSession = 0;

  for (const outcome of spoolRead.outcomes) {
    if (options.store.getEvents(outcome.sessionId).length === 0) {
      retainedOutcomes.push(outcome);
      parkedUnknownSession += 1;
      continue;
    }

    try {
      eventsAppended += options.store.append(
        verificationEvent(options.dataDir, outcome),
      );
    } catch (error: unknown) {
      // One bad outcome must not block later outcomes. Retaining it also
      // prevents a transient append failure from becoming silent data loss.
      console.error(
        `Failed to ingest gate outcome for session "${outcome.sessionId}": ${
          errorMessage(error)
        }`,
      );
      retainedOutcomes.push(outcome);
    }
  }

  // This order is the no-loss boundary: parked/retryable outcomes must be
  // durable in the live generation before the consumed generation is removed.
  await rewriteLiveSpool(options.dataDir, retainedOutcomes);
  await discardRotatedSpool(options.dataDir);

  return {
    outcomesRead: spoolRead.outcomes.length,
    eventsAppended,
    parkedUnknownSession,
    malformedLines: spoolRead.malformedLines,
  };
}

export interface GateHealth {
  policyState: PolicyLoadState;
  policyError?: string;
  spoolBacklogBytes: number;
  repos: Array<{
    repo: string;
    state: GateInstallState;
    detail: string;
  }>;
}

export async function readGateHealth(options: {
  dataDir: string;
  repos: string[];
  /** Overrides the home directory used for refusal checks (tests). */
  homeDir?: string;
}): Promise<GateHealth> {
  const policy = loadPolicy(policyPath(options.dataDir));
  // Adapters come from the registry so this module names no vendor; health is
  // read-only here by design (see the install/uninstall anti-test).
  const adapters = builtinGateAdapters({
    dataDir: options.dataDir,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });
  const [backlogBytes, repos] = await Promise.all([
    spoolBacklogBytes(options.dataDir),
    Promise.all(
      options.repos.map(
        async (
          repo: string,
        ): Promise<{
          repo: string;
          state: GateInstallState;
          detail: string;
        }> => {
          // Every registered harness is asked; the first that reports an
          // installed gate wins, otherwise the first answer stands.
          const statuses = await Promise.all(
            adapters.map((adapter) => adapter.status(repo)),
          );
          const installed = statuses.find(
            (candidate): boolean => candidate.state === "installed",
          );
          const status = installed ?? statuses[0];
          if (status === undefined) {
            return {
              repo,
              state: "not-installed",
              detail: "No gate adapters are registered.",
            };
          }
          return {
            repo,
            state: status.state,
            detail: status.detail,
          };
        },
      ),
    ),
  ]);
  const health: GateHealth = {
    policyState: policy.state,
    spoolBacklogBytes: backlogBytes,
    repos,
  };
  if (policy.error !== undefined) {
    health.policyError = policy.error;
  }
  return health;
}
