# HyperAgent Product State

This page is the canonical local summary of what belongs to the HyperAgent core, what is an optional extension, and what is release/process support.

HyperAgent's PRD core is intentionally small:

- Codex-first installable Suit.
- Local mission records as inspectable evidence.
- Workshop proposals backed by mission evidence.
- Forge reviews that improve the Workshop process.
- Human review before persistent behavior changes.
- Markdown-first memory and lightweight verification.
- Adapter-aware design without implementing every platform in the alpha.

## Product Boundaries

| Surface | Status | Source of truth | Verification tier |
| --- | --- | --- | --- |
| Codex skill | Core | `skills/codex-hyperagent/SKILL.md` | Core |
| Operating prompt | Core | `hyperagent/operating-prompt.md` | Core |
| Mission records | Core | `missions/`, `templates/mission-record.md` | Core |
| Workshop proposals | Core | `workshop/proposals/`, `templates/upgrade-proposal.md` | Core |
| Human decisions | Core | `workshop/decisions/`, `templates/upgrade-decision.md` | Core |
| Forge reviews | Core | `forge/reviews/`, `templates/forge-review.md` | Core |
| Capability registry | Core final-state index | `hyperagent/capability-registry.md` | Core |
| Project init | Core setup | `.hyperagent`, `AGENTS.md`, templates, local memory dirs | Core |
| Sensing summary | Optional extension | `scripts/hyperagent.sh sense` | Extensions |
| Workbench trace enrichment | Optional extension | `.hyperagent-evidence/workbench/traces.jsonl` | Extensions |
| Local UI cockpit | Optional extension | `scripts/hyperagent-ui.mjs`, `ui/` | Extensions |
| Reliability scoring | Optional research extension | `evals/reliability-gains.sh` | Extensions |
| Clean-install UAT | Release support | `docs/clean-install-uat.md` | Release |
| Dogfooding guide | Release support | `docs/dogfooding.md` | Release |
| GitHub issue/PR templates | Release support | `.github/` | Release |
| README architecture asset | Release support | `docs/architecture/hyperagent.mmd`, `docs/assets/hyperagent-architecture.svg` | Release |

## Verification Tiers

Use the smallest tier that proves the change.

```bash
sh scripts/verify-core.sh
sh scripts/verify-extensions.sh
sh scripts/verify-release.sh
```

`sh scripts/verify-mvp.sh` is kept as a compatibility alias for `verify-core.sh`.

## State Ownership

- Proposals are the source for proposed work.
- Decisions are the source for human approval or rejection.
- The capability registry is the final accepted-capability index, not a planning backlog.
- The backlog is a planning view over proposals, not a second approval system.
- Release notes describe what shipped at a version, not the current living product state.
- This document and `docs/roadmap.md` describe current product state.

## Current Simplification Policy

New features should qualify as durable agency infrastructure before entering core. A feature belongs in core only when it directly improves local action, evidence, verification, safety, capability discovery, or the Mission -> Workshop -> Forge learning loop.

Features that are useful but not required by the PRD core should remain optional extensions.
