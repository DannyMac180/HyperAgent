# Reliability Eval Case: HyperAgent Suit

- Run ID: hyperagent-suit
- Condition: with-hyperagent
- Scenario: Repair a broken setup command, recover from a failing check, and leave a useful report.
- Task completed: yes
- Verification: run-with-evidence
- Failure recovery: retry-with-resolution
- Proposal specificity: specific
- Time to useful artifact minutes: 24

## Run Notes

The agent used the Mission -> Workshop loop, reproduced the failing setup
command, fixed the documentation, reran the verifier, wrote a mission record,
and proposed a reusable setup-command check for future changes.

## Final Report

Completion evidence: the setup command now matches the verified local helper
usage and the mission record links to the changed documentation.

Verification: `sh scripts/verify-mvp.sh` and `sh evals/smoke-loop.sh` passed
after the retry.

Files changed: `README.md`, `docs/quickstart.md`, and a mission record in
`missions/`.

Unresolved risks: the example did not test non-Codex agent adapters.

Reusable proposal: add a setup-command fixture to the smoke eval, with a local
acceptance check and `human review required` activation.
