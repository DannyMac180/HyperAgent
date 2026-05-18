# Upgrade Decision

- Decision ID: decision-2026-05-16-accepted-local-loop-helper-and-smoke-eval
- Date/time: 2026-05-16 12:16 EDT
- Proposal: `workshop/proposals/2026-05-16-1216-local-loop-helper-and-smoke-eval.md`
- Decision: accepted
- Reviewer: user goal request to fulfill the PRD and turn HyperAgent into a working product
- Reason: The PRD requires a repeatable Mission -> Workshop -> Forge loop with human review, local memory, proposal evaluation, and verification; this upgrade implements that missing product loop without adding external dependencies or autonomous self-modification.
- Capability registry ID: local-loop-helper

## Authority Boundary

- Human approval recorded: yes
- Silent activation allowed: no
- Permission or secrets changes approved: no

## Outcome

- Files or instructions changed: `scripts/hyperagent.sh`, `evals/smoke-loop.sh`, `docs/quickstart.md`, `workshop/backlog.md`, `workshop/rubric.md`, `forge/process/quality-rubric.md`, `templates/upgrade-decision.md`, `skills/codex-hyperagent/SKILL.md`, `hyperagent/operating-prompt.md`, `README.md`, `docs/concepts.md`, `scripts/verify-mvp.sh`, `hyperagent/capability-registry.md`.
- Verification: `sh scripts/verify-mvp.sh`; `sh evals/smoke-loop.sh`; `sh scripts/hyperagent.sh status`.
- Registry update: `hyperagent/capability-registry.md`
- Rollback path: Revert the files named above and remove the `local-loop-helper` registry entry.

