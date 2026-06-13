# HyperAgent Manual Quickstart

This guide is the manual command path for developers and contributors.

If you only want to try HyperAgent in the Codex Mac app, start with the copy-paste prompt in the root `README.md`. That prompt asks Codex to run the setup for you and to report any manual step it cannot complete.

Use this guide when you want to inspect or run the setup commands yourself. It proves the Mark I loop locally: install the Codex skill, run a mission, write telemetry, propose an upgrade, and record an explicit human decision.

HyperAgent is markdown-first. If your checkout includes `hyperagent ui`, use it as an optional local cockpit for inspecting the same mission records, Workshop artifacts, Forge reviews, capabilities, and local evidence described below. The cockpit is not a hosted service, does not use a hidden database, and must not silently activate upgrades. See `docs/ui-architecture.md` for the boundary.

## 1. One-Command HyperAgent Setup

From a machine that has `git` and `sh`, run:

```bash
/bin/sh -c 'set -eu; dest="${HYPERAGENT_HOME:-$HOME/HyperAgent}"; if [ -d "$dest/.git" ]; then git -C "$dest" pull --ff-only; else test ! -e "$dest" || { echo "Refusing to replace non-repo path: $dest" >&2; exit 1; }; git clone https://github.com/DannyMac180/HyperAgent "$dest"; fi; sh "$dest/scripts/setup-hyperagent.sh" --install-dir "$dest"'
```

The setup command:

- verifies `git` and `sh`,
- uses `~/HyperAgent` by default,
- clones or fast-forward updates the HyperAgent repo,
- runs `sh scripts/verify-mvp.sh` plus smoke evals unless `--skip-smoke` is passed,
- installs or updates `codex-hyperagent` in `~/.codex/skills`,
- reports what changed and what passed,
- leaves global Codex custom instructions untouched.

To ask before initializing a project repo in the same run:

```bash
sh "$HOME/HyperAgent/scripts/setup-hyperagent.sh" --init-target /path/to/project
```

The init step is opt-in and waits for a `y` confirmation before writing project-local files. Existing project files keep the normal HyperAgent overwrite refusal unless you also pass `--force-init`.

You can also run the setup path through the wrapper after cloning:

```bash
bin/hyperagent setup-hyperagent
```

Restart Codex Desktop or open a fresh thread after setup if the installed skill does not appear immediately.

## 2. Initialize A Project

From the HyperAgent repo:

```bash
sh scripts/hyperagent.sh init --target /path/to/project
```

The repo also includes a wrapper:

```bash
bin/hyperagent init --target /path/to/project
```

Add `bin/` to your `PATH` if you want to run it as plain `hyperagent init`.

The init command creates or updates:

- `.hyperagent`
- `missions/`
- `workshop/proposals/`
- `workshop/decisions/`
- `workshop/backlog.md`
- `forge/reviews/`
- `templates/`
- `hyperagent/README.md`
- `hyperagent/capability-registry.md`
- `scripts/hyperagent.sh` as a project shim
- a HyperAgent instructions block in `AGENTS.md`

The root `.hyperagent` file is the machine-readable project anchor. It records the HyperAgent version, install mode, initialized paths, enabled adapters, verification commands, and links to project instruction files.

The schema and supported TOML subset are documented in `docs/config.md`. Validate the project contract with:

```bash
sh scripts/hyperagent.sh verify-config
```

Generated operational files are plain Markdown and shell scripts. Init separates project-local artifacts from global runtime files so each repo can inspect, edit, and commit its own local memory without receiving unnecessary runtime churn.

Init output categories:

- Project-local artifacts: mission records, Workshop proposals and decisions, Forge reviews, `AGENTS.md`, blank `workshop/backlog.md`, and blank `hyperagent/capability-registry.md`.
- Copied templates and rubrics: `templates/`, `workshop/rubric.md`, and `forge/process/quality-rubric.md`.
- Generated config and docs: `.hyperagent`, `hyperagent/README.md`, and the HyperAgent block in `AGENTS.md`.
- Global runtime dependency: `scripts/hyperagent.sh` is a small project shim that delegates to the installed HyperAgent runtime. The runtime helper and operating prompt are not copied into initialized repos by default.

Existing files are left alone when identical, and conflicting files are refused unless `--force` is passed.

Preview changes without writing files:

```bash
sh scripts/hyperagent.sh init --target /path/to/project --dry-run
```

After updating your HyperAgent install, migrate an already initialized project:

```bash
sh scripts/hyperagent.sh init --target /path/to/project --update
```

Update mode replaces older copied runtime helpers with the project shim and removes an unchanged copied runtime prompt. Locally changed files are refused unless `--force` is passed.

## 3. Install The Codex Skill

```bash
sh scripts/install-codex-skill.sh "$HOME/.codex/skills"
```

For local development:

```bash
sh scripts/install-codex-skill.sh --symlink "$HOME/.codex/skills"
```

The default mode is `human review required`.

`--symlink` is only for the global Codex skill install. Project-local files created by `hyperagent init` remain normal files, while the generated project shim delegates to the global runtime.

## 4. Use The Four Primary Flows

HyperAgent's public command model is intentionally small:

- `init`: initialize or update a repo.
- `sense`: understand current state, recent checks, changed files, PR status, and local trace health.
- `mission`: start or close out mission records.
- `review`: create Workshop proposals, run Forge reviews, record decisions, and inspect backlog movement.

`ui` remains an optional local cockpit helper when available; in this alpha it prints local cockpit pointers and stays subordinate to the markdown source of truth.

Advanced helpers remain available as compatibility aliases for at least one release. For example, `status`, `doctor`, `new-mission`, `mission-closeout`, `propose-upgrade`, `workshop-prompt`, `new-forge-review`, `forge-prompt`, `ui`, and `decide-upgrade` still work while the docs move users toward complete flows.

## 5. Sense Current State

```bash
sh scripts/hyperagent.sh sense
sh scripts/hyperagent.sh sense --doctor
```

You should see the current branch, upstream, HEAD, git status counts, changed files, recent command evidence, and optional PR/trace context.

`status` remains a compatibility diagnostics alias:

```bash
sh scripts/hyperagent.sh status
```

## 6. Capture Local Senses

Record commands and checks explicitly when they matter for a mission:

```bash
sh scripts/hyperagent.sh check -- sh scripts/verify-mvp.sh
sh scripts/hyperagent.sh record-check --status passed --command "sh scripts/verify-mvp.sh"
sh scripts/hyperagent.sh record-check --status failed --command "sh evals/smoke-loop.sh" --note "example failure note"
```

Then generate a compact mission-ready summary:

```bash
sh scripts/hyperagent.sh sense
sh scripts/hyperagent.sh sense --format json --pr off
sh scripts/hyperagent.sh doctor
```

The sensing layer summarizes the current branch, upstream, HEAD, git status counts, changed files, recent opt-in commands/checks, failures and retries, optional PR/CI status when `gh` can find a pull request, and an optional trace link passed with `--trace-url`. By default, it also checks `.hyperagent-evidence/workbench/traces.jsonl` or `HYPERAGENT_WORKBENCH_TRACE_LOG` for local Workbench/Raindrop trace entries. It is local-first and does not require hosted services. It does not inspect file contents, environment variables, shell history, credentials, or secrets, and it redacts secret-like command and trace fragments before output.

Workbench trace enrichment is a background sensing subsystem. If Workbench is unavailable, unhealthy, or not initialized yet, `sense` reports that state and continues with the lightweight fallback. Use `sense --doctor` for local diagnostics and retention/redaction reminders before adding trace evidence to a mission record. `doctor` remains as a compatibility alias.

## 7. Run A Mission In Codex

Ask Codex:

```text
Use the codex-hyperagent skill. Run a small HyperAgent mission in this repo, verify the result, write a mission record, and propose an upgrade only if there is concrete friction.
```

The mission record belongs in `missions/`. The helper prefills repo evidence such as branch, git status, changed files, command evidence, verification status, and closeout placeholders.

For end-of-task telemetry, prefer one closeout command after recording checks:

```bash
sh scripts/hyperagent.sh mission-closeout \
  --request "Run a small HyperAgent mission" \
  --slug small-hyperagent-mission \
  --outcome "Mission completed and verification passed" \
  --risks "No unresolved risks"
sh scripts/hyperagent.sh verify-mission --strict missions/MISSION.md
```

Closeout auto-fills the current sense snapshot, recent command/check evidence, changed files, verification status, unresolved-risk prompt, and candidate upgrade field so the record is suitable for Workshop evidence without copy/paste cleanup.
Pass `--mission missions/DRAFT.md` to replace a draft record with the closeout evidence instead of creating a new file.

The grouped command is the preferred user-facing form:

```bash
sh scripts/hyperagent.sh mission closeout \
  --request "Run a small HyperAgent mission" \
  --slug small-hyperagent-mission \
  --outcome "Mission completed and verification passed" \
  --risks "No unresolved risks"
sh scripts/hyperagent.sh mission verify --strict missions/MISSION.md
```

You can also create a mission record shell:

```bash
sh scripts/hyperagent.sh mission new \
  --request "Run a small HyperAgent mission" \
  --slug small-hyperagent-mission \
  --commands-run "sh scripts/verify-mvp.sh" \
  --verification-status "pending"
```

`new-mission`, `mission-closeout`, and `verify-mission` remain compatibility aliases.

## 8. Run Review Flows

`new-mission` remains useful for drafts, but strict verification intentionally fails its placeholder closeout fields until they are replaced.

Ask Codex:

```bash
sh scripts/hyperagent.sh workshop-prompt
```

Then have Codex follow the printed prompt. Proposals belong in `workshop/proposals/`.

After several missions, run a digest before writing another standalone proposal:

```bash
sh scripts/hyperagent.sh review digest --limit 12
```

The digest scans recent mission records for friction evidence that lacks proposal handoff, lists stale proposals without decisions, surfaces weak proposal evidence that may deserve Forge review, and recommends one next backlog action. To draft a proposal from the highest-value missing handoff without accepting anything:

```bash
sh scripts/hyperagent.sh review digest --limit 12 --draft-proposal
```

Drafted digest proposals remain `human review required` and do not create decision records.

To create a proposal shell:

```bash
sh scripts/hyperagent.sh review workshop \
  --mission missions/2026-05-01-2108-mark-i-build.md \
  --title "Improve first-run verification" \
  --problem "The install step needs a concrete smoke test"
```

`workshop-prompt`, `propose-upgrade`, `workshop-digest`, and `review-digest` remain compatibility aliases:

```bash
sh scripts/hyperagent.sh workshop-digest --limit 12
```

## 9. Record Human Approval Or Rejection

Persistent behavior changes are not activated silently.

```bash
sh scripts/hyperagent.sh review decide \
  --proposal workshop/proposals/2026-05-01-2108-codex-skill-installer.md \
  --decision accepted \
  --reviewer "Human reviewer" \
  --reason "The installer reduces first-run ambiguity and has a local smoke test" \
  --capability codex-skill-installer
```

Accepted decisions are recorded in `workshop/decisions/` and appended to `hyperagent/capability-registry.md`.

`decide-upgrade` remains a compatibility alias:

```bash
sh scripts/hyperagent.sh decide-upgrade \
  --proposal workshop/proposals/2026-05-01-2108-codex-skill-installer.md \
  --decision accepted \
  --reviewer "Human reviewer" \
  --reason "The installer reduces first-run ambiguity and has a local smoke test" \
  --capability codex-skill-installer
```

## 10. Run Forge Review

Ask Codex:

```bash
sh scripts/hyperagent.sh review forge new --slug workshop-quality-review
```

Forge reviews belong in `forge/reviews/`. Run one after proposals are accepted or rejected, after evals change, before release-readiness decisions, or when repeated missions show the Workshop producing vague, unsafe, untested, or low-value proposals.

Each Forge review should include the structured summary block from `templates/forge-review.md`, 0-5 scores with concrete evidence references, deterministic gate results, and payoff counters such as `regressions_caught`, `manual_steps_removed`, and `evals_added`.

You can check a completed review before using it as proposal evidence:

```bash
sh scripts/verify-forge-review.sh forge/reviews/2026-05-16-1216-workshop-quality-review.md
```

For a compact process-health report across proposals, decisions, registry entries, and audit eval coverage:

```bash
sh scripts/hyperagent.sh review forge audit
```

The audit identifies weak proposals, proposals missing decisions, accepted capabilities with incomplete traceability, and missing Forge audit eval coverage. It is read-only by default. When the findings are concrete enough to justify a process improvement, draft a normal human-review-required Workshop proposal explicitly:

```bash
sh scripts/hyperagent.sh review forge audit --write-proposal
```

The Forge should improve the Workshop process, not silently activate new capabilities. If the review finds a concrete process improvement, create a normal Workshop proposal linked to the Forge review:

```bash
sh scripts/hyperagent.sh review workshop \
  --forge-review forge/reviews/2026-05-16-1216-workshop-quality-review.md \
  --title "Improve Workshop proposal quality" \
  --problem "Recent proposals are too vague to evaluate safely"
```

`forge-prompt`, `new-forge-review`, `forge audit`, and `forge-audit` remain compatibility aliases:

```bash
sh scripts/hyperagent.sh forge audit
```

## 11. Verify

```bash
sh scripts/hyperagent.sh verify-config
sh scripts/verify-mvp.sh
sh evals/setup-hyperagent-smoke.sh
sh evals/init-smoke.sh
sh evals/sense-smoke.sh
sh evals/forge-audit-smoke.sh
sh evals/smoke-loop.sh
```

## 12. Update Later

For copy installs:

```bash
git pull
sh scripts/update-codex-skill.sh
sh scripts/verify-mvp.sh
```

For symlink installs:

```bash
git pull
sh scripts/verify-mvp.sh
```

Restart Codex Desktop or open a fresh thread after updating the installed skill.
