# Forge Quality Rubric

The Forge reviews whether the Workshop is improving the Suit in a disciplined way.

## Proposal Quality Metrics

Score each recent Workshop proposal from 0 to 2.

| Metric | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Evidence-backed | No linked evidence | Weak or indirect evidence | Specific linked mission evidence |
| Specific | Vague capability | Directional capability | Names behavior, files, and constraints |
| Testable | No eval | Manual-only check | Concrete acceptance test or smoke eval |
| Safe | Risk missing | Risk named | Risk, authority boundary, and rollback named |
| Worth installing | Low-value polish | Helpful local improvement | Meaningful reliability or agency improvement |

## Process Quality Metrics

Review the Workshop process itself:

- Are repeated friction patterns visible across missions?
- Are proposals prioritized with the same rubric?
- Are rejected proposals recorded with reasons?
- Are accepted capabilities traceable from mission evidence to registry entry?
- Are evals catching behavior, not just file presence?

## Forge Actions

The Forge may propose changes to:

- `templates/upgrade-proposal.md`
- `templates/mission-record.md`
- `workshop/rubric.md`
- `evals/README.md`
- `scripts/hyperagent.sh`
- `skills/codex-hyperagent/SKILL.md`
- `hyperagent/operating-prompt.md`

Forge process changes still require human review before activation.

