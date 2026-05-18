# HyperAgent Capability Registry

This registry records accepted Suit capabilities after human review.

Default activation mode: `human review required`.

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
