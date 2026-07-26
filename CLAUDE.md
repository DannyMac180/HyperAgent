# HyperAgent — Project Instructions for Claude Code

## Read this first

HyperAgent is being rearchitected. **`docs/architecture-v2.md` is the source of truth** for all new work; where it conflicts with the PRD (`docs/hyperagent-prd.md`) or the v1 implementation, architecture-v2 wins. `docs/insights.md` holds the product differentiators, one-liners, and demo ideas — read it before writing any user-facing copy, docs, or launch material.

**Ignore the v1 loop instructions in `AGENTS.md`** (mission records, Workshop proposals, Forge reviews, the codex-hyperagent skill). That ceremony is the v1 mechanism v2 explicitly abolishes — do not write mission records or run `scripts/hyperagent.sh` as part of doing tasks in this repo. `AGENTS.md` is retained for the v1/Codex surface until DAN-211 retires it.

## What v2 is (one paragraph)

A meta-harness: a local observer daemon (`hyperagentd`) that watches agent harnesses' own telemetry (transcripts + lifecycle hooks — never agent self-reporting), normalizes it into a canonical event schema in SQLite, and builds durable cross-vendor capabilities on top: shared memory injected into every agent, verification/safety gates at hook points, a Workshop that proposes upgrades tested by replay evals, and a Forge decay audit that retires capabilities models outgrow. The working agent carries zero HyperAgent ceremony. Paid surface: the Cockpit Mac app, over an open core.

## Core design rules (binding for all v2 code)

1. **The pilot flies; the suit records.** Nothing may require the working agent to voluntarily self-report. Observation comes from transcripts/hooks only.
2. **Durability test.** A capability is admissible only if it's ground truth, actuation/permission, measurement, or persistence (`architecture-v2.md` §4). Never install "how to think/work" instructions.
3. **Local-first.** All data in local SQLite + markdown; nothing leaves the machine. Markdown stays inspectable ground truth.
4. **Vendor-blind downstream.** Only adapters know vendor formats; everything else consumes the canonical schema (§6.1).
5. **Adapter breakage is a normal event** — version-detect, surface "adapter needs update," never fail silently.
6. **Suit cognition rides the user's own agent CLI** (headless `claude -p` / `codex exec`) — no direct model-API dependencies for background analysis.
7. **Human review for persistent behavior changes** — v1's authority boundary carries forward, enforced in code.

## Conventions

- TypeScript on Bun for all new code (`bun`/`bunx`, never npm/npx). The v1 bash CLI (`scripts/hyperagent.sh`) is legacy — do not extend it.
- v1 verify scripts (`scripts/verify-core.sh` etc.) guard the v1 tree only; do not treat their string-presence checks as gates for v2 code.
- New v2 code lives under a clean top-level layout (proposed: `src/` for daemon+engine, `src/adapters/`, `app/` for Cockpit) — establish it in DAN-198/199 and record the decision in `docs/architecture-v2.md`.

## Work tracking

Workstreams are Linear tickets **DAN-198 … DAN-215** in the HyperAgent project (team Danmac). `Engineering`-labeled tickets are implementable by Claude Code; `Business`-labeled tickets are Dan's. Each ticket cites its architecture-v2 section. Build order (§9): schema (DAN-198) → daemon + Claude Code adapter (DAN-199/200) → mission generation + scoring (DAN-201) → memory (DAN-202) → gates (DAN-203) → Workshop (DAN-204) → more adapters (DAN-205/207) → Forge (DAN-208) → Cockpit (DAN-210 design → DAN-209 build). DAN-211 (repo transition/hygiene) can run first and in parallel.

## Known repo state (2026-07-26, post-DAN-211)

- The formerly-uncommitted v1 tree is landed as its own commit; the branch is reconciled with origin/main. Working tree should be clean — if it isn't, that's new work, not legacy debt.
- `missions/` is untracked (`git rm --cached`, gitignored) and private by policy; records pushed before 2026-07-26 remain in git history and are treated as public (see `docs/evidence-policy.md`). Never re-track it.
- The two known v1 bugs (closeout `--mission` silent overwrite; redaction awk corrupting the tab-separated log) are FIXED in `scripts/hyperagent.sh`. Full AGENTS.md retirement remains open under DAN-211.
