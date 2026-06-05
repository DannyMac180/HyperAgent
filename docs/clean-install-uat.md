# HyperAgent Clean-Install UAT

Use this checklist to test the public README flow the way a first-time Codex Mac user would experience it.

The goal is to verify that the README prompt can take a machine from no local HyperAgent install to a working Codex skill and optional project initialization, without requiring the user to understand the internal command sequence first.

## What This Test Covers

- The GitHub README is the entry point.
- The copy-paste Codex prompt is enough to start setup.
- HyperAgent installs into a predictable default path: `~/HyperAgent`.
- The Codex skill is installed or updated locally.
- Project initialization happens only after explicit user confirmation.
- Codex clearly reports any manual step it cannot perform.
- Global Codex custom instructions are not changed by the installer prompt.

## Before You Start

Use a fresh scratch project so the test is safe and repeatable.

```bash
mkdir -p "$HOME/hyperagent-uat-target"
cd "$HOME/hyperagent-uat-target"
git init
printf '# HyperAgent UAT Target\n' > README.md
git add README.md
git commit -m "Initial UAT target"
```

If you already have a local HyperAgent skill installed, move it aside instead of deleting it:

```bash
if [ -e "$HOME/.codex/skills/codex-hyperagent" ] || [ -L "$HOME/.codex/skills/codex-hyperagent" ]; then
  mv "$HOME/.codex/skills/codex-hyperagent" "$HOME/.codex/skills/codex-hyperagent.backup.$(date +%Y%m%d%H%M%S)"
fi
```

If `~/HyperAgent` already exists and you want a fully clean repo clone, move it aside too:

```bash
if [ -e "$HOME/HyperAgent" ]; then
  mv "$HOME/HyperAgent" "$HOME/HyperAgent.backup.$(date +%Y%m%d%H%M%S)"
fi
```

## Test Flow

1. Open the Codex Mac app in the scratch target project.
2. Open the HyperAgent GitHub README.
3. Copy the prompt from the `Try HyperAgent In Codex Mac` section.
4. Paste the prompt into Codex.
5. Let Codex run the setup.
6. When Codex asks whether to initialize HyperAgent in the scratch project, confirm.
7. Start a fresh Codex thread or restart Codex Desktop if Codex says the installed skill needs a refresh.
8. Ask Codex to use the `codex-hyperagent` skill on a small task in the scratch project.

## Acceptance Criteria

The test passes when all of these are true:

- `~/HyperAgent` exists and is a clone of the HyperAgent repo.
- HyperAgent local verification passes, including `sh scripts/verify-mvp.sh`.
- `~/.codex/skills/codex-hyperagent/SKILL.md` exists.
- The scratch project contains `.hyperagent`, `AGENTS.md`, `missions/`, `workshop/`, `forge/`, `templates/`, and `hyperagent/` after confirmed init.
- The scratch project does not require copied `scripts/hyperagent.sh` or copied `ui/` assets for the core setup to be valid.
- Codex reports whether a restart or fresh thread is needed.
- Codex reports the files it changed.
- Codex does not edit global Codex custom instructions during the happy path.
- If Codex believes custom instructions are required, it gives the exact manual text and waits.

## Failure Notes

Record any failure with:

- what the user pasted,
- what Codex attempted,
- the exact command or step that failed,
- whether the failure required a manual step,
- whether the README prompt should be clearer,
- whether the installer or init script should become more autonomous.

## Cleanup

The scratch target can be deleted after testing:

```bash
rm -rf "$HOME/hyperagent-uat-target"
```

Restore any backed-up local skill or repo only after confirming which copy you want to keep.
