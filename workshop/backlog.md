# HyperAgent Upgrade Backlog

This backlog tracks proposed Suit and Workshop upgrades after they have evidence from mission records.

Default activation mode: `human review required`.

State ownership:

- Proposals in `workshop/proposals/` are the source for proposed work.
- Decisions in `workshop/decisions/` are the source for approvals and rejections.
- The backlog is a planning view, not a second approval system.
- Accepted capabilities are indexed in `hyperagent/capability-registry.md` only after a human decision record exists.

## Intake Rules

- Every backlog item must link to a proposal in `workshop/proposals/`.
- Every proposal must link to at least one mission record or Forge review.
- The highest-priority item must name its first implementation step and acceptance test.
- Accepted items require a decision record in `workshop/decisions/`.
- Accepted Suit capabilities are recorded in `hyperagent/capability-registry.md`.

## Priority Rubric

Score each item with `workshop/rubric.md`.

- `P0`: Blocks the Mission -> Workshop -> Forge loop or creates a serious safety gap.
- `P1`: Removes repeated friction from real missions or improves verification quality.
- `P2`: Improves ergonomics, docs, or contributor onboarding.
- `P3`: Useful later, but not needed for Mark I reliability.

## Backlog

| Priority | Status | Proposal | Evidence | Next action |
| --- | --- | --- | --- | --- |
| P0 | Accepted | `workshop/proposals/2026-05-16-1216-local-loop-helper-and-smoke-eval.md` | `missions/2026-05-16-1216-prd-fulfillment-working-product.md` | Loop helper and smoke eval implemented; keep covered by `scripts/verify-mvp.sh` and `evals/smoke-loop.sh`. |
| P1 | Accepted | `workshop/proposals/2026-05-01-2108-codex-skill-installer.md` | `missions/2026-05-01-2108-mark-i-build.md` | Installer implemented; keep covered by smoke evals. |
