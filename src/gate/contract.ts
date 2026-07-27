import { readFileSync } from "node:fs";

import { contractPath } from "./paths.ts";
import { globMatches } from "./policy.ts";

export const CONTRACT_SCHEMA_VERSION = "0.1.0";

export interface RequiredCheck {
  id: string;
  description: string;
  commandPattern: string;
}

export interface VerificationContract {
  schema_version: string;
  requiredChecks: RequiredCheck[];
  protectedPaths: string[];
}

export type ContractLoadState = "absent" | "loaded" | "invalid";

export interface ContractLoadResult {
  state: ContractLoadState;
  contract: VerificationContract | null;
  path: string;
  error?: string;
}

export interface SessionGateContext {
  commands: Array<{ command: string; passed: boolean; sequence: number }>;
  touchedFiles: Array<{ path: string; sequence: number }>;
}

export interface ContractFailure {
  checkId: string;
  reason: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: object | null = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

function validateRequiredCheck(
  value: unknown,
  index: number,
  errors: string[],
  seenIds: Set<string>,
): void {
  const label = `requiredChecks[${index}]`;
  if (!isPlainObject(value)) {
    errors.push(`CONTRACT_CHECK_TYPE_ERROR: ${label} must be an object.`);
    return;
  }

  if (!isNonEmptyString(value.id)) {
    errors.push(
      `CONTRACT_CHECK_FIELD_ERROR: ${label}.id must be a non-empty string.`,
    );
  } else if (seenIds.has(value.id)) {
    errors.push(
      `CONTRACT_DUPLICATE_CHECK_ID_ERROR: duplicate required check id "${value.id}".`,
    );
  } else {
    seenIds.add(value.id);
  }

  if (!isNonEmptyString(value.description)) {
    errors.push(
      `CONTRACT_CHECK_FIELD_ERROR: ${label}.description must be a non-empty string.`,
    );
  }
  if (!isNonEmptyString(value.commandPattern)) {
    errors.push(
      `CONTRACT_CHECK_FIELD_ERROR: ${label}.commandPattern must be a non-empty string.`,
    );
  } else {
    try {
      new RegExp(value.commandPattern, "i");
    } catch (error: unknown) {
      errors.push(
        `CONTRACT_REGEX_ERROR: ${label}.commandPattern is not a valid regular expression: ${errorMessage(error)}`,
      );
    }
  }
}

export function validateContractDoc(candidate: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(candidate)) {
    return ["CONTRACT_DOCUMENT_TYPE_ERROR: contract must be an object."];
  }

  if (candidate.schema_version !== CONTRACT_SCHEMA_VERSION) {
    errors.push(
      `CONTRACT_SCHEMA_VERSION_ERROR: schema_version must be "${CONTRACT_SCHEMA_VERSION}".`,
    );
  }
  if (!Array.isArray(candidate.requiredChecks)) {
    errors.push(
      "CONTRACT_REQUIRED_CHECKS_TYPE_ERROR: requiredChecks must be an array.",
    );
  } else {
    const seenIds = new Set<string>();
    candidate.requiredChecks.forEach((check: unknown, index: number): void => {
      validateRequiredCheck(check, index, errors, seenIds);
    });
  }

  if (!Array.isArray(candidate.protectedPaths)) {
    errors.push(
      "CONTRACT_PROTECTED_PATHS_TYPE_ERROR: protectedPaths must be an array.",
    );
  } else {
    candidate.protectedPaths.forEach((path: unknown, index: number): void => {
      if (!isNonEmptyString(path)) {
        errors.push(
          `CONTRACT_PROTECTED_PATH_FIELD_ERROR: protectedPaths[${index}] must be a non-empty string.`,
        );
      }
    });
  }
  return errors;
}

function invalidContract(path: string, error: string): ContractLoadResult {
  return {
    state: "invalid",
    contract: null,
    path,
    error,
  };
}

export function loadContract(repoPath: string): ContractLoadResult {
  let path: string;
  try {
    path = contractPath(repoPath);
  } catch (error: unknown) {
    return invalidContract(
      String(repoPath),
      `CONTRACT_PATH_ERROR: contract path cannot be resolved: ${errorMessage(error)}`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return { state: "absent", contract: null, path };
    }
    if (code === "EISDIR" || code === "ENOTDIR") {
      return invalidContract(
        path,
        `CONTRACT_PATH_TYPE_ERROR: contract path is not a readable file: ${errorMessage(error)}`,
      );
    }
    return invalidContract(
      path,
      `CONTRACT_READ_ERROR: contract file cannot be read: ${errorMessage(error)}`,
    );
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    return invalidContract(
      path,
      `CONTRACT_JSON_ERROR: contract file contains invalid JSON: ${errorMessage(error)}`,
    );
  }

  const errors = validateContractDoc(candidate);
  if (errors.length > 0) {
    return invalidContract(path, errors.join(" "));
  }
  return {
    state: "loaded",
    contract: candidate as VerificationContract,
    path,
  };
}

function commandMatches(source: string, command: string): boolean {
  try {
    return new RegExp(source, "i").test(command);
  } catch {
    return false;
  }
}

function lastMutationSequence(context: SessionGateContext): number {
  let lastSequence = Number.NEGATIVE_INFINITY;
  for (const touchedFile of context.touchedFiles) {
    if (touchedFile.sequence > lastSequence) {
      lastSequence = touchedFile.sequence;
    }
  }
  return lastSequence;
}

export function evaluateContract(
  contract: VerificationContract,
  context: SessionGateContext,
): ContractFailure[] {
  const failures: ContractFailure[] = [];
  // Verification must follow the last mutation; an earlier passing check says
  // nothing about the final file state.
  const requiredAfterSequence = lastMutationSequence(context);
  // A session that mutated nothing has nothing to verify, so required checks
  // are vacuously satisfied. Demanding tests from a read-only session would be
  // a false bounce of exactly the kind protectedPaths avoids by ignoring
  // pre-session dirt.
  const mutatedSomething = context.touchedFiles.length > 0;

  for (const check of mutatedSomething ? contract.requiredChecks : []) {
    const passedAfterLastMutation = context.commands.some(
      (command): boolean =>
        command.passed
        && command.sequence > requiredAfterSequence
        && commandMatches(check.commandPattern, command.command),
    );
    if (!passedAfterLastMutation) {
      failures.push({
        checkId: check.id,
        reason: `Required check failed: ${check.description} (${check.id}).`,
      });
    }
  }

  for (const touchedFile of context.touchedFiles) {
    const isProtected = contract.protectedPaths.some(
      (pattern: string): boolean => globMatches(pattern, touchedFile.path),
    );
    if (isProtected) {
      failures.push({
        checkId: "protected-path",
        reason: `Protected path was touched: ${touchedFile.path}.`,
      });
    }
  }

  return failures;
}
