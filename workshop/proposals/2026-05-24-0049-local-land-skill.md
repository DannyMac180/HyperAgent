# Upgrade Proposal

- Upgrade title: Add A Local PR Landing Skill
- Proposal ID: 2026-05-24-0049-local-land-skill
- Date/time: 2026-05-24 00:49 EDT
- Related mission record: `missions/2026-05-24-0048-dan-195-pr-landing.md`
- Related Forge review: none
- Evidence source type: mission
- Proposed activation mode: human review required
- Allowed activation modes: suggest only; draft files only; human review required; auto-install low risk
- Backlog priority: P2
- Workshop rubric score: 3

## Problem

- Problem observed: The issue workflow explicitly instructed the landing agent to open `.codex/skills/land/SKILL.md`, but that skill file was missing in the workspace.
- Evidence from mission records: `missions/2026-05-24-0048-dan-195-pr-landing.md` records the missing file before PR landing work continued through manual `gh` and Linear steps.
- Evidence from Forge reviews: none.
- Why the current Suit was insufficient: The landing contract is repeated in issue text instead of being captured in a local, reusable skill with a checklist for mergeability, validation, PR merge, branch cleanup, Linear attachment, Linear comment, and final state transition.

## Proposed Capability

- Type of upgrade: local skill or checked-in workflow instructions.
- Proposed capability: Add `.codex/skills/land/SKILL.md` with the repository-specific PR landing loop and exact Linear/GitHub handoff requirements.
- Expected impact: Reduces landing drift and makes future `Merging` issues easier to execute consistently.
- Transferability: Useful for HyperAgent issue work and other repos that use Linear `Merging` as a landing state.

## Implementation Plan

- Highest-priority plan step: Draft `.codex/skills/land/SKILL.md` from the existing issue landing contract without changing activation authority.
- Implementation steps: add the skill file; include mergeability checks, local validation, safe conflict handling, PR merge/delete branch behavior, Linear direct PR attachment, Linear Done transition, and blocker comment behavior; add a small README pointer if needed.
- Files or instructions likely to change: `.codex/skills/land/SKILL.md`, possibly `AGENTS.md`.
- Verification for the first step: run a dry read-through against an already merged or intentionally blocked PR and confirm the checklist covers every required handoff field.

## Safety

- Safety risk: Merging PRs and changing Linear state are persistent external actions.
- Permission or authority changes: none proposed; the skill should document existing human-authorized landing behavior only.
- Human approval required before activation: yes

## Evaluation

- Eval or acceptance test: A future Merging-state mission can cite the local skill and complete with PR URL, merged commit, validation commands, direct Linear attachment, Done state, and blocker behavior when merge is unsafe.
- Rollback plan: Remove the skill file and continue using issue text instructions.
- Open questions: Should this live only in this repo, or in the shared HyperAgent/Symphony worker prompt that dispatches `Merging` issues?

## Decision Handoff

- Recommended decision: Review after DAN-195 lands.
- Decision record path: none yet.
- Capability registry ID if accepted: `local-pr-landing-skill`
