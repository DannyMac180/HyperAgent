import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "bun:test";

const temporaryDirectories: string[] = [];
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

afterEach((): void => {
  for (const path of temporaryDirectories.splice(0).reverse()) {
    rmSync(path, { recursive: true, force: true });
  }
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const subprocess = Bun.spawn([process.execPath, cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: await subprocess.exited,
    stdout: await new Response(subprocess.stdout).text(),
    stderr: await new Response(subprocess.stderr).text(),
  };
}

test("configuration CLI scan and report emit parseable redacted JSON", async (): Promise<void> => {
  const home = temporaryDirectory("hyperagent-config-cli-home-");
  const dataDir = temporaryDirectory("hyperagent-config-cli-data-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    mcpServers: { retainedName: { command: "private-command" } },
  }));

  const scan = await runCli(["configuration", "scan", "--home", home, "--data-dir", dataDir]);
  expect(scan.exitCode).toBe(0);
  expect(scan.stderr).toBe("");
  expect(scan.stdout).not.toContain("private-command");
  expect(JSON.parse(scan.stdout)).toMatchObject({ schemaVersion: "1.0.0" });

  const report = await runCli(["configuration", "report", "--data-dir", dataDir]);
  expect(report.exitCode).toBe(0);
  expect(report.stderr).toBe("");
  expect(JSON.parse(report.stdout)).toMatchObject({
    schemaVersion: "1.0.0",
    history: [{ snapshot: { id: 1 } }],
  });
});
