# Optional Local UI Architecture

HyperAgent's product state lives in local, inspectable files. The optional `hyperagent ui` cockpit is a convenience layer over those files, not a replacement for them.

## Source Of Truth

Markdown and local evidence remain canonical:

- Mission records: `missions/`.
- Workshop proposals and decisions: `workshop/`.
- Forge reviews: `forge/reviews/`.
- Accepted capabilities: `hyperagent/capability-registry.md`.
- Project config and evidence settings: `.hyperagent` and `.hyperagent-evidence/`.

Deleting or disabling the local cockpit must not delete product state. A reviewer should be able to inspect the repo, mission records, proposals, decisions, Forge reviews, and command evidence without opening the UI.

## Local-Only Boundary

The cockpit is local-only. It must not introduce:

- a hosted service,
- a hidden database,
- background synchronization,
- silent activation of Suit upgrades,
- new secrets handling,
- autonomous self-modification.

Any future change that broadens filesystem, shell, network, deployment, account, persistent behavior, or secrets authority must be documented explicitly and require human approval before activation.

## Read-Mostly Behavior

The safe default is read-only inspection:

- Browse missions, proposals, decisions, Forge reviews, capability status, sensing summaries, and local check evidence.
- Make source paths visible so users can jump back to the markdown artifact.
- Treat missing or malformed files as visible local-state problems, not as reasons to create hidden replacement state.
- Keep visual regression or screenshot checks optional until the cockpit becomes a primary product surface.

## Explicit Local Commands

Write actions should stay narrow and obvious. A UI control may run an existing local command only when the user intentionally invokes it and the command's effect is visible in local files or command evidence.

Examples of acceptable explicit actions:

- Run a configured local verification command.
- Refresh a local sensing summary.
- Create a draft mission, Workshop proposal, Forge review, or decision through the same file-based helpers used by the CLI.

Examples of actions that require stronger review before shipping:

- Auto-accepting a Workshop proposal.
- Silently editing the capability registry.
- Starting a hosted service.
- Persisting secrets or credentials.
- Writing product state outside the configured local HyperAgent paths.

When in doubt, prefer a visible command preview and require human confirmation.
