/**
 * The adapter observe-contract (architecture-v2 §6.3, DAN-199/200).
 *
 * Everything vendor-specific lives behind this interface. The daemon — and
 * everything downstream of it — imports only this file, never an adapter's
 * internals. Adapters translate a harness's own artifacts (transcripts,
 * hooks) into canonical events; they never require the working agent to
 * self-report anything.
 *
 * Inject and Gate are deliberately absent: this is the observe-only slice
 * of the three-verb contract. They arrive with the memory engine (DAN-202)
 * and gates (DAN-203) and will extend — not modify — this contract.
 */

import type { EventInput } from "../schema/events";

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
