# Mission Record

- Mission ID: mission-2026-05-24-0652-dan-192-setup-hyperagent-rework
- Date/time: 2026-05-24 06:52 America/New_York
- Agent identity: Codex wearing the HyperAgent Suit
- Environment: macOS, zsh, workspace `/Users/danielmcateer/code/symphony-workspaces/DAN-192`
- User request: Rework DAN-192 after Linear feedback so the documented command is a one-liner and the shell script is named `setup-hyperagent` rather than `setup-codex`.

## Repository Evidence

- Repo path: `/Users/danielmcateer/code/symphony-workspaces/DAN-192`
- Branch: `danmacideas/dan-192-setup-codex-command`
- Git status:

~~~text
 M README.md
 M docs/quickstart.md
 M evals/README.md
RM evals/setup-codex-smoke.sh -> evals/setup-hyperagent-smoke.sh
 M scripts/hyperagent.sh
RM scripts/setup-codex.sh -> scripts/setup-hyperagent.sh
 M scripts/verify-mvp.sh
?? missions/2026-05-24-0652-dan-192-setup-hyperagent-rework.md
~~~

- Changed files:

~~~text
README.md
docs/quickstart.md
evals/README.md
evals/setup-hyperagent-smoke.sh
missions/2026-05-24-0652-dan-192-setup-hyperagent-rework.md
scripts/hyperagent.sh
scripts/setup-hyperagent.sh
scripts/verify-mvp.sh
~~~

## Execution Evidence

- Commands run: `sh -n scripts/verify-mvp.sh && sh -n scripts/setup-hyperagent.sh && sh -n evals/setup-hyperagent-smoke.sh && sh -n scripts/hyperagent.sh`; `sh evals/setup-hyperagent-smoke.sh`; `sh scripts/verify-mvp.sh`; `sh evals/smoke-loop.sh`; `sh -n scripts/setup-hyperagent.sh && sh -n evals/setup-hyperagent-smoke.sh && sh -n scripts/hyperagent.sh && git diff --check`.
- Verification status: Passed.

## Outcome

- Final outcome: Reworked the setup surface so the public Terminal command is a single line and the repo-local setup script/wrapper/eval names use `setup-hyperagent`.
- Completion evidence: README and quickstart now show a one-line `/bin/sh -c ... setup-hyperagent.sh ...` command; `scripts/setup-hyperagent.sh`, `bin/hyperagent setup-hyperagent`, and `evals/setup-hyperagent-smoke.sh` are verified by the smoke eval and MVP gate.
- Unresolved risks: Existing users of the previous `setup-codex` wrapper name will need the updated docs or branch; no compatibility alias was retained because the reviewer explicitly asked for the script surface to be `setup-hyperagent`.

## Actions

- Agent plan: Rename the setup script and wrapper command, simplify docs to a one-line public command, update verification pins and smoke eval names, then validate locally.
- Summary of actions taken: Renamed `scripts/setup-codex.sh` to `scripts/setup-hyperagent.sh`; renamed `evals/setup-codex-smoke.sh` to `evals/setup-hyperagent-smoke.sh`; updated `scripts/hyperagent.sh` to expose `setup-hyperagent`; updated README, quickstart, eval docs, and MVP verifier expectations; recorded this mission evidence.
- Tools used: Shell, ripgrep, git, apply_patch.
- Files or systems changed: Local repository files only.
- Verification performed: Shell syntax checks, setup smoke eval, MVP artifact verification, Mission -> Workshop smoke loop, whitespace check.

## Friction

- Failures, retries, and blockers: No implementation blocker. One historical mission file was briefly touched by bulk rename and then restored before this record was written.
- User corrections: Linear feedback requested a one-line command and `setup-hyperagent` script naming instead of `setup-codex`.
- Suit friction observed: Bulk rename can accidentally rewrite historical mission evidence; mission/history files should be excluded by default during product-surface renames.
- Candidate upgrades: Created a small scoped-rename checklist proposal so future broad renames exclude historical evidence unless explicitly requested.

## Workshop Handoff

- Upgrade proposal paths: `workshop/proposals/2026-05-24-0652-scoped-rename-safety.md`
- Follow-up owner: Human reviewer for DAN-192 / PR #16.
