# Upgrade Proposal

- Upgrade title: Linear auth fallback runbook for HyperAgent missions
- Proposal ID: proposal-2026-05-23-1449-linear-auth-fallback-runbook
- Date/time: 2026-05-23 14:49 EDT
- Related mission record: `missions/2026-05-23-1449-linear-prd-improvement-tickets.md`
- Proposed activation mode: human review required
- Allowed activation modes: suggest only; draft files only; human review required; auto-install low risk
- Backlog priority: P2
- Workshop rubric score: 6/10

## Problem

- Problem observed: Linear MCP/app calls returned `401: Reauthentication required` during a mission that needed to create Linear issues, while `LINEAR_API_KEY` was available locally and the existing Symphony config identified the HyperAgent project.
- Evidence from mission records: `missions/2026-05-23-1449-linear-prd-improvement-tickets.md`
- Why the current Suit was insufficient: The Linear skill explains MCP reauthentication, but HyperAgent does not yet document a safe fallback path for repo missions where Linear is essential and an already-configured local API credential exists.

## Proposed Capability

- Type of upgrade: Workflow documentation and safety runbook
- Proposed capability: Add a short HyperAgent Linear fallback runbook that tells agents how to handle stale Linear MCP auth, when to stop for user reauthentication, when a local API-key fallback is acceptable, and how to avoid printing secrets.
- Expected impact: Reduces mission blockage and keeps Linear work inspectable without encouraging unsafe credential handling.
- Transferability: Useful across HyperAgent Linear issue planning and implementation missions.

## Implementation Plan

- Highest-priority plan step: Add a `docs/linear-workflow.md` section or HyperAgent operating-prompt note covering Linear MCP auth failure handling and safe fallback boundaries.
- Implementation steps: Document primary MCP path; document stop condition when no safe credential exists; document local API fallback only when `LINEAR_API_KEY` is already present and needed; include token-redaction rules; reference the Symphony project slug only where project-specific docs belong.
- Files or instructions likely to change: `docs/quickstart.md` or new `docs/linear-workflow.md`, `hyperagent/operating-prompt.md`, possibly `AGENTS.md`.
- Verification for the first step: Manual review plus `sh scripts/verify-mvp.sh` if docs are added to the verifier.

## Safety

- Safety risk: Medium-low. The runbook touches credential handling, so it must emphasize never printing tokens, never storing secrets in mission records, and stopping when auth is unavailable.
- Permission or authority changes: None unless future automation broadens Linear access.
- Human approval required before activation: yes

## Evaluation

- Eval or acceptance test: A future mission can correctly handle Linear MCP reauth by either stopping for login or using an already-present local API credential without leaking secrets.
- Rollback plan: Remove the runbook/instruction change; no product state changes required.
- Open questions: Whether this should live in HyperAgent docs or remain a general Linear skill improvement outside this repo.

## Decision Handoff

- Recommended decision: Consider after higher-priority PRD faithfulness backlog work.
- Decision record path:
- Capability registry ID if accepted: linear-auth-fallback-runbook
