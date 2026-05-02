# HyperAgent Concepts

HyperAgent uses three product layers and one telemetry layer.

## Suit

The Suit is the installed operating layer an agent wears while doing work. It gives the agent a concise doctrine, local conventions, safety defaults, evidence expectations, and platform-specific instructions.

For Mark I, the Suit is:

- `skills/codex-hyperagent/SKILL.md`
- `hyperagent/operating-prompt.md`
- `hyperagent/capability-registry.md`
- the local templates and memory directories in this repo

## Mission

A Mission is a real user task performed by an agent wearing the Suit.

Every Mission should end with a structured mission record in `missions/`. The record preserves the user request, plan, tools used, files changed, verification, failures, user corrections, friction, and candidate upgrades.

Mission records are not status theater. They are evidence for future Suit improvements.

## Workshop

The Workshop turns repeated mission friction into upgrade proposals.

Workshop proposals live in `workshop/proposals/` and must link back to mission evidence. A proposal should explain the observed problem, why the current Suit was insufficient, the proposed capability, expected impact, risk, test or eval, rollback plan, and activation mode.

The default activation mode is `human review required`.

## Forge

The Forge improves the Workshop itself.

Forge reviews live in `forge/reviews/`. They review whether proposals are specific, evidence-backed, safe, testable, and worth installing. If proposals are vague or evals are weak, the Forge proposes process changes instead of new Suit capabilities.

## Local Memory Flow

1. Mission telemetry is written to `missions/`.
2. Upgrade proposals are written to `workshop/proposals/`.
3. Accepted upgrades are recorded in `hyperagent/capability-registry.md`.
4. Forge reviews are written to `forge/reviews/`.
5. Durable lessons are promoted into docs or Suit memory only after review.
6. Proposals link back to mission records as evidence.
