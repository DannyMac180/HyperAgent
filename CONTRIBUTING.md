# Contributing To HyperAgent

HyperAgent is an early alpha, Codex-first, file-based project. Contributions should make the Mission -> Workshop -> Forge loop more reliable without adding unnecessary runtime complexity.

## Ground Rules

- Keep the system local, inspectable, and dependency-light.
- Preserve `human review required` for persistent behavior changes.
- Do not add autonomous self-modification.
- Do not broaden filesystem, shell, network, deployment, account, or secrets access without explicit review.
- Prefer markdown templates, small shell scripts, and focused evals before adding heavier infrastructure.
- Keep the PRD core small. Put optional UI, sensing, Workbench, reliability, or release-support work behind the extension/release boundary described in `docs/product-state.md`.
- Use `docs/safety-policy.md` for authority-boundary checks and `docs/evidence-policy.md` before committing mission or trace evidence.

## How To Propose A Suit Upgrade

1. Start from mission evidence in `missions/`.
2. Create a proposal in `workshop/proposals/` using `templates/upgrade-proposal.md`.
3. Score the proposal with `workshop/rubric.md`.
4. Add the proposal to `workshop/backlog.md` if it is worth tracking.
5. Include an acceptance test and rollback plan.
6. Keep the activation mode `human review required`.

Accepted upgrades require:

- a proposal in `workshop/proposals/`,
- a decision record in `workshop/decisions/`,
- a capability registry entry in `hyperagent/capability-registry.md`,
- verification evidence.

## How To Add Evals

Put small, repeatable checks in `evals/`.

Good evals should:

- run locally,
- avoid hosted services,
- be deterministic enough to catch regressions,
- test behavior instead of only file presence when possible,
- be documented in `evals/README.md`.

Run:

```bash
sh scripts/verify-mvp.sh
sh evals/smoke-loop.sh
```

Use broader tiers when relevant:

```bash
sh scripts/verify-extensions.sh
sh scripts/verify-release.sh
```

## How To Change Templates

Template changes affect the Suit's memory shape. When changing templates:

- update the matching skill or operating prompt instructions,
- update verifier expectations if the field is required,
- update any smoke evals that depend on the template,
- record the reason in a mission record or Workshop proposal.

## How To Improve The Forge

Forge changes should improve the Workshop process itself.

Examples:

- better proposal quality metrics,
- stronger eval requirements,
- clearer safety review fields,
- better promotion rules from proposals to accepted capabilities.

Use `forge/process/quality-rubric.md` and write Forge reviews in `forge/reviews/`.

## Pull Requests

Before opening a PR:

```bash
sh scripts/verify-mvp.sh
sh evals/smoke-loop.sh
```

PRs should explain:

- the mission or friction being addressed,
- files changed,
- verification run,
- any safety or authority-boundary implications,
- whether user-visible module changes required an architecture diagram update,
- rollback path when behavior changes persist.
- whether the change affects core, optional extensions, release support, or adapter boundaries.
