# HyperAgent

HyperAgent is an open source "Iron Man Suit" for AI agents: a local, inspectable operating layer that helps agents turn intent into reliable action.

The category claim is simple:

> Models provide intelligence. HyperAgent provides agency.

HyperAgent starts with OpenAI Codex in the Codex Mac app. The first prototype is intentionally markdown-first: Codex wears a Suit prompt while working, writes mission records after real tasks, and uses those records to propose evidence-backed upgrades through the Workshop. The Forge then reviews whether the Workshop itself is producing useful, safe, testable improvements.

## Quick Start

1. Clone this repo.
2. Install the Codex skill by copying or symlinking `skills/codex-hyperagent/` into your Codex skills directory.
3. Start Codex in this repo and ask it to use the `codex-hyperagent` skill.
4. Use `hyperagent/operating-prompt.md` as the canonical Suit prompt.
5. After a task, inspect the new mission record in `missions/`.
6. Inspect any evidence-backed upgrade proposals in `workshop/proposals/`.

The MVP is file-based on purpose. There is no hosted service, no database, and no autonomous self-modification.

## What Is Included

- `docs/hyperagent-prd.md`: product requirements and milestone plan.
- `docs/concepts.md`: the Suit, Mission, Workshop, and Forge mental model.
- `docs/article-outline.md`: public essay outline for the Iron Man Suit thesis.
- `skills/codex-hyperagent/`: Codex skill instructions.
- `hyperagent/operating-prompt.md`: the operating layer Codex wears during work.
- `hyperagent/capability-registry.md`: accepted capability registry, empty by default.
- `templates/mission-record.md`: mission telemetry template.
- `templates/upgrade-proposal.md`: Workshop proposal template.
- `templates/forge-review.md`: Forge review template.
- `evals/`: small local checks for the Mission -> Workshop loop.

## Safety Model

The default activation mode is `human review required`.

Agents may propose upgrades freely and draft local, low-risk files when asked. They may not silently activate upgrades that increase permissions, alter secrets handling, change deployment behavior, broaden filesystem access, use new network/account access, or persist new operating rules. Until stronger policy automation exists, persistent behavior changes require explicit human approval.

## Verification

Run the local MVP verifier:

```bash
sh scripts/verify-mvp.sh
```

The verifier checks that the Codex skill, operating prompt, local memory directories, templates, documentation, capability registry, and safety defaults are present.

## Current Limits

HyperAgent Mark I is a prototype. It does not install itself automatically, does not activate upgrades, does not provide a UI, and does not support every agent platform yet. The point of this version is to prove the Mission -> Workshop loop with durable local artifacts.

## License

HyperAgent is available under the MIT License. See [LICENSE](LICENSE) for details.
