# Upgrade Proposal

- Upgrade title: Add local loop helper and smoke eval
- Proposal ID: proposal-2026-05-16-1216-local-loop-helper-and-smoke-eval
- Date/time: 2026-05-16 12:16 EDT
- Related mission record: `missions/2026-05-16-1216-prd-fulfillment-working-product.md`
- Evidence source type: mission
- Proposed activation mode: human review required
- Allowed activation modes: suggest only; draft files only; human review required; auto-install low risk
- Backlog priority: P0
- Workshop rubric score: 11

## Problem

- Problem observed: HyperAgent had strong markdown artifacts, but no repeatable local command path proving the full Mission -> Workshop -> Forge -> human decision -> registry loop.
- Evidence from mission records: `missions/2026-05-01-2108-mark-i-build.md` identified installation as first-run friction, and `missions/2026-05-16-1216-prd-fulfillment-working-product.md` identified loop verification as the remaining PRD gap.
- Why the current Suit was insufficient: The Suit instructed agents to create artifacts, but did not provide a local helper, approval decision flow, first-class backlog/rubric, Forge quality rubric, or smoke eval that exercised the product behavior.

## Proposed Capability

- Type of upgrade: Script, eval, templates, and documentation.
- Proposed capability: Add `scripts/hyperagent.sh` with local commands for status, mission shells, proposals, Workshop and Forge prompts, Forge reviews, and human approval decisions; add smoke coverage and supporting process docs.
- Expected impact: Turns HyperAgent Mark I from a scaffold into a working local product loop that new users and contributors can run and verify.
- Transferability: Useful across Codex workspaces and adaptable to future Claude Code, OpenClaw, and Cursor adapters.

## Implementation Plan

- Highest-priority plan step: Add `scripts/hyperagent.sh` and prove it can create loop artifacts in a temporary repo copy.
- Implementation steps: Add helper commands; add Workshop backlog/rubric; add decision template and directory; add Forge quality rubric; update README, Quickstart, skill, operating prompt, concepts, templates, registry, and verifier; add `evals/smoke-loop.sh`.
- Files or instructions likely to change: `scripts/hyperagent.sh`, `evals/smoke-loop.sh`, `docs/quickstart.md`, `workshop/backlog.md`, `workshop/rubric.md`, `forge/process/quality-rubric.md`, `templates/upgrade-decision.md`, `skills/codex-hyperagent/SKILL.md`, `hyperagent/operating-prompt.md`, `README.md`, `scripts/verify-mvp.sh`.
- Verification for the first step: Run `sh evals/smoke-loop.sh` and confirm it creates a mission record, proposal, Forge review, approval decision, and registry entry in a temporary repo copy.

## Safety

- Safety risk: Low. The helper writes local markdown artifacts and appends accepted capability entries only after an explicit `decide-upgrade` command.
- Permission or authority changes: None. It does not broaden filesystem, shell, network, account, deployment, or secrets access.
- Filesystem impact: Writes local mission, proposal, decision, Forge review, evidence, and registry markdown files in the repository.
- Network or account impact: None.
- Secrets handling impact: None.
- Human approval required before activation: yes

## Evaluation

- Eval or acceptance test: `sh scripts/verify-mvp.sh` and `sh evals/smoke-loop.sh`.
- Rollback plan: Remove `scripts/hyperagent.sh`, `evals/smoke-loop.sh`, related docs/templates/process files, and registry entries added by this proposal.
- Open questions: Whether a future CLI should move from shell to a richer implementation once multi-platform adapters exist.

## Decision Handoff

- Recommended decision: accepted
- Decision record path: `workshop/decisions/2026-05-16-accepted-local-loop-helper-and-smoke-eval.md`
- Capability registry ID if accepted: local-loop-helper
