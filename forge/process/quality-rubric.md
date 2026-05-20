# Forge Quality Rubric

The Forge reviews whether the Workshop is improving the Suit in a disciplined way. It should answer whether proposals improved behavior, which upgrades paid off, whether templates produced vague output, whether evals caught regressions, whether safety boundaries held, and whether the improvement process is accumulating bloat.

## Review Scope

A Forge review should inspect recent:

- Workshop proposals in `workshop/proposals/`,
- human decisions in `workshop/decisions/`,
- accepted capability registry entries in `hyperagent/capability-registry.md`,
- evals and verifier checks in `evals/` and `scripts/verify-mvp.sh`,
- mission records or follow-up evidence that show whether accepted upgrades changed behavior.

## Outcome Quality Metrics

Score the recent accepted upgrades from 0 to 2.

| Metric | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Behavior improved | No behavioral evidence | Plausible improvement | Verified behavior or repeated friction removed |
| Upgrade paid off | Cost exceeds value | Value unclear | Value is clear and proportionate |
| Process bloat controlled | Adds ceremony without payoff | Some cost not justified | New process is minimal and useful |
| Traceability | Cannot follow evidence to registry | Partial trace | Mission or Forge evidence links to proposal, decision, eval, and registry |

## Proposal Quality Metrics

Score each recent Workshop proposal from 0 to 2.

| Metric | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Evidence-backed | No linked evidence | Weak or indirect evidence | Specific linked mission evidence |
| Specific | Vague capability | Directional capability | Names behavior, files, and constraints |
| Testable | No eval | Manual-only check | Concrete acceptance test or smoke eval |
| Safe | Risk missing | Risk named | Risk, authority boundary, and rollback named |
| Worth installing | Low-value polish | Helpful local improvement | Meaningful reliability or agency improvement |

## Eval Quality Metrics

Score eval coverage from 0 to 2.

| Metric | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Regression catching | No regression check | Checks artifact presence only | Exercises behavior likely to regress |
| Failure clarity | Failure is vague | Names missing file or text | Names broken behavior and artifact |
| Coverage fit | Unrelated to proposal | Covers one part of proposal | Covers the highest-risk behavior |
| Maintenance cost | Brittle or heavyweight | Some manual upkeep | Small, local, and easy to run |

## Safety Quality Metrics

Score safety quality from 0 to 2.

| Metric | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Authority boundary | Not mentioned | Named generally | Explicit permissions, secrets, deployment, and activation boundary |
| Rollback | Missing | Generic rollback | Specific rollback path |
| Human review | Silent activation possible | Human review implied | Human review required and decision path named |
| Deferred risk | Risks disappear after decision | Some risks tracked | Rejected, deferred, and open risks are recorded |

## Process Quality Questions

Review the Workshop process itself:

- Are repeated friction patterns visible across missions?
- Are proposals prioritized with the same rubric?
- Are rejected proposals recorded with reasons?
- Are accepted capabilities traceable from mission evidence to registry entry?
- Are evals catching behavior, not just file presence?
- Are templates producing vague, repetitive, or low-value output?
- Are the Mission -> Workshop -> Forge steps adding useful evidence or process bloat?

## Forge Actions

The Forge may propose changes to:

- `templates/upgrade-proposal.md`
- `templates/mission-record.md`
- `workshop/rubric.md`
- `evals/README.md`
- `scripts/hyperagent.sh`
- `skills/codex-hyperagent/SKILL.md`
- `hyperagent/operating-prompt.md`

Forge reviews may generate process-improvement proposals. Use:

```bash
sh scripts/hyperagent.sh propose-upgrade \
  --forge-review forge/reviews/YYYY-MM-DD-HHMM-review.md \
  --title "Improve Workshop proposal quality" \
  --problem "Recent proposals are too vague to evaluate"
```

Forge process changes still require human review before activation.
