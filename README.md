# HyperAgent

HyperAgent is an open source "Iron Man Suit" for AI agents: a local, inspectable operating layer that helps agents turn intent into reliable action.

The category claim is simple:

> Models provide intelligence. HyperAgent provides agency.

HyperAgent starts with OpenAI Codex in the Codex Mac app. The first prototype is intentionally markdown-first: Codex wears a Suit prompt while working, writes mission records after real tasks, and uses those records to propose evidence-backed upgrades through the Workshop. The Forge then reviews whether the Workshop itself is producing useful, safe, testable improvements.

## Architecture

HyperAgent is designed to sit at the Codex Mac app level as a user-level operating layer across Codex workspaces. The Global Suit provides shared operating rules, safety defaults, and reusable capabilities. Each workspace gets its own local Suit context for repo-specific rules, workflows, and memory.

Mission records capture evidence from real work. The Workshop turns that evidence into proposed Suit upgrades. The Forge improves the Workshop itself by checking whether proposals are specific, evidence-backed, safe, testable, and worth installing. Human review approves persistent behavior changes before they become part of the Suit.

```mermaid
flowchart TD
  User["User"]

  Codex["Codex Mac App<br/>Host environment for Codex work"]

  HyperAgent["HyperAgent<br/>User-level meta layer"]

  Registry["Project Registry<br/>Known workspaces, paths, roles, commands"]

  GlobalSuit["Global Suit<br/>Shared operating rules, safety defaults, reusable skills"]

  WorkspaceA["Workspace A"]
  WorkspaceB["Workspace B"]
  WorkspaceC["Workspace C"]

  LocalA["Workspace-local Suit Context<br/>repo rules, commands, workflows, memory"]
  LocalB["Workspace-local Suit Context"]
  LocalC["Workspace-local Suit Context"]

  MissionA["Mission Records"]
  MissionB["Mission Records"]
  MissionC["Mission Records"]

  Workshop["Workshop<br/>Turns mission evidence into Suit upgrade proposals"]

  Forge["Forge<br/>Improves how the Workshop proposes, tests, and installs upgrades"]

  Review["Human Review<br/>Approves persistent behavior changes"]

  User --> Codex
  Codex --> HyperAgent

  HyperAgent --> Registry
  HyperAgent --> GlobalSuit
  HyperAgent --> Workshop
  HyperAgent --> Forge

  Registry --> WorkspaceA
  Registry --> WorkspaceB
  Registry --> WorkspaceC

  GlobalSuit --> LocalA
  GlobalSuit --> LocalB
  GlobalSuit --> LocalC

  WorkspaceA --> LocalA --> MissionA
  WorkspaceB --> LocalB --> MissionB
  WorkspaceC --> LocalC --> MissionC

  MissionA --> Workshop
  MissionB --> Workshop
  MissionC --> Workshop

  Workshop --> Review
  Review --> GlobalSuit

  Workshop --> Forge
  Forge --> Workshop
```

## Quick Start

1. Clone this repo.
2. Install the Codex skill:

   ```bash
   sh scripts/install-codex-skill.sh "$HOME/.codex/skills"
   ```

   For local development, use `--symlink` instead of copying:

   ```bash
   sh scripts/install-codex-skill.sh --symlink "$HOME/.codex/skills"
   ```

   The installer validates `skills/codex-hyperagent/SKILL.md`, refuses to overwrite an existing skill unless `--force` is passed, and supports `--dry-run` for previewing the install.
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
- `scripts/install-codex-skill.sh`: dependency-free Codex skill installer.
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

The verifier checks that the Codex skill, installer, operating prompt, local memory directories, templates, documentation, capability registry, and safety defaults are present.

## Current Limits

HyperAgent Mark I is a prototype. It does not activate upgrades, does not provide a UI, and does not support every agent platform yet. The point of this version is to prove the Mission -> Workshop loop with durable local artifacts.

## License

HyperAgent is available under the MIT License. See [LICENSE](LICENSE) for details.
