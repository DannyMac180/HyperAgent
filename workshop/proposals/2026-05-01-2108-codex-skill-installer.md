# Upgrade Proposal

- Upgrade title: Add a Codex skill installer command
- Proposal ID: proposal-2026-05-01-2108-codex-skill-installer
- Date/time: 2026-05-01 21:08 EDT
- Related mission record: `missions/2026-05-01-2108-mark-i-build.md`
- Evidence source type: mission
- Proposed activation mode: human review required
- Allowed activation modes: suggest only; draft files only; human review required; auto-install low risk

## Problem

- Problem observed: The Mark I quick start requires users to manually copy or symlink `skills/codex-hyperagent/` into their Codex skills directory.
- Evidence from mission records: `missions/2026-05-01-2108-mark-i-build.md` lists manual skill installation as the remaining unresolved risk.
- Why the current Suit was insufficient: HyperAgent provides the skill content and operating loop, but does not yet provide an ergonomic or verifiable install path for the first-run Codex experience.

## Proposed Capability

- Type of upgrade: Script and documentation.
- Proposed capability: Add a dependency-free installer that accepts a destination skills directory, validates `skills/codex-hyperagent/SKILL.md`, copies or symlinks the skill, and prints a verification summary.
- Expected impact: Reduces first-run ambiguity and makes the install step easier to verify without introducing a hosted service or new runtime dependency.

## Implementation Plan

- Highest-priority plan step: Add `scripts/install-codex-skill.sh` with an explicit destination argument and dry-run friendly output.
- Implementation steps: Document the command in README; make the script refuse to overwrite an existing skill unless an explicit flag is provided; add checks to `scripts/verify-mvp.sh` for the installer docs.
- Files or instructions likely to change: `scripts/install-codex-skill.sh`, `README.md`, `evals/README.md`, `scripts/verify-mvp.sh`.
- Verification for the first step: Run the installer against a temporary directory and confirm it creates `codex-hyperagent/SKILL.md` with the expected source-of-truth links.

## Safety

- Safety risk: Low. The script writes local skill files only to a user-provided directory.
- Permission or authority changes: None by default. It should not broaden filesystem, shell, network, account, deployment, or secrets access.
- Filesystem impact: Writes only to the user-provided local skills directory.
- Network or account impact: None.
- Secrets handling impact: None.
- Human approval required before activation: yes

## Evaluation

- Eval or acceptance test: `tmpdir=$(mktemp -d); sh scripts/install-codex-skill.sh "$tmpdir"; test -f "$tmpdir/codex-hyperagent/SKILL.md"`.
- Rollback plan: Remove the installed `codex-hyperagent/` directory from the target skills directory.
- Open questions: Should the default behavior copy files or create a symlink for easier local development?
