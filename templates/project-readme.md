# HyperAgent Project Setup

This repository has local HyperAgent memory and workflow files.

The root `.hyperagent` file is the machine-readable project anchor. Agents and adapters can read it to find the HyperAgent version, install mode, initialized paths, enabled adapters, verification commands, and instruction files.

Use these files to keep agent work inspectable:

- `missions/`: mission records from meaningful tasks.
- `workshop/proposals/`: proposed improvements backed by mission evidence.
- `workshop/decisions/`: explicit human approvals or rejections.
- `forge/reviews/`: reviews of Workshop proposal quality.
- `templates/`: markdown templates for records, proposals, decisions, and Forge reviews.
- `hyperagent/operating-prompt.md`: local Suit prompt.
- `hyperagent/capability-registry.md`: accepted local capabilities.

## Local Commands

```bash
hyperagent status
hyperagent sense
hyperagent check -- sh scripts/verify-mvp.sh
hyperagent sense --doctor
hyperagent mission new --request "Describe the task" --slug task-slug
hyperagent review prompt workshop
hyperagent review prompt forge
```

## Verification

For this project, the lightweight check is:

```bash
hyperagent status
```

Use `check --` to run and record verification in one step, then `sense` to summarize local evidence for mission closeout.

The sensing summary reads Git metadata, the opt-in local command log, and local Workbench trace metadata when the default ignored trace log exists. It does not inspect repository file contents or environment values, and command text is redacted for secret-like tokens before storage and output.

Add any project-specific build, test, lint, or smoke commands to `AGENTS.md` so future agents know the strongest relevant verification path.

## Copy And Symlink Behavior

`hyperagent init` copies markdown templates, prompt files, and local memory scaffolding into the target repository. It does not copy the optional UI or full HyperAgent runtime by default, because local project memory should remain portable, reviewable, and safe to edit.

If you installed the global Codex skill with `scripts/install-codex-skill.sh --symlink`, only the Codex skill install is symlinked. Project-local files created by `hyperagent init` are still normal files. Use the source HyperAgent repo or installed wrapper for runtime commands that are not copied into a project.

Existing files are left alone when they are identical. Conflicting generated files are not overwritten unless `--force` is passed.
