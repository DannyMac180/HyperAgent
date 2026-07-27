import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readPromotionConfig,
  readPromotionConfigResult,
  shouldAutoPromote,
} from "./promote.ts";
import type { MemoryKind } from "./store.ts";

const tempDirectories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "hyperagent-promote-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach((): void => {
  for (const directory of tempDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("promotion policy", (): void => {
  test("truth table covers every kind, flag, and confidence", (): void => {
    const kinds: MemoryKind[] = [
      "factual",
      "gotcha",
      "preference",
      "behavior",
    ];
    for (const kind of kinds) {
      for (const autoPromoteFactual of [true, false]) {
        for (const confidence of [0.9, 0.79]) {
          const expected = (
            kind === "factual" || kind === "gotcha"
          ) && autoPromoteFactual === true && confidence >= 0.8;
          expect(
            shouldAutoPromote(
              { kind, confidence },
              { autoPromoteFactual },
            ),
          ).toBe(expected);
        }
      }
    }
  });

  test("config reader safely handles missing, malformed, wrong typed, and valid files", (): void => {
    const directory = tempDirectory();
    const missing = join(directory, "missing.json");
    expect(readPromotionConfig(missing)).toEqual({
      autoPromoteFactual: false,
    });
    expect(readPromotionConfigResult(missing).reason).toContain("unavailable");

    const malformed = join(directory, "malformed.json");
    writeFileSync(malformed, "{", "utf8");
    expect(readPromotionConfig(malformed)).toEqual({
      autoPromoteFactual: false,
    });

    expect(readPromotionConfig(directory)).toEqual({
      autoPromoteFactual: false,
    });

    const missingKey = join(directory, "missing-key.json");
    writeFileSync(missingKey, "{}", "utf8");
    expect(readPromotionConfig(missingKey)).toEqual({
      autoPromoteFactual: false,
    });

    const wrongType = join(directory, "wrong-type.json");
    writeFileSync(wrongType, '{"autoPromoteFactual":"true"}', "utf8");
    expect(readPromotionConfig(wrongType)).toEqual({
      autoPromoteFactual: false,
    });

    const valid = join(directory, "valid.json");
    writeFileSync(valid, '{"autoPromoteFactual":true}', "utf8");
    expect(readPromotionConfig(valid)).toEqual({
      autoPromoteFactual: true,
    });
    expect(readPromotionConfigResult(valid).reason).toBeNull();
  });
});
