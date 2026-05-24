# HyperAgent Roadmap And Product State

This page is the repo source of truth for what HyperAgent has shipped, what is accepted, what is in review, and what is intentionally deferred.

State definitions:

- `Shipped`: present in repo artifacts and available to alpha users.
- `Accepted`: shipped and backed by a human decision record plus a capability registry entry.
- `In review`: implemented or proposed with mission evidence, but not yet promoted by a decision record.
- `Deferred`: part of the PRD direction, but not built for this alpha.
- `Stale`: contradicted by current repo artifacts and needing cleanup.

Default activation mode remains `human review required`. Do not treat an implemented file or merged branch as an accepted persistent capability unless it has a matching decision in `workshop/decisions/` and an accepted entry in `hyperagent/capability-registry.md`.

## PRD Milestone Map

| PRD milestone | Current state | Evidence | Linear / issue evidence | Proposal / decision | Registry entry |
| --- | --- | --- | --- | --- | --- |
| Mark I | Shipped / partially accepted | `skills/codex-hyperagent/SKILL.md`, `hyperagent/operating-prompt.md`, `templates/mission-record.md`, `templates/upgrade-proposal.md`, `missions/2026-05-01-2108-mark-i-build.md`, `scripts/verify-mvp.sh` | Initial Mark I build evidence in mission record | `workshop/proposals/2026-05-01-2108-codex-skill-installer.md`; `workshop/decisions/2026-05-16-accepted-codex-skill-installer.md` | `codex-skill-installer` |
| Workshop | Shipped / accepted for local loop helper | `scripts/hyperagent.sh`, `workshop/backlog.md`, `workshop/rubric.md`, `templates/upgrade-decision.md`, `evals/smoke-loop.sh`, `missions/2026-05-16-1216-prd-fulfillment-working-product.md` | PRD fulfillment mission evidence | `workshop/proposals/2026-05-16-1216-local-loop-helper-and-smoke-eval.md`; `workshop/decisions/2026-05-16-accepted-local-loop-helper-and-smoke-eval.md` | `local-loop-helper` |
| Forge | Shipped / in review for strengthened quantitative process | `templates/forge-review.md`, `forge/process/quality-rubric.md`, `scripts/verify-forge-review.sh`, `forge/reviews/2026-05-16-1216-workshop-quality-review.md`, `missions/2026-05-20-1556-dan-177-strengthen-forge.md`, `missions/2026-05-22-1535-dan-177-quantitative-forge-rework.md` | DAN-177 mission evidence | No decision record yet for the strengthened quantitative Forge work | In review only |
| Codex Mac App Distribution | Shipped / in review | `README.md`, `docs/quickstart.md`, `docs/clean-install-uat.md`, `scripts/install-codex-skill.sh`, `scripts/update-codex-skill.sh`, `missions/2026-05-22-1547-readme-codex-installer-flow.md` | README onboarding and installer flow mission evidence | Installer accepted; README Codex prompt and clean-install UAT are in review | `codex-skill-installer`; newer onboarding flow in review |
| Multi-Platform Suit | Deferred | PRD target remains in `docs/hyperagent-prd.md`; no Claude Code, OpenClaw, Cursor, platform registry, or shared cross-agent memory adapter is implemented | No implementation issue accepted here | None | None |

## Implemented Surfaces

| Surface | State | User-facing entry point | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Codex HyperAgent skill | Accepted | `skills/codex-hyperagent/SKILL.md` | `workshop/decisions/2026-05-16-accepted-codex-skill-installer.md` | Installed into Codex through the local installer. |
| Codex skill installer and updater | Accepted | `scripts/install-codex-skill.sh`, `scripts/update-codex-skill.sh` | `workshop/proposals/2026-05-01-2108-codex-skill-installer.md` | Local filesystem writes only; no hosted service. |
| Local Mission -> Workshop -> Forge helper | Accepted | `scripts/hyperagent.sh status`, `new-mission`, `propose-upgrade`, `new-forge-review`, `decide-upgrade` | `workshop/decisions/2026-05-16-accepted-local-loop-helper-and-smoke-eval.md` | Accepted for local markdown artifacts and human-reviewed registry promotion. |
| Project initialization | In review | `scripts/hyperagent.sh init`, `bin/hyperagent init` | `missions/2026-05-20-1017-dan-173-hyperagent-init.md`, `evals/init-smoke.sh` | Implemented and covered by smoke evals, but not accepted into the registry. |
| Local sensing and check evidence | In review | `scripts/hyperagent.sh sense`, `record-check`, `doctor` | `missions/2026-05-20-1557-dan-174-sensing-layer.md`, `missions/2026-05-21-1308-dan-174-workbench-sensing-rework.md`, `evals/sense-smoke.sh` | Local-first, redacted, and graceful when Workbench traces are unavailable. |
| Reliability gains eval | In review | `evals/reliability-gains.sh` | `missions/2026-05-20-1554-dan-176-reliability-gains-eval.md`, `evals/reliability-rubric.md` | Deterministic fixture-based eval; live trace/replay ingestion is future work. |
| Quantitative Forge review checks | In review | `templates/forge-review.md`, `scripts/verify-forge-review.sh` | `missions/2026-05-20-1556-dan-177-strengthen-forge.md`, `missions/2026-05-22-1535-dan-177-quantitative-forge-rework.md` | Adds anchored 0-5 scores, evidence fields, deterministic gates, and payoff counters. |
| README architecture diagram maintenance | In review | `docs/architecture/hyperagent.mmd`, `docs/assets/hyperagent-architecture.svg`, PR checklist | `missions/2026-05-21-1329-readme-architecture-diagram.md` | Reviewed when user-visible modules change; SVG rendering is still manual. |
| Static architecture visual | Shipped / in review | README image asset | `docs/assets/hyperagent-architecture.svg` | This is not an interactive product UI. HyperAgent still has no dashboard or polished application UI. |

## Current Limits

HyperAgent Mark I is a working local alpha. It has a README architecture visual and markdown/shell workflows, but no interactive product UI, hosted service, hidden database, autonomous self-modification, multi-platform adapter suite, or production-grade safety automation.

The current repo can answer "what should I work on next?" through:

- In-review rows in this roadmap.
- `workshop/backlog.md` for proposal-backed upgrade work.
- `docs/release-checklist.md` for release-readiness work.
- Mission records under `missions/` for evidence and unresolved risks.

## Next Work

| Priority | Work | Why next | Evidence |
| --- | --- | --- | --- |
| P1 | Decide whether `init`, `sense`, reliability evals, quantitative Forge, and architecture maintenance should be accepted capabilities or remain in review | These surfaces are implemented and documented, but do not yet have decision records or registry entries | DAN-173 through DAN-177 mission records |
| P1 | Add a lightweight `product-state` reconciliation check if roadmap drift recurs | This issue fixed the first pass with docs and verifier coverage; a script may be useful if drift repeats | DAN-181 |
| P2 | Add trace/replay-backed reliability cases | Current reliability eval is deterministic but fixture-based | `missions/2026-05-20-1554-dan-176-reliability-gains-eval.md` |
| P2 | Automate Mermaid-to-SVG rendering or document the exact render command | Diagram source and rendered asset are manually kept in sync | `missions/2026-05-21-1329-readme-architecture-diagram.md` |
| P3 | Begin multi-platform adapter design | PRD milestone remains deferred until Codex-first flow stabilizes | `docs/hyperagent-prd.md` |
