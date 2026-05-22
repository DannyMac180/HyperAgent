# HyperAgent

HyperAgent is an open source "Iron Man Suit" for AI agents: a local, inspectable operating layer that helps agents turn intent into reliable action.

The category claim is simple:

> Models provide intelligence. HyperAgent provides agency.

HyperAgent starts with OpenAI Codex in the Codex Mac app. The first prototype is intentionally markdown-first: Codex wears a Suit prompt while working, writes mission records after real tasks, and uses those records to propose evidence-backed upgrades through the Workshop. The Forge then reviews whether the Workshop itself is producing useful, safe, testable improvements.

## Alpha Status

HyperAgent is currently `v0.1.0-alpha`: a developer preview for testing the local Mission -> Workshop -> Forge loop.

This alpha is ready for early open-source use by Codex users who are comfortable with local markdown artifacts and shell scripts. It is not a hosted service, does not provide a polished UI, does not support every agent platform, and does not autonomously modify itself.

Release notes: `docs/releases/v0.1.0-alpha.md`

## Architecture

HyperAgent is designed to sit at the Codex Mac app level as a user-level operating layer across Codex workspaces. The Global Suit provides shared operating rules, safety defaults, and reusable capabilities. Each workspace gets its own local Suit context for repo-specific rules, workflows, and memory.

Mission records capture evidence from real work. The Workshop turns that evidence into proposed Suit upgrades. The Forge improves the Workshop itself by checking whether proposals are specific, evidence-backed, safe, testable, worth installing, and actually improving behavior after acceptance. Forge reviews use anchored 0-5 scores, evidence references, deterministic gates, and small payoff counters so the process can be inspected over time. Human review approves persistent behavior changes before they become part of the Suit.

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
2. Initialize HyperAgent in a project repo:

   ```bash
   sh scripts/hyperagent.sh init --target /path/to/project
   ```

   The repo also includes a wrapper:

   ```bash
   bin/hyperagent init --target /path/to/project
   ```

   Add `bin/` to your `PATH` if you want to run it as plain `hyperagent init`.

   The init command creates the markdown-first project structure: `.hyperagent`, `missions/`, `workshop/proposals/`, `workshop/decisions/`, `forge/reviews/`, `templates/`, `hyperagent/`, `scripts/hyperagent.sh`, and a HyperAgent block in `AGENTS.md`. The root `.hyperagent` file is the machine-readable project anchor for version, install mode, initialized paths, enabled adapters, verification commands, and instruction files. Init copies files by default so project memory stays inspectable and portable. It refuses conflicting overwrites unless `--force` is passed, and supports `--dry-run` for previewing setup.
3. Install the Codex skill:

   ```bash
   sh scripts/install-codex-skill.sh "$HOME/.codex/skills"
   ```

   For local development, use `--symlink` instead of copying:

   ```bash
   sh scripts/install-codex-skill.sh --symlink "$HOME/.codex/skills"
   ```

   The installer validates `skills/codex-hyperagent/SKILL.md`, refuses to overwrite an existing skill unless `--force` is passed, and supports `--dry-run` for previewing the install.
4. Check local product status:

   ```bash
   sh scripts/hyperagent.sh status
   ```

5. Start Codex in this repo and ask it to use the `codex-hyperagent` skill.
6. Use `hyperagent/operating-prompt.md` as the canonical Suit prompt.
7. After a task, inspect the new mission record in `missions/`.
8. Inspect any evidence-backed upgrade proposals in `workshop/proposals/`.
9. Record explicit human approval or rejection in `workshop/decisions/` before a proposal becomes accepted Suit memory.
10. Run a Forge review after proposal decisions, eval changes, release-readiness checks, or repeated vague Workshop output.

The MVP is file-based on purpose. There is no hosted service, no database, and no autonomous self-modification.

For the full first-run path, see `docs/quickstart.md`.

For early release readiness, see `docs/release-checklist.md`.

## Updating

HyperAgent updates use normal Git workflows.

For copy installs:

```bash
git pull
sh scripts/update-codex-skill.sh
sh scripts/verify-mvp.sh
```

For symlink installs:

```bash
git pull
sh scripts/verify-mvp.sh
```

Restart Codex Desktop or open a fresh thread after updating the installed skill.

## What Is Included

- `docs/hyperagent-prd.md`: product requirements and milestone plan.
- `docs/concepts.md`: the Suit, Mission, Workshop, and Forge mental model.
- `docs/release-checklist.md`: alpha release criteria, clean-clone test, and update model.
- `docs/releases/v0.1.0-alpha.md`: first alpha release notes.
- `docs/article-outline.md`: public essay outline for the Iron Man Suit thesis.
- `skills/codex-hyperagent/`: Codex skill instructions.
- `bin/hyperagent`: small command wrapper for `scripts/hyperagent.sh`.
- `.hyperagent`: machine-readable project config for initialized paths, adapters, and verification commands.
- `scripts/install-codex-skill.sh`: dependency-free Codex skill installer.
- `scripts/update-codex-skill.sh`: update helper for copy installs.
- `scripts/hyperagent.sh`: local helper for project init, mission shells, proposals, Forge reviews, approval decisions, and status.
- `hyperagent/operating-prompt.md`: the operating layer Codex wears during work.
- `hyperagent/capability-registry.md`: accepted capability registry with reviewed local capabilities.
- `templates/mission-record.md`: mission telemetry template.
- `templates/upgrade-proposal.md`: Workshop proposal template.
- `templates/forge-review.md`: Forge review template for outcome, proposal, eval, safety, process bloat, structured summary, gates, and payoff metrics.
- `templates/upgrade-decision.md`: human approval or rejection template.
- `workshop/backlog.md`: first-class upgrade backlog.
- `workshop/rubric.md`: proposal prioritization rubric.
- `forge/process/quality-rubric.md`: Forge quality metrics for improving Workshop output.
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

Run the end-to-end local smoke loop:

```bash
sh evals/smoke-loop.sh
```

The smoke loop copies the repo to a temporary directory, creates a mission record, creates a proposal linked to that mission, creates a Forge review, creates a process-improvement proposal linked to that Forge review, records a human-review decision, and verifies the accepted capability appears in the registry.

Run the project init smoke test:

```bash
sh evals/init-smoke.sh
```

The init smoke test creates a temporary repo, runs `hyperagent init`, checks the generated markdown-first structure and `.hyperagent` config, verifies overwrite refusal, verifies `--force`, and confirms `--dry-run` leaves the target untouched.

## Current Limits

HyperAgent Mark I is a working local prototype. It does not provide a UI, autonomously modify itself, or support every agent platform yet. The point of this version is to prove the Mission -> Workshop -> Forge loop with durable local artifacts and explicit human review.

## License

HyperAgent is available under the MIT License. See [LICENSE](LICENSE) for details.
