import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { redactSummary } from "../gate/redact.ts";
import { openConfigurationStore } from "./store.ts";
import {
  CONFIGURATION_SCHEMA_VERSION,
} from "./types.ts";
import type {
  ConfigurationChange,
  ConfigurationChanges,
  ConfigurationEntry,
  ConfigurationProduct,
  ConfigurationReport,
  ConfigurationReportOptions,
  ConfigurationScanOptions,
  ConfigurationScope,
  ConfigurationScopeKind,
  ConfigurationSnapshot,
} from "./types.ts";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_DIRECTORY_ENTRIES = 256;
const MAX_SAFE_NAMES = 128;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const AWS_ACCESS_KEY = /^(?:AKIA|ASIA)[0-9A-Z]{16}$/;
const SK_TOKEN = /^sk-[A-Za-z0-9_-]+$/;

export function configurationDatabasePath(dataDir?: string): string {
  return join(dataDir ?? join(homedir(), ".hyperagent"), "configuration.db");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key: string): string =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`,
  ).join(",")}}`;
}

function hashRedacted(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

/**
 * The only projection for configuration-derived identifiers. A configuration
 * key is not inherently safe: tokens are valid TOML/JSON keys and filenames.
 * Rejected values never enter an entry, entry key, metadata, or hash input.
 */
function projectIdentifier(value: string): string | null {
  if (!SAFE_NAME.test(value)) return null;
  if (AWS_ACCESS_KEY.test(value) || SK_TOKEN.test(value)) return null;
  if (redactSummary(value, value.length + 1) !== value) return null;
  if (value.length >= 24 && entropy(value) >= 3.5) return null;
  return value;
}

function entry(
  scope: ConfigurationScope,
  product: ConfigurationProduct,
  source: string,
  category: ConfigurationEntry["category"],
  state: ConfigurationEntry["state"],
  metadata: Record<string, unknown> = {},
  name?: string,
): ConfigurationEntry {
  const safeSource = projectIdentifier(source);
  if (safeSource === null) throw new Error(`unsafe internal configuration source: ${source}`);
  const safeName: string | undefined = name === undefined ? undefined : projectIdentifier(name) ?? undefined;
  const key = [scope.id, product, safeSource, category, safeName ?? ""].join(":");
  const redacted = {
    scopeId: scope.id,
    product,
    source: safeSource,
    category,
    ...(safeName === undefined ? {} : { name: safeName }),
    state,
    metadata,
  };
  return {
    key,
    scopeId: scope.id,
    product,
    source: safeSource,
    category,
    ...(safeName === undefined ? {} : { name: safeName }),
    state,
    metadata,
    redactedHash: hashRedacted(redacted),
  };
}

function sizeBucket(size: number): "empty" | "small" | "medium" | "large" {
  if (size === 0) return "empty";
  if (size <= 4 * 1024) return "small";
  if (size <= 64 * 1024) return "medium";
  return "large";
}

type UnavailableReason = "symlink" | "intermediate_symlink" | "wrong_type" | "unreadable" | "oversize";

type PathGuard =
  | { state: "safe" }
  | { state: "absent" }
  | { state: "unavailable"; reason: UnavailableReason };

async function guardPath(root: string, target: string): Promise<PathGuard> {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const remainder = relative(rootPath, targetPath);
  if (remainder.startsWith(`..${sep}`) || remainder === ".." || isAbsolute(remainder)) {
    return { state: "unavailable", reason: "unreadable" };
  }
  const components = remainder === "" ? [] : remainder.split(sep);
  let current = rootPath;
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    if (component === undefined) return { state: "unavailable", reason: "unreadable" };
    current = join(current, component);
    if (index === components.length - 1) break;
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) return { state: "unavailable", reason: "intermediate_symlink" };
      if (!details.isDirectory()) return { state: "unavailable", reason: "wrong_type" };
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
      return code === "ENOENT" ? { state: "absent" } : { state: "unavailable", reason: "unreadable" };
    }
  }
  return { state: "safe" };
}

type SafeFileShape =
  | { state: "absent" }
  | { state: "unavailable"; reason: UnavailableReason }
  | { state: "present"; sizeBucket: ReturnType<typeof sizeBucket> };

type SafeFileResult = Exclude<SafeFileShape, { state: "present" }>
  | { state: "present"; text: string; sizeBucket: ReturnType<typeof sizeBucket> };

/**
 * Check known path components and open the final file with O_NOFOLLOW. This is
 * best-effort against paths as observed, not a TOCTOU guarantee. Error labels
 * are fixed because operating-system messages can contain sensitive paths.
 */
async function inspectKnownFile(root: string, path: string): Promise<SafeFileShape> {
  const guard = await guardPath(root, path);
  if (guard.state !== "safe") return guard;
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(path);
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
    return code === "ENOENT" ? { state: "absent" } : { state: "unavailable", reason: "unreadable" };
  }
  if (details.isSymbolicLink()) return { state: "unavailable", reason: "symlink" };
  if (!details.isFile()) return { state: "unavailable", reason: "wrong_type" };
  if (details.size > MAX_CONFIG_BYTES) return { state: "unavailable", reason: "oversize" };
  return { state: "present", sizeBucket: sizeBucket(details.size) };
}

async function readKnownText(root: string, path: string): Promise<SafeFileResult> {
  const initial = await inspectKnownFile(root, path);
  if (initial.state !== "present") return initial;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()) return { state: "unavailable", reason: "wrong_type" };
    if (opened.size > MAX_CONFIG_BYTES) return { state: "unavailable", reason: "oversize" };
    const bytes = new Uint8Array(MAX_CONFIG_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const read = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > MAX_CONFIG_BYTES || (await handle.stat()).size > MAX_CONFIG_BYTES) {
      return { state: "unavailable", reason: "oversize" };
    }
    return {
      state: "present",
      text: new TextDecoder().decode(bytes.subarray(0, bytesRead)),
      sizeBucket: initial.sizeBucket,
    };
  } catch {
    return { state: "unavailable", reason: "unreadable" };
  } finally {
    await handle?.close();
  }
}

type SafeDirectoryResult =
  | { state: "absent" }
  | { state: "unavailable"; reason: Exclude<UnavailableReason, "oversize"> }
  | {
    state: "present";
    names: string[];
    invalidNameCount: number;
    redactedNameCount: number;
    skippedSymlinkCount: number;
    truncated: boolean;
  };

async function inspectDirectory(
  root: string,
  path: string,
  kind: "agent-file" | "agent-toml" | "directory",
): Promise<SafeDirectoryResult> {
  const guard = await guardPath(root, path);
  if (guard.state !== "safe") {
    if (guard.state === "absent") return guard;
    return { state: "unavailable", reason: guard.reason === "oversize" ? "unreadable" : guard.reason };
  }
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(path);
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
    return code === "ENOENT" ? { state: "absent" } : { state: "unavailable", reason: "unreadable" };
  }
  if (details.isSymbolicLink()) return { state: "unavailable", reason: "symlink" };
  if (!details.isDirectory()) return { state: "unavailable", reason: "wrong_type" };
  try {
    const directory = await opendir(path);
    const names: string[] = [];
    let invalidNameCount = 0;
    let redactedNameCount = 0;
    let skippedSymlinkCount = 0;
    let scannedChildCount = 0;
    let truncated = false;
    for await (const child of directory) {
      scannedChildCount += 1;
      if (scannedChildCount > MAX_DIRECTORY_ENTRIES) {
        truncated = true;
        break;
      }
      if (child.isSymbolicLink()) {
        skippedSymlinkCount += 1;
        continue;
      }
      const matches = kind === "directory"
        ? child.isDirectory()
        : child.isFile() && child.name.endsWith(kind === "agent-file" ? ".md" : ".toml");
      if (!matches) continue;
      const name = kind === "directory" ? child.name : child.name.replace(/\.[^.]+$/, "");
      const projected = projectIdentifier(name);
      if (projected !== null) names.push(projected);
      else if (SAFE_NAME.test(name)) redactedNameCount += 1;
      else invalidNameCount += 1;
    }
    return {
      state: "present",
      names: names.sort(),
      invalidNameCount,
      redactedNameCount,
      skippedSymlinkCount,
      truncated,
    };
  } catch {
    return { state: "unavailable", reason: "unreadable" };
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function boundedNames(keys: string[]): {
  count: number;
  names: string[];
  invalidCount: number;
  redactedCount: number;
  truncated: boolean;
} {
  const valid: string[] = [];
  let invalidCount = 0;
  let redactedCount = 0;
  for (const key of keys) {
    const projected = projectIdentifier(key);
    if (projected !== null) valid.push(projected);
    else if (SAFE_NAME.test(key)) redactedCount += 1;
    else invalidCount += 1;
  }
  valid.sort();
  return {
    count: Math.min(keys.length, MAX_SAFE_NAMES),
    names: valid.slice(0, MAX_SAFE_NAMES),
    invalidCount: Math.min(invalidCount, MAX_SAFE_NAMES),
    redactedCount: Math.min(redactedCount, MAX_SAFE_NAMES),
    truncated: keys.length > MAX_SAFE_NAMES
      || valid.length > MAX_SAFE_NAMES
      || invalidCount > MAX_SAFE_NAMES
      || redactedCount > MAX_SAFE_NAMES,
  };
}

function configurationMetadata(mcp: unknown, hooks: unknown): Record<string, unknown> {
  const mcpRecord = plainRecord(mcp);
  const mcpKeys = mcpRecord === null
    ? []
    : Object.keys(mcpRecord).filter((key: string): boolean => plainRecord(mcpRecord[key]) !== null);
  const untypedMcpServerCount = mcpRecord === null ? 0 : Object.keys(mcpRecord).length - mcpKeys.length;
  const hookKeys = hooks !== null && typeof hooks === "object" && !Array.isArray(hooks)
    ? Object.keys(hooks as Record<string, unknown>)
    : [];
  let hookEntryCount = hooks !== null && typeof hooks === "object" && !Array.isArray(hooks)
    ? hookKeys.reduce((total: number, key: string): number => {
      const value = (hooks as Record<string, unknown>)[key];
      return total + (Array.isArray(value) ? value.length : 1);
    }, 0)
    : 0;
  const mcpSummary = boundedNames(mcpKeys);
  const hookSummary = boundedNames(hookKeys);
  const hookEntryCountTruncated = hookEntryCount > MAX_SAFE_NAMES;
  hookEntryCount = Math.min(hookEntryCount, MAX_SAFE_NAMES);
  return {
    mcpServerCount: mcpSummary.count,
    mcpServerNames: mcpSummary.names,
    invalidMcpServerNameCount: mcpSummary.invalidCount,
    redactedMcpServerNameCount: mcpSummary.redactedCount,
    untypedMcpServerCount: Math.min(untypedMcpServerCount, MAX_SAFE_NAMES),
    untypedMcpServerCountTruncated: untypedMcpServerCount > MAX_SAFE_NAMES,
    mcpServerNamesTruncated: mcpSummary.truncated,
    hookEventCount: hookSummary.count,
    hookEventNames: hookSummary.names,
    invalidHookEventNameCount: hookSummary.invalidCount,
    redactedHookEventNameCount: hookSummary.redactedCount,
    hookEventNamesTruncated: hookSummary.truncated,
    hookEntryCount,
    hookEntryCountTruncated,
  };
}

function configMetadata(parsed: unknown): Record<string, unknown> | null {
  const root = plainRecord(parsed);
  if (root === null) return null;
  return configurationMetadata(root.mcpServers, root.hooks);
}

function tomlMetadata(text: string): Record<string, unknown> | null {
  const parsed = plainRecord(Bun.TOML.parse(text) as unknown);
  if (parsed === null) return null;
  const metadata = configurationMetadata(parsed.mcp_servers, parsed.hooks);
  const agents = plainRecord(parsed.agents);
  const agentKeys = agents === null
    ? []
    : Object.keys(agents).filter((key: string): boolean => plainRecord(agents[key]) !== null);
  const untypedAgentCount = agents === null ? 0 : Object.keys(agents).length - agentKeys.length;
  const summary = boundedNames(agentKeys);
  return {
    ...metadata,
    declaredAgentCount: summary.count,
    declaredAgentNames: summary.names,
    invalidDeclaredAgentNameCount: summary.invalidCount,
    redactedDeclaredAgentNameCount: summary.redactedCount,
    untypedDeclaredAgentCount: Math.min(untypedAgentCount, MAX_SAFE_NAMES),
    untypedDeclaredAgentCountTruncated: untypedAgentCount > MAX_SAFE_NAMES,
    declaredAgentNamesTruncated: summary.truncated,
  };
}

async function scanConfigFile(
  scope: ConfigurationScope,
  product: ConfigurationProduct,
  source: string,
  path: string,
  format: "json" | "toml",
): Promise<ConfigurationEntry[]> {
  const inspected = await readKnownText(scope.root, path);
  if (inspected.state !== "present") {
    return [entry(scope, product, source, "configuration", inspected.state, inspected.state === "unavailable" ? { reason: inspected.reason } : {})];
  }
  try {
    const metadata = format === "json"
      ? configMetadata(JSON.parse(inspected.text) as unknown)
      : tomlMetadata(inspected.text);
    if (metadata === null) return [entry(scope, product, source, "configuration", "malformed", {})];
    const registrations = Array.isArray(metadata.mcpServerNames)
      ? metadata.mcpServerNames.filter((name: unknown): name is string => typeof name === "string")
      : [];
    const declaredAgents = Array.isArray(metadata.declaredAgentNames)
      ? metadata.declaredAgentNames.filter((name: unknown): name is string => typeof name === "string")
      : [];
    return [
      entry(scope, product, source, "configuration", "present", metadata),
      ...registrations.map((name: string): ConfigurationEntry =>
        entry(scope, product, `${source}-mcp`, "configuration", "present", {}, name),
      ),
      ...declaredAgents.map((name: string): ConfigurationEntry =>
        entry(scope, product, `${source}-agents`, "agent", "present", {}, name),
      ),
    ];
  } catch {
    return [entry(scope, product, source, "configuration", "malformed", {})];
  }
}

async function scanInstruction(
  scope: ConfigurationScope,
  product: ConfigurationProduct,
  source: string,
  path: string,
): Promise<ConfigurationEntry> {
  const inspected = await inspectKnownFile(scope.root, path);
  if (inspected.state === "present") {
    // Content is intentionally discarded immediately. Size is coarse structural metadata.
    return entry(scope, product, source, "instructions", "present", { sizeBucket: inspected.sizeBucket });
  }
  return entry(scope, product, source, "instructions", inspected.state, inspected.state === "unavailable" ? { reason: inspected.reason } : {});
}

async function scanCollection(
  scope: ConfigurationScope,
  product: ConfigurationProduct,
  source: string,
  collectionCategory: "agents" | "skills",
  memberCategory: "agent" | "skill",
  path: string,
  kind: "agent-file" | "agent-toml" | "directory",
): Promise<ConfigurationEntry[]> {
  const inspected = await inspectDirectory(scope.root, path, kind);
  if (inspected.state !== "present") {
    return [entry(scope, product, source, collectionCategory, inspected.state, inspected.state === "unavailable" ? { reason: inspected.reason } : {})];
  }
  const collection = entry(scope, product, source, collectionCategory, "present", {
    memberCount: inspected.names.length,
    invalidNameCount: inspected.invalidNameCount,
    redactedNameCount: inspected.redactedNameCount,
    skippedSymlinkCount: inspected.skippedSymlinkCount,
    truncated: inspected.truncated,
  });
  return [collection, ...inspected.names.map((name: string): ConfigurationEntry =>
    entry(scope, product, source, memberCategory, "present", {}, name),
  )];
}

async function scanProduct(
  scope: ConfigurationScope,
  product: ConfigurationProduct,
): Promise<ConfigurationEntry[]> {
  const root = scope.root;
  if (product === "claude-code") {
    const base = scope.kind === "home" ? join(root, ".claude") : join(root, ".claude");
    const results = await Promise.all([
      ...(scope.kind === "home" ? [scanConfigFile(scope, product, "global-mcp", join(root, ".claude.json"), "json")] : []),
      scanConfigFile(scope, product, "settings", join(base, "settings.json"), "json"),
      scanConfigFile(scope, product, "settings-local", join(base, "settings.local.json"), "json"),
      ...(scope.kind === "repo" ? [scanConfigFile(scope, product, "mcp", join(root, ".mcp.json"), "json")] : []),
      scanInstruction(scope, product, "instructions", scope.kind === "home" ? join(base, "CLAUDE.md") : join(root, "CLAUDE.md")),
      scanCollection(scope, product, "agents-md", "agents", "agent", join(base, "agents"), "agent-file"),
      scanCollection(scope, product, "skills-claude", "skills", "skill", join(base, "skills"), "directory"),
    ]);
    return results.flat();
  }

  const base = join(root, ".codex");
  const results = await Promise.all([
    scanConfigFile(scope, product, "config", join(base, "config.toml"), "toml"),
    scanInstruction(scope, product, "instructions", scope.kind === "home" ? join(base, "AGENTS.md") : join(root, "AGENTS.md")),
    scanCollection(scope, product, "agents-toml", "agents", "agent", join(base, "agents"), "agent-toml"),
    scanCollection(scope, product, "skills-current", "skills", "skill", join(root, ".agents", "skills"), "directory"),
    scanCollection(scope, product, "skills-legacy", "skills", "skill", join(base, "skills"), "directory"),
  ]);
  return results.flat();
}

async function scanScope(scope: ConfigurationScope): Promise<ConfigurationEntry[]> {
  const root = await inspectDirectory(scope.root, scope.root, "directory");
  if (root.state !== "present") {
    return [entry(scope, "claude-code", "root", "root", root.state, root.state === "unavailable" ? { reason: root.reason } : {})];
  }
  const products = await Promise.all([scanProduct(scope, "claude-code"), scanProduct(scope, "codex")]);
  return [
    entry(scope, "claude-code", "root", "root", "present", {}),
    ...products.flat(),
  ];
}

function makeScope(kind: ConfigurationScopeKind, root: string): ConfigurationScope {
  const resolved = resolve(root);
  return { id: `${kind}:${resolved}`, kind, root: resolved };
}

function knownCollection(entryValue: ConfigurationEntry, entries: Map<string, ConfigurationEntry>): boolean {
  if (entryValue.category !== "agent" && entryValue.category !== "skill") return false;
  const collectionCategory = entryValue.category === "agent" ? "agents" : "skills";
  const collectionKey = [entryValue.scopeId, entryValue.product, entryValue.source, collectionCategory, ""].join(":");
  const collection = entries.get(collectionKey);
  return collection?.state === "present"
    && collection.metadata.truncated !== true
    && collection.metadata.skippedSymlinkCount === 0;
}

function knownMcpRegistration(entryValue: ConfigurationEntry, entries: Map<string, ConfigurationEntry>): boolean {
  if (!entryValue.source.endsWith("-mcp") || entryValue.category !== "configuration") return false;
  const configSource = entryValue.source.slice(0, -"-mcp".length);
  const configKey = [entryValue.scopeId, entryValue.product, configSource, "configuration", ""].join(":");
  const configuration = entries.get(configKey);
  return configuration?.state === "present"
    && configuration.metadata.mcpServerNamesTruncated !== true;
}

function knownDeclaredAgent(entryValue: ConfigurationEntry, entries: Map<string, ConfigurationEntry>): boolean {
  if (!entryValue.source.endsWith("-agents") || entryValue.category !== "agent") return false;
  const configSource = entryValue.source.slice(0, -"-agents".length);
  const configKey = [entryValue.scopeId, entryValue.product, configSource, "configuration", ""].join(":");
  const configuration = entries.get(configKey);
  return configuration?.state === "present"
    && configuration.metadata.declaredAgentNamesTruncated !== true;
}

export function compareConfigurationSnapshots(
  previous: ConfigurationSnapshot | null,
  current: readonly ConfigurationEntry[],
): ConfigurationChanges {
  const changes: ConfigurationChanges = { added: [], removed: [], changed: [] };
  const currentByKey = new Map(current.map((item: ConfigurationEntry) => [item.key, item]));
  if (previous === null) {
    changes.added.push(...current.filter((item: ConfigurationEntry): boolean => item.state === "present"));
    return changes;
  }
  const priorByKey = new Map(previous.entries.map((item: ConfigurationEntry) => [item.key, item]));
  for (const item of current) {
    const prior = priorByKey.get(item.key);
    if (prior === undefined) {
      if (item.state === "present") changes.added.push(item);
      continue;
    }
    if (prior.state === "absent" && item.state === "present") changes.added.push(item);
    else if (prior.state === "present" && item.state === "absent") changes.removed.push(prior);
    else if (prior.redactedHash !== item.redactedHash) changes.changed.push(item);
  }
  for (const prior of previous.entries) {
    if (currentByKey.has(prior.key) || prior.state !== "present") continue;
    if (
      knownCollection(prior, currentByKey)
      || knownMcpRegistration(prior, currentByKey)
      || knownDeclaredAgent(prior, currentByKey)
    ) {
      changes.removed.push(prior);
    }
  }
  for (const value of [changes.added, changes.removed, changes.changed]) {
    value.sort((left: ConfigurationEntry, right: ConfigurationEntry): number => left.key.localeCompare(right.key));
  }
  return changes;
}

export async function scanConfiguration(options: ConfigurationScanOptions = {}): Promise<{
  schemaVersion: string;
  snapshot: ConfigurationSnapshot;
  changes: ConfigurationChanges;
}> {
  const scopes: ConfigurationScope[] = [makeScope("home", options.home ?? homedir())];
  if (options.repo !== undefined) scopes.push(makeScope("repo", options.repo));
  const scopedEntries = await Promise.all(scopes.map(scanScope));
  const entries = scopedEntries.flat().sort((left, right) => left.key.localeCompare(right.key));
  const store = openConfigurationStore(configurationDatabasePath(options.dataDir));
  try {
    const { snapshot, changes } = store.recordSnapshot(
      (options.observedAt ?? new Date()).toISOString(), scopes, entries,
      (previousByScope) => {
        const changes: ConfigurationChanges = { added: [], removed: [], changed: [] };
        for (const scope of scopes) {
          const current = entries.filter((item: ConfigurationEntry): boolean => item.scopeId === scope.id);
          const scopeChanges = compareConfigurationSnapshots(previousByScope.get(scope.id) ?? null, current);
          changes.added.push(...scopeChanges.added);
          changes.removed.push(...scopeChanges.removed);
          changes.changed.push(...scopeChanges.changed);
        }
        for (const values of [changes.added, changes.removed, changes.changed]) {
          values.sort((left: ConfigurationEntry, right: ConfigurationEntry): number => left.key.localeCompare(right.key));
        }
        return changes;
      },
    );
    return { schemaVersion: CONFIGURATION_SCHEMA_VERSION, snapshot, changes };
  } finally {
    store.close();
  }
}

export function readConfigurationReport(options: ConfigurationReportOptions = {}): ConfigurationReport {
  const path = configurationDatabasePath(options.dataDir);
  if (!existsSync(path)) {
    return {
      schemaVersion: CONFIGURATION_SCHEMA_VERSION,
      latestSnapshot: null,
      history: [],
      latestByScope: [],
    };
  }
  const store = openConfigurationStore(path, { readOnly: true });
  try {
    const history = store.recentReports(20);
    return {
      schemaVersion: CONFIGURATION_SCHEMA_VERSION,
      latestSnapshot: history[0]?.snapshot ?? null,
      history,
      latestByScope: store.latestScopeReports(20),
    };
  } finally {
    store.close();
  }
}
