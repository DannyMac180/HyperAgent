import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GATE_CHECKS } from "../../conformance/checks/gate.ts";
import { INJECT_CHECKS } from "../../conformance/checks/inject.ts";
import { OBSERVE_CHECKS } from "../../conformance/checks/observe.ts";
import { runConformance } from "../../conformance/runner.ts";
import type {
  CheckResult,
  ConformanceReport,
} from "../../conformance/types.ts";
import goldenEvents from "./conformance-golden.json" with { type: "json" };
import {
  CODEX_DIALECT_VERSION,
} from "./adapter.ts";
import { codexConformanceDescriptor } from "./conformance.ts";

const FIXTURE_NAMES = [
  "clean.jsonl",
  "unknown-record.jsonl",
  "corrupted.jsonl",
  "resume-prefix.jsonl",
  "resume-remainder.jsonl",
  "resume-complete.jsonl",
  "truncated.jsonl",
  "truncated-remainder.txt",
] as const;
const CLI_TIMEOUT_MS = 5_000;

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  const cliPath: string = fileURLToPath(
    new URL("../../daemon/cli.ts", import.meta.url),
  );
  const subprocess = Bun.spawn(
    [process.execPath, cliPath, ...args],
    {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject): void => {
    timer = setTimeout((): void => {
      subprocess.kill();
      reject(new Error(`CLI timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);
  });
  try {
    const stdoutPromise: Promise<string> = new Response(
      subprocess.stdout,
    ).text();
    const stderrPromise: Promise<string> = new Response(
      subprocess.stderr,
    ).text();
    return await Promise.race([
      (async (): Promise<CliResult> => ({
        exitCode: await subprocess.exited,
        stdout: await stdoutPromise,
        stderr: await stderrPromise,
      }))(),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function nonPassDetail(checks: CheckResult[]): string {
  return checks
    .map(
      (check: CheckResult): string =>
        `${check.id}: ${check.status} — ${check.detail}`,
    )
    .join("\n");
}

describe("Codex conformance", (): void => {
  test("passes every vendor-blind observe check against the golden", async (): Promise<void> => {
    expect(goldenEvents.length).toBeGreaterThan(0);
    const report: ConformanceReport = await runConformance(
      codexConformanceDescriptor,
      { checks: OBSERVE_CHECKS },
    );

    expect(report.checks.map((check): string => check.id)).toEqual(
      OBSERVE_CHECKS.map((check): string => check.id),
    );
    expect(report.checks).toHaveLength(9);
    const nonPassChecks: CheckResult[] = report.checks.filter(
      (check: CheckResult): boolean => check.status !== "pass",
    );
    expect(
      nonPassChecks,
      `expected all observe checks to pass:\n${nonPassDetail(nonPassChecks)}`,
    ).toEqual([]);
    expect(
      report.checks.find(
        (check: CheckResult): boolean =>
          check.id === "observe.truncation",
      )?.status,
    ).toBe("pass");
    expect(report.verifiedCapabilities).toEqual(["observe"]);
    expect(report.adapterVersion).toBe(
      codexConformanceDescriptor.adapterVersion,
    );
    expect(report.dialectVersion).toBe(CODEX_DIALECT_VERSION);
    expect(codexConformanceDescriptor.storageTraits.appendOnlyLines).toBe(
      true,
    );
  });

  test("passes observe and inject as tier 2 while gate stays skipped", async (): Promise<void> => {
    const checks = [
      ...OBSERVE_CHECKS,
      ...INJECT_CHECKS,
      ...GATE_CHECKS,
    ];
    const report: ConformanceReport = await runConformance(
      codexConformanceDescriptor,
      { checks },
    );

    const observeAndInject: CheckResult[] = report.checks.filter(
      (check: CheckResult): boolean => check.capability !== "gate",
    );
    const nonPassChecks: CheckResult[] = observeAndInject.filter(
      (check: CheckResult): boolean => check.status !== "pass",
    );
    expect(
      nonPassChecks,
      `expected observe and inject checks to pass:\n${
        nonPassDetail(nonPassChecks)
      }`,
    ).toEqual([]);
    const gateChecks: CheckResult[] = report.checks.filter(
      (check: CheckResult): boolean => check.capability === "gate",
    );
    expect(gateChecks.length).toBeGreaterThan(0);
    expect(
      gateChecks.every(
        (check: CheckResult): boolean => check.status === "skipped",
      ),
    ).toBe(true);
    expect(report.verifiedCapabilities).toEqual(["observe", "inject"]);
    expect(report.tier).toBe(2);
    expect(report.passed).toBe(true);
  });

  test("committed rollout fixtures contain only synthetic identities and paths", (): void => {
    for (const name of FIXTURE_NAMES) {
      const contents: string = readFileSync(
        join(import.meta.dir, "conformance-fixtures", name),
        "utf8",
      );
      // Built by join so this assertion literal does not itself trip the CI
      // privacy guard's grep for absolute personal paths under src/.
      const macHomePrefix: string = ["", "Users", ""].join("/");
      expect(contents).not.toContain(macHomePrefix);
      expect(contents).not.toContain("/home/");
      expect(contents.toLowerCase()).not.toContain("daniel");
      expect(contents).not.toContain(".codex/sessions");
    }
  });

  test("CLI positional vendor form is additive to --adapter", async (): Promise<void> => {
    const positional: CliResult = await runCli([
      "conformance",
      "run",
      "codex",
    ]);
    const flagged: CliResult = await runCli([
      "conformance",
      "run",
      "--adapter",
      "codex",
    ]);
    expect(positional.exitCode).toBe(0);
    expect(flagged.exitCode).toBe(0);
    expect(positional.stderr).toBe("");
    expect(flagged.stderr).toBe("");
    expect(positional.stdout).toBe(flagged.stdout);
    expect(positional.stdout).toContain("PASS observe.discover");
    expect(positional.stdout).toContain(
      "VERIFIED CAPABILITIES: observe, inject",
    );
    expect(positional.stdout).toContain("TIER: 2");
  });
});
