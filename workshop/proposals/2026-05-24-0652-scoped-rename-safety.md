# Upgrade Proposal

- Upgrade title: Scoped Rename Safety Checklist
- Proposal ID: proposal-2026-05-24-0652-scoped-rename-safety
- Date/time: 2026-05-24 06:52 America/New_York
- Related mission record: `missions/2026-05-24-0652-dan-192-setup-hyperagent-rework.md`
- Related Forge review: none
- Evidence source type: mission record
- Proposed activation mode: human review required
- Allowed activation modes: suggest only; draft files only; human review required; auto-install low risk
- Backlog priority: P3
- Workshop rubric score: 8/12

## Problem

- Problem observed: A broad product-surface rename briefly rewrote historical mission evidence before the change was noticed and reverted.
- Evidence from mission records: `missions/2026-05-24-0652-dan-192-setup-hyperagent-rework.md` records that historical mission files were touched by bulk rename and restored.
- Evidence from Forge reviews: none
- Why the current Suit was insufficient: The operating prompt says to preserve evidence, but it does not give a concrete rename checklist that separates live product files from append-only mission history.

## Proposed Capability

- Type of upgrade: workflow checklist
- Proposed capability: Add a short scoped-rename checklist that asks agents to identify live surfaces, generated files, and historical evidence before running broad rewrites.
- Expected impact: Reduces accidental edits to mission records, review artifacts, and other historical evidence during mechanical renames.
- Transferability: Useful across HyperAgent repo work and other Codex workspaces with durable logs.

## Implementation Plan

- Highest-priority plan step: Add a concise "Scoped Renames" subsection to `hyperagent/operating-prompt.md`.
- Implementation steps: Add the subsection; reference it from project instructions only if it proves useful in another mission; avoid changing command behavior.
- Files or instructions likely to change: `hyperagent/operating-prompt.md`; possibly `skills/codex-hyperagent/SKILL.md` after human approval.
- Verification for the first step: `sh scripts/verify-mvp.sh` plus a manual check that the new text says to exclude `missions/`, `workshop/`, and `forge/` unless the task explicitly updates evidence.

## Safety

- Safety risk: Low. The proposal changes agent workflow guidance only.
- Permission or authority changes: None.
- Human approval required before activation: yes

## Evaluation

- Eval or acceptance test: During the next rename mission, confirm the agent lists intended rename scopes and does not rewrite historical mission files unless explicitly requested.
- Rollback plan: Revert the guidance text if it adds noise without preventing mistakes.
- Open questions: Whether this belongs in the global operating prompt or as a local project note.

## Decision Handoff

- Recommended decision: Keep in backlog as a P3 draft until the friction repeats.
- Decision record path: none
- Capability registry ID if accepted: none
