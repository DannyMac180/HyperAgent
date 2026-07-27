import { randomUUID } from "node:crypto";
import {
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type {
  InjectAdapter,
  InjectionResult,
} from "../types.ts";
import {
  applyManagedBlock,
  renderMemoryBlockBody,
  validateTargetRepo,
} from "../../memory/inject.ts";
import type { MemoryRow } from "../../memory/store.ts";

const TARGET_FILENAME = "CLAUDE.local.md";

export interface ClaudeCodeInjectAdapterOptions {
  homeDir?: string;
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
      // ENOENT means the failed write never left a temp file to clean up.
    }

    const cleanupDetail = cleanupFailure === undefined
      ? ""
      : ` Temp-file cleanup also failed: ${cleanupFailure}`;
    return {
      ok: false,
      reason: `Atomic write failed for ${targetPath}: ${errorMessage(error)}.${cleanupDetail}`,
    };
  }
}

export class ClaudeCodeInjectAdapter implements InjectAdapter {
  readonly vendor = "claude-code";
  private readonly homeDir: string | undefined;

  constructor(options: ClaudeCodeInjectAdapterOptions = {}) {
    this.homeDir = options.homeDir;
  }

  async renderInjection(
    targetRepo: string,
    memories: MemoryRow[],
  ): Promise<InjectionResult> {
    const validation = validateTargetRepo(targetRepo, {
      homeDir: this.homeDir,
    });
    if (!validation.ok) {
      return {
        targetPath: join(targetRepo, TARGET_FILENAME),
        changed: false,
        reason: validation.reason,
      };
    }

    // CLAUDE.md is commonly committed and could exfiltrate personal memories
    // to remotes or collaborators. Claude Code reads CLAUDE.local.md, whose
    // local-only convention makes it the deliberate injection target.
    const targetPath = join(validation.repoPath, TARGET_FILENAME);
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
          reason: `Failed to read injection target ${targetPath}: ${errorMessage(error)}`,
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
