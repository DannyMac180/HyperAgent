# Packet 04: Evidence And Process

Objective: Review mission/proposal/decision/Forge telemetry, duplication, cadence, backlog, registry, and safety complexity.

Sources:
- `templates/mission-record.md`
- `templates/upgrade-proposal.md`
- `templates/upgrade-decision.md`
- `templates/forge-review.md`
- `workshop/backlog.md`
- `workshop/rubric.md`
- `hyperagent/capability-registry.md`
- `forge/process/quality-rubric.md`
- `AGENTS.md`

Findings:
- Multiple artifacts record overlapping capability state: proposal, decision, backlog, capability registry, release notes, README, mission records.
- Mission count is much higher than proposal/decision/Forge count, so telemetry volume can grow faster than product learning.
- The project testbed instructions intentionally run full telemetry often, but that can make the product feel heavier than the PRD requires for ordinary installed users.
- Safety is mostly prose and template fields, not enforced through a compact policy/check.
- Backlog and registry are hand-maintained, which adds process load and drift risk.
- Symphony Linear handoff and README architecture diagram rules are valid for this repo but should not become product-generic operating burden.

Simplification candidates:
- Choose one canonical state source and derive views from it.
- Add cadence/threshold rules for Workshop and Forge instead of forcing every task into full process.
- Keep project-testbed rules separate from installed-user rules.
- Turn safety from duplicated prose into one compact policy checklist/verifier.
