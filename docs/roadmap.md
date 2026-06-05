# HyperAgent Roadmap And Product State

This page is the repo source of truth for what HyperAgent has shipped, what is accepted, what is in review, what is intentionally deferred, and which issue owns the next decision.

State definitions:

- `Shipped`: present in repo artifacts and available to alpha users.
- `Accepted`: shipped and backed by a human decision record plus a capability registry entry.
- `In review`: implemented or proposed with mission evidence, but not yet promoted by a decision record.
- `Deferred`: part of the PRD direction, but not built for this alpha.
- `Stale`: contradicted by current repo artifacts and needing cleanup.

Default activation mode remains `human review required`. Do not treat an implemented file or merged branch as an accepted persistent capability unless it has a matching decision in `workshop/decisions/` and an accepted entry in `hyperagent/capability-registry.md`.

## PRD Milestone Map

| PRD milestone | Alpha scope | Current state | Owner / source issue | Evidence | Next action | Registry / decision |
| --- | --- | --- | --- | --- | --- | --- |
| Mark I | Current alpha | Shipped / partially accepted | DAN-181 product-state reconciliation; DAN-183 validated config contract; DAN-184 mission closeout automation | `skills/codex-hyperagent/SKILL.md`, `hyperagent/operating-prompt.md`, `templates/mission-record.md`, `templates/upgrade-proposal.md`, `missions/2026-05-01-2108-mark-i-build.md`, `missions/2026-05-23-2234-dan-181-product-state-reconciliation.md`, `missions/2026-05-23-2236-dan-183-validated-config-contract.md`, `missions/2026-05-23-2006-dan-184-mission-closeout-automation.md`, `scripts/verify-mvp.sh` | Keep Mark I local, inspectable, and Codex-first while reviewer decisions promote or defer newer surfaces. | Accepted: `codex-skill-installer`; in review: project config and closeout automation until decision records promote them. |
| Workshop | Current alpha | Shipped / accepted for local loop helper; cadence work in progress | DAN-185 cadence audits; DAN-190 accepted-capability surfacing | `scripts/hyperagent.sh`, `workshop/backlog.md`, `workshop/rubric.md`, `templates/upgrade-decision.md`, `evals/smoke-loop.sh`, `missions/2026-05-16-1216-prd-fulfillment-working-product.md` | Use cadence evidence to move proposals through backlog/decision/registry rather than leaving them as mission notes. | Accepted: `local-loop-helper`; DAN-185 and DAN-190 remain in review/backlog. |
| Forge | Current alpha | Shipped / in review for strengthened quantitative process | DAN-196 Forge audit; prior DAN-177 quantitative Forge work | `templates/forge-review.md`, `forge/process/quality-rubric.md`, `scripts/verify-forge-review.sh`, `forge/reviews/2026-05-16-1216-workshop-quality-review.md`, `missions/2026-05-20-1556-dan-177-strengthen-forge.md`, `missions/2026-05-22-1535-dan-177-quantitative-forge-rework.md` | Land/review the Forge audit work, then decide whether quantitative Forge review becomes an accepted capability. | No decision record yet for the strengthened quantitative Forge work. |
| Codex Mac App Distribution | Current alpha | Shipped / in review | DAN-192 one-command Codex setup; DAN-193 next alpha release | `README.md`, `docs/quickstart.md`, `docs/clean-install-uat.md`, `scripts/install-codex-skill.sh`, `scripts/update-codex-skill.sh`, `missions/2026-05-22-1547-readme-codex-installer-flow.md` | Finish one-command setup review, then prepare a clean reviewed next-alpha release. | Accepted: `codex-skill-installer`; README prompt, clean-install UAT, and one-command setup remain in review. |
| Multi-Platform Suit | Future work | Deferred by design | DAN-189 Codex adapter boundary before non-Codex platforms | PRD target remains in `docs/hyperagent-prd.md`; adapter boundary docs live in `adapters/contract.md` and `adapters/codex.md`; no Claude Code, OpenClaw, Cursor, platform registry, or shared cross-agent memory adapter is implemented | Use the Codex adapter boundary as the template for future reviewed adapter issues; do not implement non-Codex adapters in the current alpha. | None. Do not add non-Codex adapters in the current alpha. |

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
| Static architecture visual | Shipped / in review | README image asset | `docs/assets/hyperagent-architecture.svg` | This is a documentation asset, not a product cockpit. |
| Optional local UI cockpit | In review | `hyperagent ui` when present in a checkout | `docs/ui-architecture.md` | Local-only, read-mostly cockpit over markdown and evidence logs; no hosted service, hidden database, or silent activation. |

## PRD Faithfulness Improvement Map

This section keeps the 17 review improvements visible without requiring chat history. Linear state is a planning signal, not an acceptance signal; accepted capabilities still require a decision record and registry entry.

| Issue | Current Linear state | Alpha classification | Roadmap area | Evidence / source | Next action |
| --- | --- | --- | --- | --- | --- |
| DAN-181 Reconcile product state | Done | Current alpha | Roadmap, release notes, registry, backlog | `missions/2026-05-23-2234-dan-181-product-state-reconciliation.md`, `docs/roadmap.md`, `docs/releases/next-alpha.md`, `hyperagent/capability-registry.md`, `workshop/backlog.md` | Keep roadmap as the canonical product-state page; add automation only if drift recurs. |
| DAN-182 Simplify CLI into five flows | In Progress | Current alpha candidate | CLI ergonomics | `scripts/hyperagent.sh`, `docs/quickstart.md`, `evals/cli-help-smoke.sh` | Review grouped `mission` and `review` commands plus compatibility aliases before promoting the simplified CLI surface. |
| DAN-183 Validated `.hyperagent` contract | Done | Current alpha | Project config | `missions/2026-05-23-2236-dan-183-validated-config-contract.md`, `.hyperagent`, `docs/config.md` | Review for acceptance and registry promotion if the contract should become an accepted capability. |
| DAN-184 Mission closeout automation | Done | Current alpha | Mission telemetry | `missions/2026-05-23-2006-dan-184-mission-closeout-automation.md`, `scripts/hyperagent.sh`, `templates/mission-record.md` | Review for acceptance and keep strict mission verification green. |
| DAN-185 Workshop/Forge cadence audits | In Progress | Current alpha candidate | Workshop and Forge process | `workshop/backlog.md`, mission evidence under `missions/` | Convert recurring mission evidence into backlog movement and reviewer-visible cadence checks. |
| DAN-186 Score real mission evidence | In Progress | Current alpha candidate | Reliability evals | `evals/reliability-gains.sh`, `evals/reliability-rubric.md`, `missions/2026-05-20-1554-dan-176-reliability-gains-eval.md` | Extend reliability scoring beyond curated fixtures while preserving deterministic local checks. |
| DAN-187 Optional local UI cockpit | Merging | Current alpha candidate | UI/dashboard | `docs/hyperagent-prd.md` MVP non-goals, `README.md` current limits, `docs/ui-architecture.md` | Keep UI optional and subordinate to markdown truth; do not build a hosted dashboard for this alpha. |
| DAN-188 Public evidence boundaries | In review | Current alpha candidate | Privacy and sample logs | `docs/evidence-policy.md`, `docs/examples/missions/public-safe-mission.md`, `scripts/hyperagent.sh mission redact-check` | Defines committed-vs-local evidence boundaries, public sample location, and a quick redaction preflight. |
| DAN-189 Codex adapter boundary | In Progress | Future work | Multi-platform Suit | `docs/hyperagent-prd.md` target-user and adapter language; `adapters/contract.md`; `adapters/codex.md` | Review the Codex adapter boundary before implementing Claude Code, Cursor, OpenClaw, or other adapters. |
| DAN-190 Accepted capabilities in status/sense/closeout | Backlog | Current alpha candidate | Capability registry visibility | `hyperagent/capability-registry.md`, `scripts/hyperagent.sh status`, `scripts/hyperagent.sh sense` | Surface accepted vs in-review capability state in local commands and closeout artifacts. |
| DAN-191 Safety and authority verifier checks | In Progress | Current alpha candidate | Safety boundary | `README.md`, `SECURITY.md`, `scripts/verify-mvp.sh`, `hyperagent/operating-prompt.md` | Add local checks that preserve `human review required` and reject authority-boundary regressions. |
| DAN-192 One-command Codex setup | Rework | Current alpha candidate | Codex Mac distribution | `README.md`, `docs/quickstart.md`, `scripts/install-codex-skill.sh`, `scripts/update-codex-skill.sh` | Address rework feedback, push the PR, and keep setup opt-in for project initialization. |
| DAN-193 Next alpha release | In Progress | Current alpha release gate | Release readiness | `docs/releases/next-alpha.md`, `docs/release-checklist.md` | Prepare the next alpha only after the product tree is clean and reviewed. |
| DAN-194 PRD milestone roadmap | In Progress | Current alpha | Roadmap | `docs/roadmap.md`, `CONTRIBUTING.md`, `scripts/verify-mvp.sh` | Keep this file reviewer-maintainable with status, owner/source issue, evidence, and next action columns. |
| DAN-195 Init drift separation | Merging | Current alpha candidate | Project init and runtime boundaries | `scripts/hyperagent.sh init`, `.hyperagent`, `docs/config.md` | Land merge if checks pass; keep local project artifacts separate from global runtime files. |
| DAN-196 Forge audit | Merging | Current alpha candidate | Forge process health | `templates/forge-review.md`, `forge/process/quality-rubric.md`, `scripts/verify-forge-review.sh` | Land merge if checks pass, then decide whether audit output changes Workshop process. |
| DAN-197 Suit-not-scaffold gate | In Progress | Current alpha guardrail | Product strategy and review gate | `docs/hyperagent-prd.md` strategic positioning, `CONTRIBUTING.md`, `.github/pull_request_template.md`, `templates/upgrade-proposal.md` | Use the review gate to route new work to core Suit infrastructure, adapter-specific conveniences, examples, or experiments. |

## Current Focus

- Keep the current alpha Codex-first: Mark I, local Mission -> Workshop -> Forge, local config, mission closeout, safety checks, and Codex Mac distribution.
- Move implemented-but-unaccepted surfaces through explicit human review before calling them accepted capabilities.
- Route task-specific conveniences into examples, adapters, or experiments instead of core Suit infrastructure.
- Preserve `docs/roadmap.md` as the concise product-state index and keep README high level.
- Use DAN-193 as the release gate once DAN-192, DAN-195, DAN-196, and safety/roadmap work are reviewed.

## Deferred By Design

- Multi-platform adapters are deferred. DAN-189 defines the Codex adapter boundary in docs only; it does not ship Claude Code, Cursor, OpenClaw, or other platform support.
- A local UI cockpit is allowed only as an optional read-mostly layer over markdown artifacts and evidence logs.
- Hosted services, hidden databases, autonomous self-modification, and broadened account/network authority remain out of scope for this alpha.
- Non-Codex platform support should not be added as an implementation shortcut before the current Codex-first flow stabilizes.

## Current Limits

HyperAgent Mark I is a working local alpha. It has a README architecture visual, markdown/shell workflows, and may include an optional local cockpit for inspecting those files. It has no polished hosted dashboard, hosted service, hidden database, autonomous self-modification, multi-platform adapter suite, or production-grade safety automation.

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
| P3 | Open reviewed future adapter issues from the adapter contract | PRD milestone remains deferred until Codex-first flow stabilizes and the Codex boundary has been reviewed | `adapters/contract.md`, `adapters/codex.md`, `docs/hyperagent-prd.md` |
