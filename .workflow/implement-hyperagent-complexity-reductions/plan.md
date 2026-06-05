# Implement HyperAgent complexity reductions

## Goal
Implement the opportunities in `.workflow/hyperagent-prd-complexity-reduction-review/final-report.md` while preserving the PRD core: Codex-first Suit, local mission evidence, Workshop, Forge, human review, and markdown-first inspectability.

## Success Criteria
- Add a canonical core-vs-extensions product-state/roadmap source.
- Split verification into core, extension, and release tiers while keeping `verify-mvp.sh` as a core alias.
- Simplify the public CLI surface with grouped commands and compatibility aliases.
- Demote UI, sensing extras, Workbench traces, reliability scoring, and release/UAT checks out of the MVP core.
- Reduce project init copying and generated-runtime drift.
- Make templates/config/state more canonical and document adapter/safety boundaries.
- Update docs and evals so simplifications are reflected consistently.
- Record workflow results, mission telemetry, and memory closeout.

## Current Context
- Repo: `/Users/danielmcateer/Desktop/dev/HyperAgent`
- Current branch: dirty working tree with existing HyperAgent changes before this mission.
- Source review: `.workflow/hyperagent-prd-complexity-reduction-review/final-report.md`.
- Prior durable memory: complexity review recommends `core` vs optional extensions, verifier tiers, CLI collapse, template/config/state canonicalization, and reduced `init` copying.

## Constraints
- Do not revert or delete existing user work.
- Keep legacy aliases where removal would break existing scripts/evals.
- Preserve markdown files as source of truth.
- Do not introduce hosted services, databases, autonomous self-modification, or new external dependencies.
- Keep UI optional, not removed.

## Risks
- Broad product-surface changes can break existing smoke evals.
- Reducing `init` copying changes initialized-project expectations.
- Some report opportunities are directional; implementation should encode them as policy/docs when full automation would be risky.

## Approval Required
The user explicitly requested implementation. No destructive deletion, mass rename, external write, deploy, or secrets operation is planned.

## Work Packets
- `packet-01-product-state-docs`: roadmap, extension boundary, adapter/safety docs, README/quickstart/release/evals docs.
- `packet-02-cli-init-config`: public command groups, `sense --doctor`, `check --`, init copy reduction, `.hyperagent` config tiers.
- `packet-03-verification-evals`: core/extension/release verifier scripts and eval docs/wrappers.
- `packet-04-artifact-state`: template-source improvements, backlog/registry/state traceability, public/private evidence policy.
- `packet-05-integration-verify`: run checks, update workflow results, mission record, memory closeout.

## Integration Policy
Implement every opportunity either as executable behavior, verification split, documentation policy, compatibility grouping, or explicit extension classification. When full deletion would be risky, preserve backward compatibility and make the simpler path canonical.

## Verification
- `sh scripts/verify-mvp.sh`
- `sh scripts/verify-extensions.sh`
- `sh scripts/verify-release.sh`
- `sh evals/smoke-loop.sh`
- `sh evals/init-smoke.sh`
- `sh evals/sense-smoke.sh`
- `sh evals/ui-smoke.sh`
- `sh evals/reliability-gains.sh`
- dynamic workflow verifier

## Reusable Artifacts
- `.workflow/implement-hyperagent-complexity-reductions/final-report.md`
- Mission record in `missions/`
