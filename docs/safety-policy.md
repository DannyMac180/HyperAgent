# HyperAgent Safety Policy

Default activation mode: `human review required`.

## Authority Boundary

Agents may:

- complete local tasks within the user's stated scope,
- write mission records,
- draft Workshop proposals,
- draft local low-risk files when asked,
- run local verification commands.

Agents may not silently:

- activate persistent behavior changes,
- broaden filesystem, shell, network, deployment, account, or secrets access,
- alter secrets handling,
- deploy, publish, email, post, or change external systems,
- approve their own upgrades.

## Required Fields For Accepted Capabilities

An accepted capability must have:

- source proposal,
- human decision record,
- activation mode,
- safety risk,
- verification evidence,
- rollback path,
- capability registry entry.

## Activation Modes

Allowed modes remain visible for PRD compatibility:

- `suggest only`,
- `draft files only`,
- `human review required`,
- `auto-install low risk`.

Operational support currently defaults to `human review required`. `auto-install low risk` is not active policy until a future safety verifier and human-approved decision record define it.
