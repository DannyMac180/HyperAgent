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

  sense [--format markdown|json] [--command-log PATH] [--trace-url URL] [--workbench-trace-log PATH] [--pr auto|off] [--doctor]
      Print a compact local sensing summary. Use --doctor for sensing diagnostics.

  mission new --request TEXT [--slug SLUG] [--commands-run TEXT] [--verification-status TEXT]
      Create a mission record in missions/.

  mission closeout --mission PATH
      Audit a mission record for pending closeout placeholders.

  review prompt workshop|forge
      Print the repeatable Workshop or Forge prompt.

  review proposal --mission PATH --title TEXT --problem TEXT [--slug SLUG]
      Create a Workshop proposal in workshop/proposals/.

  review forge [--slug SLUG]
      Create a Forge review record in forge/reviews/.

  review decision --proposal PATH --decision accepted|rejected --reviewer NAME --reason TEXT [--capability ID]
      Record a human approval decision. Accepted decisions require --capability.

  verify core|extensions|release|all
      Run HyperAgent verification tiers.

  check -- COMMAND [ARG...]
      Run a local command and record passed/failed evidence.

  check --record --command TEXT --status passed|failed|retried|skipped [--note TEXT]
      Append an opt-in check or command result to the local evidence log.

  ui [--host HOST] [--port PORT]
      Serve the optional local HyperAgent UI evidence cockpit.

Legacy aliases:
  doctor, record-check, new-mission, propose-upgrade, workshop-prompt, new-forge-review, forge-prompt, decide-upgrade

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
  cat "$repo_root/templates/project-capability-registry.md"
}

generate_init_backlog() {
  cat "$repo_root/templates/project-backlog.md"
}

generate_init_config() {
  cat "$repo_root/templates/project-config.toml"
}

generate_init_readme() {
  cat "$repo_root/templates/project-readme.md"
}

generate_init_agents_block() {
  cat "$repo_root/templates/project-agents-block.md"
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
    "$target_root/hyperagent"
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
  init_write_generated "$target_root/.hyperagent" "$force" "$dry_run" generate_init_config
  init_write_generated "$target_root/workshop/backlog.md" "$force" "$dry_run" generate_init_backlog
  init_write_generated "$target_root/hyperagent/capability-registry.md" "$force" "$dry_run" generate_init_registry
  init_write_generated "$target_root/hyperagent/README.md" "$force" "$dry_run" generate_init_readme
  init_update_agents "$target_root" "$force" "$dry_run"

  init_log "HyperAgent init complete."
  init_log "Next: inspect AGENTS.md, add project-specific verification commands, then run HyperAgent status from your installed HyperAgent helper."
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
  printf 'Product state: %s\n' "$repo_root/docs/product-state.md"
  printf 'Optional extensions: %s\n' "$repo_root/docs/extensions.md"
  printf 'Accepted capabilities:\n'
  awk '/^## / && $0 !~ /Accepted Capabilities|Capability Entry Template/ { sub(/^## /, "- "); print }' "$registry_file"
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

run_check() {
  if [ "${1:-}" = "--record" ]; then
    shift
    record_check "$@"
    return 0
  fi

  if [ "${1:-}" = "--" ]; then
    shift
  fi
  test "$#" -gt 0 || fail "check requires a command after --"

  command_text=$*
  if "$@"; then
    record_check --status passed --command "$command_text" --note "command completed" >/dev/null
    return 0
  fi
  status=$?
  record_check --status failed --command "$command_text" --note "command exited with status $status" >/dev/null
  return "$status"
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
  doctor_mode=0

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --doctor)
        doctor_mode=1
        ;;
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

  if [ "$doctor_mode" -eq 1 ]; then
    print_doctor --workbench-trace-log "$workbench_trace_log"
    return 0
  fi

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

serve_ui() {
  command -v node >/dev/null 2>&1 || fail "node is required to run the HyperAgent UI"
  exec node "$repo_root/scripts/hyperagent-ui.mjs" "$@"
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

## Artifact Metadata

- Artifact type: mission
- Artifact status: draft

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

mission_closeout() {
  mission=

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --mission)
        shift
        test "$#" -gt 0 || fail "--mission requires a path"
        mission=$1
        ;;
      *)
        fail "unknown mission closeout option: $1"
        ;;
    esac
    shift
  done

  test -n "$mission" || fail "mission closeout requires --mission"
  test -f "$mission" || fail "mission record not found: $mission"

  printf 'HyperAgent mission closeout audit\n'
  printf 'Mission: %s\n' "$mission"

  pending=$(grep -n -E 'Pending final outcome|Pending unresolved risk review|Pending verification|Replace during mission closeout|Not captured by helper' "$mission" || true)
  if [ -n "$pending" ]; then
    printf 'Status: needs closeout\n'
    printf '%s\n' "$pending"
    printf '\nRecent local sense summary follows.\n\n'
    print_sense --pr off
    return 1
  fi

  printf 'Status: closeout complete\n'
  print_sense --pr off
}

create_proposal() {
  mission=
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

  test -n "$mission" || fail "propose-upgrade requires --mission"
  test -f "$mission" || fail "mission record not found: $mission"
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
- Related mission record: \`$mission\`
- Proposed activation mode: human review required
- Allowed activation modes: suggest only; draft files only; human review required; auto-install low risk
- Backlog priority:
- Workshop rubric score:

## Artifact Metadata

- Artifact type: proposal
- Artifact status: draft

## Problem

- Problem observed: $problem
- Evidence from mission records:
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

Read recent mission records in missions/. Identify concrete Suit friction supported by evidence. Choose the highest-value friction, then create or update a proposal in workshop/proposals/ using templates/upgrade-proposal.md. Include the linked mission record, proposed capability, safety risk, eval or acceptance test, rollback plan, and an Implementation Plan with the highest-priority step first. Do not activate the upgrade. Default the activation mode to human review required.
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
- Reviewer: Codex wearing the HyperAgent Suit

## Artifact Metadata

- Artifact type: forge-review
- Artifact status: draft

## Workshop Quality

- Are proposals specific and evidence-backed?
- Are acceptance tests concrete?
- Are safety risks explicit?
- Are activation modes appropriate?
- Are repeated friction patterns being missed?
- Proposal quality score:
- Process reliability score:

## Process Upgrade Candidates

- Workshop process friction:
- Proposed process change:
- Expected effect:
- Eval for the process change:
- Rollback plan:

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

Read recent Workshop proposals in workshop/proposals/ and decisions in workshop/decisions/. Judge whether the Workshop is producing proposals that are specific, evidence-backed, testable, safe, and worth installing. Write a Forge review in forge/reviews/ using templates/forge-review.md. If the Workshop process needs an upgrade, create a separate proposal that changes the proposal template, rubric, eval format, telemetry capture, or approval policy. Do not activate process changes without human approval.
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

## Artifact Metadata

- Artifact type: decision
- Artifact status: $decision

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

mission_command() {
  subcommand=${1:-help}
  if [ "$#" -gt 0 ]; then
    shift
  fi

  case "$subcommand" in
    new)
      create_mission "$@"
      ;;
    closeout)
      mission_closeout "$@"
      ;;
    help|-h|--help)
      printf '%s\n' "Usage: sh scripts/hyperagent.sh mission new|closeout [options]"
      ;;
    *)
      fail "unknown mission command: $subcommand"
      ;;
  esac
}

review_command() {
  subcommand=${1:-help}
  if [ "$#" -gt 0 ]; then
    shift
  fi

  case "$subcommand" in
    prompt)
      prompt=${1:-}
      case "$prompt" in
        workshop) print_workshop_prompt ;;
        forge) print_forge_prompt ;;
        *) fail "review prompt requires workshop or forge" ;;
      esac
      ;;
    proposal)
      create_proposal "$@"
      ;;
    forge)
      create_forge_review "$@"
      ;;
    decision)
      record_decision "$@"
      ;;
    help|-h|--help)
      printf '%s\n' "Usage: sh scripts/hyperagent.sh review prompt|proposal|forge|decision [options]"
      ;;
    *)
      fail "unknown review command: $subcommand"
      ;;
  esac
}

verify_command() {
  tier=${1:-core}
  case "$tier" in
    core|mvp)
      (cd "$repo_root" && sh scripts/verify-core.sh)
      ;;
    extensions|extension)
      (cd "$repo_root" && sh scripts/verify-extensions.sh)
      ;;
    release)
      (cd "$repo_root" && sh scripts/verify-release.sh)
      ;;
    all)
      (cd "$repo_root" && sh scripts/verify-core.sh)
      (cd "$repo_root" && sh scripts/verify-extensions.sh)
      (cd "$repo_root" && sh scripts/verify-release.sh)
      ;;
    help|-h|--help)
      printf '%s\n' "Usage: sh scripts/hyperagent.sh verify core|extensions|release|all"
      ;;
    *)
      fail "unknown verify tier: $tier"
      ;;
  esac
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
  mission)
    mission_command "$@"
    ;;
  review)
    review_command "$@"
    ;;
  verify)
    verify_command "$@"
    ;;
  check)
    run_check "$@"
    ;;
  doctor)
    print_sense --doctor "$@"
    ;;
  ui)
    serve_ui "$@"
    ;;
  record-check)
    run_check --record "$@"
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
