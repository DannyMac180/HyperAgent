import { existsSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  GateAdapter,
  GateInstallResult,
} from "../adapters/types.ts";
import {
  loadContract,
} from "../gate/contract.ts";
import {
  listViolations,
} from "../gate/detect.ts";
import type {
  PolicyViolation,
} from "../gate/detect.ts";
import {
  runGateEval,
} from "../gate/eval.ts";
import type {
  GateDecision,
  GateHookKind,
} from "../gate/eval.ts";
import {
  policyPath,
} from "../gate/paths.ts";
import {
  loadPolicy,
} from "../gate/policy.ts";
import {
  buildMissionInput,
  generateMission,
  writeMissionRecord,
} from "../missions/generate.ts";
import {
  renderCapabilityMatrix,
} from "../conformance/matrix.ts";
import {
  ALL_CONFORMANCE_CHECKS,
  conformanceDescriptors,
  conformanceVendorNames,
  descriptorForVendor,
} from "../conformance/registry.ts";
import {
  renderConformanceReport,
} from "../conformance/render.ts";
import {
  runConformance,
} from "../conformance/runner.ts";
import type {
  ConformanceDescriptor,
  ConformanceReport,
} from "../conformance/types.ts";
import { spawnAgentRunner } from "../missions/runner.ts";
import { computeTargetRepos } from "../memory/inject.ts";
import type { InjectionResult } from "../memory/inject.ts";
import {
  openMemoryStore,
} from "../memory/store.ts";
import type {
  MemoryFilter,
  MemoryKind,
  MemoryRow,
  MemoryScope,
  MemoryStatus,
  MemoryStore,
} from "../memory/store.ts";
import {
  SCORER_VERSION,
  getTrends,
  rebuildScores,
  scoreSession,
} from "../scoring/score.ts";
import type {
  AgentTrend,
  RepoTrend,
  SessionScore,
} from "../scoring/score.ts";
import { openStore } from "../store/store.ts";
import { installProposal } from "../workshop/install.ts";
import { measureInstalled } from "../workshop/measure.ts";
import {
  humanApprovalFromCli,
  openWorkshopQueue,
} from "../workshop/queue.ts";
import type {
  WorkshopProposalFilter,
  WorkshopProposalRow,
} from "../workshop/queue.ts";
import { runWorkshop } from "../workshop/run.ts";
import type {
  WorkshopRunResult,
  WorkshopStage,
} from "../workshop/run.ts";
import {
  readGateHealth,
} from "./gate-ingest.ts";
import {
  readIngestState,
  runIngestOnce,
} from "./ingest.ts";
import type {
  AdapterRunStats,
  IngestRunResult,
} from "./ingest.ts";
import { syncMemoryTargets } from "./memory-sync.ts";
import {
  builtinAdaptersForProjectsRoot,
  builtinGateAdapters,
  gateAdapterForHarness,
  gateHarnessNames,
} from "./registry.ts";

interface CommonOptions {
  dataDir?: string;
  projectsRoot?: string;
}

const usage = `Usage:
  bun src/daemon/cli.ts ingest --once [--data-dir D] [--projects-root P]
  bun src/daemon/cli.ts watch [--workshop] [--data-dir D] [--projects-root P]
  bun src/daemon/cli.ts status [--data-dir D]
  bun src/daemon/cli.ts score [--session <id> | --all] [--data-dir D]
  bun src/daemon/cli.ts report [--days N] [--data-dir D]
  bun src/daemon/cli.ts missions [--session <id>] [--data-dir D]
  bun src/daemon/cli.ts memory list [--status S] [--scope S] [--stale --days N] [--data-dir D]
  bun src/daemon/cli.ts memory show <id> [--data-dir D]
  bun src/daemon/cli.ts memory approve <id> [--data-dir D]
  bun src/daemon/cli.ts memory reject <id> [--data-dir D]
  bun src/daemon/cli.ts memory retire <id> [--data-dir D]
  bun src/daemon/cli.ts memory add --claim C --kind K --scope S [--scope-key K] [--data-dir D]
  bun src/daemon/cli.ts memory sync [--repo <path>] [--data-dir D]
  bun src/daemon/cli.ts gate install [--repo P] [--harness H] [--data-dir D]
  bun src/daemon/cli.ts gate uninstall [--repo P] [--harness H] [--data-dir D]
  bun src/daemon/cli.ts gate status [--repo P] [--harness H] [--data-dir D]
  bun src/daemon/cli.ts gate policy show [--data-dir D]
  bun src/daemon/cli.ts gate policy validate [--data-dir D]
  bun src/daemon/cli.ts gate contract show [--repo P]
  bun src/daemon/cli.ts gate contract validate [--repo P]
  bun src/daemon/cli.ts gate test --hook <PreToolUse|PostToolUse|Stop> [--harness H] [--data-dir D] [--stdin-file F]
  bun src/daemon/cli.ts gate eval --harness H --hook <PreToolUse|PostToolUse|Stop> [--data-dir D]
  bun src/daemon/cli.ts violations [--session S] [--days N] [--data-dir D]
  bun src/daemon/cli.ts workshop run [--until cluster|propose] [--repo P] [--data-dir D]
  bun src/daemon/cli.ts workshop list [--status S] [--type T] [--data-dir D]
  bun src/daemon/cli.ts workshop show <id> [--data-dir D]
  bun src/daemon/cli.ts workshop approve <id> [--yes] [--data-dir D]
  bun src/daemon/cli.ts workshop reject <id> [--data-dir D]
  bun src/daemon/cli.ts workshop measure [--data-dir D]
  bun src/daemon/cli.ts conformance run [<vendor>|--adapter <vendor>]
  bun src/daemon/cli.ts conformance matrix [--write]
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
    if (
      flag === "--once"
      || flag === "--write"
      || flag === "--all"
      || flag === "--stale"
      || flag === "--yes"
      || flag === "--workshop"
    ) {
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
    new Set(["--workshop", "--data-dir", "--projects-root"]),
  );
  const dataDir =
    stringOption(options, "--data-dir") ?? join(homedir(), ".hyperagent");
  const projectsRoot = stringOption(options, "--projects-root");
  const workshopEnabled = options.get("--workshop") === true;
  const adapters = builtinAdaptersForProjectsRoot(projectsRoot);
  const watchers = new Map<string, FSWatcher>();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let pending = false;
  let workshopInFlight = false;
  let workshopPending = false;
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

  const triggerWorkshop = async (): Promise<void> => {
    if (stopping || !workshopEnabled) {
      return;
    }
    if (workshopInFlight) {
      workshopPending = true;
      return;
    }
    workshopInFlight = true;
    try {
      do {
        workshopPending = false;
        // runWorkshop acquires the cross-process run lock itself. Taking it
        // here as well would deadlock the daemon against its own run, which
        // would then report "already running" and never execute the pipeline.
        try {
          const result = await runWorkshopPipeline(dataDir);
          printWorkshopRunSummary(result);
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(`Workshop failed: ${message}`);
        }
      } while (workshopPending && !stopping);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Workshop failed: ${message}`);
    } finally {
      workshopInFlight = false;
    }
  };

  await trigger();
  const rescanTimer = setInterval(() => {
    void trigger();
    void triggerWorkshop();
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

function gateHealthRepos(dataDir: string): string[] {
  const dbPath = join(dataDir, "hyperagent.db");
  if (!existsSync(dbPath)) {
    return [];
  }
  const store = openStore(dbPath);
  try {
    return [...new Set(
      store.getSessions().flatMap((session): string[] =>
        session.repo === null ? [] : [session.repo]
      ),
    )].sort();
  } finally {
    store.close();
  }
}

async function statusWithGateHealthCommand(args: string[]): Promise<number> {
  const exitCode = statusCommand(args);
  const options = parseOptions(args, new Set(["--data-dir"]));
  const dataDir =
    stringOption(options, "--data-dir") ?? join(homedir(), ".hyperagent");
  const health = await readGateHealth({
    dataDir,
    repos: gateHealthRepos(dataDir),
  });
  console.log(`Gate policy: ${health.policyState}.`);
  if (health.policyError !== undefined) {
    console.log(`Gate policy error: ${health.policyError}`);
  }
  console.log(`Gate spool backlog: ${health.spoolBacklogBytes} bytes.`);
  for (const repo of health.repos) {
    console.log(
      `Gate repo ${repo.repo}: ${repo.state}; ${repo.detail}`,
    );
  }
  return exitCode;
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

function formatPercentage(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatEvidenceBacked(value: number | null): string {
  return value === null ? "n/a" : value === 1 ? "yes" : "no";
}

function printSessionScore(score: SessionScore): void {
  console.log(`Session: ${score.session_id}`);
  console.log(`Status: ${score.provisional === 1 ? "provisional" : "final"}`);
  console.log(`Scorer: ${score.scorer_version}`);
  console.log(`Turns: ${score.turn_count}`);
  console.log(`Tool calls: ${score.tool_call_count}`);
  console.log(`Errors: ${score.error_count}`);
  console.log(`Retries: ${score.retry_count}`);
  console.log(
    `Verifications: ${score.verification_passed}/${score.verification_total} passed (${formatPercentage(score.verification_pass_rate)})`,
  );
  console.log(`Completion claims: ${score.completion_claim_count}`);
  console.log(
    `Evidence-backed completion: ${formatEvidenceBacked(score.evidence_backed_completion)}`,
  );
}

function scoreCommand(args: string[]): number {
  const options = parseOptions(
    args,
    new Set(["--session", "--all", "--data-dir"]),
  );
  const sessionId = stringOption(options, "--session");
  const all = options.get("--all") === true;
  if (sessionId !== undefined && all) {
    throw new ArgumentError("Pass either --session <id> or --all, not both.");
  }
  if (sessionId === undefined && !all) {
    throw new ArgumentError("Pass either --session <id> or --all.");
  }

  const dataDir =
    stringOption(options, "--data-dir") ?? join(homedir(), ".hyperagent");
  const store = openStore(join(dataDir, "hyperagent.db"));
  try {
    if (sessionId !== undefined) {
      printSessionScore(scoreSession(store, sessionId));
      return 0;
    }

    const count = rebuildScores(store);
    const provisionalSessions = store.getSessions({ open: true });
    console.log(`Scored ${count} sessions with scorer ${SCORER_VERSION}.`);
    if (provisionalSessions.length === 0) {
      console.log("Provisional sessions: 0.");
    } else {
      console.log(`Provisional sessions: ${provisionalSessions.length}.`);
      for (const session of provisionalSessions) {
        console.log(`  provisional  ${session.session_id}`);
      }
    }
    return 0;
  } finally {
    store.close();
  }
}

interface ReportRow {
  label: string;
  sessions: string;
  verificationPassRate: string;
  errors: string;
  claims: string;
  evidenceBackedRatio: string;
}

function formatReportSection(
  title: string,
  labelHeader: string,
  rows: ReportRow[],
): void {
  const headers = [
    labelHeader,
    "Sessions",
    "Verification pass rate",
    "Errors",
    "Claims",
    "Evidence-backed ratio",
  ];
  const cells = rows.map((row): string[] => [
    row.label,
    row.sessions,
    row.verificationPassRate,
    row.errors,
    row.claims,
    row.evidenceBackedRatio,
  ]);
  const widths = headers.map((header, index): number =>
    Math.max(
      header.length,
      ...cells.map((row): number => row[index]?.length ?? 0),
    )
  );
  const render = (row: string[]): string =>
    row.map((cell, index): string => {
      const width = widths[index] ?? cell.length;
      return index === 0 ? cell.padEnd(width) : cell.padStart(width);
    }).join("  ");

  console.log(title);
  console.log(render(headers));
  console.log(render(widths.map((width): string => "-".repeat(width))));
  for (const row of cells) {
    console.log(render(row));
  }
}

function agentReportRow(trend: AgentTrend): ReportRow {
  return {
    label: trend.agent ?? "(unknown)",
    sessions: String(trend.session_count),
    verificationPassRate: formatPercentage(
      trend.average_verification_pass_rate,
    ),
    errors: String(trend.total_errors),
    claims: String(trend.total_claims),
    evidenceBackedRatio: formatPercentage(trend.evidence_backed_ratio),
  };
}

function repoReportRow(trend: RepoTrend): ReportRow {
  return {
    label: trend.repo ?? "(unknown)",
    sessions: String(trend.session_count),
    verificationPassRate: formatPercentage(
      trend.average_verification_pass_rate,
    ),
    errors: String(trend.total_errors),
    claims: String(trend.total_claims),
    evidenceBackedRatio: formatPercentage(trend.evidence_backed_ratio),
  };
}

function positiveDays(value: string | undefined): number {
  if (value === undefined) {
    return 7;
  }
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days <= 0) {
    throw new ArgumentError(
      `Invalid value for --days: ${value}; expected a positive integer.`,
    );
  }
  return days;
}

function reportCommand(args: string[]): number {
  const options = parseOptions(args, new Set(["--days", "--data-dir"]));
  const days = positiveDays(stringOption(options, "--days"));
  const dataDir =
    stringOption(options, "--data-dir") ?? join(homedir(), ".hyperagent");
  const store = openStore(join(dataDir, "hyperagent.db"));
  try {
    const trends = getTrends(store, { days });
    if (trends.by_agent.length === 0 && trends.by_repo.length === 0) {
      console.log(`No sessions in the last ${days} days.`);
      return 0;
    }
    formatReportSection(
      `Agents — last ${days} days`,
      "Agent",
      trends.by_agent.map(agentReportRow),
    );
    console.log("");
    formatReportSection(
      `Repositories — last ${days} days`,
      "Repository",
      trends.by_repo.map(repoReportRow),
    );
    return 0;
  } finally {
    store.close();
  }
}

interface MissionFile {
  name: string;
  size: number;
  mtime: Date;
  mtimeMs: number;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  );
}

async function listMissionRecords(dataDir: string): Promise<number> {
  const missionsDir = join(dataDir, "missions");
  let names: string[];
  try {
    const entries = await readdir(missionsDir, { withFileTypes: true });
    names = entries
      .filter((entry): boolean => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry): string => entry.name);
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      console.log("No mission records yet.");
      return 0;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to list mission records in ${missionsDir}: ${message}`);
  }

  const files: MissionFile[] = [];
  for (const name of names) {
    const path = join(missionsDir, name);
    try {
      const metadata = await stat(path);
      files.push({
        name,
        size: metadata.size,
        mtime: metadata.mtime,
        mtimeMs: metadata.mtimeMs,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read mission record metadata for ${path}: ${message}`);
    }
  }
  if (files.length === 0) {
    console.log("No mission records yet.");
    return 0;
  }
  files.sort((left, right): number => right.mtimeMs - left.mtimeMs);
  for (const file of files) {
    console.log(`${file.name}  ${file.size} bytes  ${file.mtime.toISOString()}`);
  }
  return 0;
}

async function missionsCommand(args: string[]): Promise<number> {
  const options = parseOptions(args, new Set(["--session", "--data-dir"]));
  const sessionId = stringOption(options, "--session");
  const dataDir =
    stringOption(options, "--data-dir") ?? join(homedir(), ".hyperagent");
  if (sessionId === undefined) {
    return listMissionRecords(dataDir);
  }

  const store = openStore(join(dataDir, "hyperagent.db"));
  try {
    const input = buildMissionInput(store, sessionId);
    const runModel = spawnAgentRunner({ dataDir });
    const record = await generateMission({ runModel }, input);
    const path = await writeMissionRecord(record, dataDir);
    console.log(`Mission record written: ${path}`);
    console.log(`Generated by: ${record.generatedBy}`);
    if (record.reason !== undefined) {
      console.log(`Reason: ${record.reason}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

const MEMORY_KINDS: ReadonlySet<string> = new Set([
  "factual",
  "gotcha",
  "preference",
  "behavior",
]);
const MEMORY_SCOPES: ReadonlySet<string> = new Set([
  "global",
  "repo",
  "agent",
]);
const MEMORY_STATUSES: ReadonlySet<string> = new Set([
  "candidate",
  "approved",
  "rejected",
  "retired",
]);

function memoryDataDir(
  options: Map<string, string | true>,
): string {
  return stringOption(options, "--data-dir")
    ?? join(homedir(), ".hyperagent");
}

function openCliMemoryStore(dataDir: string): MemoryStore {
  return openMemoryStore({
    dbPath: join(dataDir, "hyperagent.db"),
    memoryDir: join(dataDir, "memory"),
  });
}

function requiredStringOption(
  options: Map<string, string | true>,
  name: string,
): string {
  const value = stringOption(options, name);
  if (value === undefined || value.trim().length === 0) {
    throw new ArgumentError(`Missing value for ${name}`);
  }
  return value;
}

function memoryKind(value: string): MemoryKind {
  if (!MEMORY_KINDS.has(value)) {
    throw new ArgumentError(
      `Invalid memory kind: ${value}; expected factual, gotcha, preference, or behavior.`,
    );
  }
  return value as MemoryKind;
}

function memoryScope(value: string): MemoryScope {
  if (!MEMORY_SCOPES.has(value)) {
    throw new ArgumentError(
      `Invalid memory scope: ${value}; expected global, repo, or agent.`,
    );
  }
  return value as MemoryScope;
}

function memoryStatus(value: string): MemoryStatus {
  if (!MEMORY_STATUSES.has(value)) {
    throw new ArgumentError(
      `Invalid memory status: ${value}; expected candidate, approved, rejected, or retired.`,
    );
  }
  return value as MemoryStatus;
}

function printMemoryTable(memories: MemoryRow[]): void {
  if (memories.length === 0) {
    console.log("No memories found.");
    return;
  }
  const headers = ["ID", "STATUS", "KIND", "SCOPE", "CLAIM"];
  const rows = memories.map((memory: MemoryRow): string[] => [
    memory.id,
    memory.status,
    memory.kind,
    memory.scope_key === null
      ? memory.scope
      : `${memory.scope}:${memory.scope_key}`,
    memory.claim.replace(/\s+/gu, " ").trim(),
  ]);
  const widths = headers.map((header, index): number =>
    Math.max(
      header.length,
      ...rows.map((row: string[]): number => row[index]?.length ?? 0),
    )
  );
  const render = (row: string[]): string =>
    row.map((cell, index): string =>
      cell.padEnd(widths[index] ?? cell.length)
    ).join("  ").trimEnd();

  console.log(render(headers));
  for (const row of rows) {
    console.log(render(row));
  }
}

function printInjectionResults(results: InjectionResult[]): void {
  if (results.length === 0) {
    console.log("No memory injection targets.");
    return;
  }
  for (const result of results) {
    if (result.changed) {
      console.log(`changed\t${result.targetPath}`);
    } else if (
      result.reason === undefined
      || result.reason === "Injection target is already byte-identical."
    ) {
      console.log(`unchanged\t${result.targetPath}`);
    } else {
      console.log(`refused\t${result.targetPath}\t${result.reason}`);
    }
  }
}

async function syncMemoryStore(
  memoryStore: MemoryStore,
  explicitRepo?: string,
  previousTargets?: string[],
): Promise<void> {
  printInjectionResults(
    await syncMemoryTargets({
      memoryStore,
      ...(explicitRepo === undefined ? {} : { explicitRepo }),
      ...(previousTargets === undefined ? {} : { previousTargets }),
    }),
  );
}

function memoryListCommand(args: string[]): number {
  const options = parseOptions(
    args,
    new Set(["--status", "--scope", "--stale", "--days", "--data-dir"]),
  );
  const statusValue = stringOption(options, "--status");
  const scopeValue = stringOption(options, "--scope");
  const stale = options.get("--stale") === true;
  const daysValue = stringOption(options, "--days");
  if (!stale && daysValue !== undefined) {
    throw new ArgumentError("--days requires --stale.");
  }
  const filter: MemoryFilter = {
    ...(statusValue === undefined ? {} : { status: memoryStatus(statusValue) }),
    ...(scopeValue === undefined ? {} : { scope: memoryScope(scopeValue) }),
    ...(stale
      ? {
        staleBefore: new Date(
          Date.now() - positiveDays(daysValue) * 24 * 60 * 60 * 1_000,
        ).toISOString(),
      }
      : {}),
  };
  const memoryStore = openCliMemoryStore(memoryDataDir(options));
  try {
    printMemoryTable(memoryStore.listMemories(filter));
    return 0;
  } finally {
    memoryStore.close();
  }
}

function memoryIdAndOptions(
  args: string[],
): { id: string; options: Map<string, string | true> } {
  const id = args[0];
  if (id === undefined || id.startsWith("--")) {
    throw new ArgumentError("Missing memory id.");
  }
  return {
    id,
    options: parseOptions(args.slice(1), new Set(["--data-dir"])),
  };
}

function memoryShowCommand(args: string[]): number {
  const { id, options } = memoryIdAndOptions(args);
  const memoryStore = openCliMemoryStore(memoryDataDir(options));
  try {
    const memory = memoryStore.getMemory(id);
    if (memory === null) {
      console.error(`Memory not found: ${id}`);
      return 1;
    }
    console.log(JSON.stringify(memory, null, 2));
    return 0;
  } finally {
    memoryStore.close();
  }
}

async function memoryTransitionCommand(
  action: "approve" | "reject" | "retire",
  args: string[],
): Promise<number> {
  const { id, options } = memoryIdAndOptions(args);
  const memoryStore = openCliMemoryStore(memoryDataDir(options));
  try {
    const prior = memoryStore.getMemory(id);
    if (prior === null) {
      console.error(`Memory not found: ${id}`);
      return 1;
    }
    // Captured BEFORE the transition: a repo dropping out of the target set
    // must still be re-rendered (to an empty block) by this same mutation.
    const previousTargets = computeTargetRepos(memoryStore.listMemories());
    const updated = memoryStore[action](id);
    const pastTense = action === "approve"
      ? "approved"
      : action === "reject"
        ? "rejected"
        : "retired";
    console.log(`${pastTense}\t${updated.id}`);
    await syncMemoryStore(memoryStore, undefined, previousTargets);
    return 0;
  } finally {
    memoryStore.close();
  }
}

function memoryAddCommand(args: string[]): number {
  const options = parseOptions(
    args,
    new Set([
      "--claim",
      "--kind",
      "--scope",
      "--scope-key",
      "--data-dir",
    ]),
  );
  const claim = requiredStringOption(options, "--claim");
  const kind = memoryKind(requiredStringOption(options, "--kind"));
  const scope = memoryScope(requiredStringOption(options, "--scope"));
  const scopeKey = stringOption(options, "--scope-key");
  if (scope === "global" && scopeKey !== undefined) {
    throw new ArgumentError("--scope-key is not allowed for global memories.");
  }
  if (
    scope !== "global"
    && (scopeKey === undefined || scopeKey.trim().length === 0)
  ) {
    throw new ArgumentError(`--scope-key is required for ${scope} memories.`);
  }

  const memoryStore = openCliMemoryStore(memoryDataDir(options));
  try {
    const memory = memoryStore.addManual({
      claim,
      kind,
      scope,
      scope_key: scope === "global" ? null : scopeKey,
      confidence: 1,
      evidence: [{ session_id: "manual", raw_ref: null }],
      source: "manual",
    });
    console.log(`added\t${memory.id}`);
    return 0;
  } finally {
    memoryStore.close();
  }
}

async function memorySyncCommand(args: string[]): Promise<number> {
  const options = parseOptions(args, new Set(["--repo", "--data-dir"]));
  const memoryStore = openCliMemoryStore(memoryDataDir(options));
  try {
    await syncMemoryStore(memoryStore, stringOption(options, "--repo"));
    return 0;
  } finally {
    memoryStore.close();
  }
}

async function memoryCommand(args: string[]): Promise<number> {
  const subcommand = args[0];
  const rest = args.slice(1);
  if (subcommand === "list") {
    return memoryListCommand(rest);
  }
  if (subcommand === "show") {
    return memoryShowCommand(rest);
  }
  if (
    subcommand === "approve"
    || subcommand === "reject"
    || subcommand === "retire"
  ) {
    return memoryTransitionCommand(subcommand, rest);
  }
  if (subcommand === "add") {
    return memoryAddCommand(rest);
  }
  if (subcommand === "sync") {
    return memorySyncCommand(rest);
  }
  throw new ArgumentError(
    `Unknown memory subcommand: ${subcommand ?? "(missing)"}`,
  );
}

function workshopDataDir(
  options: Map<string, string | true>,
): string {
  return stringOption(options, "--data-dir")
    ?? join(homedir(), ".hyperagent");
}

function workshopStage(value: string | undefined): WorkshopStage | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "cluster" || value === "propose") {
    return value;
  }
  throw new ArgumentError(
    `Invalid value for --until: ${value}; expected cluster or propose.`,
  );
}

/** Exported for the daemon-path regression test: this is the exact function the
 * watch trigger awaits, and it must complete without any caller-held lock —
 * the pre-fix deadlock double-acquired and made every daemon run refuse. */
export async function runWorkshopPipeline(
  dataDir: string,
  repo?: string,
  until?: WorkshopStage,
): Promise<WorkshopRunResult> {
  const store = openStore(join(dataDir, "hyperagent.db"));
  if (until === "cluster") {
    try {
      return await runWorkshop(
        { store },
        {
          dataDir,
          ...(repo === undefined ? {} : { repo }),
          until,
        },
      );
    } finally {
      store.close();
    }
  }

  const queue = openWorkshopQueue({ dataDir });
  try {
    return await runWorkshop(
      {
        store,
        queue,
        propose: { runAgent: spawnAgentRunner({ dataDir }) },
      },
      {
        dataDir,
        ...(repo === undefined ? {} : { repo }),
        ...(until === undefined ? {} : { until }),
      },
    );
  } finally {
    queue.close();
    store.close();
  }
}

function printWorkshopRunSummary(result: WorkshopRunResult): void {
  console.log(`Workshop run: ${result.runId}`);
  console.log(`Status: ${result.status}`);
  console.log(`Clusters forwarded: ${result.clustersForwarded}`);
  console.log(`Proposals drafted: ${result.proposalsDrafted}`);
  console.log(`Proposals pending: ${result.proposalsPending}`);
  console.log(`Proposals held at draft: ${result.proposalsHeldAtDraft}`);
  if (result.error !== null) {
    console.log(`Error: ${result.error}`);
  }
  for (const diagnostic of result.diagnostics) {
    console.log(`Diagnostic: ${diagnostic}`);
  }
}

async function workshopRunCommand(args: string[]): Promise<number> {
  const options = parseOptions(
    args,
    new Set(["--until", "--repo", "--data-dir"]),
  );
  const until = workshopStage(stringOption(options, "--until"));
  const result = await runWorkshopPipeline(
    workshopDataDir(options),
    stringOption(options, "--repo"),
    until,
  );
  if (until === "cluster") {
    console.log("Clusters:");
    console.log(JSON.stringify(result.analysis, null, 2));
    console.log("Fragmentation report:");
    console.log(JSON.stringify(result.analysis.fragmentation, null, 2));
  } else {
    printWorkshopRunSummary(result);
  }
  return result.status === "completed" ? 0 : 1;
}

function printWorkshopTable(proposals: WorkshopProposalRow[]): void {
  if (proposals.length === 0) {
    console.log("No workshop proposals found.");
    return;
  }
  const headers = ["ID", "STATUS", "TYPE", "DURABILITY", "TITLE"];
  const rows = proposals.map((proposal): string[] => [
    proposal.id,
    proposal.status,
    proposal.type,
    proposal.durability,
    proposal.title.replace(/\s+/gu, " ").trim(),
  ]);
  const widths = headers.map((header, index): number =>
    Math.max(
      header.length,
      ...rows.map((row): number => row[index]?.length ?? 0),
    )
  );
  const render = (row: string[]): string =>
    row.map((cell, index): string =>
      cell.padEnd(widths[index] ?? cell.length)
    ).join("  ").trimEnd();

  console.log(render(headers));
  for (const row of rows) {
    console.log(render(row));
  }
}

function workshopListCommand(args: string[]): number {
  const options = parseOptions(
    args,
    new Set(["--status", "--type", "--data-dir"]),
  );
  const status = stringOption(options, "--status");
  const type = stringOption(options, "--type");
  const filter: WorkshopProposalFilter = {
    ...(status === undefined
      ? {}
      : { status: status as WorkshopProposalFilter["status"] }),
    ...(type === undefined
      ? {}
      : { type: type as WorkshopProposalFilter["type"] }),
  };
  const queue = openWorkshopQueue({ dataDir: workshopDataDir(options) });
  try {
    printWorkshopTable(queue.list(filter));
    return 0;
  } finally {
    queue.close();
  }
}

function workshopIdAndOptions(
  args: string[],
  allowedFlags: ReadonlySet<string> = new Set(["--data-dir"]),
): { id: string; options: Map<string, string | true> } {
  const id = args[0];
  if (id === undefined || id.startsWith("--")) {
    throw new ArgumentError("Missing workshop proposal id.");
  }
  return {
    id,
    options: parseOptions(args.slice(1), allowedFlags),
  };
}

function workshopShowCommand(args: string[]): number {
  const { id, options } = workshopIdAndOptions(args);
  const queue = openWorkshopQueue({ dataDir: workshopDataDir(options) });
  try {
    const proposal = queue.get(id);
    if (proposal === null) {
      console.error(`Workshop proposal not found: ${id}`);
      return 1;
    }
    console.log(`ID: ${proposal.id}`);
    console.log(`Title: ${proposal.title}`);
    console.log(`Type: ${proposal.type}`);
    console.log(`Durability: ${proposal.durability}`);
    console.log(`Status: ${proposal.status}`);
    console.log(`Content hash: ${proposal.contentHash}`);
    console.log(`Rationale: ${proposal.rationale}`);
    console.log("Body:");
    console.log(JSON.stringify(proposal.body, null, 2));
    console.log("Evidence:");
    console.log(JSON.stringify(proposal.evidence, null, 2));
    console.log("Eval verdict:");
    console.log(
      proposal.eval === null
        ? "not evaluated"
        : JSON.stringify(proposal.eval, null, 2),
    );
    console.log("Transition history:");
    for (const transition of queue.transitions(id)) {
      console.log(
        `${transition.ts}  ${transition.fromStatus ?? "(none)"} -> ` +
          `${transition.toStatus}  actor=${transition.actor}` +
          `${transition.note === null ? "" : `  note=${transition.note}`}`,
      );
    }
    return 0;
  } finally {
    queue.close();
  }
}

function printWorkshopInstallPlan(
  proposal: WorkshopProposalRow,
  dataDir: string,
): void {
  console.log(`Proposal: ${proposal.id}`);
  if (proposal.type === "memory") {
    console.log(`Target store: ${join(dataDir, "hyperagent.db")}`);
  } else if (proposal.type === "verification_check") {
    console.log(
      `Target path: ${
        proposal.repo === null
          ? "(proposal has no target repo)"
          : join(proposal.repo, ".hyperagent", "contract.json")
      }`,
    );
  } else {
    console.log("Target: manual placement required");
    console.log("This proposal must be placed by hand.");
  }
  console.log("What will be written:");
  console.log(JSON.stringify(proposal.body, null, 2));
}

function workshopApproveCommand(args: string[]): number {
  const { id, options } = workshopIdAndOptions(
    args,
    new Set(["--yes", "--data-dir"]),
  );
  const dataDir = workshopDataDir(options);
  const queue = openWorkshopQueue({ dataDir });
  try {
    const proposal = queue.get(id);
    if (proposal === null) {
      console.error(`Workshop proposal not found: ${id}`);
      return 1;
    }
    if (options.get("--yes") !== true) {
      printWorkshopInstallPlan(proposal, dataDir);
      console.log("Refusing to proceed without explicit confirmation.");
      console.log(`Re-run with --yes to approve and install proposal ${id}.`);
      return 1;
    }
    try {
      const approved = queue.approve(
        id,
        humanApprovalFromCli({ proposalId: id, confirmed: true }),
        proposal.contentHash,
      );
      const outcome = installProposal(approved, {
        openMemoryStore: () => openCliMemoryStore(dataDir),
      }, {
        ...(approved.repo === null ? {} : { targetRepo: approved.repo }),
      });
      if (!outcome.ok) {
        console.error(`Workshop approval failed: ${outcome.reason}`);
        return 1;
      }
      queue.markInstalled(id, outcome.receipt);
      console.log(JSON.stringify(outcome.receipt, null, 2));
      return 0;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Workshop approval failed: ${message}`);
      return 1;
    }
  } finally {
    queue.close();
  }
}

function workshopRejectCommand(args: string[]): number {
  const { id, options } = workshopIdAndOptions(args);
  const queue = openWorkshopQueue({ dataDir: workshopDataDir(options) });
  try {
    if (queue.get(id) === null) {
      console.error(`Workshop proposal not found: ${id}`);
      return 1;
    }
    try {
      const rejected = queue.reject(id, "human");
      console.log(`rejected\t${rejected.id}`);
      return 0;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Workshop rejection failed: ${message}`);
      return 1;
    }
  } finally {
    queue.close();
  }
}

function workshopMeasureCommand(args: string[]): number {
  const options = parseOptions(args, new Set(["--data-dir"]));
  const dataDir = workshopDataDir(options);
  const queue = openWorkshopQueue({ dataDir });
  const store = openStore(join(dataDir, "hyperagent.db"));
  try {
    const measurements = measureInstalled(
      store,
      queue.list({ status: "installed" }),
      { dataDir },
    );
    if (measurements.length === 0) {
      console.log("No installed workshop proposals found.");
      return 0;
    }
    console.log(
      "PROPOSAL  STATUS             BEFORE  AFTER  DELTA  REASON",
    );
    for (const measurement of measurements) {
      console.log(
        `${measurement.proposalId}  ${measurement.status}  ` +
          `${measurement.before.sessionCount}  ` +
          `${measurement.after.sessionCount}  ` +
          `${measurement.delta === null ? "n/a" : measurement.delta}  ` +
          measurement.reason,
      );
    }
    return 0;
  } finally {
    store.close();
    queue.close();
  }
}

async function workshopCommand(args: string[]): Promise<number> {
  const subcommand = args[0];
  const rest = args.slice(1);
  if (subcommand === "run") {
    return workshopRunCommand(rest);
  }
  if (subcommand === "list") {
    return workshopListCommand(rest);
  }
  if (subcommand === "show") {
    return workshopShowCommand(rest);
  }
  if (subcommand === "approve") {
    return workshopApproveCommand(rest);
  }
  if (subcommand === "reject") {
    return workshopRejectCommand(rest);
  }
  if (subcommand === "measure") {
    return workshopMeasureCommand(rest);
  }
  throw new ArgumentError(
    `Unknown workshop subcommand: ${subcommand ?? "(missing)"}`,
  );
}

async function runRegisteredConformance(
  descriptors: readonly ConformanceDescriptor[],
): Promise<ConformanceReport[]> {
  return Promise.all(
    descriptors.map((descriptor: ConformanceDescriptor) =>
      runConformance(descriptor, { checks: ALL_CONFORMANCE_CHECKS })
    ),
  );
}

export function conformanceExitCode(
  reports: readonly ConformanceReport[],
): number {
  return reports.some(
    (report: ConformanceReport): boolean => !report.passed,
  )
    ? 1
    : 0;
}

async function conformanceRunCommand(args: string[]): Promise<number> {
  const positionalAdapter: string | undefined = args[0] !== undefined
      && !args[0].startsWith("--")
    ? args[0]
    : undefined;
  const optionArgs: string[] = positionalAdapter === undefined
    ? args
    : args.slice(1);
  const options = parseOptions(optionArgs, new Set(["--adapter"]));
  const optionAdapter: string | undefined = stringOption(
    options,
    "--adapter",
  );
  if (positionalAdapter !== undefined && optionAdapter !== undefined) {
    throw new ArgumentError(
      "Specify the conformance adapter positionally or with --adapter, not both",
    );
  }
  const adapter: string | undefined = positionalAdapter ?? optionAdapter;
  const descriptors = adapter === undefined
    ? conformanceDescriptors()
    : [descriptorForVendor(adapter)].filter(
      (descriptor): descriptor is ConformanceDescriptor =>
        descriptor !== undefined,
    );
  if (adapter !== undefined && descriptors.length === 0) {
    throw new ArgumentError(
      `Unknown conformance adapter: ${adapter}; valid adapters: ${conformanceVendorNames().join(", ")}`,
    );
  }
  const reports = await runRegisteredConformance(descriptors);
  process.stdout.write(
    `${reports.map(renderConformanceReport).join("\n\n")}\n`,
  );
  return conformanceExitCode(reports);
}

async function conformanceMatrixCommand(args: string[]): Promise<number> {
  const options = parseOptions(args, new Set(["--write"]));
  const reports = await runRegisteredConformance(conformanceDescriptors());
  const markdown = renderCapabilityMatrix(reports);
  if (options.get("--write") === true) {
    const repoRoot = join(import.meta.dir, "..", "..");
    await writeFile(
      join(repoRoot, "docs", "capability-matrix.md"),
      markdown,
      "utf8",
    );
  } else {
    process.stdout.write(markdown);
  }
  return conformanceExitCode(reports);
}

async function conformanceCommand(args: string[]): Promise<number> {
  const subcommand = args[0];
  const rest = args.slice(1);
  if (subcommand === "run") {
    return conformanceRunCommand(rest);
  }
  if (subcommand === "matrix") {
    return conformanceMatrixCommand(rest);
  }
  throw new ArgumentError(
    `Unknown conformance subcommand: ${subcommand ?? "(missing)"}`,
  );
}

function gateDataDir(
  options: Map<string, string | true>,
): string {
  return stringOption(options, "--data-dir")
    ?? join(homedir(), ".hyperagent");
}

function gateHookKind(value: string): GateHookKind {
  if (value === "PreToolUse") {
    return "pre_tool_use";
  }
  if (value === "PostToolUse") {
    return "post_tool_use";
  }
  if (value === "Stop") {
    return "stop";
  }
  throw new ArgumentError(
    `Invalid value for --hook: ${value}; expected PreToolUse, PostToolUse, or Stop.`,
  );
}

/**
 * Resolves `--harness` through the adapter registry rather than a hardcoded
 * name, so the CLI carries no vendor knowledge and a new harness is a registry
 * entry, not an edit here. Defaults to the sole registered adapter when the
 * flag is absent and optional.
 */
function gateAdapter(
  options: Map<string, string | true>,
  dataDir: string,
  harnessRequired: boolean,
): GateAdapter {
  const harness = stringOption(options, "--harness");
  const names = gateHarnessNames();
  if (harness === undefined) {
    const [only] = builtinGateAdapters({ dataDir });
    if (harnessRequired || only === undefined) {
      throw new ArgumentError(
        `Missing value for --harness; expected one of ${names.join(", ")}.`,
      );
    }
    return only;
  }
  const selected = gateAdapterForHarness(harness, { dataDir });
  if (selected === undefined) {
    throw new ArgumentError(
      `Invalid value for --harness: ${harness}; expected one of ${names.join(", ")}.`,
    );
  }
  return selected;
}

function printGateInstallResult(result: GateInstallResult): void {
  console.log(`${result.changed ? "changed" : "unchanged"}\t${result.targetPath}`);
  if (result.reason !== undefined) {
    console.log(`  ${result.reason}`);
  }
}

async function gateInstallCommand(
  action: "install" | "uninstall",
  args: string[],
): Promise<number> {
  const options = parseOptions(args, new Set(["--repo", "--data-dir", "--harness"]));
  const dataDir = gateDataDir(options);
  const repo = stringOption(options, "--repo") ?? process.cwd();
  const adapter = gateAdapter(options, dataDir, false);
  const result = action === "install"
    ? await adapter.install(repo)
    : await adapter.uninstall(repo);
  printGateInstallResult(result);
  return 0;
}

async function gateStatusCommand(args: string[]): Promise<number> {
  const options = parseOptions(args, new Set(["--repo", "--data-dir", "--harness"]));
  const dataDir = gateDataDir(options);
  const repo = stringOption(options, "--repo") ?? process.cwd();
  const status = await gateAdapter(options, dataDir, false).status(repo);
  console.log(
    `${status.state}\t${status.targetPath}\t${status.ownedEntries}\t${status.detail}`,
  );
  return 0;
}

function gatePolicyCommand(args: string[]): number {
  const subcommand = args[0];
  const options = parseOptions(args.slice(1), new Set(["--data-dir"]));
  const loaded = loadPolicy(policyPath(gateDataDir(options)));
  if (subcommand === "show") {
    process.stdout.write(`${JSON.stringify(loaded.policy, null, 2)}\n`);
    if (loaded.state === "invalid") {
      console.error(`Policy: ${loaded.state}; ${loaded.error ?? "unknown error"}`);
      return 1;
    }
    return 0;
  }
  if (subcommand === "validate") {
    console.log(`Policy: ${loaded.state}; path: ${loaded.path}`);
    if (loaded.error !== undefined) {
      console.error(loaded.error);
    }
    return loaded.state === "invalid" ? 1 : 0;
  }
  throw new ArgumentError(
    `Unknown gate policy subcommand: ${subcommand ?? "(missing)"}`,
  );
}

function gateContractCommand(args: string[]): number {
  const subcommand = args[0];
  const options = parseOptions(args.slice(1), new Set(["--repo"]));
  const repo = stringOption(options, "--repo") ?? process.cwd();
  const loaded = loadContract(repo);
  if (subcommand === "show") {
    if (loaded.contract === null) {
      console.log(`Contract: ${loaded.state}; path: ${loaded.path}`);
      if (loaded.error !== undefined) {
        console.error(loaded.error);
      }
      return loaded.state === "invalid" ? 1 : 0;
    }
    process.stdout.write(`${JSON.stringify(loaded.contract, null, 2)}\n`);
    return 0;
  }
  if (subcommand === "validate") {
    console.log(`Contract: ${loaded.state}; path: ${loaded.path}`);
    if (loaded.error !== undefined) {
      console.error(loaded.error);
    }
    return loaded.state === "invalid" ? 1 : 0;
  }
  throw new ArgumentError(
    `Unknown gate contract subcommand: ${subcommand ?? "(missing)"}`,
  );
}

async function readGateInput(stdinFile: string | undefined): Promise<unknown> {
  const raw = stdinFile === undefined
    ? await Bun.stdin.text()
    : await readFile(stdinFile, "utf8");
  return JSON.parse(raw) as unknown;
}

async function evaluateGate(
  adapter: GateAdapter,
  hook: GateHookKind,
  dataDir: string,
  raw: unknown,
): Promise<{ decision: GateDecision; output: string }> {
  const input = adapter.parseHookStdin(hook, raw);
  if (input === null) {
    throw new Error(
      `Hook stdin is not a valid ${adapter.vendor} payload.`,
    );
  }
  const decision = await runGateEval({ dataDir, input });
  return {
    decision,
    output: adapter.renderHookOutput(hook, decision),
  };
}

function gateEvalDiagnostic(error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/gu, " ")
    .trim();
  console.error(`HyperAgent gate failed open: ${message}`);
}

async function gateEvalCommand(args: string[]): Promise<number> {
  try {
    const options = parseOptions(
      args,
      new Set(["--harness", "--hook", "--data-dir"]),
    );
    const dataDir = gateDataDir(options);
    const adapter = gateAdapter(options, dataDir, true);
    const hook = gateHookKind(requiredStringOption(options, "--hook"));
    const raw = await readGateInput(undefined);
    const evaluated = await evaluateGate(adapter, hook, dataDir, raw);
    if (evaluated.decision.failedOpen === true) {
      gateEvalDiagnostic("internal evaluation failure");
      return 0;
    }
    if (evaluated.output.length > 0) {
      process.stdout.write(evaluated.output);
    }
  } catch (error: unknown) {
    gateEvalDiagnostic(error);
  }
  return 0;
}

async function gateTestCommand(args: string[]): Promise<number> {
  const options = parseOptions(
    args,
    new Set(["--harness", "--hook", "--data-dir", "--stdin-file"]),
  );
  const dataDir = gateDataDir(options);
  const adapter = gateAdapter(options, dataDir, false);
  const hook = gateHookKind(requiredStringOption(options, "--hook"));
  const evaluated = await evaluateGate(
    adapter,
    hook,
    dataDir,
    await readGateInput(stringOption(options, "--stdin-file")),
  );
  console.log(`Decision: ${evaluated.decision.kind}`);
  console.log(
    `Matched rules: ${evaluated.decision.matchedRules.join(", ") || "(none)"}`,
  );
  console.log(
    `Failed checks: ${evaluated.decision.failedChecks.join(", ") || "(none)"}`,
  );
  if (evaluated.decision.reason !== undefined) {
    console.log(`Reason: ${evaluated.decision.reason}`);
  }
  console.log("Harness output:");
  console.log(evaluated.output.length > 0 ? evaluated.output : "(empty)");
  return 0;
}

async function gateCommand(args: string[]): Promise<number> {
  const subcommand = args[0];
  const rest = args.slice(1);
  if (subcommand === "install" || subcommand === "uninstall") {
    return gateInstallCommand(subcommand, rest);
  }
  if (subcommand === "status") {
    return gateStatusCommand(rest);
  }
  if (subcommand === "policy") {
    return gatePolicyCommand(rest);
  }
  if (subcommand === "contract") {
    return gateContractCommand(rest);
  }
  if (subcommand === "test") {
    return gateTestCommand(rest);
  }
  if (subcommand === "eval") {
    return gateEvalCommand(rest);
  }
  throw new ArgumentError(
    `Unknown gate subcommand: ${subcommand ?? "(missing)"}`,
  );
}

function printViolationTable(violations: PolicyViolation[]): void {
  if (violations.length === 0) {
    console.log("No violations found.");
    return;
  }
  const headers = [
    "SESSION",
    "RULE",
    "ACTION",
    "DETECTED",
    "EVENT",
    "EVIDENCE",
  ];
  const rows = violations.map((violation): string[] => [
    violation.session_id,
    violation.rule_id,
    violation.action,
    violation.detected_at,
    violation.event_id,
    violation.evidence,
  ]);
  const widths = headers.map((header, index): number =>
    Math.max(
      header.length,
      ...rows.map((row): number => row[index]?.length ?? 0),
    )
  );
  const render = (row: string[]): string =>
    row.map((cell, index): string =>
      cell.padEnd(widths[index] ?? cell.length)
    ).join("  ").trimEnd();
  console.log(render(headers));
  for (const row of rows) {
    console.log(render(row));
  }
}

function violationsCommand(args: string[]): number {
  const options = parseOptions(
    args,
    new Set(["--session", "--days", "--data-dir"]),
  );
  const store = openStore(join(gateDataDir(options), "hyperagent.db"));
  try {
    printViolationTable(listViolations(store, {
      ...(stringOption(options, "--session") === undefined
        ? {}
        : { sessionId: stringOption(options, "--session") }),
      ...(stringOption(options, "--days") === undefined
        ? {}
        : { days: positiveDays(stringOption(options, "--days")) }),
    }));
    return 0;
  } finally {
    store.close();
  }
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
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(cliPath)}</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
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
    return statusWithGateHealthCommand(rest);
  }
  if (command === "score") {
    return scoreCommand(rest);
  }
  if (command === "report") {
    return reportCommand(rest);
  }
  if (command === "missions") {
    return missionsCommand(rest);
  }
  if (command === "memory") {
    return memoryCommand(rest);
  }
  if (command === "gate") {
    return gateCommand(rest);
  }
  if (command === "violations") {
    return violationsCommand(rest);
  }
  if (command === "workshop") {
    return workshopCommand(rest);
  }
  if (command === "conformance") {
    return conformanceCommand(rest);
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
