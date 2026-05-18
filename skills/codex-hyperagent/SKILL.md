---
name: codex-hyperagent
description: Run Codex with the HyperAgent Suit. Use when the user asks Codex to operate as HyperAgent, run a HyperAgent mission, produce mission telemetry, review mission friction, or propose Suit upgrades.
metadata:
  short-description: Run Codex with HyperAgent mission, Workshop, and Forge loops
---

# codex-hyperagent

Use this skill when the user asks Codex to operate as HyperAgent, run a HyperAgent mission, produce mission telemetry, review mission friction, or propose Suit upgrades. In the HyperAgent repository itself, project instructions may require HyperAgent triage on every task.

## Source Of Truth

- Product contract: `docs/hyperagent-prd.md`
- Suit prompt: `hyperagent/operating-prompt.md`
- Capability registry: `hyperagent/capability-registry.md`
- Mission template: `templates/mission-record.md`
- Upgrade proposal template: `templates/upgrade-proposal.md`
- Forge review template: `templates/forge-review.md`
- Upgrade backlog: `workshop/backlog.md`
- Workshop rubric: `workshop/rubric.md`
- Forge quality rubric: `forge/process/quality-rubric.md`
- Local helper: `scripts/hyperagent.sh`

## Operating Loop

1. Read `hyperagent/operating-prompt.md`.
2. Run HyperAgent relevance triage.
3. If the task is relevant, run it as a Mission. Keep scope tight and verify the result.
4. Before final response on relevant tasks, create a mission record in `missions/` from `templates/mission-record.md`.
5. If the mission exposed friction, create at least one Workshop proposal in `workshop/proposals/` from `templates/upgrade-proposal.md`.
6. Every Workshop proposal must include an `Implementation Plan` section that names the single highest-priority plan step first, then lists implementation steps, files or instructions likely to change, and verification for that first step.
7. Score proposal priority with `workshop/rubric.md` before recommending implementation.
8. If the friction is about the quality of the Workshop process itself, create a Forge review in `forge/reviews/` from `templates/forge-review.md`.
9. Do not mark a proposal accepted unless there is an explicit human approval decision in `workshop/decisions/`.
10. Report the triage decision, mission outcome, verification, record path, proposal path if any, decision path if any, and unresolved risk to the user.

Use `sh scripts/hyperagent.sh status` to inspect local loop state. Use the helper commands when they make artifact creation more reliable, but fill in evidence, verification, and judgment yourself.

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

Review the recent mission records in `missions/`. Identify concrete Suit friction that appears in the evidence. For the highest-value friction, create an upgrade proposal in `workshop/proposals/` using `templates/upgrade-proposal.md`. Do not activate the upgrade. Default the activation mode to `human review required`.

Use `workshop/rubric.md` and update `workshop/backlog.md` when the proposal should be tracked for implementation.

## Forge Review Prompt

Review the recent upgrade proposals in `workshop/proposals/`. Judge whether the Workshop process is producing proposals that are specific, evidence-backed, testable, and safe. If the process itself needs improvement, create a Forge review in `forge/reviews/` using `templates/forge-review.md`.

Use `forge/process/quality-rubric.md` to score the Workshop process and identify process upgrades.

## Safety Defaults

- Propose upgrades freely.
- Draft local low-risk upgrade files only when asked or when the mission requires it.
- Do not activate persistent behavior changes without human approval.
- Do not broaden filesystem, shell, network, deployment, account, or secrets access without human approval.
- Do not silently alter secrets handling.
- Default all upgrade proposals to `human review required`.

Allowed activation modes are `suggest only`, `draft files only`, `human review required`, and `auto-install low risk`.

Accepted capabilities require a decision record in `workshop/decisions/` and a traceable entry in `hyperagent/capability-registry.md`.

## File Naming

Use lowercase timestamped slugs:

- `missions/YYYY-MM-DD-HHMM-brief-slug.md`
- `workshop/proposals/YYYY-MM-DD-HHMM-brief-slug.md`
- `forge/reviews/YYYY-MM-DD-HHMM-brief-slug.md`
- `workshop/decisions/YYYY-MM-DD-HHMM-accepted-or-rejected-brief-slug.md`
