import { extractFrictionSignals } from "../workshop/friction.ts";
import type { FrictionSignal } from "../workshop/friction.ts";
import type { HyperEvent } from "../schema/events.ts";
import type { SessionRow, Store } from "../store/store.ts";
import type { CapabilityRecord, CapabilityRegistry } from "./registry.ts";

export const DECAY_AUDIT_VERSION = "1";

/**
 * The falsifiable "still needed?" doctrine (architecture-v2 §6.7), v0 form.
 *
 * The full form — replay captured scenarios against the live model WITHOUT the
 * capability and observe whether it still fails — requires a sandboxed
 * headless-CLI replay harness and is deferred to a later increment. v0 is the
 * deterministic approximation over evidence the suit already records:
 *
 *   1. RECURRENCE — does the friction signature that motivated the capability
 *      still occur in post-install sessions (per vendor)?
 *   2. FIRING — for contract checks, do gate events still record the check
 *      failing post-install?
 *   3. MODEL CHANGE — has the vendor's model actually changed since install?
 *      Absence of friction under the SAME model proves nothing about the model
 *      outgrowing a crutch, so retirement requires a model change on record.
 *
 * Absence of recurrence is weaker evidence than a counterfactual replay — the
 * capability itself may be suppressing the friction. Every report carries this
 * limitation verbatim; retirement is therefore always a human decision and the
 * audit only flags candidates. The audit never mutates any store.
 */
export const DECAY_EVIDENCE_LIMITATION =
  "v0 decay evidence is recurrence-based, not counterfactual: absence of the originating friction may mean the model outgrew the capability OR that the capability is suppressing it. Counterfactual replay without the capability is a documented later increment; treat retirement candidates as review items, not verdicts.";

export const DEFAULT_MIN_POST_INSTALL_SESSIONS = 10;
/** Newest-first cap on sessions scanned per vendor; capped scans are reported. */
export const DEFAULT_MAX_SESSIONS_SCANNED = 200;

export type DecayStatus =
  | "still_needed"
  | "retirement_candidate"
  | "insufficient_data"
  | "unauditable";

export interface DecayEvidence {
  postInstallSessionCount: number;
  scannedSessionCount: number;
  scanCapped: boolean;
  minSessionsRequired: number;
  /** Distinct models recorded at/before install for this vendor. */
  modelsAtInstall: string[];
  /** Distinct models recorded post-install for this vendor. */
  modelsSince: string[];
  /** null when the vendor's sessions carry no model metadata. */
  modelChanged: boolean | null;
  recurrenceCount: number;
  lastRecurrenceTs: string | null;
  /** Gate failures naming this check post-install; null for non-check records. */
  gateFailureCount: number | null;
  /** ISO start of the audited window; null = unbounded (no install date). */
  windowStart: string | null;
}

export interface DecayVerdict {
  capabilityId: string;
  vendor: string;
  status: DecayStatus;
  reason: string;
  evidence: DecayEvidence | null;
  /** Exact human-gated action when status is retirement_candidate. */
  retirementAction: string | null;
}

export interface DecayAuditReport {
  auditVersion: string;
  generatedAt: string;
  limitation: string;
  vendors: string[];
  recordCount: number;
  verdicts: DecayVerdict[];
  diagnostics: string[];
}

export interface DecayAuditOptions {
  minPostInstallSessions?: number;
  maxSessionsScanned?: number;
}

export interface DecayAuditDeps {
  extractSignals?: (store: Store, sessionId: string) => FrictionSignal[];
  now?: () => Date;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function validatePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

interface ResolvedOptions {
  minPostInstallSessions: number;
  maxSessionsScanned: number;
}

function resolveOptions(
  rawOptions: DecayAuditOptions | undefined,
): ResolvedOptions {
  if (rawOptions !== undefined && !isPlainObject(rawOptions)) {
    throw new Error("decay audit options must be a plain object");
  }
  const resolved = (rawOptions ?? {}) as DecayAuditOptions;
  return {
    minPostInstallSessions: resolved.minPostInstallSessions === undefined
      ? DEFAULT_MIN_POST_INSTALL_SESSIONS
      : validatePositiveInteger(
        resolved.minPostInstallSessions,
        "minPostInstallSessions",
      ),
    maxSessionsScanned: resolved.maxSessionsScanned === undefined
      ? DEFAULT_MAX_SESSIONS_SCANNED
      : validatePositiveInteger(
        resolved.maxSessionsScanned,
        "maxSessionsScanned",
      ),
  };
}

/** Sessions this capability's scope makes it eligible to influence. */
function scopedSessions(
  sessions: readonly SessionRow[],
  record: CapabilityRecord,
  vendor: string,
): SessionRow[] {
  return sessions.filter((session): boolean => {
    if (session.vendor !== vendor) {
      return false;
    }
    if (record.scope.level === "repo") {
      return session.repo !== null && session.repo === record.scope.key;
    }
    if (record.scope.level === "agent") {
      return record.scope.key === vendor;
    }
    return true;
  });
}

function postInstall(
  sessions: readonly SessionRow[],
  installedAt: string | null,
): SessionRow[] {
  if (installedAt === null) {
    return [...sessions];
  }
  return sessions.filter(
    (session): boolean => session.started_at > installedAt,
  );
}

function distinctModels(sessions: readonly SessionRow[]): string[] {
  const models = new Set<string>();
  for (const session of sessions) {
    if (session.model !== null && session.model.length > 0) {
      models.add(session.model);
    }
  }
  return [...models].sort();
}

function newestFirst(sessions: readonly SessionRow[]): SessionRow[] {
  return [...sessions].sort((left, right): number =>
    right.started_at.localeCompare(left.started_at)
  );
}

function gateFailuresForCheck(
  events: readonly HyperEvent[],
  checkId: string,
): number {
  let count = 0;
  for (const event of events) {
    if (event.type !== "verification_event") {
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    if (payload.kind !== "gate") {
      continue;
    }
    const stats = payload.stats;
    if (!isPlainObject(stats)) {
      continue;
    }
    const failed = stats.failed_check_ids;
    if (Array.isArray(failed) && failed.includes(checkId)) {
      count += 1;
    }
  }
  return count;
}

function retirementAction(record: CapabilityRecord): string {
  if (record.memoryId !== null) {
    return `hyperagentd memory retire ${record.memoryId}`;
  }
  if (record.checkId !== null && record.repoRoot !== null) {
    return `review and remove check "${record.checkId}" from ${record.repoRoot}/.hyperagent/contract.json (human edit)`;
  }
  return `review workshop proposal ${record.proposalId ?? record.id} for retirement (human decision)`;
}

function verdict(
  record: CapabilityRecord,
  vendor: string,
  status: DecayStatus,
  reason: string,
  evidence: DecayEvidence | null,
): DecayVerdict {
  return {
    capabilityId: record.id,
    vendor,
    status,
    reason,
    evidence,
    retirementAction: status === "retirement_candidate"
      ? retirementAction(record)
      : null,
  };
}

function auditRecordForVendor(
  store: Store,
  record: CapabilityRecord,
  vendor: string,
  allSessions: readonly SessionRow[],
  options: ResolvedOptions,
  deps: DecayAuditDeps,
  signalCache: Map<string, FrictionSignal[]>,
  diagnostics: string[],
): DecayVerdict {
  if (record.scope.level === "agent" && record.scope.key !== vendor) {
    return verdict(
      record,
      vendor,
      "unauditable",
      `capability is scoped to agent ${String(record.scope.key)}; not applicable to ${vendor}`,
      null,
    );
  }

  const auditsBySignature = record.originSignature !== null;
  const auditsByGate = record.checkId !== null;
  if (!auditsBySignature && !auditsByGate) {
    return verdict(
      record,
      vendor,
      "unauditable",
      record.source === "memory_store"
        ? `no falsifiable origin: ${record.memoryId !== null && record.originSessionIds.length > 0 ? "extraction/manual memory has evidence sessions but no single friction signature" : "manual memory carries no friction signature"}; counterfactual replay (later increment) is the only test for it`
        : "no origin signature and no gate check id to probe",
      null,
    );
  }

  const eligible = scopedSessions(allSessions, record, vendor);
  const installedAt = record.installedAt;
  const windowSessions = postInstall(eligible, installedAt);
  const preInstallSessions = installedAt === null
    ? []
    : eligible.filter(
      (session): boolean => session.started_at <= installedAt,
    );

  const scanPool = newestFirst(windowSessions);
  const scanCapped = scanPool.length > options.maxSessionsScanned;
  const scanned = scanCapped
    ? scanPool.slice(0, options.maxSessionsScanned)
    : scanPool;
  if (scanCapped) {
    diagnostics.push(
      `${record.id} [${vendor}]: scan capped at newest ${options.maxSessionsScanned} of ${scanPool.length} post-install sessions`,
    );
  }

  let recurrenceCount = 0;
  let lastRecurrenceTs: string | null = null;
  let gateFailureCount: number | null = null;

  if (auditsBySignature) {
    const extract = deps.extractSignals
      ?? ((s: Store, sessionId: string): FrictionSignal[] =>
        extractFrictionSignals(s, sessionId));
    for (const session of scanned) {
      let signals = signalCache.get(session.session_id);
      if (signals === undefined) {
        signals = extract(store, session.session_id);
        signalCache.set(session.session_id, signals);
      }
      for (const signal of signals) {
        if (signal.signature === record.originSignature) {
          recurrenceCount += 1;
          if (lastRecurrenceTs === null || signal.ts > lastRecurrenceTs) {
            lastRecurrenceTs = signal.ts;
          }
        }
      }
    }
  }

  if (auditsByGate && record.checkId !== null) {
    gateFailureCount = 0;
    for (const session of scanned) {
      gateFailureCount += gateFailuresForCheck(
        store.getEvents(session.session_id),
        record.checkId,
      );
    }
  }

  const modelsAtInstall = distinctModels(preInstallSessions);
  const modelsSince = distinctModels(scanned);
  // TRUE requires knowledge on both sides of the install boundary: a model
  // recorded at install AND a different model recorded since. Anything less
  // is null (unverifiable), never false — false would claim same-model.
  const modelChanged: boolean | null =
    modelsSince.length === 0 || modelsAtInstall.length === 0
      ? null
      : modelsSince.some(
        (model): boolean => !modelsAtInstall.includes(model),
      );

  const evidence: DecayEvidence = {
    postInstallSessionCount: windowSessions.length,
    scannedSessionCount: scanned.length,
    scanCapped,
    minSessionsRequired: options.minPostInstallSessions,
    modelsAtInstall,
    modelsSince,
    modelChanged,
    recurrenceCount,
    lastRecurrenceTs,
    gateFailureCount,
    windowStart: record.installedAt,
  };

  if (windowSessions.length < options.minPostInstallSessions) {
    return verdict(
      record,
      vendor,
      "insufficient_data",
      `only ${windowSessions.length} post-install ${vendor} session(s); ${options.minPostInstallSessions} required`,
      evidence,
    );
  }

  const stillFiring = recurrenceCount > 0
    || (gateFailureCount !== null && gateFailureCount > 0);
  if (stillFiring) {
    return verdict(
      record,
      vendor,
      "still_needed",
      auditsBySignature && recurrenceCount > 0
        ? `originating friction recurred ${recurrenceCount} time(s), last at ${String(lastRecurrenceTs)}`
        : `gate recorded ${String(gateFailureCount)} failure(s) of check "${String(record.checkId)}" post-install`,
      evidence,
    );
  }

  const quietPhrase = auditsBySignature
    ? `no recurrence in ${scanned.length} session(s)`
    : `check "${String(record.checkId)}" did not fail in ${scanned.length} session(s)`;

  if (evidence.modelChanged !== true) {
    return verdict(
      record,
      vendor,
      "still_needed",
      evidence.modelChanged === null
        ? record.installedAt === null
          ? `${quietPhrase}, but no install date is on record — before/after model comparison impossible, so outgrowth cannot be claimed`
          : `${quietPhrase}, but model metadata is missing on one side of the install boundary — model change unverifiable, so outgrowth cannot be claimed until ${vendor} sessions record a model`
        : `${quietPhrase}, but the model has not changed since install — absence under the same model does not demonstrate outgrowth`,
      evidence,
    );
  }

  return verdict(
    record,
    vendor,
    "retirement_candidate",
    `${quietPhrase} and the ${vendor} model changed since install (${modelsAtInstall.join(", ")} -> ${modelsSince.join(", ")})`,
    evidence,
  );
}

/**
 * Runs the per-agent decay audit over a prebuilt registry. Read-only: the
 * store is queried, never written; no capability state is modified. Verdicts
 * are per capability x vendor — the same capability can be a
 * retirement_candidate for one agent and still_needed for another.
 */
export function runDecayAudit(
  store: Store,
  registry: CapabilityRegistry,
  options?: DecayAuditOptions,
  rawDeps: DecayAuditDeps = {},
): DecayAuditReport {
  if (!isPlainObject(rawDeps)) {
    throw new Error("decay audit deps must be a plain object");
  }
  const deps = rawDeps as DecayAuditDeps;
  const resolved = resolveOptions(options);
  const now = deps.now ?? ((): Date => new Date());
  const diagnostics: string[] = [...registry.diagnostics];

  const allSessions = store.getSessions();
  const vendors = [...new Set(
    allSessions.map((session): string => session.vendor),
  )].sort();

  const signalCache = new Map<string, FrictionSignal[]>();
  const verdicts: DecayVerdict[] = [];

  const records = [...registry.records].sort(
    (left, right): number => left.id.localeCompare(right.id),
  );
  for (const record of records) {
    for (const vendor of vendors) {
      verdicts.push(
        auditRecordForVendor(
          store,
          record,
          vendor,
          allSessions,
          resolved,
          deps,
          signalCache,
          diagnostics,
        ),
      );
    }
  }

  return {
    auditVersion: DECAY_AUDIT_VERSION,
    generatedAt: now().toISOString(),
    limitation: DECAY_EVIDENCE_LIMITATION,
    vendors,
    recordCount: records.length,
    verdicts,
    diagnostics,
  };
}
