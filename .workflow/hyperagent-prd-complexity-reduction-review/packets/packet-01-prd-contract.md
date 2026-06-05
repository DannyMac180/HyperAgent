# Packet 01: PRD Contract

Objective: Identify what cannot be cut without compromising product integrity.

Sources:
- `docs/hyperagent-prd.md`
- `hyperagent/operating-prompt.md`
- `skills/codex-hyperagent/SKILL.md`

Findings:
- The core product is not a UI, hosted service, database, broad automation platform, or project manager.
- The durable contract is: Codex-first operating layer, local mission records, evidence-backed Workshop proposals, Forge reviews of the improvement process, local file memory, verification expectations, and explicit human approval for persistent behavior changes.
- The PRD explicitly warns against complex UI before the markdown loop works and against brittle task-specific scaffolds.
- The MVP goal is small: complete tasks with an explicit loop, record telemetry, propose upgrades, store proposals locally, and produce one human-reviewable implementation plan.
- Future multi-platform support matters architecturally, but the PRD does not require implementing non-Codex adapters now.

Preserve:
- Suit / Mission / Workshop / Forge mental model.
- Human-review-required safety.
- Inspectable markdown artifacts.
- Codex installation path.
- Verification contracts.

Simplification implication:
- Anything outside those primitives should be either optional, generated, deferred, or moved behind an adapter/extension boundary.
