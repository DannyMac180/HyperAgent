# HyperAgent Manual Quickstart

This guide is the manual command path for developers and contributors.

If you only want to try HyperAgent in the Codex Mac app, start with the copy-paste prompt in the root `README.md`. That prompt asks Codex to run the setup for you and to report any manual step it cannot complete.

Use this guide when you want to inspect or run the setup commands yourself. It proves the Mark I loop locally: install the Codex skill, run a mission, write telemetry, propose an upgrade, and record an explicit human decision.

## 1. Initialize A Project

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
- `hyperagent/`
- `scripts/hyperagent.sh`
- a HyperAgent instructions block in `AGENTS.md`

The root `.hyperagent` file is the machine-readable project anchor. It records the HyperAgent version, install mode, initialized paths, enabled adapters, verification commands, and links to project instruction files.

Generated operational files are plain Markdown and shell scripts. Init copies project setup files by default instead of symlinking them, so each repo can inspect, edit, and commit its own local memory. Existing files are left alone when identical, and conflicting files are refused unless `--force` is passed.

Preview changes without writing files:

```bash
sh scripts/hyperagent.sh init --target /path/to/project --dry-run
```

## 2. Install The Codex Skill

```bash
sh scripts/install-codex-skill.sh "$HOME/.codex/skills"
```

For local development:

```bash
sh scripts/install-codex-skill.sh --symlink "$HOME/.codex/skills"
```

The default mode is `human review required`.

`--symlink` is only for the global Codex skill install. Project-local files created by `hyperagent init` are copies by default.

## 3. Check Local Status

```bash
sh scripts/hyperagent.sh status
```

You should see counts for missions, Workshop proposals, Workshop decisions, Forge reviews, and the capability registry path.

## 4. Capture Local Senses

Record commands and checks explicitly when they matter for a mission:

```bash
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

Workbench trace enrichment is a background sensing subsystem. If Workbench is unavailable, unhealthy, or not initialized yet, `sense` reports that state and continues with the lightweight fallback. Use `doctor` for local diagnostics and retention/redaction reminders before adding trace evidence to a mission record.

## 5. Run A Mission In Codex

Ask Codex:

```text
Use the codex-hyperagent skill. Run a small HyperAgent mission in this repo, verify the result, write a mission record, and propose an upgrade only if there is concrete friction.
```

The mission record belongs in `missions/`. The helper prefills repo evidence such as branch, git status, changed files, command evidence, verification status, and closeout placeholders.

You can also create a mission record shell:

```bash
sh scripts/hyperagent.sh new-mission \
  --request "Run a small HyperAgent mission" \
  --slug small-hyperagent-mission \
  --commands-run "sh scripts/verify-mvp.sh" \
  --verification-status "pending"
```

## 6. Run Workshop Review

Ask Codex:

```bash
sh scripts/hyperagent.sh workshop-prompt
```

Then have Codex follow the printed prompt. Proposals belong in `workshop/proposals/`.

To create a proposal shell:

```bash
sh scripts/hyperagent.sh propose-upgrade \
  --mission missions/2026-05-01-2108-mark-i-build.md \
  --title "Improve first-run verification" \
  --problem "The install step needs a concrete smoke test"
```

## 7. Record Human Approval Or Rejection

Persistent behavior changes are not activated silently.

```bash
sh scripts/hyperagent.sh decide-upgrade \
  --proposal workshop/proposals/2026-05-01-2108-codex-skill-installer.md \
  --decision accepted \
  --reviewer "Human reviewer" \
  --reason "The installer reduces first-run ambiguity and has a local smoke test" \
  --capability codex-skill-installer
```

Accepted decisions are recorded in `workshop/decisions/` and appended to `hyperagent/capability-registry.md`.

## 8. Run Forge Review

Ask Codex:

```bash
sh scripts/hyperagent.sh forge-prompt
```

Forge reviews belong in `forge/reviews/`. Run one after proposals are accepted or rejected, after evals change, before release-readiness decisions, or when repeated missions show the Workshop producing vague, unsafe, untested, or low-value proposals.

Each Forge review should include the structured summary block from `templates/forge-review.md`, 0-5 scores with concrete evidence references, deterministic gate results, and payoff counters such as `regressions_caught`, `manual_steps_removed`, and `evals_added`.

You can check a completed review before using it as proposal evidence:

```bash
sh scripts/verify-forge-review.sh forge/reviews/2026-05-16-1216-workshop-quality-review.md
```

For a compact process-health report across proposals, decisions, registry entries, and audit eval coverage:

```bash
sh scripts/hyperagent.sh forge audit
```

The audit identifies weak proposals, proposals missing decisions, accepted capabilities with incomplete traceability, and missing Forge audit eval coverage. It is read-only by default. When the findings are concrete enough to justify a process improvement, draft a normal human-review-required Workshop proposal explicitly:

```bash
sh scripts/hyperagent.sh forge audit --write-proposal
```

The Forge should improve the Workshop process, not silently activate new capabilities. If the review finds a concrete process improvement, create a normal Workshop proposal linked to the Forge review:

```bash
sh scripts/hyperagent.sh propose-upgrade \
  --forge-review forge/reviews/2026-05-16-1216-workshop-quality-review.md \
  --title "Improve Workshop proposal quality" \
  --problem "Recent proposals are too vague to evaluate safely"
```

## 9. Verify

```bash
sh scripts/verify-mvp.sh
sh evals/init-smoke.sh
sh evals/sense-smoke.sh
sh evals/forge-audit-smoke.sh
sh evals/smoke-loop.sh
```

## 10. Update Later

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
