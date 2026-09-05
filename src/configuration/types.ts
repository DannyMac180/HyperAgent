/**
 * The public configuration record deliberately describes the shape of known
 * configuration only. Configuration values, instruction bodies, hook commands,
 * URLs, and credentials never enter the record. Accepted selected roots and
 * projected identifiers remain inspectable local metadata.
 */
export const CONFIGURATION_SCHEMA_VERSION = "1.0.0";

export type ConfigurationState = "present" | "absent" | "unavailable" | "malformed";
export type ConfigurationScopeKind = "home" | "repo";
export type ConfigurationProduct = "claude-code" | "codex";
export type ConfigurationCategory =
  | "root"
  | "configuration"
  | "instructions"
  | "agents"
  | "skills"
  | "agent"
  | "skill";

export interface ConfigurationScope {
  /** A stable identifier formed from an explicitly selected root. */
  id: string;
  kind: ConfigurationScopeKind;
  /** The user-selected scan root. It is never derived from configuration. */
  root: string;
}

export interface ConfigurationEntry {
  key: string;
  scopeId: string;
  product: ConfigurationProduct;
  source: string;
  category: ConfigurationCategory;
  /** Included only after identifier projection rejects token-like names. */
  name?: string;
  state: ConfigurationState;
  /** Structural, allowlisted metadata only. */
  metadata: Record<string, unknown>;
  /** SHA-256 over this entry's redacted representation, never file contents. */
  redactedHash: string;
}

export interface ConfigurationSnapshot {
  id: number;
  observedAt: string;
  scopes: ConfigurationScope[];
  entries: ConfigurationEntry[];
}

export type ConfigurationChangeKind = "added" | "removed" | "changed";

export interface ConfigurationChange {
  kind: ConfigurationChangeKind;
  entry: ConfigurationEntry;
}

export interface ConfigurationChanges {
  added: ConfigurationEntry[];
  removed: ConfigurationEntry[];
  changed: ConfigurationEntry[];
}

export interface ConfigurationSnapshotReport {
  snapshot: ConfigurationSnapshot;
  changes: ConfigurationChanges;
}

export interface ConfigurationScopeReport {
  scope: ConfigurationScope;
  snapshotId: number;
  observedAt: string;
  entries: ConfigurationEntry[];
  changes: ConfigurationChanges;
}

export interface ConfigurationReport {
  schemaVersion: string;
  latestSnapshot: ConfigurationSnapshot | null;
  /** Most recent first; bounded to twenty snapshots by the public reader. */
  history: ConfigurationSnapshotReport[];
  /** The most recent observation for each remembered selected scope, bounded to twenty. */
  latestByScope: ConfigurationScopeReport[];
}

export interface ConfigurationScanOptions {
  /** Defaults to the current user's home directory. */
  home?: string;
  /** An explicitly selected repository root. No repository is auto-discovered. */
  repo?: string;
  /** Defaults to ~/.hyperagent. Configuration history is stored separately there. */
  dataDir?: string;
  /** Test seam; omitted in normal use. */
  observedAt?: Date;
}

export interface ConfigurationReportOptions {
  dataDir?: string;
}
