# HyperAgent Quickstart

This guide proves the Mark I loop locally: install the Codex skill, run a mission, write telemetry, propose an upgrade, and record an explicit human decision.

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

## 4. Run A Mission In Codex

Ask Codex:

```text
Use the codex-hyperagent skill. Run a small HyperAgent mission in this repo, verify the result, write a mission record, and propose an upgrade only if there is concrete friction.
```

The mission record belongs in `missions/`.

You can also create a mission record shell:

```bash
sh scripts/hyperagent.sh new-mission --request "Run a small HyperAgent mission" --slug small-hyperagent-mission
```

## 5. Run Workshop Review

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

## 6. Record Human Approval Or Rejection

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

## 7. Run Forge Review

Ask Codex:

```bash
sh scripts/hyperagent.sh forge-prompt
```

Forge reviews belong in `forge/reviews/`. The Forge should improve the Workshop process, not silently activate new capabilities.

## 8. Verify

```bash
sh scripts/verify-mvp.sh
sh evals/init-smoke.sh
sh evals/smoke-loop.sh
```

## 9. Update Later

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
