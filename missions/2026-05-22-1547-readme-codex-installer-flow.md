# Mission Record

- Mission ID: 2026-05-22-1547-readme-codex-installer-flow
- Date/time: 2026-05-22 15:47 EDT
- Agent identity: Codex with HyperAgent Suit
- Environment: `/Users/danielmcateer/Desktop/dev/HyperAgent`
- User request: Rewrite the README around a simple Codex Mac copy-paste installer flow, move detailed commands into developer docs, and add a clean-install UAT checklist.

## Repository Evidence

- Repo path: `/Users/danielmcateer/Desktop/dev/HyperAgent`
- Branch: `danmacideas/dan-175-improve-mission-record-generation-with-prefilled-evidence`
- Git status:

~~~text
modified=3 added=0 deleted=0 renamed=0 untracked=8
~~~

- Changed files:

~~~text
README.md
docs/quickstart.md
scripts/verify-mvp.sh
docs/clean-install-uat.md
missions/2026-05-22-1547-readme-codex-installer-flow.md
~~~

## Execution Evidence

- Commands run:
  - `sed -n '1,220p' /Users/danielmcateer/.codex/skills/codex-hyperagent/SKILL.md`
  - `sed -n '1,220p' /Users/danielmcateer/Documents/Obsidian/Ideaverse/Codex/AGENTS.md`
  - `rg -n "HyperAgent|README|quickstart|clean install|onboarding" /Users/danielmcateer/.codex/memories/MEMORY.md`
  - `sed -n '1,260p' hyperagent/operating-prompt.md`
  - `sed -n '1,260p' README.md`
  - `sed -n '1,260p' docs/quickstart.md`
  - `sed -n '1,240p' scripts/install-codex-skill.sh`
  - `sed -n '1,220p' scripts/update-codex-skill.sh`
  - `sed -n '1,280p' scripts/hyperagent.sh`
  - `sh scripts/verify-mvp.sh` (failed before verifier update because README no longer carried the manual init command)
  - `sh scripts/verify-mvp.sh`
  - `sh evals/smoke-loop.sh`
  - `sh evals/init-smoke.sh`
  - `sh evals/sense-smoke.sh`
  - `sh scripts/hyperagent.sh status`
  - `sh scripts/hyperagent.sh sense --pr off`
- Verification status: passed after updating the verifier for the new README/manual-doc split.

## Outcome

- Final outcome: The public README now presents a simple Codex Mac copy-paste setup prompt, the command-heavy setup path is framed as a manual developer quickstart, and a clean-install UAT checklist exists for repeatable acceptance testing.
- Completion evidence: `sh scripts/verify-mvp.sh`, `sh evals/smoke-loop.sh`, `sh evals/init-smoke.sh`, and `sh evals/sense-smoke.sh` all passed.
- Unresolved risks: The clean-install UAT is documented but has not yet been performed in a fresh Codex Desktop session.

## Actions

- Agent plan: Simplify the README front door, preserve detailed commands in developer docs, add a clean-install UAT checklist, update verification, and record mission telemetry.
- Summary of actions taken:
  - Replaced the README's long Quick Start command list with a `Try HyperAgent In Codex Mac` prompt.
  - Set `~/HyperAgent` as the default clone path and removed the earlier `~/Developer/HyperAgent` assumption.
  - Added safety language telling Codex not to edit global custom instructions and to wait if a manual custom-instructions step is required.
  - Reframed `docs/quickstart.md` as the manual command path for developers and contributors.
  - Added `docs/clean-install-uat.md` with setup, test flow, acceptance criteria, failure notes, and cleanup.
  - Updated `scripts/verify-mvp.sh` so the artifact contract checks the new README prompt and the moved manual command path.
- Tools used: shell, `rg`, `sed`, `git diff`, `apply_patch`, HyperAgent helper scripts.
- Files or systems changed:
  - `README.md`
  - `docs/quickstart.md`
  - `docs/clean-install-uat.md`
  - `scripts/verify-mvp.sh`
  - `missions/2026-05-22-1547-readme-codex-installer-flow.md`
- Verification performed:
  - `sh scripts/verify-mvp.sh`
  - `sh evals/smoke-loop.sh`
  - `sh evals/init-smoke.sh`
  - `sh evals/sense-smoke.sh`

## Friction

- Failures, retries, and blockers: The first verifier run failed because `scripts/verify-mvp.sh` still required the manual `hyperagent init` command to appear in `README.md`. That expectation conflicted with the new product decision to keep the README as the simple Codex prompt surface.
- User corrections: The user clarified that `~/Developer/HyperAgent` should not be assumed because `~/Developer` is not a standard macOS directory.
- Suit friction observed: Artifact verification can overfit to a specific README structure instead of the current public onboarding contract.
- Candidate upgrades: No separate Workshop proposal created; the verifier drift was corrected in this mission by checking the README prompt, the manual quickstart, and the UAT doc explicitly.

## Workshop Handoff

- Upgrade proposal paths: None.
- Follow-up owner: Human developer should run `docs/clean-install-uat.md` from a fresh Codex Mac session before treating the onboarding flow as release-ready.
