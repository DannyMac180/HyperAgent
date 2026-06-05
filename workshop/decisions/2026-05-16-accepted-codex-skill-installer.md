# Upgrade Decision

- Decision ID: decision-2026-05-16-accepted-codex-skill-installer
- Date/time: 2026-05-16
- Proposal: `workshop/proposals/2026-05-01-2108-codex-skill-installer.md`
- Decision: accepted
- Reviewer: repository review via merged PR #1
- Reason: The installer removes first-run ambiguity, keeps writes local, refuses overwrite unless `--force` is provided, and has temp-directory smoke coverage.
- Capability registry ID: codex-skill-installer

## Authority Boundary

- Human approval recorded: yes
- Silent activation allowed: no
- Permission or secrets changes approved: no
- Filesystem authority approved: no new authority; writes remain limited to the explicit local skills target.
- Network or account authority approved: no

## Outcome

- Files or instructions changed: `scripts/install-codex-skill.sh`, `README.md`, `evals/README.md`, `scripts/verify-mvp.sh`
- Verification: `sh scripts/verify-mvp.sh`; temp-directory installer smoke checks
- Registry update: `hyperagent/capability-registry.md`
- Rollback path: remove installed `codex-hyperagent/` from the target skills directory and revert the installer/docs changes.
