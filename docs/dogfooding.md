# HyperAgent Dogfooding Guide

Use this guide to test HyperAgent as an end user for two weeks, starting from a fresh install.

This is a human UAT guide for the developer of HyperAgent. It is not a Codex implementation task. Codex can run individual HyperAgent missions during normal work, but the product judgment in this guide belongs to the human reviewer.

The goal is to let the product tell us what it wants to become through use. Run HyperAgent on every meaningful task in this repo, then periodically review the mission, Workshop, and Forge artifacts for PRD faithfulness.

## Scope

Dogfooding covers the current Codex-first alpha:

- Fresh Codex Mac setup from the public README.
- Optional project initialization in a scratch repo.
- Real work inside the HyperAgent repo.
- Mission records for meaningful tasks.
- Workshop proposals only when mission evidence shows concrete friction.
- Forge reviews when proposal quality, eval quality, safety, or process bloat needs review.
- Human review before any persistent behavior change becomes accepted.

Dogfooding does not require:

- hosted services,
- an interactive dashboard,
- non-Codex adapters,
- autonomous self-modification,
- hidden databases,
- editing global Codex custom instructions.

## Fresh Install Baseline

Start from the same path a first-time Codex user would see.

1. Open the GitHub README.
2. Follow the `Try HyperAgent In Codex Mac` command path or assisted Codex prompt.
3. Confirm HyperAgent installs or updates into `~/HyperAgent`.
4. Confirm `~/.codex/skills/codex-hyperagent/SKILL.md` exists.
5. Confirm setup reports whether Codex Desktop needs a restart or fresh thread.
6. Confirm setup leaves global Codex custom instructions unchanged.
7. Run the manual command path from `docs/quickstart.md` if the assisted prompt fails or feels unclear.

Expected result:

- `sh scripts/verify-mvp.sh` passes in the HyperAgent install.
- The setup path either completes cleanly or stops with one exact manual step.
- The user can explain what was installed without reading internal implementation files.

Record the baseline in `docs/clean-install-uat.md` before a release candidate is tagged.

## Scratch Project Initialization

Create a disposable repo and initialize HyperAgent there.

```bash
mkdir -p "$HOME/hyperagent-dogfood-target"
cd "$HOME/hyperagent-dogfood-target"
git init
printf '# HyperAgent Dogfood Target\n' > README.md
git add README.md
git commit -m "Initial dogfood target"
```

From the HyperAgent install:

```bash
sh scripts/hyperagent.sh init --target "$HOME/hyperagent-dogfood-target"
```

Check that init:

- asks before project initialization when run through setup with `--init-target`,
- creates `.hyperagent`,
- creates `AGENTS.md`,
- creates `missions/`, `workshop/`, `forge/`, `templates/`, `hyperagent/`, and `scripts/hyperagent.sh`,
- writes a project shim instead of copying global runtime internals,
- refuses conflicting local files unless `--force` is passed,
- keeps activation mode at `human review required`.

Run:

```bash
cd "$HOME/hyperagent-dogfood-target"
sh scripts/hyperagent.sh verify-config
sh scripts/hyperagent.sh sense
```

Expected result:

- The scratch repo has enough local context for Codex to wear HyperAgent.
- The generated artifacts are readable as normal project files.
- The config tells a future agent where mission, Workshop, Forge, and evidence files live.

## Two-Week Operating Rule

For two weeks, use HyperAgent on every meaningful task in this repo.

A meaningful task is any task that:

- changes files, docs, scripts, templates, skills, evals, or product behavior,
- asks about the PRD, architecture, setup, install flow, skill behavior, or repo status,
- requires investigation across multiple files or commands,
- involves verification, debugging, failing checks, or repeated friction,
- could reveal an improvement to the Suit, Workshop, Forge, installer, docs, adapters, or evals.

Skip mission telemetry only for isolated low-signal tasks:

- trivial one-line commands,
- simple factual answers that do not depend on repo state,
- small conversational clarifications,
- status restatements without new investigation.

When in doubt, record the mission. This repo is the HyperAgent testbed.

## Per-Task Mission Checklist

For each meaningful task:

1. Start in Codex with the HyperAgent instructions active.
2. Confirm the task is in Mission mode or explicitly note why it is skipped.
3. Inspect only the files and systems needed for the task.
4. Make focused changes.
5. Run the smallest meaningful verification.
6. Prefer recording checks through:

```bash
sh scripts/hyperagent.sh check -- sh scripts/verify-mvp.sh
```

7. Close out the mission:

```bash
sh scripts/hyperagent.sh mission closeout \
  --request "Describe the task" \
  --slug task-slug \
  --outcome "What changed and why it is complete" \
  --risks "Known residual risk, or No unresolved risks"
```

8. Verify the mission record:

```bash
sh scripts/hyperagent.sh mission verify --strict missions/MISSION.md
```

9. Create a Workshop proposal only when the mission shows concrete reusable friction.
10. Create a Forge review only when the Workshop process itself needs review.

Expected result:

- Mission records contain enough evidence to review the work without opening a chat transcript.
- Verification status is explicit.
- Candidate upgrades distinguish real repeated friction from one-off inconvenience.
- Persistent behavior changes remain human-review-required until a decision record exists.

## Daily Review

At the end of each dogfooding day, spend 10 minutes reviewing the newest artifacts.

Run:

```bash
sh scripts/hyperagent.sh sense
sh scripts/hyperagent.sh review digest --limit 12
sh scripts/hyperagent.sh review forge audit
```

Check:

- Did every meaningful task produce a mission record?
- Are mission records specific enough to support later Workshop review?
- Did any mission reveal the same friction seen earlier?
- Did any proposal include evidence, expected impact, safety, rollback, and verification?
- Are any accepted capabilities missing a decision record or registry trace?
- Did the agent overuse Workshop or Forge for tasks that did not need them?

Record notes in repo artifacts only when they are useful for future review:

- mission updates in `missions/`,
- proposal follow-ups in `workshop/backlog.md`,
- release-impacting observations in `docs/releases/next-alpha.md`,
- product-state changes in `docs/roadmap.md`.

## Twice-Weekly PRD Faithfulness Review

Twice per week, review whether actual use is making HyperAgent more faithful to the PRD.

Open:

- `docs/hyperagent-prd.md`,
- `docs/roadmap.md`,
- `hyperagent/capability-registry.md`,
- `workshop/backlog.md`,
- recent files under `missions/`,
- recent files under `workshop/proposals/`,
- recent files under `forge/reviews/`,
- `docs/releases/next-alpha.md`.

Ask:

- Does HyperAgent still behave like a Suit instead of a brittle task scaffold?
- Are installed capabilities improving agency infrastructure: sensing, verification, memory, safety, capability discovery, upgrade flow, or adapter boundaries?
- Are Codex-specific conveniences staying inside the Codex adapter instead of pretending to be universal platform behavior?
- Are local markdown artifacts still the source of truth?
- Are mission records useful enough to propose upgrades without transcript archaeology?
- Are proposals tied to evidence rather than vibes?
- Are Forge reviews improving proposal quality rather than adding ceremony?
- Are evals catching meaningful regressions?
- Are release notes and the roadmap honest about what is shipped, accepted, in review, deferred, or missing?

Expected result:

- The roadmap and release notes describe the product that actually exists.
- Accepted capabilities have decision records and registry entries.
- In-review surfaces remain clearly marked until a human reviewer accepts them.
- Future work is grounded in observed use, not imagined product shape.

## End-Of-Week Review

At the end of each week, choose one of three outcomes for each repeated friction pattern:

- `Fix now`: open or update an issue because the friction blocks core dogfooding.
- `Propose`: create or refine a Workshop proposal because the friction is reusable but needs review.
- `Watch`: keep the evidence in mission records because the pattern is still weak.

Use this rubric:

| Signal | Fix now | Propose | Watch |
| --- | --- | --- | --- |
| Repeats across tasks | yes | yes | maybe |
| Blocks verification or completion | yes | maybe | no |
| Improves durable agency infrastructure | yes | yes | unclear |
| Requires new authority or permissions | human review first | human review first | no change |
| Has a local eval path | yes | likely | not yet |

Update `workshop/backlog.md` when a proposal should be tracked. Do not promote anything to accepted capability without a human decision record.

## PRD Faithfulness Checklist

Use this checklist during the two-week review and before release readiness.

### Installable Operating Layer

- Codex skill installs from the README flow.
- Setup is understandable without internal repo knowledge.
- Project init is opt-in.
- Global Codex custom instructions are unchanged.
- The operating prompt clearly tells Codex how to run Mission, Workshop, and Forge loops.

### Mission Layer

- Mission records include request, environment, actions, changed files, checks, failures, completion evidence, risks, and candidate upgrades.
- Mission closeout can be run without hand-writing the whole record.
- Strict mission verification catches incomplete placeholders.
- Public examples and committed evidence avoid secrets and sensitive local context.

### Workshop

- Proposals cite mission evidence.
- Proposals include expected benefit, implementation plan, safety, eval, rollback, and decision handoff.
- Proposal priority is scored with `workshop/rubric.md`.
- Workshop output stays `human review required` unless explicitly accepted.

### Forge

- Forge reviews use concrete evidence and anchored scores.
- Forge reviews check outcome quality, proposal quality, eval quality, safety, and process bloat.
- `forge audit` surfaces stale decisions, weak proposal fields, registry traceability gaps, and eval coverage gaps.
- Forge improvements create normal Workshop proposals instead of silently changing process rules.

### Safety And Authority

- Persistent behavior changes require human approval.
- Network, account, filesystem, deployment, and secrets boundaries are explicit.
- New capabilities document rollback.
- Accepted registry entries point to proposal, decision, and verification evidence.

### Suit Not Scaffold

- New features strengthen durable agency infrastructure.
- Adapter-specific conveniences stay in adapter docs or examples.
- Task-specific shortcuts do not become core Suit policy.
- The product remains useful as models improve.

## Failure Log Template

When dogfooding reveals a failure, record it in the artifact closest to the failure.

Use this shape:

```markdown
## Dogfood Failure

- Date:
- Task:
- Expected behavior:
- Actual behavior:
- User-visible impact:
- Artifact evidence:
- Command or check:
- Repro steps:
- Suspected product area:
- Fix now / Propose / Watch:
- Follow-up issue or proposal:
```

Avoid storing secrets or private transcript dumps. Link to mission records, proposals, Forge reviews, issues, or release notes instead.

## Completion Criteria

The two-week dogfood pass is complete when:

- fresh install has been tested and recorded,
- scratch project init has been tested,
- every meaningful HyperAgent repo task either has a mission record or an explicit skip note,
- at least two PRD faithfulness reviews have been completed,
- repeated friction has been classified as `Fix now`, `Propose`, or `Watch`,
- release notes and roadmap reflect what dogfooding actually found,
- accepted capabilities have proposal, decision, registry, and verification evidence,
- no persistent behavior change was activated without human review.

The final dogfood report should summarize:

- date range,
- commit or release candidate tested,
- install result,
- mission count,
- proposal count,
- Forge review count,
- checks run,
- repeated friction patterns,
- PRD faithfulness verdict,
- release blockers,
- next recommended issue.
