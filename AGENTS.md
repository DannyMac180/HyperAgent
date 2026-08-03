# HyperAgent — Project Instructions

This repository is the **open data plane** of HyperAgent (MIT). These instructions apply to any agent working in this repo, whatever harness it runs in. They mirror `CLAUDE.md`; where the two disagree, that is a bug — fix both.

## The one rule that shapes everything else

**The pilot flies; the suit records.** HyperAgent observes agents through their harness's own telemetry — transcripts and lifecycle hooks — and never by asking an agent to report on itself. An agent working in this repo carries **zero HyperAgent ceremony**: no mission record to write, no proposal to file, no operating prompt to wear, no loop to run before or after the actual task. Just do the task.

If you find an instruction anywhere in this repo telling an agent to record its own work, that instruction is v1 and it is wrong. The v1 self-reporting loop — Mission → Workshop → Forge as agent-authored markdown, the `codex-hyperagent` skill, `hyperagent/operating-prompt.md`, and the `scripts/hyperagent.sh` CLI — was **retired on 2026-08-03** and now exists only in git history.

Why it was abolished rather than improved: it was measured. 60 of 66 recorded missions closed with no usable handoff, and the auto-closeout template filled the agent's own judgment fields with boilerplate. Self-assessment written by the thing being assessed degrades toward whatever passes the check. Involuntary observation is not an implementation detail here; it is the product.

## What this repo is

A local observer daemon (`hyperagentd`) watches agent harnesses' own telemetry, normalizes it into one vendor-neutral event schema in append-only SQLite, and exposes durable capabilities on top of that record: memory shared across agents and injected into each one, and verification/safety gates at harness hook points.

Recording is open and MIT because trust requires that observation be inspectable. The judgment plane — scoring, the Workshop that proposes upgrades, the Forge decay audit, and the Cockpit Mac app — is proprietary and lives in a separate private repo.

## Core design rules (binding for all code here)

1. **No self-reporting.** Observation comes from transcripts and hooks only. Nothing may require the working agent's cooperation.
2. **Durability test.** A capability is admissible only if it is ground truth, actuation/permission, measurement, or persistence (`docs/architecture-v2.md` §4). Never install "how to think" or "how to work" instructions — a more capable model makes those worthless, and they are the fastest thing for a harness vendor to absorb.
3. **Local-first.** Data lives in local SQLite and markdown, and markdown stays inspectable ground truth.
4. **Vendor-blind downstream.** Only adapters know vendor formats; everything else consumes the canonical schema (`docs/schema.md`).
5. **Adapter breakage is a normal event.** Version-detect and surface "adapter needs update" — never fail silently, and never claim coverage you do not have.
6. **Human review for persistent behavior changes**, enforced in code rather than requested in prose. See `docs/gates.md`.

## Conventions

- TypeScript on Bun (`bun`/`bunx`, never npm/npx).
- Tests: `bun test`. Typecheck: `bunx tsc --noEmit`. Both gate CI.
- Source layout: `src/schema`, `src/store`, `src/adapters`, `src/daemon`, `src/gate`, `src/memory`, `src/conformance`.
- A capability-matrix row is earned by a passing conformance run, never by editing the table. Regenerate with `bun src/daemon/cli.ts conformance matrix --write`.

## Open-core boundary

Everything pushed here is irrevocably MIT. **Never add judgment-plane code to this repo** — scoring, missions, workshop, forge/decay audit, and memory extraction/promotion/queue belong in the private cockpit repo. If a task appears to need them, stop and ask rather than guessing.

The seam the private plane attaches to is `IngestOptions` (`src/daemon/ingest.ts`) plus `WatchPlugins` and `runCli(args, extraCommands, watchPlugins)` (`src/daemon/cli.ts`). Keep it stable and vendor-blind; an interface change needs the matching private-side change landing with it.

Schema and store changes always land here first.
