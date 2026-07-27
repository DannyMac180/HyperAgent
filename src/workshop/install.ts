import {
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  CONTRACT_SCHEMA_VERSION,
  loadContract,
  validateContractDoc,
} from "../gate/contract.ts";
import type { VerificationContract } from "../gate/contract.ts";
import { contractPath } from "../gate/paths.ts";
import { validateTargetRepo } from "../memory/inject.ts";
import {
  claimHash,
  openMemoryStore,
} from "../memory/store.ts";
import type {
  AddMemoryInput,
  MemoryStore,
} from "../memory/store.ts";
import {
  renderPredicateForContract,
} from "./predicates.ts";
import type { PredicateRender } from "./predicates.ts";
import {
  verifyContentHash,
} from "./queue.ts";
import type { WorkshopProposalRow } from "./queue.ts";

export type InstallMode = "automatic" | "manual";

export interface InstallReceipt {
  proposalId: string;
  contentHash: string;
  mode: InstallMode;
  installedAt: string;
  /** Exactly what was written where — empty for manual installs. */
  writes: Array<{ target: string; description: string }>;
  /** For manual installs: the rendered artifact for a human to place. */
  renderedArtifact: string | null;
  notes: string[];
}

export type InstallOutcome =
  | { ok: true; receipt: InstallReceipt }
  | { ok: false; reason: string; code: InstallFailureCode };

export type InstallFailureCode =
  | "not_approved"
  | "hash_mismatch"
  | "repo_ineligible"
  | "unrenderable"
  | "duplicate_check_id"
  | "write_failed"
  | "unsupported";

type InstallMemoryStore = Pick<
  MemoryStore,
  "addManual" | "close" | "listMemories"
>;

export interface InstallDeps {
  memoryStore?: InstallMemoryStore;
  openMemoryStore?: typeof openMemoryStore;
  validateTargetRepo?: typeof validateTargetRepo;
  loadContract?: typeof loadContract;
  contractPath?: typeof contractPath;
  renderPredicateForContract?: typeof renderPredicateForContract;
  verifyContentHash?: typeof verifyContentHash;
  writeContractAtomically?: (
    target: string,
    content: string,
    proposalId: string,
  ) => void;
  now?: () => Date;
}

export interface InstallOptions {
  targetRepo?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function failure(
  code: InstallFailureCode,
  reason: string,
): InstallOutcome {
  return { ok: false, code, reason };
}

function installedAt(deps: InstallDeps): string {
  const date = (deps.now ?? ((): Date => new Date()))();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error("install now() must return a valid Date");
  }
  return date.toISOString();
}

function automaticReceipt(
  row: WorkshopProposalRow,
  deps: InstallDeps,
  writes: InstallReceipt["writes"],
  notes: string[] = [],
): InstallReceipt {
  return {
    proposalId: row.id,
    contentHash: row.contentHash,
    mode: "automatic",
    installedAt: installedAt(deps),
    writes,
    renderedArtifact: null,
    notes,
  };
}

function manualReceipt(
  row: WorkshopProposalRow,
  deps: InstallDeps,
  renderedArtifact: string,
): InstallReceipt {
  return {
    proposalId: row.id,
    contentHash: row.contentHash,
    mode: "manual",
    installedAt: installedAt(deps),
    writes: [],
    renderedArtifact,
    notes: ["A human must place the rendered artifact in the approved target."],
  };
}

function verifyImmediatelyBeforeWrite(
  row: WorkshopProposalRow,
  deps: InstallDeps,
): InstallOutcome | null {
  const result = (deps.verifyContentHash ?? verifyContentHash)(row);
  if (result.ok) {
    return null;
  }
  return failure(
    "hash_mismatch",
    `Proposal content hash mismatch: expected ${result.expected}, got ${result.actual}.`,
  );
}

function renderEvidenceRawRef(row: WorkshopProposalRow): string {
  return JSON.stringify({
    clusterSignature: row.evidence.clusterSignature,
    eventIds: row.evidence.eventIds,
  });
}

function memoryInput(row: WorkshopProposalRow): AddMemoryInput | null {
  if (row.body.type !== "memory" || row.evidence.sessionIds.length === 0) {
    return null;
  }
  const scope = row.repo !== null
    ? "repo"
    : row.agent !== null
      ? "agent"
      : "global";
  const scopeKey = scope === "repo"
    ? row.repo
    : scope === "agent"
      ? row.agent
      : null;
  const rawRef = renderEvidenceRawRef(row);
  return {
    claim: row.body.content,
    kind: "behavior",
    scope,
    scope_key: scopeKey,
    confidence: 1,
    evidence: row.evidence.sessionIds.map(
      (sessionId: string): AddMemoryInput["evidence"][number] => ({
        session_id: sessionId,
        raw_ref: rawRef,
      }),
    ),
    source: "manual",
  };
}

function installMemory(
  row: WorkshopProposalRow,
  deps: InstallDeps,
): InstallOutcome {
  const input = memoryInput(row);
  if (input === null) {
    return failure(
      "unsupported",
      "Memory proposals require memory content and at least one evidence session.",
    );
  }

  const suppliedStore = deps.memoryStore;
  const store = suppliedStore
    ?? (deps.openMemoryStore ?? openMemoryStore)();
  const ownsStore = suppliedStore === undefined;
  const expectedClaimHash = claimHash(input.claim);
  try {
    const existing = store.listMemories().find(
      (memory): boolean => memory.claim_hash === expectedClaimHash,
    );
    const hashFailure = verifyImmediatelyBeforeWrite(row, deps);
    if (hashFailure !== null) {
      return hashFailure;
    }
    if (existing !== undefined) {
      return {
        ok: true,
        receipt: automaticReceipt(row, deps, [], [
          `Memory claim ${expectedClaimHash} already exists; no write was needed.`,
        ]),
      };
    }

    // addManual commits the SQLite row before writing its mirror. If the mirror
    // write crashes, the claim-hash lookup above makes the retry a safe no-op.
    store.addManual(input);
    return {
      ok: true,
      receipt: automaticReceipt(
        row,
        deps,
        [{
          target: `memory:${expectedClaimHash}`,
          description: "Added an approved memory and its managed mirror.",
        }],
      ),
    };
  } catch (error: unknown) {
    return failure(
      "write_failed",
      `Memory install failed: ${errorMessage(error)}`,
    );
  } finally {
    if (ownsStore) {
      store.close();
    }
  }
}

function defaultWriteContractAtomically(
  target: string,
  content: string,
  proposalId: string,
): void {
  const safeProposalId = proposalId.replace(/[^a-zA-Z0-9_-]/gu, "_");
  const temporaryPath = `${target}.${safeProposalId}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temporaryPath, content, "utf8");
  renameSync(temporaryPath, target);
}

function sameRequiredCheck(
  left: VerificationContract["requiredChecks"][number],
  right: VerificationContract["requiredChecks"][number],
): boolean {
  return left.id === right.id
    && left.description === right.description
    && left.commandPattern === right.commandPattern;
}

function mergePredicate(
  contract: VerificationContract,
  rendered: PredicateRender,
): VerificationContract {
  if (rendered.kind === "required_check") {
    return {
      ...contract,
      requiredChecks: [...contract.requiredChecks, rendered.check],
      protectedPaths: [...contract.protectedPaths],
    };
  }
  if (rendered.kind === "protected_path") {
    return {
      ...contract,
      requiredChecks: [...contract.requiredChecks],
      protectedPaths: [...contract.protectedPaths, rendered.path],
    };
  }
  return contract;
}

function installVerificationCheck(
  row: WorkshopProposalRow,
  deps: InstallDeps,
  options: InstallOptions,
): InstallOutcome {
  if (row.body.type !== "verification_check") {
    return failure(
      "unsupported",
      "Verification-check proposal body does not match its proposal type.",
    );
  }
  const candidateRepo = options.targetRepo ?? row.repo;
  if (candidateRepo === null || candidateRepo === undefined) {
    return failure(
      "repo_ineligible",
      "Verification-check install requires a target repo.",
    );
  }
  const targetValidation = (
    deps.validateTargetRepo ?? validateTargetRepo
  )(candidateRepo);
  if (!targetValidation.ok) {
    return failure("repo_ineligible", targetValidation.reason);
  }

  const rendered = (
    deps.renderPredicateForContract ?? renderPredicateForContract
  )(row.body.predicate, row.id, row.body.description);
  if (rendered.kind === "unrenderable") {
    return failure("unrenderable", rendered.reason);
  }

  const loadResult = (
    deps.loadContract ?? loadContract
  )(targetValidation.repoPath);
  if (loadResult.state === "invalid") {
    return failure(
      "write_failed",
      loadResult.error ?? `Existing contract is invalid: ${loadResult.path}`,
    );
  }
  const current: VerificationContract = loadResult.contract ?? {
    schema_version: CONTRACT_SCHEMA_VERSION,
    requiredChecks: [],
    protectedPaths: [],
  };

  if (rendered.kind === "required_check") {
    const duplicate = current.requiredChecks.find(
      (check): boolean => check.id === rendered.check.id,
    );
    if (duplicate !== undefined) {
      if (!sameRequiredCheck(duplicate, rendered.check)) {
        return failure(
          "duplicate_check_id",
          `Required check id "${rendered.check.id}" already exists.`,
        );
      }
      const hashFailure = verifyImmediatelyBeforeWrite(row, deps);
      if (hashFailure !== null) {
        return hashFailure;
      }
      return {
        ok: true,
        receipt: automaticReceipt(row, deps, [], [
          `Required check "${rendered.check.id}" already matches the approved proposal; no write was needed.`,
        ]),
      };
    }
  }

  if (
    rendered.kind === "protected_path"
    && current.protectedPaths.includes(rendered.path)
  ) {
    const hashFailure = verifyImmediatelyBeforeWrite(row, deps);
    if (hashFailure !== null) {
      return hashFailure;
    }
    return {
      ok: true,
      receipt: automaticReceipt(row, deps, [], [
        `Protected path "${rendered.path}" already exists; no write was needed.`,
      ]),
    };
  }

  const merged = mergePredicate(current, rendered);
  const validationErrors = validateContractDoc(merged);
  if (validationErrors.length > 0) {
    return failure(
      "write_failed",
      `Merged contract is invalid: ${validationErrors.join(" ")}`,
    );
  }
  const target = (
    deps.contractPath ?? contractPath
  )(targetValidation.repoPath);
  const content = `${JSON.stringify(merged, null, 2)}\n`;
  const hashFailure = verifyImmediatelyBeforeWrite(row, deps);
  if (hashFailure !== null) {
    return hashFailure;
  }

  try {
    // The deterministic temp file is replaced on retry, and rename commits the
    // complete validated document atomically. Exact-match detection above
    // recovers a crash after rename but before the caller stores the receipt.
    (
      deps.writeContractAtomically ?? defaultWriteContractAtomically
    )(target, content, row.id);
  } catch (error: unknown) {
    return failure(
      "write_failed",
      `Contract write failed: ${errorMessage(error)}`,
    );
  }
  const description = rendered.kind === "required_check"
    ? `Appended required check "${rendered.check.id}".`
    : `Appended protected path "${rendered.path}".`;
  return {
    ok: true,
    receipt: automaticReceipt(
      row,
      deps,
      [{ target, description }],
    ),
  };
}

function installManual(
  row: WorkshopProposalRow,
  deps: InstallDeps,
): InstallOutcome {
  if (
    row.body.type !== "instruction_edit"
    && row.body.type !== "skill"
  ) {
    return failure(
      "unsupported",
      "Manual proposal body does not match its proposal type.",
    );
  }
  const hashFailure = verifyImmediatelyBeforeWrite(row, deps);
  if (hashFailure !== null) {
    return hashFailure;
  }
  return {
    ok: true,
    receipt: manualReceipt(row, deps, row.body.content),
  };
}

export function installProposal(
  row: WorkshopProposalRow,
  deps: InstallDeps,
  options: InstallOptions = {},
): InstallOutcome {
  if (!isPlainObject(deps) || !isPlainObject(options)) {
    return failure("unsupported", "Install dependencies and options must be objects.");
  }
  if (row.status !== "approved") {
    return failure(
      "not_approved",
      `Proposal ${row.id} has status "${row.status}", not "approved".`,
    );
  }

  try {
    switch (row.type) {
      case "memory":
        return installMemory(row, deps);
      case "verification_check":
        return installVerificationCheck(row, deps, options);
      case "instruction_edit":
      case "skill":
        return installManual(row, deps);
    }
  } catch (error: unknown) {
    return failure(
      "unsupported",
      `Proposal could not be installed: ${errorMessage(error)}`,
    );
  }
}
