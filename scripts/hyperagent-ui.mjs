#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const scriptDir = resolve(new URL(".", import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "..");
const uiRoot = join(repoRoot, "ui");

const args = parseArgs(process.argv.slice(2));
const host = args.host || "127.0.0.1";
const port = Number(args.port || process.env.HYPERAGENT_UI_PORT || 8765);

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
]);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") {
      parsed.host = argv[++index];
    } else if (arg === "--port") {
      parsed.port = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return parsed;
}

function usage() {
  return `Usage: node scripts/hyperagent-ui.mjs [--host HOST] [--port PORT]\n\nServes the local HyperAgent evidence cockpit.\n`;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function safeStaticPath(urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const decoded = decodeURIComponent(requested);
  const fullPath = normalize(join(uiRoot, decoded));
  if (!fullPath.startsWith(uiRoot)) {
    return null;
  }
  return fullPath;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${host}:${port}`);
  const filePath = safeStaticPath(url.pathname);
  if (!filePath) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    const type = contentTypes.get(extname(filePath)) || "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
    });
    res.end(data);
  } catch (error) {
    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    sendText(res, 404, "Not found");
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${host}:${port}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/overview") {
      sendJson(res, 200, await buildOverview());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/missions") {
      sendJson(res, 200, await readArtifacts("missions", parseMission));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/proposals") {
      sendJson(res, 200, await readArtifacts("workshop/proposals", parseProposal));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/forge-reviews") {
      sendJson(res, 200, await readArtifacts("forge/reviews", parseForgeReview));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/decisions") {
      sendJson(res, 200, await readArtifacts("workshop/decisions", parseDecision));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/capabilities") {
      sendJson(res, 200, await readCapabilities());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/sense") {
      sendJson(res, 200, await runSenseJson());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/actions/run") {
      const body = await readRequestJson(req);
      sendJson(res, 200, await runAllowedAction(body.action));
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function readRequestJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) {
      throw new Error("request body too large");
    }
  }
  return body ? JSON.parse(body) : {};
}

async function readArtifacts(directory, parser) {
  const dir = join(repoRoot, directory);
  if (!existsSync(dir)) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const artifacts = [];
  for (const file of files) {
    const absolutePath = join(dir, file);
    const content = await readFile(absolutePath, "utf8");
    const fileStat = await stat(absolutePath);
    artifacts.push(parser(content, absolutePath, fileStat));
  }
  return artifacts;
}

function artifactBase(content, absolutePath, fileStat) {
  return {
    id: relative(repoRoot, absolutePath).replace(/\\/g, "/").replace(/\.md$/, ""),
    file: relative(repoRoot, absolutePath).replace(/\\/g, "/"),
    title: firstHeading(content),
    modifiedAt: fileStat.mtime.toISOString(),
    rawPreview: content.split("\n").slice(0, 12).join("\n"),
  };
}

function parseMission(content, absolutePath, fileStat) {
  const base = artifactBase(content, absolutePath, fileStat);
  const verification = field(content, "Verification status");
  const outcome = field(content, "Final outcome");
  const risk = field(content, "Unresolved risks");
  return {
    ...base,
    missionId: field(content, "Mission ID") || base.id,
    dateTime: field(content, "Date/time"),
    request: field(content, "User request"),
    branch: stripTicks(field(content, "Branch")),
    verification,
    outcome,
    risk,
    status: statusFromText(`${verification} ${outcome} ${risk}`),
    changedFiles: codeBlockAfter(content, "- Changed files:"),
    commands: field(content, "Commands run"),
    friction: field(content, "Suit friction observed"),
  };
}

function parseProposal(content, absolutePath, fileStat) {
  const base = artifactBase(content, absolutePath, fileStat);
  return {
    ...base,
    title: field(content, "Upgrade title") || base.title,
    proposalId: field(content, "Proposal ID") || base.id,
    dateTime: field(content, "Date/time"),
    mission: stripTicks(field(content, "Related mission record")),
    activationMode: field(content, "Proposed activation mode"),
    priority: field(content, "Backlog priority"),
    score: field(content, "Workshop rubric score"),
    problem: field(content, "Problem observed"),
    capability: field(content, "Proposed capability"),
    expectedImpact: field(content, "Expected impact"),
    firstStep: field(content, "Highest-priority plan step"),
    decision: field(content, "Recommended decision"),
    status: proposalStatus(content),
  };
}

function parseForgeReview(content, absolutePath, fileStat) {
  const base = artifactBase(content, absolutePath, fileStat);
  return {
    ...base,
    reviewId: field(content, "Review ID") || base.id,
    dateTime: field(content, "Date/time"),
    reviewer: field(content, "Reviewer"),
    proposalsReviewed: field(content, "Proposals reviewed"),
    proposalScore: field(content, "Proposal quality score"),
    processScore: field(content, "Process reliability score"),
    friction: field(content, "Workshop process friction"),
    recommendation: field(content, "Recommendation"),
    humanApprovalNeeded: field(content, "Human approval needed"),
  };
}

function parseDecision(content, absolutePath, fileStat) {
  const base = artifactBase(content, absolutePath, fileStat);
  return {
    ...base,
    decisionId: field(content, "Decision ID") || base.id,
    dateTime: field(content, "Date/time"),
    proposal: stripTicks(field(content, "Proposal")),
    decision: field(content, "Decision"),
    reviewer: field(content, "Reviewer"),
    reason: field(content, "Reason"),
    capability: field(content, "Capability registry ID"),
  };
}

async function readCapabilities() {
  const registry = join(repoRoot, "hyperagent/capability-registry.md");
  if (!existsSync(registry)) {
    return [];
  }
  const content = await readFile(registry, "utf8");
  const sections = content.split(/\n(?=##\s+)/g).filter((section) => section.startsWith("## "));
  return sections
    .filter((section) => !section.startsWith("## Accepted Capabilities") && !section.startsWith("## Capability Entry Template"))
    .map((section) => ({
      id: firstHeading(section).replace(/^#+\s*/, "").trim(),
      title: field(section, "Title"),
      status: field(section, "Status"),
      sourceProposal: stripTicks(field(section, "Source proposal")),
      decisionRecord: stripTicks(field(section, "Decision record")),
      acceptedAt: field(section, "Accepted at"),
      activationMode: field(section, "Activation mode"),
      verification: field(section, "Verification"),
      rollback: field(section, "Rollback"),
    }));
}

async function buildOverview() {
  const [missions, proposals, forgeReviews, decisions, capabilities, sense] = await Promise.all([
    readArtifacts("missions", parseMission),
    readArtifacts("workshop/proposals", parseProposal),
    readArtifacts("forge/reviews", parseForgeReview),
    readArtifacts("workshop/decisions", parseDecision),
    readCapabilities(),
    runSenseJson().catch((error) => ({ error: error.message })),
  ]);
  const pendingProposals = proposals.filter((proposal) => proposal.status !== "accepted" && proposal.status !== "rejected");
  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    safetyMode: "human review required",
    missionCount: missions.length,
    proposalCount: proposals.length,
    pendingProposalCount: pendingProposals.length,
    forgeReviewCount: forgeReviews.length,
    decisionCount: decisions.length,
    capabilityCount: capabilities.length,
    latestMission: missions[0] || null,
    latestProposal: proposals[0] || null,
    latestForgeReview: forgeReviews[0] || null,
    recentMissions: missions.slice(0, 6),
    pendingProposals: pendingProposals.slice(0, 6),
    capabilities: capabilities.slice(0, 6),
    sense,
  };
}

async function runSenseJson() {
  const { stdout } = await execFileAsync("sh", ["scripts/hyperagent.sh", "sense", "--format", "json", "--pr", "off"], {
    cwd: repoRoot,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function runAllowedAction(action) {
  const allowed = {
    status: ["sh", ["scripts/hyperagent.sh", "status"]],
    sense: ["sh", ["scripts/hyperagent.sh", "sense", "--pr", "off"]],
    verify: ["sh", ["scripts/verify-mvp.sh"]],
  };
  if (!Object.hasOwn(allowed, action)) {
    throw new Error("unsupported action");
  }
  const [command, commandArgs] = allowed[action];
  const startedAt = new Date().toISOString();
  try {
    const { stdout, stderr } = await execFileAsync(command, commandArgs, {
      cwd: repoRoot,
      timeout: action === "verify" ? 30000 : 15000,
      maxBuffer: 1024 * 1024,
    });
    return {
      action,
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      output: stdout,
      errorOutput: stderr,
    };
  } catch (error) {
    return {
      action,
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      output: error.stdout || "",
      errorOutput: error.stderr || error.message,
    };
  }
}

function firstHeading(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Untitled";
}

function field(content, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^-\\s+${escaped}:\\s*(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

function stripTicks(value) {
  return value.replace(/^`|`$/g, "");
}

function codeBlockAfter(content, marker) {
  const index = content.indexOf(marker);
  if (index < 0) {
    return [];
  }
  const rest = content.slice(index);
  const match = rest.match(/~~~text\n([\s\S]*?)\n~~~/);
  if (!match) {
    return [];
  }
  return match[1].split("\n").map((line) => line.trim()).filter(Boolean);
}

function statusFromText(text) {
  const lower = text.toLowerCase();
  if (lower.includes("fail") || lower.includes("blocked")) {
    return "needs-attention";
  }
  if (lower.includes("pending")) {
    return "pending";
  }
  if (lower.includes("pass") || lower.includes("verified") || lower.includes("complete")) {
    return "verified";
  }
  return "recorded";
}

function proposalStatus(content) {
  const explicitStatus = field(content, "Artifact status").toLowerCase();
  if (explicitStatus && explicitStatus !== "draft") {
    return explicitStatus;
  }
  const lower = content.toLowerCase();
  if (lower.includes("- recommended decision: accepted") || lower.includes("- decision: accepted")) {
    return "accepted";
  }
  if (lower.includes("- recommended decision: rejected") || lower.includes("- decision: rejected")) {
    return "rejected";
  }
  if (lower.includes("human review required")) {
    return "review";
  }
  return "draft";
}

if (args.help) {
  process.stdout.write(usage());
  process.exit(0);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`invalid port: ${args.port}`);
}

const server = createServer(async (req, res) => {
  if (req.url?.startsWith("/api/")) {
    await handleApi(req, res);
    return;
  }
  await serveStatic(req, res);
});

server.listen(port, host, () => {
  process.stdout.write(`HyperAgent UI running at http://${host}:${port}\n`);
});
