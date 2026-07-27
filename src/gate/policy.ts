import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { redactSummary } from "./redact.ts";

export const POLICY_SCHEMA_VERSION = "0.1.0";

export type PolicyAction = "block" | "flag";
export type PathAccess = "read" | "write" | "any";

export interface PolicyMatcher {
  /** JS regex source, matched case-insensitively against the canonical tool name. */
  toolNamePattern?: string;
  /** JS regex source, matched case-insensitively against the command string. */
  commandPattern?: string;
  /** Glob (supports `*`, `**`, `?`), matched against each candidate path. */
  pathPattern?: string;
  /** Which kind of path access the pathPattern applies to. Default "any". */
  pathAccess?: PathAccess;
}

export interface PolicyRule {
  id: string;
  description: string;
  action: PolicyAction;
  enabled: boolean;
  match: PolicyMatcher;
}

export interface PolicyDoc {
  schema_version: string;
  rules: PolicyRule[];
}

export type PolicyLoadState = "default" | "loaded" | "invalid";

export interface PolicyLoadResult {
  state: PolicyLoadState;
  policy: PolicyDoc;
  path: string;
  error?: string;
}

export const DEFAULT_POLICY: PolicyDoc = {
  schema_version: POLICY_SCHEMA_VERSION,
  rules: [
    {
      id: "secrets-file-write.env",
      description: "Write to an environment secrets file.",
      action: "flag",
      enabled: true,
      match: { pathPattern: "**/.env*", pathAccess: "write" },
    },
    {
      id: "secrets-file-write.pem",
      description: "Write to a PEM credential file.",
      action: "flag",
      enabled: true,
      match: { pathPattern: "**/*.pem", pathAccess: "write" },
    },
    {
      id: "secrets-file-write.id-rsa",
      description: "Write to an RSA private-key file.",
      action: "flag",
      enabled: true,
      match: { pathPattern: "**/id_rsa*", pathAccess: "write" },
    },
    {
      id: "secrets-file-write.credentials",
      description: "Write to a credentials file.",
      action: "flag",
      enabled: true,
      match: { pathPattern: "**/credentials*", pathAccess: "write" },
    },
    {
      id: "secrets-file-write.key",
      description: "Write to a key file.",
      action: "flag",
      enabled: true,
      match: { pathPattern: "**/*.key", pathAccess: "write" },
    },
    {
      id: "permission-config-edit.claude-settings",
      description: "Write to the shared harness permission settings.",
      action: "flag",
      enabled: true,
      match: {
        pathPattern: "**/.claude/settings.json",
        pathAccess: "write",
      },
    },
    {
      id: "permission-config-edit.claude-settings-local",
      description: "Write to the local harness permission settings.",
      action: "flag",
      enabled: true,
      match: {
        pathPattern: "**/.claude/settings.local.json",
        pathAccess: "write",
      },
    },
    {
      id: "permission-config-edit.policy",
      description: "Write to the HyperAgent gate policy.",
      action: "flag",
      enabled: true,
      match: {
        pathPattern: "**/.hyperagent/policy.json",
        pathAccess: "write",
      },
    },
    {
      id: "permission-config-edit.contract",
      description: "Write to the repository verification contract.",
      action: "flag",
      enabled: true,
      match: {
        pathPattern: "**/.hyperagent/contract.json",
        pathAccess: "write",
      },
    },
    {
      id: "external-publish-command",
      description: "Run a command that publishes work externally.",
      action: "flag",
      enabled: true,
      match: {
        commandPattern:
          "git\\s+push|npm\\s+publish|bunx?\\s+publish|gh\\s+(pr|release)\\s+create|docker\\s+push",
      },
    },
    {
      id: "destructive-recursive-delete",
      description: "Recursively delete from an absolute root path.",
      action: "block",
      // Blocking ships off because tightening authority is the user's decision.
      enabled: false,
      match: {
        commandPattern: "rm\\s+(-[A-Za-z]*[rR][A-Za-z]*\\s+)+/",
      },
    },
  ],
};

/**
 * Invalid policy must retain visible safety signals instead of degrading to
 * an empty policy, while never acquiring blocking authority from bad input.
 */
export const FLAG_ONLY_BASELINE: PolicyDoc = {
  schema_version: DEFAULT_POLICY.schema_version,
  rules: DEFAULT_POLICY.rules.map((rule: PolicyRule): PolicyRule => ({
    ...rule,
    action: "flag",
    match: { ...rule.match },
  })),
};

interface RuleMatchResult {
  evidenceParts: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: object | null = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateRegexSource(
  value: unknown,
  label: string,
  errors: string[],
): void {
  if (!isNonEmptyString(value)) {
    errors.push(`POLICY_RULE_FIELD_ERROR: ${label} must be a non-empty string.`);
    return;
  }

  try {
    new RegExp(value, "i");
  } catch (error: unknown) {
    errors.push(
      `POLICY_REGEX_ERROR: ${label} is not a valid regular expression: ${errorMessage(error)}`,
    );
  }
}

function validateMatcher(
  value: unknown,
  ruleIndex: number,
  errors: string[],
): void {
  const label = `rules[${ruleIndex}].match`;
  if (!isPlainObject(value)) {
    errors.push(`POLICY_RULE_FIELD_ERROR: ${label} must be an object.`);
    return;
  }

  const hasToolNamePattern = value.toolNamePattern !== undefined;
  const hasCommandPattern = value.commandPattern !== undefined;
  const hasPathPattern = value.pathPattern !== undefined;
  if (!hasToolNamePattern && !hasCommandPattern && !hasPathPattern) {
    errors.push(
      `POLICY_MATCHER_EMPTY_ERROR: ${label} must define toolNamePattern, commandPattern, or pathPattern.`,
    );
  }

  if (hasToolNamePattern) {
    validateRegexSource(
      value.toolNamePattern,
      `${label}.toolNamePattern`,
      errors,
    );
  }
  if (hasCommandPattern) {
    validateRegexSource(
      value.commandPattern,
      `${label}.commandPattern`,
      errors,
    );
  }
  if (
    hasPathPattern
    && !isNonEmptyString(value.pathPattern)
  ) {
    errors.push(
      `POLICY_RULE_FIELD_ERROR: ${label}.pathPattern must be a non-empty string.`,
    );
  }
  if (
    value.pathAccess !== undefined
    && value.pathAccess !== "read"
    && value.pathAccess !== "write"
    && value.pathAccess !== "any"
  ) {
    errors.push(
      `POLICY_RULE_FIELD_ERROR: ${label}.pathAccess must be "read", "write", or "any".`,
    );
  }
  if (value.pathAccess !== undefined && !hasPathPattern) {
    errors.push(
      `POLICY_RULE_FIELD_ERROR: ${label}.pathAccess requires pathPattern.`,
    );
  }
}

function validateRule(
  value: unknown,
  ruleIndex: number,
  errors: string[],
  seenIds: Set<string>,
): void {
  const label = `rules[${ruleIndex}]`;
  if (!isPlainObject(value)) {
    errors.push(`POLICY_RULE_TYPE_ERROR: ${label} must be an object.`);
    return;
  }

  if (!isNonEmptyString(value.id)) {
    errors.push(`POLICY_RULE_FIELD_ERROR: ${label}.id must be a non-empty string.`);
  } else if (seenIds.has(value.id)) {
    errors.push(`POLICY_DUPLICATE_RULE_ID_ERROR: duplicate rule id "${value.id}".`);
  } else {
    seenIds.add(value.id);
  }

  if (!isNonEmptyString(value.description)) {
    errors.push(
      `POLICY_RULE_FIELD_ERROR: ${label}.description must be a non-empty string.`,
    );
  }
  if (value.action !== "block" && value.action !== "flag") {
    errors.push(
      `POLICY_RULE_FIELD_ERROR: ${label}.action must be "block" or "flag".`,
    );
  }
  if (typeof value.enabled !== "boolean") {
    errors.push(`POLICY_RULE_FIELD_ERROR: ${label}.enabled must be a boolean.`);
  }
  validateMatcher(value.match, ruleIndex, errors);
}

export function validatePolicyDoc(candidate: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(candidate)) {
    return ["POLICY_DOCUMENT_TYPE_ERROR: policy must be an object."];
  }

  if (candidate.schema_version !== POLICY_SCHEMA_VERSION) {
    errors.push(
      `POLICY_SCHEMA_VERSION_ERROR: schema_version must be "${POLICY_SCHEMA_VERSION}".`,
    );
  }
  if (!Array.isArray(candidate.rules)) {
    errors.push("POLICY_RULES_TYPE_ERROR: rules must be an array.");
    return errors;
  }

  const seenIds = new Set<string>();
  candidate.rules.forEach((rule: unknown, index: number): void => {
    validateRule(rule, index, errors, seenIds);
  });
  return errors;
}

function invalidPolicy(path: string, error: string): PolicyLoadResult {
  return {
    state: "invalid",
    policy: FLAG_ONLY_BASELINE,
    path,
    error,
  };
}

export function loadPolicy(path: string): PolicyLoadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return { state: "default", policy: DEFAULT_POLICY, path };
    }
    if (code === "EISDIR" || code === "ENOTDIR") {
      return invalidPolicy(
        path,
        `POLICY_PATH_TYPE_ERROR: policy path is not a readable file: ${errorMessage(error)}`,
      );
    }
    return invalidPolicy(
      path,
      `POLICY_READ_ERROR: policy file cannot be read: ${errorMessage(error)}`,
    );
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    return invalidPolicy(
      path,
      `POLICY_JSON_ERROR: policy file contains invalid JSON: ${errorMessage(error)}`,
    );
  }

  const errors = validatePolicyDoc(candidate);
  if (errors.length > 0) {
    return invalidPolicy(path, errors.join(" "));
  }
  return { state: "loaded", policy: candidate as PolicyDoc, path };
}

function regexMatches(source: string, candidate: string): boolean {
  try {
    return new RegExp(source, "i").test(candidate);
  } catch {
    return false;
  }
}

function escapeRegexCharacter(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character)
    ? `\\${character}`
    : character;
}

function globRegexSource(glob: string): string {
  const normalizedGlob = glob.replace(/\\/gu, "/");
  let source = "^";

  for (let index = 0; index < normalizedGlob.length; index += 1) {
    const character = normalizedGlob[index];
    if (character === undefined) {
      continue;
    }
    if (character === "*") {
      const nextCharacter = normalizedGlob[index + 1];
      if (nextCharacter === "*") {
        const afterDoubleStar = normalizedGlob[index + 2];
        if (afterDoubleStar === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegexCharacter(character);
    }
  }

  return `${source}$`;
}

export function globMatches(glob: string, candidatePath: string): boolean {
  const normalizedCandidate = candidatePath.replace(/\\/gu, "/");
  return new RegExp(globRegexSource(glob)).test(normalizedCandidate);
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/gu, "/");
}

/**
 * The path's form relative to `repoRoot`, or null when it does not live under
 * that root. Deliberately string-based: `path.relative` resolves a relative
 * input against `process.cwd()`, which in a hook process is the agent's
 * directory, not the repo we are reasoning about.
 */
function repoRelativePath(
  candidatePath: string,
  repoRoot: string,
): string | null {
  if (!isAbsolute(candidatePath) || !isAbsolute(repoRoot)) {
    return null;
  }
  const normalizedRoot = normalizeSeparators(repoRoot).replace(/\/+$/u, "");
  const normalizedCandidate = normalizeSeparators(candidatePath);
  const prefix = `${normalizedRoot}/`;
  return normalizedCandidate.startsWith(prefix)
    ? normalizedCandidate.slice(prefix.length)
    : null;
}

/**
 * Match a user-authored glob against a runtime path on BOTH bases.
 *
 * Runtime paths arrive absolute (a harness reports `/abs/repo/secrets/key.pem`)
 * while humans naturally write repo-relative globs (`secrets/**`). Matching only
 * the absolute form makes every relative pattern silently never fire — a
 * safety rule that looks configured but is dead. So a pattern matches when it
 * matches the absolute path OR the path's repo-relative form.
 *
 * When no repo root is known, only the absolute form can be compared; patterns
 * intended to be repo-relative should be written with a leading `**\/` to stay
 * portable, which is why every shipped default rule does.
 */
export function pathMatchesGlob(
  glob: string,
  candidatePath: string,
  repoRoot?: string,
): boolean {
  if (globMatches(glob, candidatePath)) {
    return true;
  }
  if (repoRoot === undefined || repoRoot.length === 0) {
    return false;
  }
  const relativeForm = repoRelativePath(candidatePath, repoRoot);
  return relativeForm !== null && globMatches(glob, relativeForm);
}

function candidatePaths(
  access: PathAccess,
  candidate: PolicyCandidate,
): string[] {
  if (access === "read") {
    return candidate.readPaths;
  }
  if (access === "write") {
    return candidate.writePaths;
  }
  return [...candidate.readPaths, ...candidate.writePaths];
}

function matchRule(
  rule: PolicyRule,
  candidate: PolicyCandidate,
): RuleMatchResult | null {
  const evidenceParts: string[] = [];
  if (rule.match.toolNamePattern !== undefined) {
    if (!regexMatches(rule.match.toolNamePattern, candidate.toolName)) {
      return null;
    }
    evidenceParts.push(`tool=${candidate.toolName}`);
  }

  if (rule.match.commandPattern !== undefined) {
    if (!regexMatches(rule.match.commandPattern, candidate.command)) {
      return null;
    }
    evidenceParts.push(`command=${candidate.command}`);
  }

  if (rule.match.pathPattern !== undefined) {
    const access = rule.match.pathAccess ?? "any";
    const pathPattern = rule.match.pathPattern;
    const matchedPath = candidatePaths(access, candidate).find(
      (path: string): boolean =>
        pathMatchesGlob(pathPattern, path, candidate.repoRoot),
    );
    if (matchedPath === undefined) {
      return null;
    }
    evidenceParts.push(`${access}-path=${matchedPath}`);
  }

  return { evidenceParts };
}

function comparePolicyMatches(
  left: PolicyMatch,
  right: PolicyMatch,
): number {
  if (left.action !== right.action) {
    return left.action === "block" ? -1 : 1;
  }
  if (left.ruleId === right.ruleId) {
    return 0;
  }
  return left.ruleId < right.ruleId ? -1 : 1;
}

export interface PolicyCandidate {
  toolName: string;
  command: string;
  readPaths: string[];
  writePaths: string[];
  /**
   * Repo the action happened in, when known. Lets a user-authored relative
   * pathPattern (`secrets/**`) match an absolute runtime path. Absent means
   * only the absolute form is compared.
   */
  repoRoot?: string;
}

export interface PolicyMatch {
  ruleId: string;
  action: PolicyAction;
  description: string;
  evidence: string;
}

export function matchPolicy(
  policy: PolicyDoc,
  candidate: PolicyCandidate,
  options?: { includeDisabled?: boolean },
): PolicyMatch[] {
  const matches: PolicyMatch[] = [];
  for (const rule of policy.rules) {
    if (!rule.enabled && options?.includeDisabled !== true) {
      continue;
    }
    const result = matchRule(rule, candidate);
    if (result === null) {
      continue;
    }
    matches.push({
      ruleId: rule.id,
      action: rule.action,
      description: rule.description,
      evidence: redactSummary(result.evidenceParts.join("; ")),
    });
  }
  return matches.sort(comparePolicyMatches);
}
