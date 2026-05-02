# codex-hyperagent

Use this skill when the user asks Codex to operate as HyperAgent, run a HyperAgent mission, produce mission telemetry, review mission friction, or propose Suit upgrades.

## Source Of Truth

- Product contract: `docs/hyperagent-prd.md`
- Suit prompt: `hyperagent/operating-prompt.md`
- Capability registry: `hyperagent/capability-registry.md`
- Mission template: `templates/mission-record.md`
- Upgrade proposal template: `templates/upgrade-proposal.md`
- Forge review template: `templates/forge-review.md`

## Operating Loop

1. Read `hyperagent/operating-prompt.md`.
2. Run the user task as a Mission. Keep scope tight and verify the result.
3. Before final response, create a mission record in `missions/` from `templates/mission-record.md`.
4. If the mission exposed friction, create at least one Workshop proposal in `workshop/proposals/` from `templates/upgrade-proposal.md`.
5. Every Workshop proposal must include an `Implementation Plan` section that names the single highest-priority plan step first, then lists implementation steps, files or instructions likely to change, and verification for that first step.
6. If the friction is about the quality of the Workshop process itself, create a Forge review in `forge/reviews/` from `templates/forge-review.md`.
7. Report the mission outcome, verification, record path, and proposal path to the user.

## Workshop Review Prompt

Review the recent mission records in `missions/`. Identify concrete Suit friction that appears in the evidence. For the highest-value friction, create an upgrade proposal in `workshop/proposals/` using `templates/upgrade-proposal.md`. Do not activate the upgrade. Default the activation mode to `human review required`.

## Forge Review Prompt

Review the recent upgrade proposals in `workshop/proposals/`. Judge whether the Workshop process is producing proposals that are specific, evidence-backed, testable, and safe. If the process itself needs improvement, create a Forge review in `forge/reviews/` using `templates/forge-review.md`.

## Safety Defaults

- Propose upgrades freely.
- Draft local low-risk upgrade files only when asked or when the mission requires it.
- Do not activate persistent behavior changes without human approval.
- Do not broaden filesystem, shell, network, deployment, account, or secrets access without human approval.
- Do not silently alter secrets handling.
- Default all upgrade proposals to `human review required`.

Allowed activation modes are `suggest only`, `draft files only`, `human review required`, and `auto-install low risk`.

## File Naming

Use lowercase timestamped slugs:

- `missions/YYYY-MM-DD-HHMM-brief-slug.md`
- `workshop/proposals/YYYY-MM-DD-HHMM-brief-slug.md`
- `forge/reviews/YYYY-MM-DD-HHMM-brief-slug.md`
