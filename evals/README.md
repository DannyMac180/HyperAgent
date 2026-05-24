# HyperAgent Evals

Mark I evals are local checks for the Mission -> Workshop loop. They are intentionally small and dependency-free.

Run:

```bash
sh scripts/hyperagent.sh verify-config
sh scripts/verify-mvp.sh
```

The config verifier checks the root `.hyperagent` project contract. The artifact verifier checks whether the repo contains the artifacts required by the PRD for the Codex-first prototype.

## Loop Smoke Eval

Run:

```bash
sh evals/smoke-loop.sh
```

The smoke loop copies the repo to a temporary directory, then verifies that the local helper can:

- create a mission record in `missions/` with repo evidence, command evidence, verification status, and closeout placeholders,
- run `hyperagent check` and record command status automatically,
- create or update a closeout mission record with sense snapshot, recent checks, changed files, verification status, unresolved risks, and candidate upgrades,
- fail strict mission verification when draft placeholders remain,
- create a proposal linked to that mission in `workshop/proposals/`,
- create a Forge review in `forge/reviews/`,
- create a process-improvement proposal linked to that Forge review,
- record a human-review decision in `workshop/decisions/`,
- append an accepted capability to `hyperagent/capability-registry.md`.

## Forge Audit Smoke Eval

Run:

```bash
sh evals/forge-audit-smoke.sh
```

The Forge audit smoke test copies the repo to a temporary directory, adds one complete proposal fixture and one intentionally weak proposal fixture, then verifies that `forge audit`:

- prints a concise process-health report,
- identifies weak proposals and proposals missing decisions,
- reports a finding count,
- drafts a human-review-required process proposal only when explicitly requested with `--write-proposal`.

## Reliability Gains Eval

Run:

```bash
sh evals/reliability-gains.sh
```

The reliability gains eval scores comparable local run records for the same task,
including a baseline `without-hyperagent` case and a `with-hyperagent` case. It
is deterministic, dependency-free, and writes inspectable output to
`evals/out/reliability-gains/`.

The first rubric scores six dimensions:

- task completion,
- quality of final reports,
- missed verification,
- failure recovery,
- proposal specificity,
- time to useful PR or useful artifact.

See `evals/reliability-rubric.md` for the scoring rubric and
`evals/fixtures/reliability/` for the built-in example cases.

## Init Smoke Eval

Run:

```bash
sh evals/init-smoke.sh
```

The init smoke test creates a temporary repo, runs `sh scripts/hyperagent.sh init --target`, and verifies that setup:

- creates `missions/`, `workshop/proposals/`, `workshop/decisions/`, and `forge/reviews/`,
- creates `.hyperagent` as the machine-readable project anchor for version, install mode, paths, adapters, verification commands, and instruction links,
- validates the generated `.hyperagent` contract,
- fails with an actionable error when a core config field is missing,
- copies templates, rubrics, the local prompt, a blank project backlog, a project capability registry, and `scripts/hyperagent.sh`,
- adds project instructions to `AGENTS.md`,
- documents copy vs symlink behavior in `hyperagent/README.md`,
- refuses conflicting overwrites unless `--force` is passed,
- leaves the target untouched during `--dry-run`.

## Sense Smoke Eval

Run:

```bash
sh evals/sense-smoke.sh
```

The sense smoke test copies the repo to a temporary directory, then verifies that the local helper can:

- record passed and failed command/check evidence in the ignored local evidence log,
- summarize branch, status counts, and changed files,
- report recent commands plus failures and retries,
- produce both Markdown and JSON summaries for mission records,
- include an optional local trace reference,
- enrich the summary from a local Workbench trace fixture by default,
- report Workbench trace health through `doctor`,
- redact secret-like command, note, and trace fragments before storage and output.

## Installer Smoke Eval

Run the installer against a temporary skills directory:

```bash
tmpdir=$(mktemp -d)
sh scripts/install-codex-skill.sh "$tmpdir"
test -f "$tmpdir/codex-hyperagent/SKILL.md"
```

The installed `SKILL.md` should retain the source-of-truth links to the Suit prompt, capability registry, mission template, Workshop proposal template, and Forge review template.

## Manual Smoke Eval

1. Ask Codex to use the `codex-hyperagent` skill for a small real task in this repo.
2. Confirm Codex writes a mission record in `missions/`.
3. Confirm the record includes evidence, verification, friction, and candidate upgrades.
4. Confirm Codex writes at least one proposal in `workshop/proposals/` when friction is present.
5. Confirm the proposal links to the mission record and uses `human review required`.
6. Confirm a human approval or rejection can be recorded in `workshop/decisions/`.
7. Confirm Forge can review recent proposal quality and write a review in `forge/reviews/`.
8. Confirm Forge can generate a process-improvement proposal with `propose-upgrade --forge-review`.
9. Confirm Forge can audit proposal quality and traceability with `sh scripts/hyperagent.sh forge audit`.
