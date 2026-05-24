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

  sense [--format markdown|json] [--command-log PATH] [--trace-url URL] [--workbench-trace-log PATH] [--pr auto|off]
      Print a compact local sensing summary for mission records.

  doctor [--workbench-trace-log PATH]
      Print local diagnostics for HyperAgent sensing and Workbench trace enrichment.

  record-check --command TEXT --status passed|failed|retried|skipped [--note TEXT]
      Append an opt-in check or command result to the local evidence log.

  new-mission --request TEXT [--slug SLUG] [--commands-run TEXT] [--verification-status TEXT]
      Create a mission record in missions/.

  propose-upgrade (--mission PATH | --forge-review PATH) --title TEXT --problem TEXT [--slug SLUG]
      Create a Workshop proposal in workshop/proposals/ from mission evidence or Forge review evidence.

  workshop-prompt
      Print the repeatable Workshop review prompt.

  new-forge-review [--slug SLUG]
      Create a Forge review record in forge/reviews/.

  forge audit [--write-proposal]
  forge-audit [--write-proposal]
      Audit Workshop proposals, decisions, registry traceability, and eval coverage.

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
default_evidence_dir="$repo_root/.hyperagent-evidence"
default_command_log="$default_evidence_dir/commands.log"
default_workbench_trace_log="$default_evidence_dir/workbench/traces.jsonl"
eval_dir="$repo_root/evals"

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

redact_stream() {
  awk '
    {
      redact_next = 0
      for (i = 1; i <= NF; i++) {
        lower = tolower($i)
        if (redact_next == 1) {
          $i = "[REDACTED]"
          redact_next = 0
          continue
        }
        if (lower ~ /(token|secret|password|passwd|api_key|access_key|private_key|bearer)/) {
          if ($i ~ /=/) {
            sub(/=.*/, "=[REDACTED]", $i)
          } else {
            $i = "[REDACTED]"
          }
          if (lower ~ /bearer/) {
            redact_next = 1
          }
        }
      }
      print
    }
  '
}

redact_text() {
  printf '%s\n' "$1" | redact_stream
}

trim_text() {
  sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

field_value() {
  file="$1"
  label="$2"
  awk -v label="$label" '
    index($0, "- " label ":") == 1 {
      sub("^- " label ":[[:space:]]*", "")
      print
      exit
    }
  ' "$file" | trim_text
}

meaningful_value() {
  value=$(printf '%s' "$1" | trim_text)
  case "$value" in
    ''|'-'|'`'|'``'|'yes/no'|'ready/not ready'|'PATH'|'PATH '*|'Pending '*|'pending')
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

strip_ticks() {
  printf '%s' "$1" | sed 's/^`//; s/`$//'
}

repo_relative_path() {
  path="$1"
  case "$path" in
    "$repo_root"/*) printf '%s\n' "${path#$repo_root/}" ;;
    *) printf '%s\n' "$path" ;;
  esac
}

path_exists_from_repo() {
  raw_path=$(strip_ticks "$1")
  meaningful_value "$raw_path" || return 1
  case "$raw_path" in
    /*) test -f "$raw_path" ;;
    *) test -f "$repo_root/$raw_path" ;;
  esac
}

json_escape() {
  awk '
    BEGIN { ORS = "" }
    {
      gsub(/\\/, "\\\\")
      gsub(/"/, "\\\"")
      gsub(/\t/, "\\t")
      gsub(/\r/, "\\r")
      if (line_seen) {
        printf "\\n"
      }
      printf "%s", $0
      line_seen = 1
    }
  '
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
evidence_log = ".hyperagent-evidence/commands.log"
workbench_trace_log = ".hyperagent-evidence/workbench/traces.jsonl"

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
sh scripts/hyperagent.sh sense
sh scripts/hyperagent.sh record-check --status passed --command "sh scripts/verify-mvp.sh"
sh scripts/hyperagent.sh doctor
sh scripts/hyperagent.sh new-mission --request "Describe the task" --slug task-slug
sh scripts/hyperagent.sh workshop-prompt
sh scripts/hyperagent.sh forge-prompt
sh scripts/hyperagent.sh propose-upgrade --forge-review forge/reviews/REVIEW.md --title "Improve Workshop quality" --problem "The Workshop process needs a concrete fix"
sh scripts/hyperagent.sh forge audit
```

## Verification

Run Forge reviews after proposal decisions, eval changes, release-readiness checks, or repeated vague Workshop output. Forge process improvements should become normal Workshop proposals linked to the Forge review and remain `human review required`.

For this project, the lightweight check is:

```bash
sh scripts/hyperagent.sh status
```

To capture local task evidence for mission records:

```bash
sh scripts/hyperagent.sh record-check --status passed --command "sh scripts/verify-mvp.sh"
sh scripts/hyperagent.sh sense
```

The sensing summary reads Git metadata, the opt-in local command log, and local Workbench trace metadata when the default ignored trace log exists. It does not inspect repository file contents or environment values, and command text is redacted for secret-like tokens before storage and output.

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

is_git_repo() {
  command -v git >/dev/null 2>&1 && git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

git_branch() {
  if is_git_repo; then
    git -C "$repo_root" symbolic-ref --short HEAD 2>/dev/null \
      || git -C "$repo_root" rev-parse --short HEAD 2>/dev/null \
      || printf 'unknown'
  else
    printf 'not a git repository'
  fi
}

git_status_short() {
  if is_git_repo; then
    status=$(git -C "$repo_root" status --short 2>/dev/null || true)
    if [ -n "$status" ]; then
      printf '%s\n' "$status"
    else
      printf 'clean\n'
    fi
  else
    printf 'not a git repository\n'
  fi
}

git_changed_files() {
  if is_git_repo; then
    status=$(git -C "$repo_root" status --short 2>/dev/null || true)
    if [ -n "$status" ]; then
      printf '%s\n' "$status" | sed 's/^...//'
    else
      printf 'none\n'
    fi
  else
    printf 'not a git repository\n'
  fi
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

record_check() {
  command_text=
  status=
  note=
  log_file="$default_command_log"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --command)
        shift
        test "$#" -gt 0 || fail "--command requires text"
        command_text=$1
        ;;
      --status)
        shift
        test "$#" -gt 0 || fail "--status requires passed, failed, retried, or skipped"
        status=$1
        ;;
      --note)
        shift
        test "$#" -gt 0 || fail "--note requires text"
        note=$1
        ;;
      --command-log)
        shift
        test "$#" -gt 0 || fail "--command-log requires a path"
        log_file=$1
        ;;
      *)
        fail "unknown record-check option: $1"
        ;;
    esac
    shift
  done

  test -n "$command_text" || fail "record-check requires --command"
  case "$status" in
    passed|failed|retried|skipped) ;;
    *) fail "--status must be passed, failed, retried, or skipped" ;;
  esac

  mkdir -p "$(dirname "$log_file")"
  safe_command=$(redact_text "$command_text")
  safe_note=$(redact_text "$note")
  printf '%s\t%s\t%s\t%s\n' "$(now_readable)" "$status" "$safe_command" "$safe_note" >>"$log_file"
  printf '%s\n' "$log_file"
}

git_value() {
  if git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$repo_root" "$@" 2>/dev/null || true
  fi
}

git_changed_files() {
  if git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$repo_root" status --porcelain=v1 2>/dev/null | awk '{ print substr($0, 4) }'
  fi
}

git_status_counts() {
  if git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$repo_root" status --porcelain=v1 2>/dev/null | awk '
      BEGIN { modified = 0; added = 0; deleted = 0; renamed = 0; untracked = 0 }
      {
        code = substr($0, 1, 2)
        if (code == "??") {
          untracked++
        }
        if (code ~ /M/) {
          modified++
        }
        if (code ~ /A/) {
          added++
        }
        if (code ~ /D/) {
          deleted++
        }
        if (code ~ /R/) {
          renamed++
        }
      }
      END {
        printf "modified=%d added=%d deleted=%d renamed=%d untracked=%d", modified, added, deleted, renamed, untracked
      }
    '
  else
    printf 'not a git repository'
  fi
}

read_recent_commands() {
  log_file="$1"
  if [ -f "$log_file" ]; then
    tail -n 12 "$log_file" | redact_stream
  fi
}

read_failure_commands() {
  log_file="$1"
  if [ -f "$log_file" ]; then
    tail -n 50 "$log_file" | awk -F '\t' '$2 == "failed" || $2 == "retried" { print }' | tail -n 8 | redact_stream
  fi
}

workbench_trace_log_path() {
  override="$1"
  if [ -n "$override" ]; then
    printf '%s\n' "$override"
    return 0
  fi
  if [ -n "${HYPERAGENT_WORKBENCH_TRACE_LOG:-}" ]; then
    printf '%s\n' "$HYPERAGENT_WORKBENCH_TRACE_LOG"
    return 0
  fi
  printf '%s\n' "$default_workbench_trace_log"
}

workbench_trace_status() {
  trace_log="$1"
  if [ ! -e "$trace_log" ]; then
    printf 'unavailable: trace log not found'
    return 0
  fi
  if [ ! -r "$trace_log" ]; then
    printf 'unhealthy: trace log is not readable'
    return 0
  fi
  trace_count=$(wc -l <"$trace_log" 2>/dev/null | tr -d ' ' || true)
  test -n "$trace_count" || trace_count=0
  if [ "$trace_count" -eq 0 ] 2>/dev/null; then
    printf 'healthy: trace log readable, no trace entries yet'
    return 0
  fi
  printf 'healthy: %s local trace entries available' "$trace_count"
}

read_workbench_traces() {
  trace_log="$1"
  if [ -r "$trace_log" ]; then
    tail -n 8 "$trace_log" | redact_stream | awk '
      length($0) > 240 { print substr($0, 1, 237) "..."; next }
      { print }
    '
  fi
}

pr_summary() {
  pr_mode="$1"
  test "$pr_mode" = auto || return 0
  command -v gh >/dev/null 2>&1 || return 0

  pr_line=$(cd "$repo_root" && gh pr view --json number,url,state,headRefName,baseRefName --jq '"#\(.number) \(.state) \(.headRefName)->\(.baseRefName) \(.url)"' 2>/dev/null || true)
  test -n "$pr_line" || return 0
  printf '%s\n' "$pr_line"

  checks_line=$(cd "$repo_root" && gh pr checks --json name,state,conclusion --jq 'group_by(.state) | map("\(.[0].state)=\(length)") | join(", ")' 2>/dev/null || true)
  if [ -n "$checks_line" ]; then
    printf 'checks: %s\n' "$checks_line"
  fi
}

print_sense_markdown() {
  command_log="$1"
  trace_url="$2"
  pr_mode="$3"
  workbench_trace_log="$4"
  branch=$(git_value rev-parse --abbrev-ref HEAD)
  upstream=$(git_value rev-parse --abbrev-ref --symbolic-full-name '@{u}')
  head_sha=$(git_value rev-parse --short HEAD)
  status_counts=$(git_status_counts)
  changed_files=$(git_changed_files)
  recent_commands=$(read_recent_commands "$command_log")
  failure_commands=$(read_failure_commands "$command_log")
  pr_info=$(pr_summary "$pr_mode")
  workbench_status=$(workbench_trace_status "$workbench_trace_log")
  workbench_traces=$(read_workbench_traces "$workbench_trace_log")

  printf '# HyperAgent Sense Summary\n\n'
  printf '%s\n' "- Generated: $(now_readable)"
  printf '%s\n' "- Repo: \`$repo_root\`"
  printf '%s\n' "- Branch: \`${branch:-unavailable}\`"
  printf '%s\n' "- Upstream: \`${upstream:-none}\`"
  printf '%s\n' "- HEAD: \`${head_sha:-unavailable}\`"
  printf '%s\n' "- Git status counts: \`$status_counts\`"
  printf '%s\n' "- Command log: \`$command_log\`"
  if [ -n "$trace_url" ]; then
    printf '%s\n' "- Trace: $(redact_text "$trace_url")"
  else
    printf '%s\n' "- Trace: not provided"
  fi
  printf '%s\n' "- Workbench trace log: \`$workbench_trace_log\`"
  printf '%s\n' "- Workbench trace status: \`$workbench_status\`"
  printf '\n## Changed Files\n\n'
  if [ -n "$changed_files" ]; then
    printf '%s\n' "$changed_files" | sed 's/^/- `/' | sed 's/$/`/'
  else
    printf '%s\n' "- none"
  fi
  printf '\n## Recent Commands And Checks\n\n'
  if [ -n "$recent_commands" ]; then
    printf '%s\n' "$recent_commands" | awk -F '\t' '{ printf "- %s `%s` %s", $2, $3, $1; if ($4 != "") { printf " - %s", $4 } printf "\n" }'
  else
    printf '%s\n' "- no command log entries found"
  fi
  printf '\n## Failures And Retries\n\n'
  if [ -n "$failure_commands" ]; then
    printf '%s\n' "$failure_commands" | awk -F '\t' '{ printf "- %s `%s` %s", $2, $3, $1; if ($4 != "") { printf " - %s", $4 } printf "\n" }'
  else
    printf '%s\n' "- none recorded"
  fi
  printf '\n## PR And CI\n\n'
  if [ -n "$pr_info" ]; then
    printf '%s\n' "$pr_info" | sed 's/^/- /'
  else
    printf '%s\n' "- not available locally"
  fi
  printf '\n## Workbench Traces\n\n'
  if [ -n "$workbench_traces" ]; then
    printf '%s\n' "$workbench_traces" | sed 's/^/- `/' | sed 's/$/`/'
  else
    printf '%s\n' "- no local Workbench traces available"
  fi
  printf '\n## Safety\n\n'
  printf '%s\n' "- Does not inspect file contents, environment variables, shell history, credentials, or hosted services unless optional PR lookup is enabled and available."
  printf '%s\n' "- Command and Workbench evidence is local, redacted for secret-like tokens before output, and safe to omit when unavailable."
}

print_json_array_from_lines() {
  lines="$1"
  if [ -z "$lines" ]; then
    printf '[]'
    return 0
  fi
  printf '%s\n' "$lines" | awk '
    BEGIN { printf "[" }
    {
      gsub(/\\/, "\\\\")
      gsub(/"/, "\\\"")
      gsub(/\t/, "\\t")
      gsub(/\r/, "\\r")
      if (NR > 1) {
        printf ","
      }
      printf "\"%s\"", $0
    }
    END { printf "]" }
  '
}

print_sense_json() {
  command_log="$1"
  trace_url="$2"
  pr_mode="$3"
  workbench_trace_log="$4"
  branch=$(git_value rev-parse --abbrev-ref HEAD)
  upstream=$(git_value rev-parse --abbrev-ref --symbolic-full-name '@{u}')
  head_sha=$(git_value rev-parse --short HEAD)
  status_counts=$(git_status_counts)
  changed_files=$(git_changed_files)
  recent_commands=$(read_recent_commands "$command_log")
  failure_commands=$(read_failure_commands "$command_log")
  pr_info=$(pr_summary "$pr_mode")
  workbench_status=$(workbench_trace_status "$workbench_trace_log")
  workbench_traces=$(read_workbench_traces "$workbench_trace_log")

  printf '{\n'
  printf '  "generated": "%s",\n' "$(now_readable | json_escape)"
  printf '  "repo": "%s",\n' "$(printf '%s' "$repo_root" | json_escape)"
  printf '  "branch": "%s",\n' "$(printf '%s' "${branch:-unavailable}" | json_escape)"
  printf '  "upstream": "%s",\n' "$(printf '%s' "${upstream:-none}" | json_escape)"
  printf '  "head": "%s",\n' "$(printf '%s' "${head_sha:-unavailable}" | json_escape)"
  printf '  "git_status_counts": "%s",\n' "$(printf '%s' "$status_counts" | json_escape)"
  printf '  "changed_files": '
  print_json_array_from_lines "$changed_files"
  printf ',\n'
  printf '  "command_log": "%s",\n' "$(printf '%s' "$command_log" | json_escape)"
  printf '  "recent_commands": '
  print_json_array_from_lines "$recent_commands"
  printf ',\n'
  printf '  "failures_and_retries": '
  print_json_array_from_lines "$failure_commands"
  printf ',\n'
  printf '  "pr_and_ci": '
  print_json_array_from_lines "$pr_info"
  printf ',\n'
  printf '  "trace": "%s",\n' "$(redact_text "$trace_url" | json_escape)"
  printf '  "workbench": {\n'
  printf '    "trace_log": "%s",\n' "$(printf '%s' "$workbench_trace_log" | json_escape)"
  printf '    "status": "%s",\n' "$(printf '%s' "$workbench_status" | json_escape)"
  printf '    "recent_traces": '
  print_json_array_from_lines "$workbench_traces"
  printf '\n'
  printf '  },\n'
  printf '  "safety": "Does not inspect file contents, environment variables, shell history, credentials, or hosted services unless optional PR lookup is enabled and available. Command and Workbench evidence is local, redacted for secret-like tokens before output, and safe to omit when unavailable."\n'
  printf '}\n'
}

print_sense() {
  format=markdown
  command_log="$default_command_log"
  trace_url=
  pr_mode=auto
  workbench_trace_log_override=

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --format)
        shift
        test "$#" -gt 0 || fail "--format requires markdown or json"
        format=$1
        ;;
      --command-log)
        shift
        test "$#" -gt 0 || fail "--command-log requires a path"
        command_log=$1
        ;;
      --trace-url)
        shift
        test "$#" -gt 0 || fail "--trace-url requires a URL or local trace reference"
        trace_url=$1
        ;;
      --workbench-trace-log)
        shift
        test "$#" -gt 0 || fail "--workbench-trace-log requires a path"
        workbench_trace_log_override=$1
        ;;
      --pr)
        shift
        test "$#" -gt 0 || fail "--pr requires auto or off"
        pr_mode=$1
        ;;
      *)
        fail "unknown sense option: $1"
        ;;
    esac
    shift
  done

  workbench_trace_log=$(workbench_trace_log_path "$workbench_trace_log_override")

  case "$format" in
    markdown) print_sense_markdown "$command_log" "$trace_url" "$pr_mode" "$workbench_trace_log" ;;
    json) print_sense_json "$command_log" "$trace_url" "$pr_mode" "$workbench_trace_log" ;;
    *) fail "--format must be markdown or json" ;;
  esac
}

print_doctor() {
  workbench_trace_log_override=

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --workbench-trace-log)
        shift
        test "$#" -gt 0 || fail "--workbench-trace-log requires a path"
        workbench_trace_log_override=$1
        ;;
      *)
        fail "unknown doctor option: $1"
        ;;
    esac
    shift
  done

  workbench_trace_log=$(workbench_trace_log_path "$workbench_trace_log_override")

  printf 'HyperAgent doctor\n'
  printf 'Repo: %s\n' "$repo_root"
  if git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'Git: healthy\n'
  else
    printf 'Git: unavailable\n'
  fi
  if [ -e "$default_command_log" ]; then
    printf 'Command log: %s\n' "$default_command_log"
  else
    printf 'Command log: not initialized yet (%s)\n' "$default_command_log"
  fi
  printf 'Workbench trace log: %s\n' "$workbench_trace_log"
  printf 'Workbench trace status: %s\n' "$(workbench_trace_status "$workbench_trace_log")"
  printf 'Workbench retention: local ignored evidence; keep only recent mission-relevant traces and prune manually or with your local Workbench policy.\n'
  printf 'Workbench redaction: HyperAgent redacts secret-like tokens before sense output; Workbench may still store local prompts, tool payloads, file paths, and command outputs.\n'
  printf 'Fallback: sense remains usable without Workbench traces.\n'
}

create_mission() {
  request=
  slug=
  commands_run='Not captured by helper. Add commands manually during mission closeout.'
  verification_status='Pending verification. Replace with the final verification result during mission closeout.'

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
      --commands-run)
        shift
        test "$#" -gt 0 || fail "--commands-run requires text"
        commands_run=$1
        ;;
      --verification-status)
        shift
        test "$#" -gt 0 || fail "--verification-status requires text"
        verification_status=$1
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
  branch=$(git_branch)
  git_status=$(git_status_short)
  changed_files=$(git_changed_files)

  cat >"$file" <<EOF
# Mission Record

- Mission ID: mission-$stamp-$slug
- Date/time: $(now_readable)
- Agent identity: Codex wearing the HyperAgent Suit
- Environment: \`$repo_root\`
- User request: $request

## Repository Evidence

- Repo path: \`$repo_root\`
- Branch: \`$branch\`
- Git status:

~~~text
$git_status
~~~

- Changed files:

~~~text
$changed_files
~~~

## Execution Evidence

- Commands run: $commands_run
- Verification status: $verification_status

## Outcome

- Final outcome: Pending final outcome. Replace during mission closeout.
- Completion evidence:
- Unresolved risks: Pending unresolved risk review. Replace during mission closeout.

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

proposal_has_decision() {
  proposal="$1"
  rel=$(repo_relative_path "$proposal")
  base=$(basename "$proposal")
  find "$decision_dir" -maxdepth 1 -type f -name '*.md' 2>/dev/null | while IFS= read -r decision_file; do
    if grep -F -e "\`$rel\`" -e "$rel" -e "\`$proposal\`" -e "$proposal" -e "$base" "$decision_file" >/dev/null 2>&1; then
      printf '%s\n' "$decision_file"
      break
    fi
  done
}

audit_proposals() {
  findings_file="$1"
  find "$proposal_dir" -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort | while IFS= read -r proposal; do
    rel=$(repo_relative_path "$proposal")
    missing_quality=

    evidence_missions=$(field_value "$proposal" "Evidence from mission records")
    evidence_forge=$(field_value "$proposal" "Evidence from Forge reviews")
    if ! meaningful_value "$evidence_missions" && ! meaningful_value "$evidence_forge"; then
      missing_quality="${missing_quality} evidence"
    fi

    proposed_capability=$(field_value "$proposal" "Proposed capability")
    first_step=$(field_value "$proposal" "Highest-priority plan step")
    changed_files=$(field_value "$proposal" "Files or instructions likely to change")
    if ! meaningful_value "$proposed_capability" || ! meaningful_value "$first_step" || ! meaningful_value "$changed_files"; then
      missing_quality="${missing_quality} specificity"
    fi

    eval_plan=$(field_value "$proposal" "Eval or acceptance test")
    if ! meaningful_value "$eval_plan"; then
      missing_quality="${missing_quality} acceptance-test"
    fi

    safety_risk=$(field_value "$proposal" "Safety risk")
    authority_change=$(field_value "$proposal" "Permission or authority changes")
    human_review=$(field_value "$proposal" "Human approval required before activation")
    if ! meaningful_value "$safety_risk" || ! meaningful_value "$authority_change" || ! printf '%s' "$human_review" | grep -i 'yes' >/dev/null 2>&1; then
      missing_quality="${missing_quality} safety"
    fi

    rollback_plan=$(field_value "$proposal" "Rollback plan")
    if ! meaningful_value "$rollback_plan"; then
      missing_quality="${missing_quality} rollback"
    fi

    recommended_decision=$(field_value "$proposal" "Recommended decision")
    decision_record_path=$(field_value "$proposal" "Decision record path")
    capability_id=$(field_value "$proposal" "Capability registry ID if accepted")
    if ! meaningful_value "$recommended_decision" || ! meaningful_value "$decision_record_path" || ! meaningful_value "$capability_id"; then
      missing_quality="${missing_quality} decision-handoff"
    fi

    if [ -n "$missing_quality" ]; then
      cleaned=$(printf '%s' "$missing_quality" | sed 's/^ //; s/ /, /g')
      printf '%s\n' "- [weak-proposal] \`$rel\`: missing $cleaned." >>"$findings_file"
    fi

    decision_match=$(proposal_has_decision "$proposal" | head -n 1)
    if [ -z "$decision_match" ] && ! path_exists_from_repo "$decision_record_path"; then
      printf '%s\n' "- [stale-proposal] \`$rel\`: no matching decision record found." >>"$findings_file"
    fi
  done
}

audit_decisions() {
  findings_file="$1"
  find "$decision_dir" -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort | while IFS= read -r decision_file; do
    rel=$(repo_relative_path "$decision_file")
    proposal_path=$(field_value "$decision_file" "Proposal")
    decision_value=$(field_value "$decision_file" "Decision")
    capability=$(field_value "$decision_file" "Capability registry ID")

    if ! path_exists_from_repo "$proposal_path"; then
      printf '%s\n' "- [decision-link] \`$rel\`: proposal link is missing or points to a missing file." >>"$findings_file"
    fi

    if [ "$decision_value" = accepted ] && meaningful_value "$capability"; then
      if ! grep -F "## $capability" "$registry_file" >/dev/null 2>&1; then
        printf '%s\n' "- [decision-registry] \`$rel\`: accepted capability \`$capability\` is missing from the registry." >>"$findings_file"
      fi
    fi
  done
}

audit_registry() {
  findings_file="$1"
  test -f "$registry_file" || {
    printf '%s\n' "- [registry-traceability] \`$(repo_relative_path "$registry_file")\`: registry file is missing." >>"$findings_file"
    return 0
  }

  awk -v findings_file="$findings_file" -v registry_rel="$(repo_relative_path "$registry_file")" '
    function emit() {
      if (cap == "" || cap == "Accepted Capabilities" || cap == "Capability Entry Template") {
        return
      }
      missing = ""
      if (block !~ /- Source proposal:/) {
        missing = missing " source-proposal"
      }
      if (block !~ /- Decision record:/) {
        missing = missing " decision-record"
      }
      if (block !~ /- Verification:/) {
        missing = missing " evidence"
      }
      if (block !~ /- Rollback:/) {
        missing = missing " rollback"
      }
      if (missing != "") {
        gsub(/^ /, "", missing)
        gsub(/ /, ", ", missing)
        printf "- [registry-traceability] `%s#%s`: missing %s.\n", registry_rel, cap, missing >> findings_file
      }
    }
    /^## / {
      emit()
      cap = substr($0, 4)
      block = $0 "\n"
      next
    }
    cap != "" {
      block = block $0 "\n"
    }
    END {
      emit()
    }
  ' "$registry_file"
}

audit_evals() {
  findings_file="$1"
  if [ ! -f "$eval_dir/forge-audit-smoke.sh" ]; then
    printf '%s\n' "- [eval-coverage] \`evals/forge-audit-smoke.sh\`: missing Forge audit smoke eval." >>"$findings_file"
  fi
  if [ ! -d "$eval_dir/fixtures/forge-audit" ]; then
    printf '%s\n' "- [eval-coverage] \`evals/fixtures/forge-audit\`: missing good/weak proposal fixtures." >>"$findings_file"
  fi
}

generate_forge_audit_report() {
  findings_file=$(mktemp)
  audit_proposals "$findings_file"
  audit_decisions "$findings_file"
  audit_registry "$findings_file"
  audit_evals "$findings_file"

  proposal_count=$(count_markdown_files "$proposal_dir")
  decision_count=$(count_markdown_files "$decision_dir")
  registry_count=$(grep -c '^## ' "$registry_file" 2>/dev/null || true)
  eval_check_count=$(find "$eval_dir" -maxdepth 1 -type f -name '*forge-audit*' 2>/dev/null | wc -l | tr -d ' ')
  finding_count=$(wc -l <"$findings_file" | tr -d ' ')
  test -n "$finding_count" || finding_count=0

  printf '# Forge Audit\n\n'
  printf '%s\n' "- Generated: $(now_readable)"
  printf '%s\n' "- Proposals reviewed: $proposal_count"
  printf '%s\n' "- Decisions reviewed: $decision_count"
  printf '%s\n' "- Registry headings reviewed: $registry_count"
  printf '%s\n' "- Forge audit eval checks found: $eval_check_count"
  printf '%s\n' "- Finding count: $finding_count"
  if [ "$finding_count" -eq 0 ] 2>/dev/null; then
    printf '%s\n' "- Recommendation: no process proposal needed"
  else
    printf '%s\n' "- Recommendation: draft or review a human-review-required process proposal"
  fi

  printf '\n## Findings\n\n'
  if [ "$finding_count" -eq 0 ] 2>/dev/null; then
    printf '%s\n' "- none"
  else
    cat "$findings_file"
  fi

  printf '\n## Next Action\n\n'
  if [ "$finding_count" -eq 0 ] 2>/dev/null; then
    printf '%s\n' "- Continue using Forge reviews after proposal decisions and eval changes."
  else
    printf '%s\n' "- Resolve stale decisions, fill weak proposal fields, repair registry traceability, or run \`sh scripts/hyperagent.sh forge audit --write-proposal\` to draft a process-improvement proposal."
  fi

  rm -f "$findings_file"
}

create_forge_audit_process_proposal() {
  audit_summary="$1"
  stamp=$(now_stamp)
  slug=forge-audit-process-health
  file="$proposal_dir/$stamp-$slug.md"
  test ! -e "$file" || fail "proposal already exists: $file"
  finding_line=$(grep -F -- '- Finding count:' "$audit_summary" | head -n 1 | sed 's/^- Finding count: //')

  cat >"$file" <<EOF
# Upgrade Proposal

- Upgrade title: Improve Forge audit follow-through
- Proposal ID: proposal-$stamp-$slug
- Date/time: $(now_readable)
- Related mission record:
- Related Forge review:
- Evidence source type: forge audit
- Proposed activation mode: human review required
- Allowed activation modes: suggest only; draft files only; human review required; auto-install low risk
- Backlog priority: P2
- Workshop rubric score:

## Problem

- Problem observed: \`forge audit\` found $finding_line proposal, decision, registry, or eval process-health finding(s).
- Evidence from mission records:
- Evidence from Forge reviews: Forge audit output generated by \`sh scripts/hyperagent.sh forge audit\`.
- Why the current Suit was insufficient: The Workshop process needs explicit follow-through on stale decisions, weak proposal fields, registry traceability, and eval coverage.

## Proposed Capability

- Type of upgrade: Process improvement.
- Proposed capability: Add or tighten the smallest rule, template field, eval, or maintainer checklist item needed to prevent the repeated audit finding.
- Expected impact: Better proposal quality and traceability without silently accepting or installing process changes.
- Transferability: Useful across HyperAgent project workspaces that rely on local Markdown proposals, decisions, and registry entries.

## Implementation Plan

- Highest-priority plan step: Triage the audit findings and pick the smallest process change that prevents the most severe recurring issue.
- Implementation steps: Review audit findings; update the relevant template, rubric, helper, or eval; run \`sh scripts/hyperagent.sh forge audit\`; record a human decision before activation.
- Files or instructions likely to change: \`templates/upgrade-proposal.md\`, \`forge/process/quality-rubric.md\`, \`evals/\`, \`scripts/hyperagent.sh\`, or maintainer docs depending on the selected finding.
- Verification for the first step: Re-run \`sh scripts/hyperagent.sh forge audit\` and confirm the selected finding is resolved or intentionally deferred.

## Safety

- Safety risk: Low. This proposal changes local process artifacts only after human review.
- Permission or authority changes: None. It does not broaden filesystem, shell, network, account, deployment, or secrets access.
- Human approval required before activation: yes

## Evaluation

- Eval or acceptance test: \`sh scripts/hyperagent.sh forge audit\`; \`sh evals/forge-audit-smoke.sh\`.
- Rollback plan: Revert the process artifact changes and remove this proposal from the backlog if the audit rule proves too noisy.
- Open questions: Which finding is recurring enough to justify a template or eval change rather than a one-time cleanup?

## Decision Handoff

- Recommended decision: proposed
- Decision record path:
- Capability registry ID if accepted: forge-audit-process-health
EOF

  printf '%s\n' "$file"
}

run_forge_audit() {
  write_proposal=0

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --write-proposal)
        write_proposal=1
        ;;
      *)
        fail "unknown forge audit option: $1"
        ;;
    esac
    shift
  done

  audit_tmp=$(mktemp)
  generate_forge_audit_report >"$audit_tmp"
  cat "$audit_tmp"

  if [ "$write_proposal" -eq 1 ]; then
    finding_count=$(grep -F -- '- Finding count:' "$audit_tmp" | head -n 1 | sed 's/^- Finding count: //')
    test -n "$finding_count" || finding_count=0
    if [ "$finding_count" -gt 0 ] 2>/dev/null; then
      proposal_path=$(create_forge_audit_process_proposal "$audit_tmp")
      printf '\n%s\n' "Process proposal created: \`$(repo_relative_path "$proposal_path")\`"
    else
      printf '\n%s\n' "Process proposal created: none; no audit findings were strong enough."
    fi
  fi

  rm -f "$audit_tmp"
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
  sense)
    print_sense "$@"
    ;;
  doctor)
    print_doctor "$@"
    ;;
  record-check)
    record_check "$@"
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
  forge)
    subcommand=${1:-help}
    if [ "$#" -gt 0 ]; then
      shift
    fi
    case "$subcommand" in
      audit)
        run_forge_audit "$@"
        ;;
      help|-h|--help)
        usage
        ;;
      *)
        usage >&2
        fail "unknown forge subcommand: $subcommand"
        ;;
    esac
    ;;
  forge-audit)
    run_forge_audit "$@"
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
