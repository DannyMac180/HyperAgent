# HyperAgent Next Alpha Notes

These notes track unreleased product surface that exists after `v0.1.0-alpha`. They are not a release tag.

For current state and acceptance status, see `docs/roadmap.md`.

## Unreleased Since `v0.1.0-alpha`

- `hyperagent init` project setup with `.hyperagent`, local templates, generated project backlog, capability registry, and `AGENTS.md` instructions.
- Local sensing through `scripts/hyperagent.sh sense`, `record-check`, and `doctor`, including redacted command/check evidence, changed-file summaries, optional PR/CI lookup, and local Workbench trace enrichment when available.
- Simplified CLI help around five primary flows: `init`, `sense`, `mission`, `review`, and `ui`, with grouped mission/review commands and compatibility aliases for the older flat helper commands.
- Reliability gains eval with deterministic baseline and HyperAgent fixture records.
- Strengthened Forge review template, rubric, structured summary, anchored 0-5 scores, deterministic gates, payoff counters, and `scripts/verify-forge-review.sh`.
- README Codex Mac copy-paste setup prompt and clean-install UAT checklist.
- README architecture diagram source and rendered asset maintenance guardrails.
- Product-state roadmap in `docs/roadmap.md`.

## Acceptance Status

The following are accepted capabilities because they have decision records and registry entries:

- Codex skill installer.
- Local Mission -> Workshop -> Forge loop helper.

The following are in review until a human decision record promotes or rejects them:

- Project initialization.
- Local sensing and Workbench trace enrichment.
- Reliability gains eval.
- Quantitative Forge checks.
- README Codex Mac onboarding prompt and clean-install UAT.
- Architecture diagram maintenance.
- Product-state roadmap and reconciliation checklist.

## Current Limits

The next alpha still does not include:

- autonomous self-modification,
- hosted memory,
- an interactive product UI or dashboard,
- multi-platform support beyond Codex,
- automatic upgrades across every user project,
- production-grade safety automation.

Persistent behavior changes still require human review.
