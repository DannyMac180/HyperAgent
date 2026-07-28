# Decision Record — DAN-213: The Open-Core Boundary

- **Status:** Accepted (ratified by Dan, 2026-07-28)
- **Date:** 2026-07-26
- **Decider:** Dan (Business)
- **Ticket:** [DAN-213](https://linear.app/danmac/issue/DAN-213/decide-the-open-core-boundary)
- **Supersedes:** the working recommendation in the ticket description ("daemon + adapters + CLI + schema open; Cockpit paid")

## Decision

**Split on plane, not surface: the observation plane is open source; the judgment plane is paid.** The paid product is not "the Mac app UI" — it is the intelligence and workflow layer, delivered through the Mac app.

| Plane | Components | License / Terms |
|---|---|---|
| **Open — the data plane ("the armor")** | Canonical event schema spec · `hyperagentd` daemon · all harness adapters · SQLite event store · CLI for raw inspection/query · markdown ground-truth artifacts | MIT |
| **Paid — the judgment plane ("the cockpit")** | Session scoring + rubric · comparative agent measurement + routing recommendations · mission generation · memory extraction pipelines + injection management UX · Workshop proposal generation · replay-eval harness · decay audit · review queue (approve/reject with evidence) · dashboards, menu-bar app, notifications | Proprietary, shipped inside the Cockpit Mac app |

One-liner (from `insights.md`, now with a precise referent): **"Charge for the cockpit, not the armor"** — where the cockpit is the judgment layer, not the pixels.

## Context

The ticket's working recommendation opened everything except the Mac app. Analysis (2026-07-26 session) concluded that boundary fails for the 2026 launch audience:

1. **The DIY test.** The launch audience is technical agent power users — exactly the people who can tell their own coding agent "build me a dashboard over `~/.hyperagent/hyperagent.db`" and get 80% of a read-mostly Cockpit in an afternoon. A versioned open schema makes the DIY dashboard cheap to *regenerate* whenever it drifts, killing the classic "you could build it but not maintain it" defense. UI polish, code-signing, and menu-bar presence are real but Raycast-tier value — not a durable wedge.
2. **The trust argument only needs open eyes, not an open brain.** "Audit it yourself, nothing leaves your machine" requires the components that *read your transcripts* to be inspectable: daemon, adapters, schema, store. It does not require the analytics on top to be open. Open the plane that touches trust; charge for the plane that embodies judgment.
3. **The moat was being given away.** Comparative measurement and replay evals (differentiators #5 and #8 in `insights.md`) are the structural moat — the craft distilled from the v1 post-mortem. Under the old boundary they defaulted into the open daemon, making the free product complete and the paid product decorative. Raw events are data; scoring, memory quality, and decay-audit methodology are judgment. Open = flight recorder; paid = flight instructor.
4. **Workflow resists self-generation better than views.** The review queue is a *maintained, correct approval pipeline* for persistent behavior changes (core rule 7: human review, enforced in code). Agents generate dashboards easily; they generate trustworthy approval workflows badly. That surface belongs in the product users pay to rely on.

## Clarifications and consequences

- **Cognition rides the user's CLI (unchanged).** The judgment plane is prompts + rubrics + orchestration code dispatched through headless `claude -p` / `codex exec` — no hosted inference, no margin decay. Consequence: the paid IP is trivially clonable *once read*. Closed source doesn't stop a determined cloner; it stops the free product from being complete and stops "just fork it" from being the default path.
- **Methodology open, machinery paid.** The worldview ships free — essays, the durability test, the decay-audit concept, the schema spec. The implementations earn. Publishing the methodology is the marketing; it does not obligate publishing the pipeline code.
- **Post-hoc policy *detection* is open; the surfacing is paid.** Detection lives in the daemon's observation path (trust surface). The Cockpit surfaces violations, trends, and "which agent to trust with what."
- **Safety gates (blocking hooks) are open.** Actuation/permission is armor, not cockpit — users must be able to audit anything that can block their agents.
- **Schema as standard.** MIT-licensing the schema spec keeps the "publish as standalone agent-telemetry standard" option (architecture-v2 §10) fully open.
- **Teams tier (deferred, named now).** "Your team's agents share one nervous system" requires sync infrastructure — genuinely not self-generatable and the cleanest future paid line above the individual Cockpit. Not scoped here; recorded so the boundary anticipates it.
- **Non-engineer buyers (2027).** For them the app is the whole product regardless of boundary. They widen the funnel later; they do not justify a UI-only boundary today.

## What this changes in practice

- `src/` layout (DAN-198/199) must keep the judgment plane physically separable from the daemon — no scoring/extraction/Workshop code in the MIT tree. The open repo's first commit ships with MIT `LICENSE`; the judgment plane lives in a private repo (or private subtree) from day one. Relicensing later is painful; separating later is worse.
- DAN-201 (mission generation + scoring) lands on the **paid** side of the line. Its interface to the open store is the canonical schema only — vendor-blind and plane-blind.
- Launch copy: sell the mirror first, but the free mirror is the recorder; the paid mirror is the one that tells you what it means.

## Alternatives considered

1. **Everything open except the Mac app UI** (the ticket's working recommendation) — rejected: paid product is generatable by the launch audience's own agents; moat given away (see Context).
2. **Fully proprietary** — rejected: forfeits the trust story software reading all agent transcripts cannot live without, and the schema-as-standard option.
3. **Open core + BSL/SSPL on the judgment plane** — rejected for now: source-available licensing invites the clone it tries to prevent while forfeiting the simplicity of "MIT armor, paid cockpit." Revisit only if a hosted/Teams product creates a hyperscaler-style risk.

## Ratification record (2026-07-28)

Dan ratified the plane boundary with four concrete calls:

1. **Product model clarified:** the paid Mac app ships *everything* — no in-app paywall or feature-gating. The public repo is the curated trust subset. The split is a build/repo boundary, not a runtime one.
2. **Topology — A, flip-in-place:** the existing public `HyperAgent` repo stays public and becomes the open-plane repo. The judgment plane is extracted (with history, via `git filter-repo`) into a new **private** `hyperagent-cockpit` repo, then removed from public HEAD via `git rm` — no history rewrite, no force push. Already-published judgment-plane code (through `7c2ca5d`, including DAN-204 Workshop drafting) remains irrevocably MIT in history; future versions are private.
3. **Open daemon is runnable standalone** — the free product is a working flight recorder (observe + store + gate + raw CLI). Requires a typed plugin seam (`onEvent` / `onSessionEnd` / `registerCommands`) replacing the direct judgment-plane imports in `src/daemon/ingest.ts` and `src/daemon/cli.ts`. The Cockpit builds its own daemon binary linking the judgment modules.
4. **File-level boundary (verified 2026-07-28 — no open file imports a private file):**
   - **Open:** `src/schema/`, `src/store/`, `src/adapters/` (incl. `types.ts` — its memory-type imports resolve to open files), `src/gate/`, `src/daemon/` (post-seam), `src/memory/store.ts`, `src/memory/inject.ts`, adapter injection renderers.
   - **Private:** `src/memory/extract.ts`, `src/memory/promote.ts`, `src/memory/queue.ts`, `src/missions/` (all), `src/scoring/` (all), all Workshop code.

**Timing decision: freeze now, split later.** Effective immediately, no new judgment-plane code is pushed to the public repo (see CLAUDE.md). Split execution awaits Dan's explicit go. Order of operations when it runs: extract → build-verify cockpit green → `git rm` from public. Schema changes always land in the public repo first.

## Review trigger

Revisit this boundary when the Teams tier is scoped, or if post-launch evidence shows the free data plane alone drives adoption without conversion (the judgment plane priced wrong or valued wrong).
