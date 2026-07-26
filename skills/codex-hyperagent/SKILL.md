---
name: codex-hyperagent
description: Run Codex with the HyperAgent Suit. Use when the user asks Codex to operate as HyperAgent, run a HyperAgent mission, produce mission telemetry, review mission friction, or propose Suit upgrades.
metadata:
  short-description: Run Codex with HyperAgent mission, Workshop, and Forge loops
  version: v0.1.0-alpha
---

# codex-hyperagent

Use this skill when the user asks Codex to operate as HyperAgent, run a HyperAgent mission, produce mission telemetry, review mission friction, or propose Suit upgrades. In the HyperAgent repository itself, project instructions may require HyperAgent triage on every task.

## Source Of Truth

- Product contract: `docs/hyperagent-prd.md`
- Suit prompt: `hyperagent/operating-prompt.md`
- Capability registry: configured by `.hyperagent/config.toml`; new installs default to `.hyperagent/hyperagent/capability-registry.md`
- Mission template: configured by `.hyperagent/config.toml`; new installs default to `.hyperagent/templates/mission-record.md`
- Upgrade proposal template: configured by `.hyperagent/config.toml`; new installs default to `.hyperagent/templates/upgrade-proposal.md`
- Forge review template: configured by `.hyperagent/config.toml`; new installs default to `.hyperagent/templates/forge-review.md`
- Upgrade backlog: `workshop/backlog.md`
- Workshop rubric: `workshop/rubric.md`
- Forge quality rubric: `forge/process/quality-rubric.md`
- Forge audit command: `sh scripts/hyperagent.sh review forge audit`
- Local helper: `scripts/hyperagent.sh`

## Operating Loop

1. Read `hyperagent/operating-prompt.md`.
2. Run HyperAgent relevance triage.
3. If the task is relevant, run it as a Mission. Keep scope tight and verify the result.
4. Run verification through `sh scripts/hyperagent.sh check -- COMMAND` when possible so evidence is recorded automatically.
5. Before final response on relevant tasks, create or update a mission record with `sh scripts/hyperagent.sh mission closeout --request "..." --slug "..." --outcome "..." --risks "..."`.
6. Run `sh scripts/hyperagent.sh mission verify --strict PATH` before using the mission as Workshop evidence. New installs default to `.hyperagent/missions/MISSION.md`.
7. If the mission exposed friction, create at least one Workshop proposal in the configured proposals directory. New installs default to `.hyperagent/workshop/proposals/`.
8. Every Workshop proposal must include an `Implementation Plan` section that names the single highest-priority plan step first, then lists implementation steps, files or instructions likely to change, and verification for that first step.
9. Score proposal priority with `workshop/rubric.md` before recommending implementation.
10. If the friction is about the quality of the Workshop process itself, create a Forge review in the configured Forge reviews directory. New installs default to `.hyperagent/forge/reviews/`.
11. Do not mark a proposal accepted unless there is an explicit human approval decision in the configured decisions directory. New installs default to `.hyperagent/workshop/decisions/`.
12. Report the triage decision, mission outcome, verification, record path, proposal path if any, decision path if any, and unresolved risk to the user.

Use `sh scripts/hyperagent.sh sense` to inspect current local context. Prefer `check`, `sense`, `mission closeout`, and `mission verify --strict` when they make artifact creation more reliable, but fill in final outcome and risk judgment yourself.

## Relevance Triage

Run triage before deciding whether to write mission telemetry.

Use the full HyperAgent loop when the task:

- changes files, docs, scripts, templates, skills, evals, or product behavior,
- asks about the HyperAgent PRD, architecture, setup, install flow, skill behavior, or repo status,
- requires investigation across multiple files or commands,
- involves verification, debugging, failing checks, or repeated friction,
- could reveal an improvement to the Suit, Workshop, Forge, installer, docs, or evals,
- explicitly asks to use HyperAgent or run a HyperAgent mission.

Skip the full loop when the task is clearly isolated and low-signal:

- simple factual answer that does not depend on repo state,
- trivial one-line command,
- restating prior status without new investigation,
- small conversational clarification,
- simple wording or formatting that does not affect project behavior.

When skipping, say: `HyperAgent triage: isolated one-off; no mission record written.`

When in doubt inside the HyperAgent repo, run the full loop. This project is the testbed.

## Workshop Review Prompt

Review the recent mission records in the configured missions directory. New installs default to `.hyperagent/missions/`. Identify concrete Suit friction that appears in the evidence. For the highest-value friction, create an upgrade proposal in the configured proposals directory using the configured upgrade proposal template. Do not activate the upgrade. Default the activation mode to `human review required`.

Use `workshop/rubric.md` and update `workshop/backlog.md` when the proposal should be tracked for implementation.

## Forge Review Prompt

Review recent upgrade proposals, decisions, accepted capabilities, and evals in `evals/` plus `scripts/verify-mvp.sh`. Use configured paths from `.hyperagent/config.toml` when present; new installs default to `.hyperagent/workshop/proposals/`, `.hyperagent/workshop/decisions/`, and `.hyperagent/hyperagent/capability-registry.md`.

Run Forge reviews after proposals are accepted or rejected, evals change, release-readiness checks, or repeated missions where Workshop output looks vague, unsafe, untested, or too heavy. Judge outcome quality, proposal quality, eval quality, safety quality, and process bloat. If the process itself needs improvement, create a Forge review in the configured Forge reviews directory using the configured Forge review template.

Use `forge/process/quality-rubric.md` to score the Workshop process and identify process upgrades. When a process upgrade is warranted, generate a Workshop proposal from the Forge review with `sh scripts/hyperagent.sh review workshop --forge-review PATH --title "..." --problem "..."`. Keep the proposal in `human review required` mode.

Use `sh scripts/hyperagent.sh review forge audit` for a concise process-health report covering proposal quality, stale or missing decisions, accepted capability traceability, and Forge audit eval coverage. The audit is read-only unless `--write-proposal` is passed, and generated proposals must remain `human review required`.

## Safety Defaults

- Propose upgrades freely.
- Draft local low-risk upgrade files only when asked or when the mission requires it.
- Do not activate persistent behavior changes without human approval.
- Do not broaden filesystem, shell, network, deployment, account, or secrets access without human approval.
- Do not silently alter secrets handling.
- Default all upgrade proposals to `human review required`.
- Keep persistent behavior changes `human review required`.

Allowed activation modes are `suggest only`, `draft files only`, `human review required`, and `auto-install low risk`.

Accepted capabilities require a decision record in the configured decisions directory and a traceable entry in the configured capability registry.

## File Naming

Use lowercase timestamped slugs:

- `.hyperagent/missions/YYYY-MM-DD-HHMM-brief-slug.md`
- `.hyperagent/workshop/proposals/YYYY-MM-DD-HHMM-brief-slug.md`
- `.hyperagent/forge/reviews/YYYY-MM-DD-HHMM-brief-slug.md`
- `.hyperagent/workshop/decisions/YYYY-MM-DD-HHMM-accepted-or-rejected-brief-slug.md`
