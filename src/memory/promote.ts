import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { MemoryKind } from "./store.ts";

export interface PromotionConfig {
  autoPromoteFactual: boolean;
}

export interface PromotionConfigReadResult {
  config: PromotionConfig;
  reason: string | null;
}

const DEFAULT_PROMOTION_CONFIG: PromotionConfig = {
  autoPromoteFactual: false,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPromotionConfigResult(
  configPath: string = join(homedir(), ".hyperagent", "config.json"),
): PromotionConfigReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch (error: unknown) {
    return {
      config: { ...DEFAULT_PROMOTION_CONFIG },
      reason: `promotion config unavailable or malformed: ${errorMessage(error)}`,
    };
  }
  if (
    !isRecord(parsed)
    || typeof parsed.autoPromoteFactual !== "boolean"
  ) {
    return {
      config: { ...DEFAULT_PROMOTION_CONFIG },
      reason: "promotion config autoPromoteFactual must be a boolean",
    };
  }
  return {
    config: { autoPromoteFactual: parsed.autoPromoteFactual },
    reason: null,
  };
}

export function readPromotionConfig(configPath?: string): PromotionConfig {
  return readPromotionConfigResult(configPath).config;
}

export function shouldAutoPromote(
  candidate: { kind: MemoryKind; confidence: number },
  config: PromotionConfig,
): boolean {
  if (candidate.kind === "behavior" || candidate.kind === "preference") {
    return false;
  }
  return config.autoPromoteFactual === true && candidate.confidence >= 0.8;
}
