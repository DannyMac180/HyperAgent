# HyperAgent Capability Registry

This registry records accepted Suit capabilities after human review.

Default activation mode: `human review required`.

Accepted entries require a matching proposal or review artifact, a human decision record in `workshop/decisions/`, and evidence-backed verification. Implemented surfaces without a decision record stay in the in-review section below and are not activated as accepted capabilities.

## Accepted Capabilities

## codex-skill-installer

- Status: accepted
- Title: Codex skill installer
- Source proposal: `workshop/proposals/2026-05-01-2108-codex-skill-installer.md`
- Decision record: `workshop/decisions/2026-05-16-accepted-codex-skill-installer.md`
- Accepted by: repository review via merged PR #1
- Accepted at: 2026-05-16
- Activation mode: human review required
- Files or instructions changed: `scripts/install-codex-skill.sh`, `README.md`, `evals/README.md`, `scripts/verify-mvp.sh`
- Verification: `sh scripts/verify-mvp.sh`; temp-directory installer smoke checks
- Rollback: remove installed `codex-hyperagent/` from the target skills directory and revert the installer/docs changes.

## local-loop-helper

- Status: accepted
- Title: Local Mission -> Workshop -> Forge loop helper
- Source proposal: `workshop/proposals/2026-05-16-1216-local-loop-helper-and-smoke-eval.md`
- Decision record: `workshop/decisions/2026-05-16-accepted-local-loop-helper-and-smoke-eval.md`
- Accepted by: user goal request to fulfill the PRD and turn HyperAgent into a working product
- Accepted at: 2026-05-16 12:16 EDT
- Activation mode: human review required
- Files or instructions changed: `scripts/hyperagent.sh`, `evals/smoke-loop.sh`, `docs/quickstart.md`, `workshop/backlog.md`, `workshop/rubric.md`, `forge/process/quality-rubric.md`, `templates/upgrade-decision.md`, `skills/codex-hyperagent/SKILL.md`, `hyperagent/operating-prompt.md`, `README.md`, `docs/concepts.md`, `scripts/verify-mvp.sh`
- Verification: `sh scripts/verify-mvp.sh`; `sh evals/smoke-loop.sh`; `sh scripts/hyperagent.sh status`
- Rollback: remove the loop helper, smoke eval, process docs/templates, related verifier requirements, and this registry entry.

## In Review Capabilities

These surfaces exist in repo artifacts or mission evidence, but do not yet have acceptance decision records. Keep them `human review required` until a reviewer records an accepted or rejected decision.

| Capability candidate | Status | Evidence | Decision state |
| --- | --- | --- | --- |
| `project-init` | in review | `missions/2026-05-20-1017-dan-173-hyperagent-init.md`; `evals/init-smoke.sh` | No decision record yet. |
| `local-sensing` | in review | `missions/2026-05-20-1557-dan-174-sensing-layer.md`; `missions/2026-05-21-1308-dan-174-workbench-sensing-rework.md`; `evals/sense-smoke.sh` | No decision record yet. |
| `reliability-gains-eval` | in review | `missions/2026-05-20-1554-dan-176-reliability-gains-eval.md`; `evals/reliability-gains.sh` | No decision record yet. |
| `quantitative-forge-review` | in review | `missions/2026-05-20-1556-dan-177-strengthen-forge.md`; `missions/2026-05-22-1535-dan-177-quantitative-forge-rework.md`; `scripts/verify-forge-review.sh` | No decision record yet. |
| `readme-architecture-maintenance` | in review | `missions/2026-05-21-1329-readme-architecture-diagram.md`; `docs/architecture/hyperagent.mmd`; `docs/assets/hyperagent-architecture.svg` | No decision record yet. |
| `product-state-roadmap` | in review | `docs/roadmap.md`; `docs/releases/next-alpha.md`; `missions/2026-05-23-2234-dan-181-product-state-reconciliation.md` | No decision record yet. |

## Capability Entry Template

- Capability ID:
- Title:
- Source proposal:
- Accepted by:
- Accepted at:
- Activation mode:
- Files or instructions changed:
- Verification:
- Rollback:
