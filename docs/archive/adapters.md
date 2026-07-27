# HyperAgent Adapter Boundary

HyperAgent is Codex-first in the alpha, but the PRD requires durable agency infrastructure rather than brittle Codex-only assumptions.

Adapters define how a host agent environment receives the Suit.

## Adapter Responsibilities

An adapter should define:

- install path or activation mechanism,
- prompt or skill format,
- available tool assumptions,
- local memory location,
- verification commands,
- safety constraints,
- update model,
- limits and unsupported behavior.

## Current Adapter

| Adapter | Status | Files |
| --- | --- | --- |
| Codex Mac app | Alpha core | `skills/codex-hyperagent/`, `scripts/install-codex-skill.sh`, `scripts/update-codex-skill.sh` |

## Deferred Adapters

Claude Code, Cursor, OpenClaw, and other agent hosts are deferred. Do not add platform-specific code until the Codex-first loop is stable and the adapter contract is tested.

## Rule

Core HyperAgent features should be described in adapter-neutral terms first. Adapter-specific convenience belongs in adapter docs or extension files.
