# HyperAgent Roadmap

This roadmap maps the PRD milestones to the current alpha state. Keep it short and link to detailed artifacts instead of duplicating them.

## Milestone Status

| PRD milestone | Status | Notes |
| --- | --- | --- |
| Milestone 1: HyperAgent Mark I | Done for alpha | Codex skill, operating prompt, mission/proposal/Forge templates, local memory dirs, installer, and core verifier exist. |
| Milestone 2: Workshop | Alpha | Backlog, rubric, proposal template, decisions, and registry exist. Next simplification is deriving state from proposals/decisions instead of duplicating it. |
| Milestone 3: Forge | Alpha | Forge template and quality rubric exist. Keep Forge passive by default and cadence-driven. |
| Milestone 4: Codex Mac App Distribution | Alpha | README prompt, installer, update helper, quickstart, and UAT docs exist. Setup remains Codex-assisted instead of a hosted installer. |
| Milestone 5: Multi-Platform Suit | Deferred | Define adapter contracts now; do not implement non-Codex adapters in the alpha core. |

## Active Product Direction

1. Keep the core small and markdown-first.
2. Make optional extensions explicit: UI, sensing extras, Workbench traces, reliability scoring.
3. Split verification into core, extensions, and release tiers.
4. Collapse the public command surface while preserving compatibility aliases.
5. Reduce `hyperagent init` drift by installing local memory/setup rather than copying the whole runtime.
6. Use decisions/proposals as source evidence for capability state.

## Deferred

- Hosted service or database-backed memory.
- Autonomous self-modification.
- Production-grade safety automation.
- Non-Codex adapters beyond an adapter contract.
- Polished hosted dashboard.
