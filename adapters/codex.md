# Codex Adapter

## Status

Codex is the only shipped HyperAgent adapter in `v0.1.0-alpha`. It targets OpenAI Codex running in the Codex Mac app and keeps HyperAgent local, markdown-first, and human-review-required.

Non-Codex platforms are not implemented by this adapter.

## Install And Update

Codex owns the installed skill surface:

- Source skill: `skills/codex-hyperagent/SKILL.md`
- Optional Codex agent metadata: `skills/codex-hyperagent/agents/openai.yaml`
- Installer: `scripts/install-codex-skill.sh`
- Updater for copy installs: `scripts/update-codex-skill.sh`
- One-command setup path: `scripts/setup-hyperagent.sh`

The default local Codex skills directory is `~/.codex/skills`. The installer supports copy and symlink modes. Project initialization remains opt-in through `scripts/setup-hyperagent.sh --init-target /path/to/project` or `sh scripts/hyperagent.sh init --target /path/to/project`.

Global Codex custom instructions are not edited by the installer.

## Prompt And Skill Surface

Codex enters HyperAgent through the `codex-hyperagent` skill and the operating prompt:

- Skill instructions: `skills/codex-hyperagent/SKILL.md`
- Runtime operating prompt: `hyperagent/operating-prompt.md`
- Project-level instructions: `AGENTS.md`
- Initialized project helper: `scripts/hyperagent.sh`

The skill tells Codex when to run the Mission -> Workshop -> Forge loop, how to write mission records, and when persistent behavior changes require human review.

## Tool Capability Assumptions

The Codex adapter assumes a local workspace with:

- Filesystem read/write access inside the active project and configured writable roots.
- Shell access for local verification commands.
- Git and GitHub CLI access when the user asks for branch, PR, or landing work.
- Optional Linear access through available connector tools or local GraphQL fallback.
- Optional browser, Chrome, or desktop automation only when the task requires it.

The adapter does not assume hosted services, hidden databases, autonomous deployments, or unrestricted network/account authority.

## Memory And Artifacts

Codex-owned and HyperAgent-owned artifacts are intentionally separate:

- Cross-project Codex memory may live outside the repo, such as Dan's Obsidian Codex vault.
- Project truth lives in repo markdown and scripts.
- Mission records live in `missions/`.
- Workshop proposals live in `workshop/proposals/`.
- Human decisions live in `workshop/decisions/`.
- Forge reviews live in `forge/reviews/`.
- Local runtime evidence, when opted in, lives under `.hyperagent-evidence/` and is ignored by git.

The adapter should summarize durable project state into markdown artifacts rather than depending on transcript history.

## Verification

The Codex adapter is healthy when these checks pass:

```bash
sh scripts/hyperagent.sh verify-config
sh scripts/verify-mvp.sh
sh evals/smoke-loop.sh
```

`verify-mvp` must require this file, the generic adapter contract, `.hyperagent`, the Codex skill, the installer, the operating prompt, and the safety defaults.

## Safety And Authority

Default activation mode remains `human review required`.

Codex may propose upgrades and draft local low-risk files when asked. It may not silently activate upgrades that increase permissions, alter secrets handling, change deployment behavior, broaden filesystem access, use new network/account access, or persist new operating rules.

The adapter must not store secrets or credentials in mission records, memory, adapter docs, or local evidence logs.

## Status Reporting

Codex reports completion through:

- Final user-facing summaries.
- Mission records for substantial HyperAgent work.
- Linear comments and direct PR attachments when issue workflow requires them.
- Pull request descriptions and review comments when GitHub workflow requires them.
- Local command evidence captured by `sh scripts/hyperagent.sh check -- ...` when useful.

Issue handoffs should include what changed, commits, validation, remaining risks, and the PR URL.

## UI And Sensing

The Codex adapter can use local sensing helpers:

- `sh scripts/hyperagent.sh status`
- `sh scripts/hyperagent.sh sense --pr off`
- `sh scripts/hyperagent.sh doctor`

Workbench/Raindrop trace sensing is local and optional through `.hyperagent-evidence/workbench/traces.jsonl` or `HYPERAGENT_WORKBENCH_TRACE_LOG`. It must remain redacted and local-first.

The adapter does not provide a hosted dashboard or product UI.

## Future Adapter Work

A future Claude Code, Cursor, OpenClaw, or other adapter should start from `adapters/contract.md`, document the platform-specific boundary, and ship in its own reviewed issue. It should not change the meaning of `[adapters] codex = true`.
