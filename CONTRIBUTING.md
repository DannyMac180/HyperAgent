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
5. Complete the Suit Not Scaffold review gate.
6. Include an acceptance test and rollback plan.
7. Keep the activation mode `human review required`.

## Suit Not Scaffold Review Gate

Before adding a feature, decide whether it strengthens durable agency infrastructure or only patches a narrow workflow. The allowed durable-agency pillars are: sensing, verification, memory, safety, capability discovery, upgrade flow, and adapter boundary.

Answer these questions in the proposal and PR:

- Which durable-agency pillar does this strengthen?
- Is the feature core Suit infrastructure, an adapter-specific convenience, an example, or an experiment?
- If it is task-specific, why does it belong outside core?
- What evidence or local verification will show the feature prevents product creep instead of adding it?

Use these homes:

- Core Suit infrastructure belongs in the local Mission -> Workshop -> Forge loop, shared templates, verification, safety boundaries, memory shape, or capability discovery surfaces.
- Adapter-specific conveniences belong under adapter-owned docs, config, scripts, or examples until the adapter boundary is accepted.
- Examples belong in docs, fixtures, eval fixtures, or sample artifacts that do not become required product behavior.
- Experiments belong in Workshop proposals, backlog candidates, or clearly marked future work until a human decision accepts them.

Accepted upgrades require:

- a proposal in `workshop/proposals/`,
- a decision record in `workshop/decisions/`,
- a capability registry entry in `hyperagent/capability-registry.md`,
- verification evidence.

## How To Handle Mission Evidence

Mission records can include local paths, issue metadata, trace references, and implementation details from real dogfooding. Before committing mission evidence, follow `docs/evidence-policy.md`.

Use `docs/examples/missions/` for public-safe sample missions. Keep raw local evidence in ignored paths such as `.hyperagent-evidence/`.

Before proposing a public mission commit, run:

```bash
sh scripts/hyperagent.sh verify-mission --strict PATH
sh scripts/hyperagent.sh mission redact-check PATH
```

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

## Product State Reconciliation

When a contribution changes user-visible product state, reconcile the inspectable truth files in the same PR.

Checklist:

- Update `docs/roadmap.md` when a surface becomes shipped, accepted, in review, deferred, or stale.
- Keep `README.md` high level and link to `docs/roadmap.md` instead of duplicating detailed status tables.
- Update `docs/releases/v0.1.0-alpha.md` only for first-alpha truth; put unreleased next-alpha notes in `docs/releases/next-alpha.md`.
- Add accepted capabilities to `hyperagent/capability-registry.md` only after a human decision record exists in `workshop/decisions/`.
- Put implemented-but-unaccepted surfaces in the registry and backlog as `in review`, not `accepted`.
- Update `workshop/backlog.md` when a new proposal-backed item, review candidate, or deferred PRD area changes.
- Review `docs/architecture/hyperagent.mmd` and `docs/assets/hyperagent-architecture.svg` when user-visible modules are added, removed, renamed, or materially changed.
- Run `sh scripts/verify-mvp.sh` after reconciliation.

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
