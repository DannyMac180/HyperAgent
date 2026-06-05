# HyperAgent Dogfooding Guide

This guide is for a human reviewer dogfooding HyperAgent from a fresh install and then through repeated real use.

The goal is not to have Codex grade itself. The goal is for a human to check whether HyperAgent is faithful to the PRD: a Codex-first, local, markdown-first Suit that records mission evidence, proposes upgrades through the Workshop, reviews the Workshop through the Forge, and keeps persistent changes under human review.

## Source Documents

Read these first:

- `docs/hyperagent-prd.md`
- `docs/product-state.md`
- `docs/roadmap.md`
- `docs/extensions.md`
- `docs/safety-policy.md`
- `docs/evidence-policy.md`
- `README.md`
- `docs/quickstart.md`
- `docs/clean-install-uat.md`

## What To Prove

The dogfooding pass should prove these claims:

- A first-time Codex Mac user can install the `codex-hyperagent` skill.
- HyperAgent works without hosted services, a database, or autonomous self-modification.
- The core loop works with local markdown artifacts: Mission -> Workshop -> Forge -> Human Review.
- Core verification is separate from optional extensions and release checks.
- The optional local UI and sensing surfaces remain views/helpers over markdown, not the source of truth.
- Project initialization creates local memory/setup files without copying the full helper runtime or optional UI into the target project.
- Human review remains required before persistent behavior changes.

## Fresh-Install UAT

Use a scratch project and follow `docs/clean-install-uat.md`.

After setup, verify:

- `~/HyperAgent` exists and is a clone of this repo.
- `~/.codex/skills/codex-hyperagent/SKILL.md` exists.
- `sh scripts/verify-mvp.sh` passes from the HyperAgent repo.
- `sh scripts/hyperagent.sh verify all` passes from the HyperAgent repo.
- The scratch project has `.hyperagent`, `AGENTS.md`, `missions/`, `workshop/`, `forge/`, `templates/`, and `hyperagent/`.
- The scratch project does not need a copied `scripts/hyperagent.sh` or copied `ui/` directory for the core setup to be valid.
- Codex reports any restart or fresh-thread requirement clearly.
- Codex does not edit global Codex custom instructions.

Record failures with the pasted prompt, command attempted, exact failure, and whether the failure is product, docs, or environment friction.

## One Real Mission

In a scratch or low-risk repo, ask Codex to use the HyperAgent skill on a real small task.

Check the result:

- A mission record is written in `missions/`.
- The mission record includes request, plan, files or systems changed, commands/checks, verification, outcome, risks, and friction.
- The final user-facing response matches the mission evidence.
- If there was concrete friction, a Workshop proposal is created in `workshop/proposals/`.
- If there was no concrete friction, Codex says no proposal was needed instead of inventing one.

Then run:

```bash
sh scripts/hyperagent.sh mission closeout --mission path/to/mission.md
```

The closeout audit should identify pending placeholders or confirm that the mission is complete.

## Workshop Review

After several missions, run a human review of Workshop behavior.

Check:

- Proposals link to mission evidence.
- Proposed capabilities are specific and testable.
- Safety risk, activation mode, rollback, and verification are explicit.
- Proposals do not silently activate persistent behavior changes.
- The backlog remains a planning view, not a second approval source.

Useful command:

```bash
sh scripts/hyperagent.sh review prompt workshop
```

## Forge Review

After multiple proposals or obvious process friction, review the Workshop process.

Check:

- Forge reviews judge proposal specificity, evidence, tests, safety, and value.
- Forge changes improve the Workshop, not the user's code directly.
- Process changes remain `human review required`.
- Repeated low-value proposals or stale decisions are called out explicitly.

Useful command:

```bash
sh scripts/hyperagent.sh review prompt forge
```

## Extension Checks

Optional extensions should help without becoming required core product surface.

### Sensing

Run:

```bash
sh scripts/hyperagent.sh sense --pr off
sh scripts/hyperagent.sh sense --doctor
```

Check that missing Workbench traces are reported as optional fallback state, not as product failure.

### Local UI

Run:

```bash
sh scripts/hyperagent.sh ui
```

Check that the UI reads local markdown artifacts, exposes only explicit local actions, and does not replace markdown as source of truth.

### Reliability Eval

Run:

```bash
sh evals/extensions/reliability-gains.sh
```

Treat this as an optional research/eval surface until it uses real repeated mission evidence.

## Verification Cadence

For core changes:

```bash
sh scripts/verify-core.sh
sh evals/smoke-loop.sh
```

For optional extensions:

```bash
sh scripts/verify-extensions.sh
sh evals/extensions/sense-smoke.sh
sh evals/extensions/ui-smoke.sh
sh evals/extensions/reliability-gains.sh
```

Before a public release:

```bash
sh scripts/verify-release.sh
sh evals/init-smoke.sh
```

## Two-Week Dogfooding Cadence

For a serious dogfooding run:

1. Use HyperAgent on meaningful repo tasks for two weeks.
2. Review mission records every few days for missing evidence, weak verification, repeated friction, and unclear risks.
3. Review Workshop proposals weekly for specificity, testability, safety, rollback quality, and actual value.
4. Review Forge output weekly for whether it improves proposal quality instead of adding process theater.
5. Keep a short human notes file with surprising wins, annoying friction, skipped checks, and any places where HyperAgent felt heavier than the work deserved.
6. End the run by updating `docs/product-state.md`, `docs/roadmap.md`, and release notes only if the actual product state changed.

## Pass Criteria

Dogfooding passes when:

- A fresh install works from the README path.
- A real mission creates useful local evidence.
- Workshop proposals are evidence-backed when friction exists.
- Forge reviews improve process quality when proposal quality is weak.
- Core verification passes.
- Optional extensions remain optional.
- Human approval remains required for persistent changes.
- A human can understand what happened by reading the repo artifacts without opening the chat transcript.

## Fail Criteria

Dogfooding fails when:

- Setup depends on hidden local state.
- Codex changes global instructions without explicit approval.
- Mission records are missing verification, outcome, or risk evidence.
- Workshop proposals are generic, unlinked to evidence, or hard to test.
- Forge reviews add ceremony without improving proposal quality.
- Optional UI/sensing/reliability surfaces become required for the core loop.
- Persistent behavior changes are activated without human review.
