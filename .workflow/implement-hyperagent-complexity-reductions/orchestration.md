# Orchestration: Implement HyperAgent complexity reductions

## Execution Rules

- Keep the original objective intact.
- Ask for approval before risky, expensive, external, or destructive actions.
- Keep immediate blocking work local.
- Delegate only bounded, disjoint, materially useful packets.
- Integrate packet results before final verification.
- Preserve compatibility aliases for existing commands and evals.
- Prefer docs/policy/verification classification over deleting optional capabilities.

## Branching Rules
- If a change would remove Mission, Workshop, Forge, human review, local markdown, or Codex-first installability, reject it.
- If a simplification can be implemented by making a smaller path canonical while preserving legacy behavior, prefer that.
- If a report item is not safely automatable, implement it as an explicit policy, roadmap status, verifier boundary, or extension classification.

## Packet Prompts
- Product-state/docs: canonical core vs extension boundary, roadmap, docs consolidation, release positioning, public/private evidence policy.
- CLI/init/config: public command groups, `sense --doctor`, `check --`, init scope reduction, `.hyperagent` tiers.
- Verification/evals: core/extension/release verifier split, docs/eval wrappers, MVP checks trim optional surfaces.
- Artifact/state: template/state/capability traceability, safety policy, adapter boundary, backlog/registry simplification.
- Integration/verify: run checks, workflow results, mission record, memory closeout.

## Completion Audit
- Product files updated.
- Verification checks run or skipped with reason.
- Workflow result written under `results/`.
- Mission record written.
- Obsidian Codex memory closeout completed.
