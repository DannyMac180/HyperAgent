import {
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { InjectAdapter } from "../../adapters/types.ts";
import {
  applyManagedBlock,
} from "../../memory/inject.ts";
import type { InjectionResult } from "../../memory/inject.ts";
import type { MemoryRow } from "../../memory/store.ts";
import type {
  ConformanceContext,
  ConformanceDescriptor,
  InjectFixtureSet,
} from "../types.ts";

export type InjectMutation =
  | "none"
  | "round-trip"
  | "idempotency"
  | "removal"
  | "refusal";

const INJECT_MUTATIONS: readonly InjectMutation[] = [
  "none",
  "round-trip",
  "idempotency",
  "removal",
  "refusal",
];
const STUB_VENDOR = "stub";
const STUB_ADAPTER_VERSION = "1.0.0";
const STUB_DIALECT_VERSION = "1";
const STUB_ARTIFACT_NAME = "STUB.md";
const STUB_SENTINEL = "stub-inject-sentinel";
const STUB_FOREIGN_CONTENT = "# User content\n\nThis text is not managed.\n";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    return "unknown thrown value";
  }
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

function requireAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || !isAbsolute(value)
  ) {
    throw new Error(`${label} must be a non-empty absolute path`);
  }
  return resolve(value);
}

function isAtOrUnder(candidate: string, root: string): boolean {
  const pathFromRoot: string = relative(resolve(root), resolve(candidate));
  return (
    pathFromRoot === ""
    || (
      pathFromRoot !== ".."
      && !pathFromRoot.startsWith(`..${sep}`)
      && !isAbsolute(pathFromRoot)
    )
  );
}

function validateMemories(value: unknown): MemoryRow[] {
  if (!Array.isArray(value)) {
    throw new Error("stub inject memories must be an array");
  }
  return value.map((candidate: unknown, index: number): MemoryRow => {
    if (!isPlainObject(candidate)) {
      throw new Error(`stub inject memories[${index}] must be a plain object`);
    }
    if (
      typeof candidate.claim !== "string"
      || candidate.claim.trim().length === 0
    ) {
      throw new Error(
        `stub inject memories[${index}].claim must be a non-empty string`,
      );
    }
    return candidate as unknown as MemoryRow;
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw new Error(
      `stub inject could not inspect ${JSON.stringify(path)}: `
      + errorMessage(error),
    );
  }
}

async function readExisting(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return "";
    }
    throw new Error(
      `stub inject could not read ${JSON.stringify(path)}: `
      + errorMessage(error),
    );
  }
}

class StubInjectAdapter implements InjectAdapter {
  public readonly vendor = STUB_VENDOR;
  private renderCount = 0;

  public constructor(
    private readonly tempRoot: string,
    private readonly refusalRoot: string,
    private readonly mutation: InjectMutation,
  ) {}

  public async renderInjection(
    targetRepo: string,
    memories: MemoryRow[],
  ): Promise<InjectionResult> {
    const repoPath: string = requireAbsolutePath(
      targetRepo,
      "stub inject targetRepo",
    );
    const validatedMemories: MemoryRow[] = validateMemories(memories);
    const targetPath: string = join(repoPath, STUB_ARTIFACT_NAME);

    if (!isAtOrUnder(repoPath, this.tempRoot)) {
      return {
        targetPath,
        changed: false,
        reason: "Refused target outside the conformance temp root.",
      };
    }
    if (!(await pathExists(join(repoPath, ".git")))) {
      return {
        targetPath,
        changed: false,
        reason: "Refused target without a .git entry.",
      };
    }
    const protectedPatterns = [".claude", ".hyperagent"] as const;
    if (this.mutation !== "refusal") {
      for (const pattern of protectedPatterns) {
        if (isAtOrUnder(repoPath, join(this.refusalRoot, pattern))) {
          return {
            targetPath,
            changed: false,
            reason: `Refused target at or under ${pattern}.`,
          };
        }
      }
    }

    const existingContent: string = await readExisting(targetPath);
    if (this.mutation === "removal" && validatedMemories.length === 0) {
      await writeFile(targetPath, "", "utf8");
      return {
        targetPath,
        changed: existingContent.length > 0,
      };
    }

    const blockBody: string = this.mutation === "round-trip"
      ? "round-trip mutant omitted the supplied memories"
      : validatedMemories.map((memory: MemoryRow): string =>
        `- ${memory.claim}`).join("\n");
    const edit = applyManagedBlock(existingContent, blockBody);
    if (!edit.ok) {
      return {
        targetPath,
        changed: false,
        reason: edit.reason,
      };
    }

    this.renderCount += 1;
    const nextContent: string = this.mutation === "idempotency"
      ? `${edit.content}\n${this.renderCount}`
      : edit.content;
    const changed: boolean = nextContent !== existingContent;
    if (changed) {
      try {
        await mkdir(repoPath, { recursive: true });
        await writeFile(targetPath, nextContent, "utf8");
      } catch (error: unknown) {
        throw new Error(
          `stub inject could not write ${JSON.stringify(targetPath)}: `
          + errorMessage(error),
        );
      }
    }
    return { targetPath, changed };
  }
}

function stubMemory(): MemoryRow {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    id: "stub-inject-memory",
    claim: STUB_SENTINEL,
    kind: "factual",
    scope: "global",
    scope_key: null,
    confidence: 1,
    status: "approved",
    evidence: [{ session_id: "stub:inject", raw_ref: null }],
    source: "manual",
    claim_hash: "stub-inject-memory-hash",
    created_at: timestamp,
    updated_at: timestamp,
    last_validated_at: timestamp,
  };
}

async function createInjectFixtures(
  context: ConformanceContext,
  mutation: InjectMutation,
): Promise<InjectFixtureSet> {
  const tempRoot: string = requireAbsolutePath(
    context.tempRoot,
    "context.tempRoot",
  );
  const refusalRoot: string = join(tempRoot, "stub-inject-refusal-home");
  try {
    await mkdir(refusalRoot, { recursive: true });
  } catch (error: unknown) {
    throw new Error(
      `stub refusal root creation failed: ${errorMessage(error)}`,
    );
  }
  return {
    adapter: new StubInjectAdapter(tempRoot, refusalRoot, mutation),
    memories: [stubMemory()],
    sentinel: STUB_SENTINEL,
    managedArtifactPath(repoPath: string): string {
      return join(
        requireAbsolutePath(repoPath, "managedArtifactPath repoPath"),
        STUB_ARTIFACT_NAME,
      );
    },
    foreignContent: STUB_FOREIGN_CONTENT,
    refusalRoot,
  };
}

export function createStubInjectDescriptor(
  mutation: InjectMutation,
): ConformanceDescriptor {
  if (!INJECT_MUTATIONS.includes(mutation)) {
    throw new Error(`unsupported inject mutation: ${String(mutation)}`);
  }
  return {
    vendor: STUB_VENDOR,
    adapterVersion: STUB_ADAPTER_VERSION,
    dialectVersion: STUB_DIALECT_VERSION,
    claimed: {
      observe: false,
      inject: true,
      gate: false,
    },
    storageTraits: { appendOnlyLines: false },
    claimedHookKinds: [],
    forbiddenTargetPatterns: [".claude", ".hyperagent"],
    factories: {
      async inject(context: ConformanceContext): Promise<InjectFixtureSet> {
        return createInjectFixtures(context, mutation);
      },
    },
  };
}
