import type {
  GateAdapter,
  InjectAdapter,
  ObserveAdapter,
} from "../adapters/types.ts";
import type {
  GateDecision,
  GateHookKind,
} from "../gate/eval.ts";
import type { MemoryRow } from "../memory/store.ts";
import type { EventInput } from "../schema/events.ts";

export type ConformanceCapability = "observe" | "inject" | "gate";

/**
 * Four statuses, and the distinction between the last two is load-bearing:
 *  - "skipped"        = the adapter never CLAIMED this capability. Reported,
 *                       never omitted, so a report always shows the full grid.
 *  - "not-applicable" = the capability IS claimed but this specific check is
 *                       gated off by a storage trait (e.g. line-truncation
 *                       checks against a harness that is not append-only-lines).
 * Conflating them would let a future adapter look complete by claiming less.
 */
export type CheckStatus = "pass" | "fail" | "skipped" | "not-applicable";

export interface CheckResult {
  id: string;
  capability: ConformanceCapability;
  status: CheckStatus;
  detail: string;
}

export type ConformanceTier = 1 | 2 | 3 | "below-tier";

export interface ConformanceReport {
  vendor: string;
  adapterVersion: string;
  dialectVersion: string;
  checks: CheckResult[];
  verifiedCapabilities: ConformanceCapability[];
  tier: ConformanceTier;
  /** True when no check failed. Skipped/not-applicable do not fail a run. */
  passed: boolean;
}

/** Storage traits gate checks that only make sense for some artifact shapes. */
export interface StorageTraits {
  /** Artifact is append-only, one record per line (JSONL). Extensible: add traits here. */
  appendOnlyLines: boolean;
}

export interface ConformanceContext {
  /** Every fixture and every adapter instance must live under this root. */
  tempRoot: string;
}

export interface ObserveVariant {
  adapter: ObserveAdapter;
  /** Human label used in the check detail line. */
  label: string;
}

/**
 * Resume is exercised by starting from an artifact holding a PREFIX of the
 * record stream, taking the adapter's opaque resumeToken, then completing the
 * artifact and continuing. That is a genuinely mid-stream token without the
 * runner having to understand the token's vendor-specific encoding.
 */
export interface ResumeFixture {
  /** Adapter rooted at the prefix artifact. */
  adapter: ObserveAdapter;
  /** Appends the remaining records so pass 2 has new content to read. */
  completeArtifact(): Promise<void>;
  /** Independent adapter over an already-complete copy, for the single-pass baseline. */
  fullAdapter: ObserveAdapter;
}

/** Trait-gated on appendOnlyLines: a byte-truncated trailing record. */
export interface TruncationFixture {
  adapter: ObserveAdapter;
  /** Appends the rest of the truncated trailing record. */
  completeLine(): Promise<void>;
}

export interface ObserveFixtureSet {
  adapter: ObserveAdapter;
  /** Sessions the clean adapter must discover, e.g. `${vendor}:`. */
  expectedSessionIdPrefix: string;
  /** Committed expected-event snapshot, already normalized. */
  goldenEvents: readonly unknown[];
  /**
   * Strips fields that are legitimately machine-dependent (absolute temp
   * paths, etc.) so the golden snapshot can be committed. Every normalization
   * a descriptor performs must be documented in the descriptor file.
   */
  normalizeEvent(event: EventInput, context: ConformanceContext): unknown;
  unknownRecord: ObserveVariant;
  corrupted: ObserveVariant;
  resume: ResumeFixture;
  /** Required when storageTraits.appendOnlyLines is true; omitted otherwise. */
  truncation?: TruncationFixture;
}

export interface InjectFixtureSet {
  adapter: InjectAdapter;
  /** Memories whose rendered form must contain `sentinel`. */
  memories: MemoryRow[];
  sentinel: string;
  /** Where the managed artifact lands inside a target repo. */
  managedArtifactPath(repoPath: string): string;
  /** Non-managed content pre-written into the artifact; must survive removal. */
  foreignContent: string;
}

export interface GateFixtureSet {
  adapter: GateAdapter;
  /** The harness config file the gate install owns entries in. */
  managedArtifactPath(repoPath: string): string;
  /** Foreign content written before install; must survive uninstall. */
  foreignContent: string;
  /** A canonical raw hook stdin payload in this harness's dialect. */
  hookStdin(kind: GateHookKind): unknown;
  /** The decision the runner will render for this kind. */
  decisionFor(kind: GateHookKind): GateDecision;
  /**
   * Vendor-correct-shape assertion on rendered stdout.
   * Returns null when the shape is correct, else a problem description.
   */
  validateHookOutput(
    kind: GateHookKind,
    decision: GateDecision,
    rendered: string,
  ): string | null;
  /** Payloads that must make parseHookStdin return null rather than throw. */
  malformedHookStdin(): readonly unknown[];
}

export interface ConformanceFactories {
  /** Each factory builds adapter instances AND fixtures under context.tempRoot. */
  observe?(context: ConformanceContext): Promise<ObserveFixtureSet>;
  inject?(context: ConformanceContext): Promise<InjectFixtureSet>;
  gate?(context: ConformanceContext): Promise<GateFixtureSet>;
}

export interface ConformanceDescriptor {
  vendor: string;
  /** Stamped into the report — "verified" is always versioned. */
  adapterVersion: string;
  /** Fixture dialect version — bump when the recorded harness format changes. */
  dialectVersion: string;
  claimed: { observe: boolean; inject: boolean; gate: boolean };
  storageTraits: StorageTraits;
  claimedHookKinds: readonly GateHookKind[];
  /**
   * Path segments that must be REFUSED as injection targets. The runner builds
   * structural look-alikes under its temp root and asserts refusal against
   * those — it never touches the real home directories.
   */
  forbiddenTargetPatterns: readonly string[];
  factories: ConformanceFactories;
}
