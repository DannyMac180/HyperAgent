# Forge Quality Rubric

The Forge reviews whether the Workshop is improving the Suit in a disciplined way. It should answer whether proposals improved behavior, which upgrades paid off, whether templates produced vague output, whether evals caught regressions, whether safety boundaries held, and whether the improvement process is accumulating bloat.

## Review Scope

A Forge review should inspect recent:

- Workshop proposals in `workshop/proposals/`,
- human decisions in `workshop/decisions/`,
- accepted capability registry entries in `hyperagent/capability-registry.md`,
- evals and verifier checks in `evals/` and `scripts/verify-mvp.sh`,
- mission records or follow-up evidence that show whether accepted upgrades changed behavior.

## Score Scale

Forge scores use a 0-5 scale. Every score must include at least one evidence reference such as a mission path, proposal path, eval path, command result, changed file, before/after behavior, or a specific missing-artifact reason.

| Score | Meaning |
| --- | --- |
| 0 | Missing, invalid, or contradicted by evidence |
| 1 | Present only as vague narrative with weak evidence |
| 2 | Partially present, but important gaps remain |
| 3 | Adequate and traceable for human review |
| 4 | Strong, specific, and backed by direct evidence |
| 5 | Exemplary, deterministic, reusable, and supported by direct before/after or regression evidence |

## Outcome Quality Metrics

Score the recent accepted upgrades from 0 to 5.

| Metric | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Behavior improved | No behavioral evidence | Plausible improvement | Verified behavior or repeated friction removed |
| Upgrade paid off | Cost exceeds value | Value unclear | Value is clear and proportionate |
| Process bloat controlled | Adds ceremony without payoff | Some cost not justified | New process is minimal and useful |
| Traceability | Cannot follow evidence to registry | Partial trace | Mission or Forge evidence links to proposal, decision, eval, and registry |

## Proposal Quality Metrics

Score each recent Workshop proposal from 0 to 5.

| Metric | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Evidence-backed | No linked evidence | Weak or indirect evidence | Specific linked mission evidence |
| Specific | Vague capability | Directional capability | Names behavior, files, and constraints |
| Testable | No eval | Manual-only check | Concrete acceptance test or smoke eval |
| Safe | Risk missing | Risk named | Risk, authority boundary, and rollback named |
| Worth installing | Low-value polish | Helpful local improvement | Meaningful reliability or agency improvement |

## Eval Quality Metrics

Score eval coverage from 0 to 5.

| Metric | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Regression catching | No regression check | Checks artifact presence only | Exercises behavior likely to regress |
| Failure clarity | Failure is vague | Names missing file or text | Names broken behavior and artifact |
| Coverage fit | Unrelated to proposal | Covers one part of proposal | Covers the highest-risk behavior |
| Maintenance cost | Brittle or heavyweight | Some manual upkeep | Small, local, and easy to run |

## Safety Quality Metrics

Score safety quality from 0 to 5.

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

## Deterministic Gates

A Forge recommendation should be `ready` only when all gates pass:

- Testable behavior claim present.
- Owner surface named.
- Eval or check plan present.
- Rollback or human-review boundary present.
- Every score has at least one evidence reference or a missing-artifact reason.

If any gate fails, the recommendation should be `not ready` and the follow-up should name the missing artifact or weak process field.

## Payoff Metrics

For each accepted Workshop proposal reviewed, record simple counters when evidence exists:

- `regressions_caught`
- `repeat_friction_seen_again`
- `manual_steps_removed`
- `evals_added`
- `artifacts_retired`

These metrics are intentionally small and local. They help answer whether an upgrade paid off without turning Forge into a hosted analytics system.

## Forge Actions

The Forge may propose changes to:

- `templates/upgrade-proposal.md`
- `templates/mission-record.md`
- `workshop/rubric.md`
- `evals/README.md`
- `scripts/hyperagent.sh`
- `skills/codex-hyperagent/SKILL.md`
- `hyperagent/operating-prompt.md`

The Forge may also run an opinionated local audit:

```bash
sh scripts/hyperagent.sh forge audit
```

The audit reports weak proposals, stale or missing decisions, accepted registry entries without source proposal, decision, verification evidence, or rollback traceability, and missing Forge audit eval coverage. It is read-only by default. `--write-proposal` drafts one `human review required` process-improvement proposal when the findings are concrete enough to act on; it never accepts, installs, or records a decision.

Forge reviews may generate process-improvement proposals. Use:

```bash
sh scripts/hyperagent.sh propose-upgrade \
  --forge-review forge/reviews/YYYY-MM-DD-HHMM-review.md \
  --title "Improve Workshop proposal quality" \
  --problem "Recent proposals are too vague to evaluate"
```

Forge process changes still require human review before activation.
