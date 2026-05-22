#!/bin/sh
set -eu

usage() {
  cat <<'USAGE'
Usage: sh scripts/hyperagent.sh COMMAND [options]

Commands:
  init [--target DIR] [--force] [--dry-run]
      Create or update HyperAgent project setup files in DIR. Defaults to the current directory.

  status
      Print HyperAgent local product status.

  new-mission --request TEXT [--slug SLUG]
      Create a mission record in missions/.

  propose-upgrade (--mission PATH | --forge-review PATH) --title TEXT --problem TEXT [--slug SLUG]
      Create a Workshop proposal in workshop/proposals/ from mission evidence or Forge review evidence.

  workshop-prompt
      Print the repeatable Workshop review prompt.

  new-forge-review [--slug SLUG]
      Create a Forge review record in forge/reviews/.

  forge-prompt
      Print the repeatable Forge review prompt.

  decide-upgrade --proposal PATH --decision accepted|rejected --reviewer NAME --reason TEXT [--capability ID]
      Record a human approval decision. Accepted decisions require --capability and are added to the capability registry.

  help
      Show this help.
USAGE
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd)

mission_dir="$repo_root/missions"
proposal_dir="$repo_root/workshop/proposals"
decision_dir="$repo_root/workshop/decisions"
forge_dir="$repo_root/forge/reviews"
registry_file="$repo_root/hyperagent/capability-registry.md"

now_stamp() {
  date '+%Y-%m-%d-%H%M'
}

now_readable() {
  date '+%Y-%m-%d %H:%M %Z'
}

slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9][^a-z0-9]*/-/g; s/^-//; s/-$//'
}

ensure_dirs() {
  mkdir -p "$mission_dir" "$proposal_dir" "$decision_dir" "$forge_dir"
}

init_log() {
  printf '%s\n' "$1"
}

init_parent_dir() {
  dirname "$1"
}

init_same_file() {
  test -f "$1" && test -f "$2" && cmp -s "$1" "$2"
}

init_install_file() {
  src="$1"
  dest="$2"
  force="$3"
  dry_run="$4"

  if [ -e "$dest" ]; then
    if init_same_file "$src" "$dest"; then
      init_log "up to date: $dest"
      return 0
    fi
    test "$force" -eq 1 || fail "refusing to overwrite existing file without --force: $dest"
    if [ "$dry_run" -eq 1 ]; then
      init_log "would replace: $dest"
      return 0
    fi
    cp "$src" "$dest"
    init_log "replaced: $dest"
    return 0
  fi

  if [ "$dry_run" -eq 1 ]; then
    init_log "would create: $dest"
    return 0
  fi

  mkdir -p "$(init_parent_dir "$dest")"
  cp "$src" "$dest"
  init_log "created: $dest"
}

init_write_generated() {
  dest="$1"
  force="$2"
  dry_run="$3"
  generator="$4"
  tmp=$(mktemp)
  "$generator" >"$tmp"

  if [ -e "$dest" ]; then
    if cmp -s "$tmp" "$dest"; then
      init_log "up to date: $dest"
      rm -f "$tmp"
      return 0
    fi
    test "$force" -eq 1 || {
      rm -f "$tmp"
      fail "refusing to overwrite existing file without --force: $dest"
    }
    if [ "$dry_run" -eq 1 ]; then
      init_log "would replace: $dest"
      rm -f "$tmp"
      return 0
    fi
    cp "$tmp" "$dest"
    init_log "replaced: $dest"
    rm -f "$tmp"
    return 0
  fi

  if [ "$dry_run" -eq 1 ]; then
    init_log "would create: $dest"
    rm -f "$tmp"
    return 0
  fi

  mkdir -p "$(init_parent_dir "$dest")"
  cp "$tmp" "$dest"
  init_log "created: $dest"
  rm -f "$tmp"
}

init_touch_file() {
  dest="$1"
  dry_run="$2"

  if [ -e "$dest" ]; then
    init_log "up to date: $dest"
    return 0
  fi

  if [ "$dry_run" -eq 1 ]; then
    init_log "would create: $dest"
    return 0
  fi

  mkdir -p "$(init_parent_dir "$dest")"
  : >"$dest"
  init_log "created: $dest"
}

generate_init_registry() {
  cat <<'EOF'
# HyperAgent Capability Registry

This project-local registry records accepted HyperAgent capabilities for this repository.

- Default activation mode: human review required
- Silent activation allowed: no
- Permission, deployment, account, or secrets changes require explicit human approval.

## Accepted Capabilities

No project-local capabilities have been accepted yet.

Add accepted capabilities only after a proposal in `workshop/proposals/` has a matching human decision in `workshop/decisions/`.
EOF
}

generate_init_backlog() {
  cat <<'EOF'
# HyperAgent Project Upgrade Backlog

This project-local backlog tracks proposed HyperAgent, Suit, and workflow upgrades after they have evidence from mission records.

Default activation mode: `human review required`.

## Intake Rules

- Every backlog item must link to a proposal in `workshop/proposals/`.
- Every proposal must link to at least one mission record or Forge review.
- The highest-priority item must name its first implementation step and acceptance test.
- Accepted items require a decision record in `workshop/decisions/`.
- Accepted local capabilities are recorded in `hyperagent/capability-registry.md`.

## Priority Rubric

Score each item with `workshop/rubric.md`.

- `P0`: Blocks the Mission -> Workshop -> Forge loop or creates a serious safety gap.
- `P1`: Removes repeated friction from real missions or improves verification quality.
- `P2`: Improves ergonomics, docs, or contributor onboarding.
- `P3`: Useful later, but not needed for local reliability.

## Backlog

| Priority | Status | Proposal | Evidence | Next action |
| --- | --- | --- | --- | --- |
EOF
}

generate_init_config() {
  cat <<'EOF'
# HyperAgent project config

hyperagent_version = "v0.1.0-alpha"
config_version = 1
install_mode = "copy"

[paths]
project_instructions = "AGENTS.md"
missions = "missions"
workshop_proposals = "workshop/proposals"
workshop_decisions = "workshop/decisions"
workshop_backlog = "workshop/backlog.md"
workshop_rubric = "workshop/rubric.md"
forge_reviews = "forge/reviews"
forge_quality_rubric = "forge/process/quality-rubric.md"
templates = "templates"
operating_prompt = "hyperagent/operating-prompt.md"
capability_registry = "hyperagent/capability-registry.md"
project_readme = "hyperagent/README.md"
local_helper = "scripts/hyperagent.sh"

[adapters]
codex = true

[verification]
commands = [
  "sh scripts/hyperagent.sh status",
]
EOF
}

generate_init_readme() {
  cat <<'EOF'
# HyperAgent Project Setup

This repository has local HyperAgent memory and workflow files.

The root `.hyperagent` file is the machine-readable project anchor. Scripts and
adapters can read it to find the HyperAgent version, install mode, initialized
paths, enabled adapters, verification commands, and instruction files.

Use these files to keep agent work inspectable:

- `missions/`: mission records from meaningful tasks.
- `workshop/proposals/`: proposed improvements backed by mission or Forge review evidence.
- `workshop/decisions/`: explicit human approvals or rejections.
- `forge/reviews/`: reviews of Workshop proposal quality.
- `templates/`: markdown templates for records, proposals, decisions, and Forge reviews.
- `hyperagent/operating-prompt.md`: local Suit prompt.
- `hyperagent/capability-registry.md`: accepted local capabilities.

## Local Commands

```bash
sh scripts/hyperagent.sh status
sh scripts/hyperagent.sh new-mission --request "Describe the task" --slug task-slug
sh scripts/hyperagent.sh workshop-prompt
sh scripts/hyperagent.sh forge-prompt
sh scripts/hyperagent.sh propose-upgrade --forge-review forge/reviews/REVIEW.md --title "Improve Workshop quality" --problem "The Workshop process needs a concrete fix"
```

## Verification

Run Forge reviews after proposal decisions, eval changes, release-readiness checks, or repeated vague Workshop output. Forge process improvements should become normal Workshop proposals linked to the Forge review and remain `human review required`.

For this project, the lightweight check is:

```bash
sh scripts/hyperagent.sh status
```

Add any project-specific build, test, lint, or smoke commands to `AGENTS.md` so future agents know the strongest relevant verification path.

## Copy And Symlink Behavior

`hyperagent init` copies markdown templates, prompt files, and helper scripts into the target repository. It does not symlink project setup files by default, because local project memory should remain portable, reviewable, and safe to edit.

If you installed the global Codex skill with `scripts/install-codex-skill.sh --symlink`, only the Codex skill install is symlinked. Project-local files created by `hyperagent init` are still normal files.

Existing files are left alone when they are identical. Conflicting generated files are not overwritten unless `--force` is passed.
EOF
}

generate_init_agents_block() {
  cat <<'EOF'
<!-- hyperagent-init:start -->

## HyperAgent Project Instructions

Use HyperAgent triage for substantial work in this repository.

Run the full Mission -> Workshop -> Forge loop when a task:

- changes files, docs, scripts, templates, tests, product behavior, or workflow behavior,
- requires investigation across multiple files or commands,
- involves verification, debugging, or failing checks,
- reveals friction worth turning into a reusable improvement,
- explicitly asks for HyperAgent.

For full-loop tasks:

1. Complete the task with focused changes and explicit verification.
2. Write a mission record in `missions/`.
3. Create a Workshop proposal in `workshop/proposals/` only when there is concrete Suit friction, Forge review evidence, or a worthwhile improvement.
4. Create a Forge review in `forge/reviews/` only when the Workshop process itself needs review.
5. Keep persistent behavior changes `human review required`.

Skip the full loop only for clearly isolated one-off tasks such as simple factual answers, trivial commands, small clarifications, or status restatements without new investigation. When skipping, say that HyperAgent triage classified the task as an isolated one-off and no mission record was written.

Local verification guidance:

```bash
sh scripts/hyperagent.sh status
```

Add project-specific build, test, lint, or smoke commands here as they become known.

<!-- hyperagent-init:end -->
EOF
}

init_update_agents() {
  target_root="$1"
  force="$2"
  dry_run="$3"
  agents="$target_root/AGENTS.md"
  block=$(mktemp)
  existing=$(mktemp)
  merged=$(mktemp)
  generate_init_agents_block >"$block"

  if [ ! -e "$agents" ]; then
    if [ "$dry_run" -eq 1 ]; then
      init_log "would create: $agents"
    else
      cp "$block" "$agents"
      init_log "created: $agents"
    fi
    rm -f "$block" "$existing" "$merged"
    return 0
  fi

  if grep -F '<!-- hyperagent-init:start -->' "$agents" >/dev/null; then
    awk '/<!-- hyperagent-init:start -->/{capture=1} capture{print} /<!-- hyperagent-init:end -->/{capture=0}' "$agents" >"$existing"
    if cmp -s "$block" "$existing"; then
      init_log "up to date: $agents"
      rm -f "$block" "$existing" "$merged"
      return 0
    fi
    test "$force" -eq 1 || {
      rm -f "$block" "$existing" "$merged"
      fail "refusing to replace existing HyperAgent block without --force: $agents"
    }
    if [ "$dry_run" -eq 1 ]; then
      init_log "would update HyperAgent block: $agents"
      rm -f "$block" "$existing" "$merged"
      return 0
    fi
    awk -v block_file="$block" '
      BEGIN {
        while ((getline line < block_file) > 0) {
          block = block line "\n"
        }
      }
      /<!-- hyperagent-init:start -->/ {
        if (!printed) {
          printf "%s", block
          printed = 1
        }
        skip = 1
        next
      }
      /<!-- hyperagent-init:end -->/ {
        skip = 0
        next
      }
      !skip { print }
    ' "$agents" >"$merged"
    cp "$merged" "$agents"
    init_log "updated HyperAgent block: $agents"
    rm -f "$block" "$existing" "$merged"
    return 0
  fi

  if [ "$dry_run" -eq 1 ]; then
    init_log "would append HyperAgent block: $agents"
  else
    {
      printf '\n\n'
      cat "$block"
    } >>"$agents"
    init_log "appended HyperAgent block: $agents"
  fi
  rm -f "$block" "$existing" "$merged"
}

init_project() {
  target=.
  force=0
  dry_run=0

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --target)
        shift
        test "$#" -gt 0 || fail "--target requires a directory"
        target=$1
        ;;
      --force)
        force=1
        ;;
      --dry-run)
        dry_run=1
        ;;
      *)
        fail "unknown init option: $1"
        ;;
    esac
    shift
  done

  test -d "$target" || fail "target directory does not exist: $target"
  target_root=$(CDPATH= cd "$target" && pwd)

  init_log "HyperAgent init target: $target_root"
  if [ "$dry_run" -eq 1 ]; then
    init_log "Dry run: no files will be changed."
  fi

  for dir in \
    "$target_root/missions" \
    "$target_root/workshop/proposals" \
    "$target_root/workshop/decisions" \
    "$target_root/forge/reviews" \
    "$target_root/forge/process" \
    "$target_root/templates" \
    "$target_root/hyperagent" \
    "$target_root/scripts"
  do
    if [ "$dry_run" -eq 1 ]; then
      if [ -d "$dir" ]; then
        init_log "up to date: $dir"
      else
        init_log "would create: $dir"
      fi
    else
      mkdir -p "$dir"
      init_log "ensured directory: $dir"
    fi
  done

  init_touch_file "$target_root/missions/.gitkeep" "$dry_run"
  init_touch_file "$target_root/workshop/proposals/.gitkeep" "$dry_run"
  init_touch_file "$target_root/workshop/decisions/.gitkeep" "$dry_run"
  init_touch_file "$target_root/forge/reviews/.gitkeep" "$dry_run"

  init_install_file "$repo_root/templates/mission-record.md" "$target_root/templates/mission-record.md" "$force" "$dry_run"
  init_install_file "$repo_root/templates/upgrade-proposal.md" "$target_root/templates/upgrade-proposal.md" "$force" "$dry_run"
  init_install_file "$repo_root/templates/upgrade-decision.md" "$target_root/templates/upgrade-decision.md" "$force" "$dry_run"
  init_install_file "$repo_root/templates/forge-review.md" "$target_root/templates/forge-review.md" "$force" "$dry_run"
  init_install_file "$repo_root/workshop/rubric.md" "$target_root/workshop/rubric.md" "$force" "$dry_run"
  init_install_file "$repo_root/forge/process/quality-rubric.md" "$target_root/forge/process/quality-rubric.md" "$force" "$dry_run"
  init_install_file "$repo_root/hyperagent/operating-prompt.md" "$target_root/hyperagent/operating-prompt.md" "$force" "$dry_run"
  init_install_file "$repo_root/scripts/hyperagent.sh" "$target_root/scripts/hyperagent.sh" "$force" "$dry_run"

  init_write_generated "$target_root/.hyperagent" "$force" "$dry_run" generate_init_config
  init_write_generated "$target_root/workshop/backlog.md" "$force" "$dry_run" generate_init_backlog
  init_write_generated "$target_root/hyperagent/capability-registry.md" "$force" "$dry_run" generate_init_registry
  init_write_generated "$target_root/hyperagent/README.md" "$force" "$dry_run" generate_init_readme
  init_update_agents "$target_root" "$force" "$dry_run"

  init_log "HyperAgent init complete."
  init_log "Next: inspect AGENTS.md, add project-specific verification commands, then run: sh scripts/hyperagent.sh status"
}

count_markdown_files() {
  dir="$1"
  find "$dir" -maxdepth 1 -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' '
}

print_status() {
  ensure_dirs
  printf 'HyperAgent status\n'
  printf 'Repo: %s\n' "$repo_root"
  printf 'Mode: human review required\n'
  printf 'Missions: %s\n' "$(count_markdown_files "$mission_dir")"
  printf 'Workshop proposals: %s\n' "$(count_markdown_files "$proposal_dir")"
  printf 'Workshop decisions: %s\n' "$(count_markdown_files "$decision_dir")"
  printf 'Forge reviews: %s\n' "$(count_markdown_files "$forge_dir")"
  test -f "$registry_file" || fail "missing capability registry: $registry_file"
  printf 'Capability registry: %s\n' "$registry_file"
}

create_mission() {
  request=
  slug=

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --request)
        shift
        test "$#" -gt 0 || fail "--request requires text"
        request=$1
        ;;
      --slug)
        shift
        test "$#" -gt 0 || fail "--slug requires text"
        slug=$(slugify "$1")
        ;;
      *)
        fail "unknown new-mission option: $1"
        ;;
    esac
    shift
  done

  test -n "$request" || fail "new-mission requires --request"
  test -n "$slug" || slug=$(slugify "$request")
  test -n "$slug" || slug=mission

  ensure_dirs
  stamp=$(now_stamp)
  file="$mission_dir/$stamp-$slug.md"
  test ! -e "$file" || fail "mission already exists: $file"

  cat >"$file" <<EOF
# Mission Record

- Mission ID: mission-$stamp-$slug
- Date/time: $(now_readable)
- Agent identity: Codex wearing the HyperAgent Suit
- Environment: \`$repo_root\`
- User request: $request

## Outcome

- Final outcome:
- Completion evidence:
- Unresolved risks:

## Actions

- Agent plan:
- Summary of actions taken:
- Tools used:
- Files or systems changed:
- Verification performed:

## Friction

- Failures, retries, and blockers:
- User corrections:
- Suit friction observed:
- Candidate upgrades:

## Workshop Handoff

- Upgrade proposal paths:
- Follow-up owner: Human reviewer
EOF

  printf '%s\n' "$file"
}

create_proposal() {
  mission=
  forge_review=
  title=
  problem=
  slug=

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --mission)
        shift
        test "$#" -gt 0 || fail "--mission requires a path"
        mission=$1
        ;;
      --forge-review)
        shift
        test "$#" -gt 0 || fail "--forge-review requires a path"
        forge_review=$1
        ;;
      --title)
        shift
        test "$#" -gt 0 || fail "--title requires text"
        title=$1
        ;;
      --problem)
        shift
        test "$#" -gt 0 || fail "--problem requires text"
        problem=$1
        ;;
      --slug)
        shift
        test "$#" -gt 0 || fail "--slug requires text"
        slug=$(slugify "$1")
        ;;
      *)
        fail "unknown propose-upgrade option: $1"
        ;;
    esac
    shift
  done

  test -n "$mission$forge_review" || fail "propose-upgrade requires --mission or --forge-review"
  if [ -n "$mission" ] && [ -n "$forge_review" ]; then
    fail "propose-upgrade accepts only one evidence source: --mission or --forge-review"
  fi
  if [ -n "$mission" ]; then
    test -f "$mission" || fail "mission record not found: $mission"
    evidence_type="mission"
    related_mission="\`$mission\`"
    related_forge_review=""
    evidence_from_missions="\`$mission\`"
    evidence_from_forge=""
  else
    test -f "$forge_review" || fail "forge review not found: $forge_review"
    evidence_type="forge review"
    related_mission=""
    related_forge_review="\`$forge_review\`"
    evidence_from_missions=""
    evidence_from_forge="\`$forge_review\`"
  fi
  test -n "$title" || fail "propose-upgrade requires --title"
  test -n "$problem" || fail "propose-upgrade requires --problem"
  test -n "$slug" || slug=$(slugify "$title")
  test -n "$slug" || slug=upgrade

  ensure_dirs
  stamp=$(now_stamp)
  file="$proposal_dir/$stamp-$slug.md"
  test ! -e "$file" || fail "proposal already exists: $file"

  cat >"$file" <<EOF
# Upgrade Proposal

- Upgrade title: $title
- Proposal ID: proposal-$stamp-$slug
- Date/time: $(now_readable)
- Related mission record: $related_mission
- Related Forge review: $related_forge_review
- Evidence source type: $evidence_type
- Proposed activation mode: human review required
- Allowed activation modes: suggest only; draft files only; human review required; auto-install low risk
- Backlog priority:
- Workshop rubric score:

## Problem

- Problem observed: $problem
- Evidence from mission records: $evidence_from_missions
- Evidence from Forge reviews: $evidence_from_forge
- Why the current Suit was insufficient:

## Proposed Capability

- Type of upgrade:
- Proposed capability:
- Expected impact:
- Transferability:

## Implementation Plan

- Highest-priority plan step:
- Implementation steps:
- Files or instructions likely to change:
- Verification for the first step:

## Safety

- Safety risk:
- Permission or authority changes:
- Human approval required before activation: yes

## Evaluation

- Eval or acceptance test:
- Rollback plan:
- Open questions:

## Decision Handoff

- Recommended decision:
- Decision record path:
- Capability registry ID if accepted:
EOF

  printf '%s\n' "$file"
}

print_workshop_prompt() {
  cat <<'EOF'
Use HyperAgent Workshop Mode.

Read recent mission records in missions/. Identify concrete Suit friction supported by evidence. Choose the highest-value friction, then create or update a proposal in workshop/proposals/ using templates/upgrade-proposal.md. Include the linked mission record, proposed capability, safety risk, eval or acceptance test, rollback plan, and an Implementation Plan with the highest-priority step first. If the evidence is a Forge review about Workshop quality, create the proposal with --forge-review instead of --mission. Do not activate the upgrade. Default the activation mode to human review required.
EOF
}

create_forge_review() {
  slug=

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --slug)
        shift
        test "$#" -gt 0 || fail "--slug requires text"
        slug=$(slugify "$1")
        ;;
      *)
        fail "unknown new-forge-review option: $1"
        ;;
    esac
    shift
  done

  test -n "$slug" || slug=workshop-quality-review
  ensure_dirs
  stamp=$(now_stamp)
  file="$forge_dir/$stamp-$slug.md"
  test ! -e "$file" || fail "forge review already exists: $file"

  cat >"$file" <<EOF
# Forge Review

- Review ID: forge-$stamp-$slug
- Date/time: $(now_readable)
- Proposals reviewed:
- Decisions reviewed:
- Evals reviewed:
- Accepted capabilities reviewed:
- Prior Forge score history reviewed:
- Reviewer: Codex wearing the HyperAgent Suit

## Structured Summary

\`\`\`json
{
  "reviewed_artifacts": {
    "missions": [],
    "proposals": [],
    "decisions": [],
    "evals": [],
    "accepted_capabilities": [],
    "prior_forge_reviews": []
  },
  "scores": {
    "outcome_quality": {"score": null, "evidence": []},
    "proposal_specificity": {"score": null, "evidence": []},
    "eval_coverage": {"score": null, "evidence": []},
    "safety_boundary_preservation": {"score": null, "evidence": []},
    "regression_detection": {"score": null, "evidence": []},
    "process_bloat_risk": {"score": null, "evidence": []}
  },
  "pass_fail_gates": {
    "testable_behavior_claim": null,
    "owner_surface_named": null,
    "eval_or_check_plan": null,
    "rollback_or_human_review_boundary": null,
    "scores_have_evidence": null
  },
  "payoff_metrics": {
    "regressions_caught": 0,
    "repeat_friction_seen_again": 0,
    "manual_steps_removed": 0,
    "evals_added": 0,
    "artifacts_retired": 0
  },
  "recommendation": "",
  "confidence": "",
  "follow_up_required": false,
  "upgrade_id": ""
}
\`\`\`

## Outcome Quality

- Did accepted upgrades improve agent behavior?
- Which upgrades paid off?
- Which upgrades created process bloat?
- What behavior evidence supports the outcome judgment?
- Outcome quality score (0-5):
- Outcome quality evidence:

## Proposal Quality

- Are proposals specific and evidence-backed?
- Which templates or proposal sections produced vague output?
- Are priorities and decision handoffs clear?
- Are repeated friction patterns being missed?
- Proposal specificity score (0-5):
- Proposal specificity evidence:

## Eval Quality

- Are acceptance tests concrete enough to catch regressions?
- Did evals verify behavior instead of file presence only?
- Which regressions would current evals miss?
- Eval coverage score (0-5):
- Eval coverage evidence:
- Regression detection score (0-5):
- Regression detection evidence:

## Safety Quality

- Are safety risks explicit?
- Are activation modes appropriate?
- Are authority, permission, secrets, deployment, and rollback boundaries clear?
- Are rejected or deferred upgrades recorded with reasons?
- Safety boundary preservation score (0-5):
- Safety boundary preservation evidence:

## Process Quality

- Are process costs proportionate to the value of the upgrade?
- Are accepted capabilities traceable from mission evidence to proposal, decision, eval, and registry entry?
- Process bloat risk score (0-5):
- Process bloat risk evidence:

## Deterministic Gates

- Testable behavior claim present: yes/no
- Owner surface named: yes/no
- Eval or check plan present: yes/no
- Rollback or human-review boundary present: yes/no
- Every score has evidence: yes/no
- Gate result: ready/not ready

## Process Improvement Proposal

- Workshop process friction:
- Proposed process change:
- Expected effect:
- Eval for the process change:
- Rollback plan:
- Generate proposal when:
- Suggested proposal command: \`sh scripts/hyperagent.sh propose-upgrade --forge-review PATH --title "..." --problem "..."\`

## Decision

- Recommendation:
- Human approval needed:
- Follow-up proposal path:
EOF

  printf '%s\n' "$file"
}

print_forge_prompt() {
  cat <<'EOF'
Use HyperAgent Forge Mode.

Read recent Workshop proposals in workshop/proposals/, decisions in workshop/decisions/, accepted capabilities in hyperagent/capability-registry.md, evals in evals/ plus scripts/verify-mvp.sh, and prior Forge score history in forge/reviews/. Judge outcome quality, proposal specificity, eval coverage, safety boundary preservation, regression detection, and process bloat risk with 0-5 scores. Every score must cite evidence or a missing-artifact reason. Fill the structured summary, deterministic gates, payoff metrics, recommendation, confidence, and follow-up fields in templates/forge-review.md. Run Forge reviews when proposals are accepted or rejected, evals change, a release checklist asks whether upgrades paid off, or repeated missions show the Workshop producing vague or low-value proposals. If the Workshop process needs an upgrade, create a separate process-improvement proposal with sh scripts/hyperagent.sh propose-upgrade --forge-review PATH --title "..." --problem "...". Do not activate process changes without human approval.
EOF
}

record_decision() {
  proposal=
  decision=
  reviewer=
  reason=
  capability=

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --proposal)
        shift
        test "$#" -gt 0 || fail "--proposal requires a path"
        proposal=$1
        ;;
      --decision)
        shift
        test "$#" -gt 0 || fail "--decision requires accepted or rejected"
        decision=$1
        ;;
      --reviewer)
        shift
        test "$#" -gt 0 || fail "--reviewer requires a name"
        reviewer=$1
        ;;
      --reason)
        shift
        test "$#" -gt 0 || fail "--reason requires text"
        reason=$1
        ;;
      --capability)
        shift
        test "$#" -gt 0 || fail "--capability requires an id"
        capability=$(slugify "$1")
        ;;
      *)
        fail "unknown decide-upgrade option: $1"
        ;;
    esac
    shift
  done

  test -n "$proposal" || fail "decide-upgrade requires --proposal"
  test -f "$proposal" || fail "proposal not found: $proposal"
  case "$decision" in
    accepted|rejected) ;;
    *) fail "--decision must be accepted or rejected" ;;
  esac
  test -n "$reviewer" || fail "decide-upgrade requires --reviewer"
  test -n "$reason" || fail "decide-upgrade requires --reason"
  if [ "$decision" = accepted ]; then
    test -n "$capability" || fail "accepted decisions require --capability"
  fi

  ensure_dirs
  stamp=$(now_stamp)
  proposal_slug=$(basename "$proposal" .md | sed 's/[^a-zA-Z0-9][^a-zA-Z0-9]*/-/g')
  file="$decision_dir/$stamp-$decision-$proposal_slug.md"
  test ! -e "$file" || fail "decision already exists: $file"

  cat >"$file" <<EOF
# Upgrade Decision

- Decision ID: decision-$stamp-$decision-$proposal_slug
- Date/time: $(now_readable)
- Proposal: \`$proposal\`
- Decision: $decision
- Reviewer: $reviewer
- Reason: $reason
- Capability registry ID: $capability

## Authority Boundary

- Human approval recorded: yes
- Silent activation allowed: no
- Permission or secrets changes approved: no

## Rollback

- Rollback path: follow the proposal rollback plan and remove any registry entry associated with \`$capability\`.
EOF

  if [ "$decision" = accepted ]; then
    test -f "$registry_file" || fail "missing capability registry: $registry_file"
    cat >>"$registry_file" <<EOF

## $capability

- Status: accepted
- Proposal: \`$proposal\`
- Decision record: \`$file\`
- Accepted by: $reviewer
- Date/time: $(now_readable)
- Activation mode: human review required
- Rollback: remove this registry entry and revert files named by the decision/proposal.
EOF
  fi

  printf '%s\n' "$file"
}

command=${1:-help}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command" in
  init)
    init_project "$@"
    ;;
  status)
    print_status "$@"
    ;;
  new-mission)
    create_mission "$@"
    ;;
  propose-upgrade)
    create_proposal "$@"
    ;;
  workshop-prompt)
    print_workshop_prompt
    ;;
  new-forge-review)
    create_forge_review "$@"
    ;;
  forge-prompt)
    print_forge_prompt
    ;;
  decide-upgrade)
    record_decision "$@"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    fail "unknown command: $command"
    ;;
esac
