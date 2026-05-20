# HyperAgent Evals

Mark I evals are local checks for the Mission -> Workshop loop. They are intentionally small and dependency-free.

Run:

```bash
sh scripts/verify-mvp.sh
```

The verifier checks whether the repo contains the artifacts required by the PRD for the Codex-first prototype.

## Loop Smoke Eval

Run:

```bash
sh evals/smoke-loop.sh
```

The smoke loop copies the repo to a temporary directory, then verifies that the local helper can:

- create a mission record in `missions/`,
- create a proposal linked to that mission in `workshop/proposals/`,
- create a Forge review in `forge/reviews/`,
- record a human-review decision in `workshop/decisions/`,
- append an accepted capability to `hyperagent/capability-registry.md`.

## Init Smoke Eval

Run:

```bash
sh evals/init-smoke.sh
```

The init smoke test creates a temporary repo, runs `sh scripts/hyperagent.sh init --target`, and verifies that setup:

- creates `missions/`, `workshop/proposals/`, `workshop/decisions/`, and `forge/reviews/`,
- creates `.hyperagent` as the machine-readable project anchor for version, install mode, paths, adapters, verification commands, and instruction links,
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
- redact secret-like command and note fragments before storage and output.

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
