# Workshop Prioritization Rubric

Use this rubric when reviewing mission records and choosing which Suit upgrade to propose or implement first.

## Scoring

Score each proposal from 0 to 2 in each category.

| Category | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Evidence | No mission evidence | Single weak signal | Clear mission evidence or repeated friction |
| Impact | Cosmetic | Saves manual effort | Improves reliability, verification, or safety |
| Specificity | Vague | Directional | Names files, behavior, and first step |
| Testability | No eval | Manual check only | Concrete acceptance test or smoke eval |
| Safety | Risk unclear | Risk named | Risk named with rollback and authority boundary |
| Transfer | One-off task fix | Useful in this repo | Useful across Codex workspaces or future adapters |

## Decision Bands

- `10-12`: Strong candidate. Add to backlog and consider implementation.
- `7-9`: Good candidate. Tighten eval or safety notes before implementation.
- `4-6`: Keep as a draft proposal unless the user explicitly prioritizes it.
- `0-3`: Do not implement yet. Ask for better evidence or fold into another proposal.

## Required Implementation Plan

Before a proposal can move from `proposed` to `accepted`, it must include:

- Highest-priority plan step.
- Files or instructions likely to change.
- Eval or acceptance test.
- Rollback plan.
- Proposed activation mode.
- Human reviewer or explicit approval path.

