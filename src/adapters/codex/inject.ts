import { randomUUID } from "node:crypto";
import {
  realpathSync,
} from "node:fs";
import {
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  join,
  resolve,
  sep,
} from "node:path";

import type {
  InjectAdapter,
  InjectionResult,
} from "../types.ts";
import {
  applyManagedBlock,
  renderMemoryBlockBody,
  validateTargetRepo,
} from "../../memory/inject.ts";
import type {
  TargetValidation,
} from "../../memory/inject.ts";
import type { MemoryRow } from "../../memory/store.ts";

const TARGET_FILENAME = "AGENTS.md";
const OPERATION_TIMEOUT_MS = 5_000;

export interface CodexInjectAdapterOptions {
  homeDir?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

async function bounded<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject): void => {
    timer = setTimeout((): void => {
      reject(new Error(`${label} timed out after ${OPERATION_TIMEOUT_MS}ms`));
    }, OPERATION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operation(), timeout]);
  } catch (error: unknown) {
    throw new Error(`${label} failed: ${errorMessage(error)}`);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function isAtOrUnder(candidate: string, directory: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}${sep}`);
}

function canonicalCodexDirectory(homeDir: string): string {
  const candidate: string = join(homeDir, ".codex");
  try {
    return realpathSync(candidate);
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
    return resolve(realpathSync(homeDir), ".codex");
  }
}

function validateCodexTarget(
  candidate: string,
  homeDir: string | undefined,
): TargetValidation {
  const validation: TargetValidation = validateTargetRepo(candidate, {
    ...(homeDir === undefined ? {} : { homeDir }),
  });
  if (!validation.ok) {
    return validation;
  }

  let codexDirectory: string;
  try {
    codexDirectory = canonicalCodexDirectory(homeDir ?? homedir());
  } catch (error: unknown) {
    return {
      ok: false,
      reason:
        `Protected Codex directory cannot be canonicalized: ` +
        errorMessage(error),
    };
  }
  if (isAtOrUnder(validation.repoPath, codexDirectory)) {
    return {
      ok: false,
      reason:
        `Refused target at or under Codex data directory ${codexDirectory}.`,
    };
  }
  return validation;
}

async function atomicWrite(
  targetPath: string,
  content: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(tempPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(tempPath, targetPath);
    return { ok: true };
  } catch (error: unknown) {
    let cleanupFailure: string | undefined;
    try {
      await unlink(tempPath);
    } catch (cleanupError: unknown) {
      if (errorCode(cleanupError) !== "ENOENT") {
        cleanupFailure = errorMessage(cleanupError);
      }
      // ENOENT means the failed write left no temporary file to remove.
    }

    const cleanupDetail: string =
      cleanupFailure === undefined
        ? ""
        : ` Temp-file cleanup also failed: ${cleanupFailure}`;
    return {
      ok: false,
      reason:
        `Atomic write failed for ${targetPath}: ${errorMessage(error)}.` +
        cleanupDetail,
    };
  }
}

export class CodexInjectAdapter implements InjectAdapter {
  readonly vendor = "codex";
  private readonly homeDir: string | undefined;

  constructor(options: CodexInjectAdapterOptions = {}) {
    this.homeDir = options.homeDir;
  }

  async renderInjection(
    targetRepo: string,
    memories: MemoryRow[],
  ): Promise<InjectionResult> {
    return bounded(
      `Codex injection for ${JSON.stringify(targetRepo)}`,
      async (): Promise<InjectionResult> =>
        this.renderInjectionWithinTimeout(targetRepo, memories),
    );
  }

  /**
   * All asynchronous filesystem work in this method runs inside the public
   * renderInjection timeout. Keeping the operations together also guarantees
   * that validation, read, edit, and atomic replacement describe one target.
   */
  private async renderInjectionWithinTimeout(
    targetRepo: string,
    memories: MemoryRow[],
  ): Promise<InjectionResult> {
    const validation: TargetValidation = validateCodexTarget(
      targetRepo,
      this.homeDir,
    );
    if (!validation.ok) {
      return {
        targetPath: join(targetRepo, TARGET_FILENAME),
        changed: false,
        reason: validation.reason,
      };
    }

    /*
     * Unlike Claude Code's CLAUDE.local.md, Codex's AGENTS.md is typically a
     * tracked repository instruction file. HyperAgent therefore owns only its
     * delimited block and deliberately adds no .gitignore entry or local-file
     * machinery; user-authored tracked bytes outside the block must survive.
     */
    const targetPath: string = join(validation.repoPath, TARGET_FILENAME);
    let existingContent: string;
    try {
      existingContent = await readFile(targetPath, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") {
        existingContent = "";
      } else {
        return {
          targetPath,
          changed: false,
          reason:
            `Failed to read injection target ${targetPath}: ` +
            errorMessage(error),
        };
      }
    }

    const edit = applyManagedBlock(
      existingContent,
      renderMemoryBlockBody(memories),
    );
    if (!edit.ok) {
      return {
        targetPath,
        changed: false,
        reason: edit.reason,
      };
    }
    if (edit.content === existingContent) {
      return {
        targetPath,
        changed: false,
        reason: "Injection target is already byte-identical.",
      };
    }

    const writeResult = await atomicWrite(targetPath, edit.content);
    if (!writeResult.ok) {
      return {
        targetPath,
        changed: false,
        reason: writeResult.reason,
      };
    }
    return {
      targetPath,
      changed: true,
    };
  }
}
