/**
 * The adapter observe-contract (architecture-v2 §6.3, DAN-199/200).
 *
 * Everything vendor-specific lives behind this interface. The daemon — and
 * everything downstream of it — imports only this file, never an adapter's
 * internals. Adapters translate a harness's own artifacts (transcripts,
 * hooks) into canonical events; they never require the working agent to
 * self-report anything.
 *
 * Inject extends this contract additively with the memory engine (DAN-202).
 * Gate now extends the contract additively for DAN-203 without modifying the
 * existing contracts.
 */

import type {
  GateDecision,
  GateHookInput,
  GateHookKind,
} from "../gate/eval.ts";
import type { InjectionResult } from "../memory/inject.ts";
import type { MemoryRow } from "../memory/store.ts";
import type { EventInput } from "../schema/events.ts";

export type { InjectionResult } from "../memory/inject.ts";

/** A harness session source an adapter has located on disk. */
export interface DiscoveredSession {
  /** Canonical session id (schema.md §4.1): `<vendor>:<native-or-derived>`. */
  sessionId: string;
  /** Absolute path to the vendor artifact backing this session. */
  path: string;
  /** Artifact mtime (ms epoch) — lets the daemon skip unchanged files. */
  mtimeMs: number;
  /** Artifact size in bytes — cheap change detection alongside mtime. */
  sizeBytes: number;
  /**
   * Vendor-native project identity, when the harness has one (Claude Code's
   * per-project transcript directory name, e.g. `-Users-dan-dev-repo`).
   * Absent when the vendor doesn't attribute sessions to projects (Codex's
   * date-bucketed rollouts) — such sessions cannot be excluded by project,
   * matching the honest "sessions with no project" framing upstream.
   */
  projectDir?: string;
}

/**
 * Result of one parse pass over a session artifact.
 *
 * Parsing is incremental: the daemon hands back `resumeToken` from the last
 * pass and the adapter continues from there (byte offset, line number —
 * opaque to the daemon). Re-parsing from zero MUST be safe: event ids are
 * deterministic (see `deterministicEventId`), so replays dedupe in the store.
 */
export interface ParseResult {
  events: EventInput[];
  /** Opaque continuation token; pass to the next parseSession call. */
  resumeToken: string;
  /** Lines/records skipped because their type is unknown to this adapter version. */
  skippedUnknown: number;
  /** Records that LOOKED like known types but failed to parse — the breakage signal. */
  parseFailures: number;
  /**
   * Best-evidence repo attribution for the whole session as of this pass
   * (git root of the dominant working-directory/file-touch evidence — see
   * `adapters/attribution.ts`). `null` means the adapter looked and no repo
   * is honestly derivable; absent means the adapter does not attribute.
   * The daemon persists the latest value and stamps it into the quiesce
   * `session_end` payload so the sessions table stays an event projection.
   */
  sessionRepo?: string | null;
}

export type AdapterHealthStatus = "ok" | "needs_update" | "unavailable";

/**
 * Adapter breakage is a normal event (architecture-v2 rule 5). Health is
 * derived, surfaced, and never silent: a spike of parseFailures flips an
 * adapter to `needs_update`; a missing install directory means `unavailable`.
 */
export interface AdapterHealth {
  status: AdapterHealthStatus;
  /** Harness version as detected on this machine, when determinable. */
  harnessVersion: string | null;
  /** Human-readable one-liner shown by `hyperagentd status`. */
  detail: string;
}

export interface ObserveAdapter {
  /** Vendor slug used in canonical events (e.g. "claude-code"). */
  readonly vendor: string;
  /** Adapter semver, stamped into every event's envelope. */
  readonly adapterVersion: string;

  /** Is this harness present on this machine, and can we read its artifacts? */
  detect(): Promise<AdapterHealth>;

  /** Enumerate session artifacts under the adapter's (configurable) roots. */
  discoverSessions(): Promise<DiscoveredSession[]>;

  /**
   * Parse one session artifact from `resumeToken` (empty string = from the
   * beginning). MUST tolerate: unknown record types (count, skip), truncated
   * trailing lines (leave for the next pass), and being re-run over already-
   * ingested content (deterministic ids make that a store-level no-op).
   */
  parseSession(
    session: DiscoveredSession,
    resumeToken: string,
  ): Promise<ParseResult>;
}

export interface InjectAdapter {
  /** Vendor slug used to select agent-scoped memories (e.g. "claude-code"). */
  readonly vendor: string;

  /** Render approved memories into this harness's native dialect for one repo. */
  renderInjection(
    targetRepo: string,
    memories: MemoryRow[],
  ): Promise<InjectionResult>;
}

/**
 * `refused` is terminal and distinct from `not-installed`: the target is
 * permanently ineligible (suit-owned or PAI infrastructure directories, no
 * `.git`), so reporting it as merely not-yet-installed would imply an install
 * that can never succeed.
 */
export type GateInstallState =
  | "installed"
  | "stale"
  | "not-installed"
  | "foreign"
  | "refused";

export interface GateStatus {
  state: GateInstallState;
  targetPath: string;
  /** Number of hyperagent-owned hook entries found. */
  ownedEntries: number;
  detail: string;
}

export interface GateInstallResult {
  targetPath: string;
  changed: boolean;
  /** Populated when refused, failed, or a no-op. */
  reason?: string;
}

export interface GateAdapter {
  readonly vendor: string;
  install(repoPath: string): Promise<GateInstallResult>;
  uninstall(repoPath: string): Promise<GateInstallResult>;
  status(repoPath: string): Promise<GateStatus>;

  /**
   * Translate this harness's hook stdin into the canonical, vendor-neutral
   * shape. Returns null when the payload is unusable so the hook runtime can
   * fail open.
   *
   * Hook dialects live behind the adapter for the same reason transcript
   * formats do: the daemon and the CLI stay vendor-blind, and adding a harness
   * never edits them.
   */
  parseHookStdin(hook: GateHookKind, raw: unknown): GateHookInput | null;

  /**
   * Render a decision as the bytes this harness expects on stdout. An empty
   * string means "no decision output" — the non-decision path.
   */
  renderHookOutput(hook: GateHookKind, decision: GateDecision): string;
}
