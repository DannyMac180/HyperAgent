# Upgrade Proposal

- Upgrade title: Product-state reconciliation for PRD faithfulness
- Proposal ID: proposal-2026-05-23-1321-product-state-reconciliation
- Date/time: 2026-05-23 13:21 EDT
- Related mission record: `missions/2026-05-23-1321-prd-faithfulness-review.md`
- Proposed activation mode: human review required
- Allowed activation modes: suggest only; draft files only; human review required; auto-install low risk
- Backlog priority: P1
- Workshop rubric score: 8/10

## Problem

- Problem observed: HyperAgent now has more product surface than its authoritative state files acknowledge. README, release notes, capability registry, backlog, and mission evidence can drift apart even while local smoke tests pass.
- Evidence from mission records: `missions/2026-05-23-1321-prd-faithfulness-review.md`; recent missions record implemented capabilities such as `hyperagent init`, sensing, reliability evals, and local UI, while `hyperagent/capability-registry.md` and `workshop/backlog.md` still list only two accepted capabilities.
- Why the current Suit was insufficient: The current loop records missions and proposals, but it does not force a product-state closeout after meaningful product changes. Verification mostly proves files and behavior exist; it does not prove the public story, registry, backlog, roadmap, and release notes agree.

## Proposed Capability

- Type of upgrade: Verification and product-governance workflow
- Proposed capability: Add a lightweight product-state reconciliation checklist or command that audits PRD milestone status, accepted capabilities, backlog entries, release notes, README claims, `.hyperagent` verification commands, and recent mission evidence after product-surface changes.
- Expected impact: Reduces stale docs, missing registry entries, forgotten backlog items, and release claims that lag the actual product.
- Transferability: Useful for HyperAgent itself and any initialized project that uses Mission -> Workshop -> Forge as a durable improvement loop.

## Implementation Plan

- Highest-priority plan step: Add `docs/roadmap.md` with a PRD milestone status table and links to implemented capabilities, mission evidence, proposals, decisions, and deferred work.
- Implementation steps: Add roadmap; update README and release notes to link to it; add a manual reconciliation checklist to `CONTRIBUTING.md`; optionally add `sh scripts/hyperagent.sh product-state` later; extend `verify-mvp` to check for roadmap presence and core section headings.
- Files or instructions likely to change: `docs/roadmap.md`, `README.md`, `docs/releases/v0.1.0-alpha.md` or next release notes, `CONTRIBUTING.md`, `scripts/verify-mvp.sh`, possibly `scripts/hyperagent.sh`.
- Verification for the first step: `sh scripts/verify-mvp.sh`; manual check that the roadmap maps PRD milestones to current status with links to evidence.

## Safety

- Safety risk: Low. This is documentation and local verification workflow only.
- Permission or authority changes: None.
- Human approval required before activation: yes

## Evaluation

- Eval or acceptance test: A product-state review can answer "what is shipped, accepted, in progress, deferred, or stale?" from repo files without relying on chat history.
- Rollback plan: Remove the roadmap/checklist and verifier requirement; leave existing mission records and proposals untouched.
- Open questions: Whether this should stay manual for the next alpha or become a helper command once the roadmap shape settles.

## Decision Handoff

- Recommended decision: Accept as a P1 product-governance improvement.
- Decision record path:
- Capability registry ID if accepted: product-state-reconciliation
