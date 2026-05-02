# HyperAgent Evals

Mark I evals are local checks for the Mission -> Workshop loop. They are intentionally small and dependency-free.

Run:

```bash
sh scripts/verify-mvp.sh
```

The verifier checks whether the repo contains the artifacts required by the PRD for the Codex-first prototype.

## Manual Smoke Eval

1. Ask Codex to use the `codex-hyperagent` skill for a small real task in this repo.
2. Confirm Codex writes a mission record in `missions/`.
3. Confirm the record includes evidence, verification, friction, and candidate upgrades.
4. Confirm Codex writes at least one proposal in `workshop/proposals/` when friction is present.
5. Confirm the proposal links to the mission record and uses `human review required`.
