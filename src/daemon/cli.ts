import { existsSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readIngestState,
  runIngestOnce,
} from "./ingest.ts";
import type {
  AdapterRunStats,
  IngestRunResult,
} from "./ingest.ts";
import { builtinAdaptersForProjectsRoot } from "./registry.ts";
import { openStore } from "../store/store.ts";

interface CommonOptions {
  dataDir?: string;
  projectsRoot?: string;
}

const usage = `Usage:
  bun src/daemon/cli.ts ingest --once [--data-dir D] [--projects-root P]
  bun src/daemon/cli.ts watch [--data-dir D] [--projects-root P]
  bun src/daemon/cli.ts status [--data-dir D]
  bun src/daemon/cli.ts install-plist [--write]
`;

class ArgumentError extends Error {}

function parseOptions(
  args: string[],
  allowedFlags: ReadonlySet<string>,
): Map<string, string | true> {
  const parsed = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined || !flag.startsWith("--")) {
      throw new ArgumentError(`Unexpected argument: ${flag ?? ""}`);
    }
    if (!allowedFlags.has(flag)) {
      throw new ArgumentError(`Unknown flag: ${flag}`);
    }
    if (flag === "--once" || flag === "--write") {
      parsed.set(flag, true);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ArgumentError(`Missing value for ${flag}`);
    }
    parsed.set(flag, value);
    index += 1;
  }
  return parsed;
}

function stringOption(
  options: Map<string, string | true>,
  name: string,
): string | undefined {
  const value = options.get(name);
  return typeof value === "string" ? value : undefined;
}

function printRun(result: IngestRunResult): void {
  for (const adapter of result.adapters) {
    console.log(
        `${adapter.vendor} ${adapter.adapterVersion}: ${adapter.status}; ` +
        `${adapter.sessionsParsed}/${adapter.sessionsDiscovered} parsed, ` +
        `${adapter.eventsAppended} events appended, ` +
        `${adapter.sessionsClosed} closed`,
    );
    if (adapter.detail.length > 0) {
      console.log(`  ${adapter.detail}`);
    }
  }
}

async function ingestCommand(args: string[]): Promise<number> {
  const options = parseOptions(
    args,
    new Set(["--once", "--data-dir", "--projects-root"]),
  );
  const common: CommonOptions = {
    dataDir: stringOption(options, "--data-dir"),
    projectsRoot: stringOption(options, "--projects-root"),
  };
  const result = await runIngestOnce({
    ...(common.dataDir === undefined ? {} : { dataDir: common.dataDir }),
    adapters: builtinAdaptersForProjectsRoot(common.projectsRoot),
  });
  printRun(result);
  return 0;
}

function watchedRoots(
  dataDir: string,
  projectsRoot: string | undefined,
): string[] {
  const state = readIngestState(dataDir);
  const roots = new Set<string>();
  if (projectsRoot !== undefined) {
    roots.add(resolve(projectsRoot));
  }
  for (const session of Object.values(state.sessions)) {
    roots.add(dirname(session.path));
  }
  return [...roots];
}

async function watchCommand(args: string[]): Promise<number> {
  const options = parseOptions(
    args,
    new Set(["--data-dir", "--projects-root"]),
  );
  const dataDir =
    stringOption(options, "--data-dir") ?? join(homedir(), ".hyperagent");
  const projectsRoot = stringOption(options, "--projects-root");
  const adapters = builtinAdaptersForProjectsRoot(projectsRoot);
  const watchers = new Map<string, FSWatcher>();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let pending = false;
  let stopping = false;

  const syncWatchers = (): void => {
    for (const root of watchedRoots(dataDir, projectsRoot)) {
      if (watchers.has(root)) {
        continue;
      }
      try {
        const watcher = watch(root, () => {
          if (debounceTimer !== undefined) {
            clearTimeout(debounceTimer);
          }
          debounceTimer = setTimeout(() => {
            void trigger();
          }, 2_000);
        });
        watcher.on("error", (error: Error) => {
          console.error(`Watch error for ${root}: ${error.message}`);
        });
        watchers.set(root, watcher);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Could not watch ${root}: ${message}`);
      }
    }
  };

  const trigger = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    try {
      do {
        pending = false;
        try {
          printRun(await runIngestOnce({ dataDir, adapters }));
          syncWatchers();
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(`Ingest failed: ${message}`);
        }
      } while (pending && !stopping);
    } finally {
      inFlight = false;
    }
  };

  await trigger();
  const rescanTimer = setInterval(() => {
    void trigger();
  }, 60_000);

  await new Promise<void>((resolveShutdown) => {
    const shutdown = (): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
      clearInterval(rescanTimer);
      for (const watcher of watchers.values()) {
        watcher.close();
      }
      resolveShutdown();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  return 0;
}

function statusCommand(args: string[]): number {
  const options = parseOptions(args, new Set(["--data-dir"]));
  const dataDir =
    stringOption(options, "--data-dir") ?? join(homedir(), ".hyperagent");
  const state = readIngestState(dataDir);
  const eventCounts = readEventCounts(
    join(dataDir, "hyperagent.db"),
    state.lastRun?.adapters.map((adapter) => adapter.vendor) ?? [],
  );
  if (state.lastRun === undefined) {
    console.log(`No ingest state found at ${join(dataDir, "ingest-state.json")}.`);
    console.log(`Total events: ${formatTotalEventCount(eventCounts)}.`);
    return 0;
  }

  for (const adapter of state.lastRun.adapters) {
    const sessions = Object.values(state.sessions).filter(
      (session) => session.vendor === adapter.vendor,
    ).length;
    console.log(
      formatStatus(
        adapter,
        sessions,
        eventCounts.byVendor.get(adapter.vendor) ?? "unknown",
      ),
    );
  }
  const allSessions = Object.values(state.sessions);
  const closed = allSessions.filter((session) => session.closed).length;
  console.log(
    `Total sessions: ${allSessions.length}; closed: ${closed}; ` +
      `events: ${formatTotalEventCount(eventCounts)}`,
  );
  return 0;
}

interface EventCounts {
  total: number | "unknown";
  byVendor: Map<string, number | "unknown">;
  reason?: string;
}

function readEventCounts(dbPath: string, vendors: string[]): EventCounts {
  if (!existsSync(dbPath)) {
    return {
      total: 0,
      byVendor: new Map(vendors.map((vendor) => [vendor, 0])),
    };
  }

  const byVendor = new Map<string, number | "unknown">(
    vendors.map((vendor) => [vendor, "unknown"]),
  );
  try {
    const store = openStore(dbPath);
    try {
      const totalRow = store.db
        .query<{ count: unknown }, []>(
          "SELECT count(*) AS count FROM events",
        )
        .get();
      if (totalRow === null || typeof totalRow.count !== "number") {
        throw new Error("invalid total event count");
      }
      for (const vendor of vendors) {
        const vendorRow = store.db
          .query<{ count: unknown }, [string]>(
            "SELECT count(*) AS count FROM events WHERE vendor = ?",
          )
          .get(vendor);
        if (vendorRow === null || typeof vendorRow.count !== "number") {
          throw new Error(`invalid event count for vendor ${vendor}`);
        }
        byVendor.set(vendor, vendorRow.count);
      }
      return { total: totalRow.count, byVendor };
    } finally {
      store.close();
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return { total: "unknown", byVendor, reason };
  }
}

function formatTotalEventCount(counts: EventCounts): string {
  if (counts.reason === undefined) {
    return String(counts.total);
  }
  return `unknown (${counts.reason})`;
}

function formatStatus(
  stats: AdapterRunStats,
  sessions: number,
  events: number | "unknown",
): string {
  const harness = stats.harnessVersion ?? "unknown";
  return (
    `${stats.vendor} ${stats.adapterVersion}: ${stats.status} ` +
    `(${stats.detail}); harness ${harness}; sessions ${sessions}; ` +
    `events ${events} (last run appended ${stats.eventsAppended}); ` +
    `last run skipped ${stats.skippedUnknown}; ` +
    `last run parse failures ${stats.parseFailures}`
  );
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launchdPlist(dataDir: string): string {
  const cliPath = fileURLToPath(import.meta.url);
  const outputPath = join(dataDir, "hyperagentd.out.log");
  const errorPath = join(dataDir, "hyperagentd.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hyperagent.hyperagentd</string>
  <key>ProgramArguments</key>
  <array>
    <string>bun</string>
    <string>${xmlEscape(cliPath)}</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(outputPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errorPath)}</string>
</dict>
</plist>
`;
}

async function installPlistCommand(args: string[]): Promise<number> {
  const options = parseOptions(args, new Set(["--write"]));
  const dataDir = join(homedir(), ".hyperagent");
  const plist = launchdPlist(dataDir);
  if (options.get("--write") !== true) {
    process.stdout.write(plist);
    return 0;
  }
  const launchAgents = join(homedir(), "Library", "LaunchAgents");
  const path = join(
    launchAgents,
    "com.hyperagent.hyperagentd.plist",
  );
  await mkdir(launchAgents, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path, plist, "utf8");
  console.log(path);
  console.log(`launchctl load ${path}`);
  return 0;
}

async function main(args: string[]): Promise<number> {
  const command = args[0];
  if (command === "--help") {
    process.stdout.write(usage);
    return 0;
  }
  const rest = args.slice(1);
  if (command === "ingest") {
    return ingestCommand(rest);
  }
  if (command === "watch") {
    return watchCommand(rest);
  }
  if (command === "status") {
    return statusCommand(rest);
  }
  if (command === "install-plist") {
    return installPlistCommand(rest);
  }
  process.stdout.write(usage);
  return 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error: unknown) {
    if (error instanceof ArgumentError) {
      console.error(error.message);
      process.exitCode = 2;
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
