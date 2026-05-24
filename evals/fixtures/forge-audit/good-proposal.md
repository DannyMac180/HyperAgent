# Upgrade Proposal

- Upgrade title: Good Forge audit fixture
- Proposal ID: proposal-forge-audit-good-fixture
- Date/time: 2026-05-23 10:00 EDT
- Related mission record: `missions/example-good-mission.md`
- Related Forge review:
- Evidence source type: mission
- Proposed activation mode: human review required
- Allowed activation modes: suggest only; draft files only; human review required; auto-install low risk
- Backlog priority: P2
- Workshop rubric score: 10

## Problem

- Problem observed: Maintainers need a known-good proposal fixture for Forge audit regression checks.
- Evidence from mission records: `missions/example-good-mission.md`
- Evidence from Forge reviews:
- Why the current Suit was insufficient: Without a positive fixture, the audit could become a pure failure detector and regress on valid handoffs.

## Proposed Capability

- Type of upgrade: Eval fixture.
- Proposed capability: Keep a complete proposal with evidence, specificity, acceptance test, safety, rollback, and decision handoff fields.
- Expected impact: Makes the Forge audit eval catch both false negatives and noisy false positives.
- Transferability: Useful for every local HyperAgent checkout that runs the audit eval.

## Implementation Plan

- Highest-priority plan step: Add this proposal to the Forge audit smoke fixture set.
- Implementation steps: Copy the proposal into a temporary repo; add a matching rejected decision; run the audit.
- Files or instructions likely to change: `evals/fixtures/forge-audit/good-proposal.md`, `evals/forge-audit-smoke.sh`.
- Verification for the first step: `sh evals/forge-audit-smoke.sh`.

## Safety

- Safety risk: Low. This is a local eval fixture.
- Permission or authority changes: None.
- Human approval required before activation: yes

## Evaluation

- Eval or acceptance test: `sh evals/forge-audit-smoke.sh`.
- Rollback plan: Remove the fixture and its smoke assertions.
- Open questions: None.

## Decision Handoff

- Recommended decision: rejected
- Decision record path: `workshop/decisions/2026-05-23-rejected-forge-audit-good-fixture.md`
- Capability registry ID if accepted: forge-audit-good-fixture
