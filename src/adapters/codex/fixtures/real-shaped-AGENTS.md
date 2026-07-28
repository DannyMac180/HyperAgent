# Fixture Project Instructions

This repository is a testbed. In this project, agents should inspect project instructions before changing behavior.

## Default Behavior

At the start of each task, decide whether the full project workflow is relevant.

Use the full workflow when the task:

- changes files, docs, scripts, templates, or product behavior,
- requires investigation across multiple files or commands,
- involves verification, debugging, failing checks, or repeated friction.

For full-workflow tasks:

1. Read the project operating prompt.
2. Complete the task with focused changes.
3. Run the narrowest relevant verification.

<!-- hyperagent:memory:begin -->
<!-- managed by hyperagent — edits here are overwritten -->
- stale fixture memory
<!-- hyperagent:memory:end -->

## Testing Posture

Prefer concrete verification evidence over self-reported completion.

## Documentation Checkpoint

Before handoff, check whether completed changes require documentation updates.

## README Architecture Diagram

When user-visible modules change, review the editable diagram source and rendered asset.
