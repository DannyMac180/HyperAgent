# HyperAgent Next Alpha Candidate Notes

These notes track unreleased product surface that exists after `v0.1.0-alpha`. They are not a release tag, and they should not be copied into public release claims until the release checklist below is complete from a clean reviewed tree.

For current state and acceptance status, see `docs/roadmap.md`.

## Release Candidate Status

Status as of 2026-05-24: pre-tag release preparation.

The repo is release-candidate ready only after all of these are true:

- The branch or `main` being tagged has no uncommitted product changes.
- README, release notes, roadmap, install docs, and limitations describe the same shipped surface.
- Clean-clone verification has passed from outside the development checkout.
- Clean-install Codex Desktop UAT has been attempted and recorded in `docs/clean-install-uat.md`.
- Any intentionally unshipped local artifacts are documented under `Not Shipped In This Candidate`.

## Unreleased Since `v0.1.0-alpha`

- `hyperagent init` project setup with `.hyperagent`, local templates, generated project backlog, capability registry, and `AGENTS.md` instructions.
- Local sensing through `scripts/hyperagent.sh sense`, `record-check`, and `doctor`, including redacted command/check evidence, changed-file summaries, optional PR/CI lookup, and local Workbench trace enrichment when available.
- Simplified CLI help around five primary flows: `init`, `sense`, `mission`, `review`, and `ui`, with grouped mission/review commands and compatibility aliases for the older flat helper commands.
- Reliability gains eval with deterministic baseline and HyperAgent fixture records.
- Strengthened Forge review template, rubric, structured summary, anchored 0-5 scores, deterministic gates, payoff counters, and `scripts/verify-forge-review.sh`.
- README Codex Mac copy-paste setup prompt and clean-install UAT checklist.
- README architecture diagram source and rendered asset maintenance guardrails.
- Product-state roadmap in `docs/roadmap.md`.
- Optional local UI cockpit architecture note that keeps `hyperagent ui` subordinate to markdown and local evidence truth.

## Candidate Scope

Done for this candidate:

- Release-facing docs distinguish accepted, in-review, deferred, and not-shipped surfaces.
- README points users to `docs/roadmap.md` for the current state of `init`, `sense`, reliability evals, Forge checks, and newer surfaces.
- The first-alpha release notes avoid claiming newer in-review surfaces as accepted capabilities.
- The release checklist includes clean-clone, smoke, and clean-install UAT gates before tagging.

Deferred for a later alpha:

- Accepting or rejecting `project-init`, `local-sensing`, `reliability-gains-eval`, `quantitative-forge-review`, `readme-architecture-maintenance`, and `product-state-roadmap` through human decision records.
- Trace/replay-backed reliability cases beyond the deterministic fixture eval.
- Automated Mermaid-to-SVG rendering for README architecture updates.
- Multi-platform adapters beyond Codex.

Not shipped in this candidate:

- Hosted services, hosted memory, or hidden databases.
- Interactive product UI or dashboard. The README architecture image is static documentation only.
- Autonomous self-modification or automatic activation of persistent behavior changes.
- Automatic upgrades across every user project.
- Production-grade safety automation.

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
- a polished hosted dashboard,
- multi-platform support beyond Codex,
- automatic upgrades across every user project,
- production-grade safety automation.

Persistent behavior changes still require human review.

## Verification Record

Record the release-candidate verification here before tagging.

| Check | Status | Evidence |
| --- | --- | --- |
| `sh scripts/verify-mvp.sh` | Passed on 2026-05-24 | Ran from branch `dan-193-next-alpha-release-prep` after merging `origin/main` into the release-prep branch; output: `HyperAgent MVP artifact verification passed.` |
| `sh evals/smoke-loop.sh` | Passed on 2026-05-24 | Ran from branch `dan-193-next-alpha-release-prep` after merging `origin/main` into the release-prep branch; output: `HyperAgent smoke loop passed.` |
| `sh evals/init-smoke.sh` | Passed on 2026-05-24 | Ran from branch `dan-193-next-alpha-release-prep` after merging `origin/main` into the release-prep branch; output: `HyperAgent init smoke passed.` |
| `sh evals/sense-smoke.sh` | Passed on 2026-05-24 | Ran from branch `dan-193-next-alpha-release-prep` after merging `origin/main` into the release-prep branch; output: `HyperAgent sense smoke passed.` |
| `sh evals/ui-smoke.sh` | Pending refresh | The eval exists as the canonical optional local cockpit smoke check; refresh before tagging the next alpha. |
| Remote clean-clone install test | Blocked on 2026-05-24 | `git clone https://github.com/DannyMac180/HyperAgent.git` failed with `Could not resolve host: github.com` in the sandbox. |
| Local clean-clone install test | Passed on 2026-05-24 | Cloned branch `dan-193-next-alpha-release-prep` into a temp directory after merging `origin/main`; `verify-mvp`, `smoke-loop`, and temp skill install passed. |
| Manual Codex Desktop clean-install UAT | Pending / manual | Use `docs/clean-install-uat.md`; record the result there or in the release PR. |
