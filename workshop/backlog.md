# HyperAgent Upgrade Backlog

This backlog tracks proposed Suit and Workshop upgrades after they have evidence from mission records.

Default activation mode: `human review required`.

## Intake Rules

- Every backlog item must link to a proposal in `workshop/proposals/`.
- Every proposal must link to at least one mission record or Forge review.
- The highest-priority item must name its first implementation step and acceptance test.
- Accepted items require a decision record in `workshop/decisions/`.
- Accepted Suit capabilities are recorded in `hyperagent/capability-registry.md`.
- Implemented surfaces without a proposal or decision belong in `Review Candidates` until a reviewer decides whether to write a proposal, accept/reject the surface, or defer it.
- Run `sh scripts/hyperagent.sh workshop-digest --limit 12` after several missions or before release-readiness review to find recurring friction, stale proposals, weak proposal evidence, and Forge cadence needs.
- Digest-generated proposals are drafts only. They must stay `human review required` and cannot be moved to accepted backlog status without a decision record.

## Priority Rubric

Score each item with `workshop/rubric.md`.

- `P0`: Blocks the Mission -> Workshop -> Forge loop or creates a serious safety gap.
- `P1`: Removes repeated friction from real missions or improves verification quality.
- `P2`: Improves ergonomics, docs, or contributor onboarding.
- `P3`: Useful later, but not needed for Mark I reliability.

## Proposal Backlog

| Priority | Status | Proposal | Evidence | Next action |
| --- | --- | --- | --- | --- |
| P3 | Proposed | `workshop/proposals/2026-05-24-0652-scoped-rename-safety.md` | `missions/2026-05-24-0652-dan-192-setup-hyperagent-rework.md` | Keep as draft unless scoped rename friction repeats; first step would add a short checklist to `hyperagent/operating-prompt.md`. |
| P0 | Accepted | `workshop/proposals/2026-05-16-1216-local-loop-helper-and-smoke-eval.md` | `missions/2026-05-16-1216-prd-fulfillment-working-product.md` | Loop helper and smoke eval implemented; keep covered by `scripts/verify-mvp.sh` and `evals/smoke-loop.sh`. |
| P1 | Accepted | `workshop/proposals/2026-05-01-2108-codex-skill-installer.md` | `missions/2026-05-01-2108-mark-i-build.md` | Installer implemented; keep covered by smoke evals. |

## Review Candidates

These are implemented or documented surfaces with mission evidence but no explicit acceptance decision record. They are intentionally not listed as accepted backlog items.

| Priority | Status | Candidate | Evidence | Next action |
| --- | --- | --- | --- | --- |
| P1 | In review | Project initialization | `missions/2026-05-20-1017-dan-173-hyperagent-init.md`; `evals/init-smoke.sh` | Reviewer decides whether to create/accept a proposal and registry entry, or keep as in-review implementation. |
| P1 | In review | Local sensing and Workbench trace enrichment | `missions/2026-05-20-1557-dan-174-sensing-layer.md`; `missions/2026-05-21-1308-dan-174-workbench-sensing-rework.md`; `evals/sense-smoke.sh` | Reviewer decides whether to accept as a capability after DAN-174 review. |
| P1 | In review | Reliability gains eval | `missions/2026-05-20-1554-dan-176-reliability-gains-eval.md`; `evals/reliability-gains.sh` | Reviewer decides whether fixture-backed scoring is sufficient or requires trace/replay follow-up first. |
| P1 | In review | Quantitative Forge review checks | `missions/2026-05-20-1556-dan-177-strengthen-forge.md`; `missions/2026-05-22-1535-dan-177-quantitative-forge-rework.md`; `scripts/verify-forge-review.sh` | Reviewer decides whether to accept, reject, or require JSON-aware validation follow-up. |
| P2 | In review | README architecture diagram maintenance | `missions/2026-05-21-1329-readme-architecture-diagram.md`; `docs/architecture/hyperagent.mmd`; `docs/assets/hyperagent-architecture.svg` | Keep PR checklist guardrail; consider rendering automation if manual sync recurs. |
| P2 | In review | Product-state roadmap and reconciliation checklist | `docs/roadmap.md`; `docs/releases/next-alpha.md`; DAN-181 | Use this roadmap as source of truth; add a `product-state` check only if drift recurs. |

## Deferred PRD Work

| Priority | Status | Area | Evidence | Next action |
| --- | --- | --- | --- | --- |
| P3 | Deferred | Multi-platform Suit adapters | `docs/hyperagent-prd.md` milestone 5 | Wait until Codex-first Mark I surfaces have accepted status and stable docs. |
| P3 | Deferred | Interactive UI/dashboard | `docs/hyperagent-prd.md` MVP non-goals; `README.md` current limits | Do not build before the markdown loop is stable and reviewed. |
