# HyperAgent — Project Instructions for Claude Code

## Read this first

This repo is the **open data plane** of HyperAgent (MIT). `AGENTS.md` carries the same instructions for non-Claude agents — keep the two in sync; where they disagree, that is a bug in both.

**`docs/architecture-v2.md` is the rearchitecture rationale**; `docs/schema.md` wins on schema questions.

The v1 self-reporting loop — mission records, the `codex-hyperagent` skill, `hyperagent/operating-prompt.md`, the `scripts/hyperagent.sh` CLI, and the v1 verify scripts — was **retired on 2026-08-03** and exists only in git history. Its documentation is in `docs/archive/`. If you find an instruction telling an agent to record its own work, it is a leftover and it is wrong.

## What this is (one paragraph)

A meta-harness: a local observer daemon (`hyperagentd`) that watches agent harnesses' own telemetry (transcripts + lifecycle hooks — never agent self-reporting), normalizes it into a canonical event schema in append-only SQLite, and builds durable cross-vendor capabilities on top — memory shared across agents and injected into each, and verification/safety gates at hook points. The working agent carries zero HyperAgent ceremony. Judgment over that record (scoring, improvement proposals, decay audit, the Cockpit app) is the separate proprietary plane.

## Core design rules (binding for all code here)

1. **The pilot flies; the suit records.** Nothing may require the working agent to voluntarily self-report. Observation comes from transcripts/hooks only.
2. **Durability test.** A capability is admissible only if it's ground truth, actuation/permission, measurement, or persistence (`architecture-v2.md` §4). Never install "how to think/work" instructions.
3. **Local-first.** All data in local SQLite + markdown; nothing leaves the machine. Markdown stays inspectable ground truth.
4. **Vendor-blind downstream.** Only adapters know vendor formats; everything else consumes the canonical schema (§6.1).
5. **Adapter breakage is a normal event** — version-detect, surface "adapter needs update," never fail silently.
6. **Human review for persistent behavior changes** — enforced in code, not asked for in prose (`docs/gates.md`).

## Conventions

- TypeScript on Bun (`bun`/`bunx`, never npm/npx).
- Tests: `bun test`. Typecheck: `bunx tsc --noEmit`. Both gate CI, alongside a privacy guard.
- Layout: `src/schema`, `src/store`, `src/adapters`, `src/daemon`, `src/gate`, `src/memory`, `src/conformance`.
- A capability-matrix row is earned by a passing conformance run, never by editing the table (`bun src/daemon/cli.ts conformance matrix --write`).

## Open-core boundary (DAN-213, executed 2026-07-28)

This repo is the **open data plane** ("the armor", MIT): schema, store, adapters, daemon, gates, `memory/store.ts` + `memory/inject.ts` + injection renderers, conformance, raw-inspection CLI. The **judgment plane** ("the cockpit", proprietary) lives in the private `hyperagent-cockpit` repo: scoring, missions, workshop, forge/decay audit, memory extraction/promotion/queue. See `docs/decisions/DAN-213-open-core-boundary.md`.

**Binding rules for this repo:**
- Never add judgment-plane code here — every push is irrevocably MIT. If a task needs scoring/missions/workshop/forge/memory-extraction changes, it belongs in `hyperagent-cockpit` (checkout: `~/Desktop/dev/hyperagent-cockpit`); stop and surface if unsure.
- **This checkout is the side door.** The cockpit repo vendors this one as its `open/` submodule (tracking `main`), so cross-plane and judgment-plane sessions start there and edit this code through `open/`. Use this checkout for open-plane-only work. Either way the commit lands here and goes through a PR — after it merges, the cockpit's submodule pin gets bumped separately.
- The daemon/CLI seam is `IngestOptions.scorer`/`missionQueue`/`memoryQueue` (`src/daemon/ingest.ts`), `WatchPlugins` + `runCli(args, extraCommands, watchPlugins)` (`src/daemon/cli.ts`). The Cockpit wraps these; keep them stable and vendor-blind — interface changes need a matching cockpit PR before merge.
- Schema and store changes always land HERE first; the cockpit pins this repo and consumes the canonical schema only.
- Judgment-plane git history predating the split (through `61499ab`) remains in this repo's public history — that's accepted and irrevocable; do not attempt history rewrites.

## Work tracking

Workstreams are Linear tickets **DAN-198 … DAN-215** in the HyperAgent project (team Danmac). `Engineering`-labeled tickets are implementable by Claude Code; `Business`-labeled tickets are Dan's. Each ticket cites its architecture-v2 section. Build order (§9): schema (DAN-198) → daemon + Claude Code adapter (DAN-199/200) → mission generation + scoring (DAN-201) → memory (DAN-202) → gates (DAN-203) → Workshop (DAN-204) → more adapters (DAN-205/207) → Forge (DAN-208) → Cockpit (DAN-210 design → DAN-209 build). DAN-211 (repo transition/hygiene) can run first and in parallel.

## Known repo state (2026-08-03, post-v1-retirement)

- `missions/` is untracked (`git rm --cached`, gitignored) and private by policy; records pushed before 2026-07-26 remain in git history and are treated as public (see `docs/evidence-policy.md`). Never re-track it.
- The v1 surface (`scripts/`, `evals/`, `bin/`, `ui/`, `adapters/`, `templates/`, `hyperagent/`, `workshop/`, `forge/`, `skills/codex-hyperagent/`) was deleted on 2026-08-03 and lives in git history. `AGENTS.md` and `README.md` were rewritten around the data plane at the same time.
