#!/bin/sh
set -eu

usage() {
  cat <<'USAGE'
Usage: sh scripts/hyperagent.sh COMMAND [options]

Primary flows:
  init [--target DIR] [--update] [--force] [--dry-run]
      Create or update HyperAgent project setup files in DIR. Defaults to the current directory.

  sense [--format markdown|json] [--command-log PATH] [--trace-url URL] [--workbench-trace-log PATH] [--pr auto|off]
      Understand current repo state, recent checks, changed files, PR status, and local trace health.

  doctor [--workbench-trace-log PATH]
  sense --doctor [--workbench-trace-log PATH]
      Run local diagnostics for sensing and Workbench trace enrichment.

  mission new --request TEXT [--slug SLUG] [--commands-run TEXT] [--verification-status TEXT]
      Start a mission record in missions/.

  mission closeout --request TEXT [--mission PATH] [--slug SLUG] [--outcome TEXT] [--risks TEXT] [--candidate-upgrades TEXT]
      Close out a mission with sense, checks, changed files, risks, and Workshop prompts.

  mission verify [--strict] PATH
      Check a mission record. Strict mode fails placeholder closeout text.

  review workshop (--mission PATH | --forge-review PATH) --title TEXT --problem TEXT [--slug SLUG]
      Create a human-review-required Workshop proposal from mission or Forge evidence.

  review proposal (--mission PATH | --forge-review PATH) --title TEXT --problem TEXT [--slug SLUG]
      Compatibility alias for review workshop.

  review digest [--limit N] [--draft-proposal] [--title TEXT] [--slug SLUG]
      Review recent mission, Workshop, and Forge artifacts for backlog movement opportunities.

  review forge new [--slug SLUG]
      Create a Forge review record in forge/reviews/.

  review forge audit [--write-proposal]
      Audit Workshop proposal quality, decisions, registry traceability, and eval coverage.

  review decide --proposal PATH --decision accepted|rejected --reviewer NAME --reason TEXT [--capability ID]
      Record a human approval decision. Accepted decisions require --capability.

  review decision --proposal PATH --decision accepted|rejected --reviewer NAME --reason TEXT [--capability ID]
      Compatibility alias for review decide.

  verify core|extensions|release|all
      Run HyperAgent verification tiers.

  ui
      Open the local HyperAgent cockpit when available. Currently prints local status and roadmap pointers.

Compatibility and diagnostics:
  setup-hyperagent [options]
      Clone/update HyperAgent, verify it, install the Codex skill, and optionally init a target project.

  verify-config
      Validate the root .hyperagent project contract.

  verify-safety
      Validate proposal, decision, and accepted capability safety boundaries.

  status
      Print legacy local product status diagnostics.

  record-check --command TEXT --status passed|failed|retried|skipped [--note TEXT]
      Append an opt-in check or command result to the local evidence log.

  check [--note TEXT] [--command-log PATH] -- COMMAND [ARG...]
      Run a command and automatically record its pass/fail status.

  new-mission --request TEXT [--slug SLUG] [--commands-run TEXT] [--verification-status TEXT]
      Create a mission record in missions/.

  mission-closeout --request TEXT [--mission PATH] [--slug SLUG] [--outcome TEXT] [--risks TEXT] [--candidate-upgrades TEXT]
      Create or update a near-final mission record with current sense, checks, changed files, and review prompts.

  verify-mission [--strict] PATH
      Check a mission record. Strict mode fails placeholder closeout text.

  mission redact-check PATH...
      Flag mission evidence that should be redacted before public commit.

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

  workshop-digest [--limit N] [--draft-proposal] [--title TEXT] [--slug SLUG]
      Review recent missions, Workshop proposals, and Forge reviews for backlog movement opportunities.

  review-digest [--limit N] [--draft-proposal] [--title TEXT] [--slug SLUG]
      Compatibility alias for review digest.

  help
      Show this help.
USAGE
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
runtime_root=$(CDPATH= cd "$script_dir/.." && pwd)
repo_root=${HYPERAGENT_PROJECT_ROOT:-$runtime_root}
config_file="$repo_root/.hyperagent"

strip_toml_value() {
  sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^"//; s/"$//'
}

config_raw_value() {
  want_section="$1"
  want_key="$2"
  test -f "$config_file" || return 0
  awk -v want_section="$want_section" -v want_key="$want_key" '
    BEGIN { section = "" }
    /^[[:space:]]*($|#)/ { next }
    /^[[:space:]]*\[[^]]+\][[:space:]]*$/ {
      section = $0
      sub(/^[[:space:]]*\[/, "", section)
      sub(/\][[:space:]]*$/, "", section)
      next
    }
    section == want_section {
      line = $0
      sub(/[[:space:]]+#.*/, "", line)
      split(line, parts, "=")
      key = parts[1]
      sub(/^[[:space:]]*/, "", key)
      sub(/[[:space:]]*$/, "", key)
      if (key == want_key) {
        sub(/^[^=]*=/, "", line)
        print line
        exit
      }
    }
  ' "$config_file"
}

config_string_value() {
  config_raw_value "$1" "$2" | strip_toml_value
}

config_value_or_default() {
  value=$(config_string_value "$1" "$2")
  if [ -n "$value" ]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$3"
  fi
}

config_array_values() {
  want_section="$1"
  want_key="$2"
  test -f "$config_file" || return 0
  awk -v want_section="$want_section" -v want_key="$want_key" '
    function emit_strings(s) {
      while (match(s, /"[^"]*"/)) {
        print substr(s, RSTART + 1, RLENGTH - 2)
        s = substr(s, RSTART + RLENGTH)
      }
    }
    BEGIN { section = ""; capture = 0 }
    /^[[:space:]]*($|#)/ { next }
    /^[[:space:]]*\[[^]]+\][[:space:]]*$/ {
      section = $0
      sub(/^[[:space:]]*\[/, "", section)
      sub(/\][[:space:]]*$/, "", section)
      next
    }
    section == want_section && capture == 0 {
      line = $0
      sub(/[[:space:]]+#.*/, "", line)
      key = line
      sub(/=.*/, "", key)
      sub(/^[[:space:]]*/, "", key)
      sub(/[[:space:]]*$/, "", key)
      if (key == want_key) {
        capture = 1
        sub(/^[^=]*=/, "", line)
        emit_strings(line)
        if (line ~ /\]/) {
          exit
        }
        next
      }
    }
    section == want_section && capture == 1 {
      line = $0
      sub(/[[:space:]]+#.*/, "", line)
      emit_strings(line)
      if (line ~ /\]/) {
        exit
      }
    }
  ' "$config_file"
}

resolve_project_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$repo_root" "$1" ;;
  esac
}

config_path_or_default() {
  resolve_project_path "$(config_value_or_default paths "$1" "$2")"
}

mission_dir=$(config_path_or_default missions "missions")
proposal_dir=$(config_path_or_default workshop_proposals "workshop/proposals")
decision_dir=$(config_path_or_default workshop_decisions "workshop/decisions")
forge_dir=$(config_path_or_default forge_reviews "forge/reviews")
registry_file=$(config_path_or_default capability_registry "hyperagent/capability-registry.md")
default_command_log=$(config_path_or_default evidence_log ".hyperagent-evidence/commands.log")
default_evidence_dir=$(dirname "$default_command_log")
default_workbench_trace_log=$(config_path_or_default workbench_trace_log ".hyperagent-evidence/workbench/traces.jsonl")
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

shell_single_quote() {
  printf "%s" "$1" | sed "s/'/'\\\\''/g; 1s/^/'/; \$s/\$/'/"
}

init_is_runtime_helper_copy() {
  test -f "$1" \
    && grep -F "generate_init_config()" "$1" >/dev/null 2>&1 \
    && grep -F "init_project()" "$1" >/dev/null 2>&1
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
  update="${5:-0}"
  legacy_generator="${6:-}"
  tmp=$(mktemp)
  "$generator" >"$tmp"

  if [ -e "$dest" ]; then
    if cmp -s "$tmp" "$dest"; then
      init_log "up to date: $dest"
      rm -f "$tmp"
      return 0
    fi
    if [ "$update" -eq 1 ] && [ -n "$legacy_generator" ]; then
      legacy_tmp=$(mktemp)
      "$legacy_generator" >"$legacy_tmp"
      if cmp -s "$legacy_tmp" "$dest"; then
        if [ "$dry_run" -eq 1 ]; then
          init_log "would update generated file: $dest"
          rm -f "$tmp" "$legacy_tmp"
          return 0
        fi
        cp "$tmp" "$dest"
        init_log "updated generated file: $dest"
        rm -f "$tmp" "$legacy_tmp"
        return 0
      fi
      rm -f "$legacy_tmp"
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

generate_init_project_helper() {
  runtime_hint=$(shell_single_quote "$runtime_root")
  cat <<EOF
#!/bin/sh
set -eu

script_dir=\$(CDPATH= cd "\$(dirname "\$0")" && pwd)
project_root=\$(CDPATH= cd "\$script_dir/.." && pwd)
runtime_root_hint=$runtime_hint

if [ -n "\${HYPERAGENT_RUNTIME_ROOT:-}" ]; then
  runtime_helper="\$HYPERAGENT_RUNTIME_ROOT/scripts/hyperagent.sh"
elif [ -n "\$runtime_root_hint" ] && [ -f "\$runtime_root_hint/scripts/hyperagent.sh" ]; then
  runtime_helper="\$runtime_root_hint/scripts/hyperagent.sh"
else
  runtime_helper=
fi

if [ -n "\$runtime_helper" ] && [ -f "\$runtime_helper" ]; then
  HYPERAGENT_PROJECT_ROOT="\$project_root" exec sh "\$runtime_helper" "\$@"
fi

if command -v hyperagent >/dev/null 2>&1; then
  HYPERAGENT_PROJECT_ROOT="\$project_root" exec hyperagent "\$@"
fi

printf 'FAIL: HyperAgent runtime not found. Set HYPERAGENT_RUNTIME_ROOT or put hyperagent on PATH.\\n' >&2
exit 1
EOF
}

init_write_project_helper() {
  dest="$1"
  force="$2"
  dry_run="$3"
  update="$4"
  tmp=$(mktemp)
  generate_init_project_helper >"$tmp"

  if [ -e "$dest" ]; then
    if cmp -s "$tmp" "$dest"; then
      init_log "up to date: $dest"
      rm -f "$tmp"
      return 0
    fi
    if [ "$update" -eq 1 ] && init_is_runtime_helper_copy "$dest"; then
      if [ "$dry_run" -eq 1 ]; then
        init_log "would replace copied runtime helper with project shim: $dest"
        rm -f "$tmp"
        return 0
      fi
      cp "$tmp" "$dest"
      chmod +x "$dest"
      init_log "replaced copied runtime helper with project shim: $dest"
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
    chmod +x "$dest"
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
  chmod +x "$dest"
  init_log "created: $dest"
  rm -f "$tmp"
}

init_migrate_runtime_prompt() {
  dest="$1"
  force="$2"
  dry_run="$3"
  update="$4"

  [ -e "$dest" ] || return 0
  [ "$update" -eq 1 ] || return 0

  if init_same_file "$runtime_root/hyperagent/operating-prompt.md" "$dest" || [ "$force" -eq 1 ]; then
    if [ "$dry_run" -eq 1 ]; then
      init_log "would remove copied runtime prompt: $dest"
    else
      rm -f "$dest"
      init_log "removed copied runtime prompt: $dest"
    fi
    return 0
  fi

  fail "refusing to remove changed legacy runtime file without --force: $dest"
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
install_mode = "global-runtime"

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
capability_registry = "hyperagent/capability-registry.md"
project_readme = "hyperagent/README.md"
local_helper = "scripts/hyperagent.sh"
evidence_log = ".hyperagent-evidence/commands.log"
workbench_trace_log = ".hyperagent-evidence/workbench/traces.jsonl"

[runtime]
helper = "scripts/hyperagent.sh"
operating_prompt = "hyperagent/operating-prompt.md"
override_env = "HYPERAGENT_RUNTIME_ROOT"

[adapters]
codex = true

[verification]
commands = [
  "sh scripts/hyperagent.sh verify-config",
  "sh scripts/hyperagent.sh status",
  "sh scripts/hyperagent.sh sense --pr off",
  "sh scripts/hyperagent.sh doctor",
]
EOF
}

generate_init_config_legacy_copy() {
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
- `hyperagent/capability-registry.md`: accepted local capabilities.

## Init Output Categories

- Project-local artifacts: `missions/`, `workshop/proposals/`, `workshop/decisions/`, `forge/reviews/`, `AGENTS.md`, `workshop/backlog.md`, and `hyperagent/capability-registry.md`.
- Copied templates and rubrics: `templates/`, `workshop/rubric.md`, and `forge/process/quality-rubric.md`.
- Generated config and docs: `.hyperagent`, `hyperagent/README.md`, and this repository's HyperAgent block in `AGENTS.md`.
- Global runtime dependency: the local `scripts/hyperagent.sh` shim delegates to the installed HyperAgent runtime instead of copying the full runtime helper or operating prompt into this repo.

## Five Primary Flows

```bash
sh scripts/hyperagent.sh init --target /path/to/project
sh scripts/hyperagent.sh sense
sh scripts/hyperagent.sh mission closeout --request "Describe the task" --slug task-slug
sh scripts/hyperagent.sh review workshop --mission missions/MISSION.md --title "Improve the Suit" --problem "Concrete friction from the mission"
sh scripts/hyperagent.sh review forge audit
sh scripts/hyperagent.sh ui
```

Compatibility aliases remain available for at least one release:

```bash
sh scripts/hyperagent.sh verify-config
sh scripts/hyperagent.sh status
sh scripts/hyperagent.sh record-check --status passed --command "sh scripts/verify-mvp.sh"
sh scripts/hyperagent.sh doctor
sh scripts/hyperagent.sh new-mission --request "Describe the task" --slug task-slug
sh scripts/hyperagent.sh mission-closeout --request "Describe the task" --slug task-slug
sh scripts/hyperagent.sh workshop-prompt
sh scripts/hyperagent.sh forge-prompt
sh scripts/hyperagent.sh propose-upgrade --forge-review forge/reviews/REVIEW.md --title "Improve Workshop quality" --problem "The Workshop process needs a concrete fix"
```

## Verification

Run Forge reviews after proposal decisions, eval changes, release-readiness checks, or repeated vague Workshop output. Forge process improvements should become normal Workshop proposals linked to the Forge review and remain `human review required`.

For this project, the lightweight check is:

```bash
sh scripts/hyperagent.sh verify-config
sh scripts/hyperagent.sh sense
```

To capture local task evidence for mission records:

```bash
sh scripts/hyperagent.sh record-check --status passed --command "sh scripts/verify-mvp.sh"
sh scripts/hyperagent.sh sense
sh scripts/hyperagent.sh mission closeout --request "Describe the task" --slug task-slug
```

The sensing summary reads Git metadata, the opt-in local command log, and local Workbench trace metadata when the default ignored trace log exists. It does not inspect repository file contents or environment values, and command text is redacted for secret-like tokens before storage and output.

Add any project-specific build, test, lint, or smoke commands to `AGENTS.md` so future agents know the strongest relevant verification path.

## Copy And Symlink Behavior

`hyperagent init` copies stable markdown templates and rubrics into the target repository. It generates blank project-local backlog and capability registry files, and it installs a small `scripts/hyperagent.sh` shim that runs the global HyperAgent runtime against this project.

If you installed the global Codex skill with `scripts/install-codex-skill.sh --symlink`, only the Codex skill install is symlinked. Project-local files created by `hyperagent init` are still normal files.

Existing files are left alone when they are identical. Conflicting generated files are not overwritten unless `--force` is passed.

## Updating Existing Projects

Run `hyperagent init --target /path/to/project --update` after updating the HyperAgent install. Update mode migrates older initialized repos from copied runtime files to the project shim when the files match the known generated runtime copies. Locally changed runtime copies are refused unless `--force` is passed.
EOF
}

generate_init_readme_legacy_copy() {
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
sh scripts/hyperagent.sh verify-config
sh scripts/hyperagent.sh status
sh scripts/hyperagent.sh sense
sh scripts/hyperagent.sh check -- sh scripts/verify-mvp.sh
sh scripts/hyperagent.sh record-check --status passed --command "sh scripts/verify-mvp.sh"
sh scripts/hyperagent.sh doctor
sh scripts/hyperagent.sh mission-closeout --request "Describe the task" --slug task-slug
sh scripts/hyperagent.sh verify-mission --strict missions/MISSION.md
sh scripts/hyperagent.sh workshop-prompt
sh scripts/hyperagent.sh forge-prompt
sh scripts/hyperagent.sh propose-upgrade --forge-review forge/reviews/REVIEW.md --title "Improve Workshop quality" --problem "The Workshop process needs a concrete fix"
sh scripts/hyperagent.sh forge audit
```

## Verification

Run Forge reviews after proposal decisions, eval changes, release-readiness checks, or repeated vague Workshop output. Forge process improvements should become normal Workshop proposals linked to the Forge review and remain `human review required`.

For this project, the lightweight check is:

```bash
sh scripts/hyperagent.sh verify-config
sh scripts/hyperagent.sh status
```

To capture local task evidence for mission records:

```bash
sh scripts/hyperagent.sh check -- sh scripts/verify-mvp.sh
sh scripts/hyperagent.sh record-check --status passed --command "sh scripts/verify-mvp.sh"
sh scripts/hyperagent.sh sense
sh scripts/hyperagent.sh mission-closeout --request "Describe the task" --slug task-slug
sh scripts/hyperagent.sh verify-mission --strict missions/MISSION.md
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
  update=0

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
      --update)
        update=1
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

  init_install_file "$runtime_root/templates/mission-record.md" "$target_root/templates/mission-record.md" "$force" "$dry_run"
  init_install_file "$runtime_root/templates/upgrade-proposal.md" "$target_root/templates/upgrade-proposal.md" "$force" "$dry_run"
  init_install_file "$runtime_root/templates/upgrade-decision.md" "$target_root/templates/upgrade-decision.md" "$force" "$dry_run"
  init_install_file "$runtime_root/templates/forge-review.md" "$target_root/templates/forge-review.md" "$force" "$dry_run"
  init_install_file "$runtime_root/workshop/rubric.md" "$target_root/workshop/rubric.md" "$force" "$dry_run"
  init_install_file "$runtime_root/forge/process/quality-rubric.md" "$target_root/forge/process/quality-rubric.md" "$force" "$dry_run"
  init_migrate_runtime_prompt "$target_root/hyperagent/operating-prompt.md" "$force" "$dry_run" "$update"
  init_write_project_helper "$target_root/scripts/hyperagent.sh" "$force" "$dry_run" "$update"

  init_write_generated "$target_root/.hyperagent" "$force" "$dry_run" generate_init_config "$update" generate_init_config_legacy_copy
  init_write_generated "$target_root/workshop/backlog.md" "$force" "$dry_run" generate_init_backlog "$update"
  init_write_generated "$target_root/hyperagent/capability-registry.md" "$force" "$dry_run" generate_init_registry "$update"
  init_write_generated "$target_root/hyperagent/README.md" "$force" "$dry_run" generate_init_readme "$update" generate_init_readme_legacy_copy
  init_update_agents "$target_root" "$force" "$dry_run"

  init_log "HyperAgent init complete."
  init_log "Next: inspect AGENTS.md, add project-specific verification commands, then run: sh scripts/hyperagent.sh verify-config"
}

config_errors=0

config_error() {
  config_errors=$((config_errors + 1))
  printf 'ERROR: %s\n' "$1" >&2
}

config_require_scalar() {
  section="$1"
  key="$2"
  label="$3"
  value=$(config_string_value "$section" "$key")
  if [ -z "$value" ]; then
    if [ -n "$section" ]; then
      config_error "missing required field [$section].$key in .hyperagent"
    else
      config_error "missing required field $key in .hyperagent"
    fi
    return 1
  fi
  printf '%s\n' "$value"
  return 0
}

config_require_path() {
  key="$1"
  kind="$2"
  value=$(config_string_value paths "$key")
  if [ -z "$value" ]; then
    config_error "missing required field [paths].$key in .hyperagent"
    return 1
  fi
  case "$value" in
    /*)
      config_error "[paths].$key must be project-relative, got absolute path: $value"
      return 1
      ;;
    *../*|../*|*/..)
      config_error "[paths].$key must stay inside the project, got: $value"
      return 1
      ;;
  esac
  resolved=$(resolve_project_path "$value")
  case "$kind" in
    file)
      test -f "$resolved" || config_error "configured file for [paths].$key is missing: $resolved"
      ;;
    dir)
      test -d "$resolved" || config_error "configured directory for [paths].$key is missing: $resolved"
      ;;
    writable-file)
      parent=$(dirname "$resolved")
      test -d "$parent" || test ! -e "$parent" || config_error "configured parent path is not a directory for [paths].$key: $parent"
      ;;
    *)
      config_error "internal verifier error: unknown path kind for [paths].$key"
      ;;
  esac
}

config_array_contains() {
  section="$1"
  key="$2"
  expected="$3"
  config_array_values "$section" "$key" | awk -v expected="$expected" '$0 == expected { found = 1 } END { exit(found ? 0 : 1) }'
}

config_array_count() {
  config_array_values "$1" "$2" | wc -l | tr -d ' '
}

verify_config() {
  config_errors=0

  if [ ! -f "$config_file" ]; then
    config_error "missing project config: $config_file"
    printf 'HyperAgent config verification failed: %s error(s)\n' "$config_errors" >&2
    return 1
  fi

  hyperagent_version=$(config_string_value "" hyperagent_version)
  config_version=$(config_string_value "" config_version)
  install_mode=$(config_string_value "" install_mode)

  test -n "$hyperagent_version" || config_error "missing required field hyperagent_version in .hyperagent"
  test -n "$config_version" || config_error "missing required field config_version in .hyperagent"
  test -n "$install_mode" || config_error "missing required field install_mode in .hyperagent"

  if [ -n "$hyperagent_version" ] && [ "$hyperagent_version" != "v0.1.0-alpha" ]; then
    config_error "stale hyperagent_version: expected v0.1.0-alpha, got $hyperagent_version"
  fi
  if [ -n "$config_version" ] && [ "$config_version" != "1" ]; then
    config_error "unsupported config_version: expected 1, got $config_version"
  fi
  case "$install_mode" in
    ""|copy|symlink|global-runtime) ;;
    *) config_error "unsupported install_mode: expected copy, symlink, or global-runtime, got $install_mode" ;;
  esac

  config_require_path project_instructions file
  config_require_path missions dir
  config_require_path workshop_proposals dir
  config_require_path workshop_decisions dir
  config_require_path workshop_backlog file
  config_require_path workshop_rubric file
  config_require_path forge_reviews dir
  config_require_path forge_quality_rubric file
  config_require_path templates dir
  if [ "$install_mode" = "global-runtime" ]; then
    runtime_helper=$(config_string_value runtime helper)
    runtime_prompt=$(config_string_value runtime operating_prompt)
    runtime_override=$(config_string_value runtime override_env)
    test -n "$runtime_helper" || config_error "missing required field [runtime].helper in .hyperagent"
    test -n "$runtime_prompt" || config_error "missing required field [runtime].operating_prompt in .hyperagent"
    test -n "$runtime_override" || config_error "missing required field [runtime].override_env in .hyperagent"
  else
    config_require_path operating_prompt file
  fi
  config_require_path capability_registry file
  config_require_path project_readme file
  config_require_path local_helper file
  config_require_path evidence_log writable-file
  config_require_path workbench_trace_log writable-file

  codex_adapter=$(config_string_value adapters codex)
  case "$codex_adapter" in
    true) ;;
    "") config_error "missing required field [adapters].codex in .hyperagent" ;;
    *) config_error "unsupported [adapters].codex value: expected true, got $codex_adapter" ;;
  esac

  command_count=$(config_array_count verification commands)
  if [ "$command_count" -eq 0 ] 2>/dev/null; then
    config_error "missing required non-empty [verification].commands array in .hyperagent"
  fi
  config_array_contains verification commands "sh scripts/hyperagent.sh verify-config" \
    || config_error "[verification].commands must include: sh scripts/hyperagent.sh verify-config"
  config_array_contains verification commands "sh scripts/hyperagent.sh status" \
    || config_error "[verification].commands must include: sh scripts/hyperagent.sh status"

  if [ "$config_errors" -gt 0 ]; then
    printf 'HyperAgent config verification failed: %s error(s)\n' "$config_errors" >&2
    return 1
  fi

  printf 'HyperAgent config verification passed.\n'
  printf 'Config: %s\n' "$config_file"
}

count_markdown_files() {
  dir="$1"
  find "$dir" -maxdepth 1 -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' '
}

recent_markdown_files() {
  dir="$1"
  limit="$2"
  find "$dir" -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort -r | awk -v limit="$limit" 'limit <= 0 || NR <= limit'
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
  verify_config >/dev/null
  ensure_dirs
  accepted_capabilities=$(read_accepted_capabilities)
  printf 'HyperAgent status\n'
  printf 'Repo: %s\n' "$repo_root"
  printf 'Mode: human review required\n'
  printf 'Missions: %s\n' "$(count_markdown_files "$mission_dir")"
  printf 'Workshop proposals: %s\n' "$(count_markdown_files "$proposal_dir")"
  printf 'Workshop decisions: %s\n' "$(count_markdown_files "$decision_dir")"
  printf 'Forge reviews: %s\n' "$(count_markdown_files "$forge_dir")"
  test -f "$registry_file" || fail "missing capability registry: $registry_file"
  printf 'Capability registry: %s\n' "$registry_file"
  printf 'Accepted capabilities: %s\n' "$(accepted_capability_count "$accepted_capabilities")"
  print_accepted_capabilities_text "$accepted_capabilities" '  '
}

record_check() {
  verify_config >/dev/null

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
  note=
  log_file="$default_command_log"

  while [ "$#" -gt 0 ]; do
    case "$1" in
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
      --)
        shift
        break
        ;;
      *)
        break
        ;;
    esac
    shift
  done

  test "$#" -gt 0 || fail "check requires a command after --"
  command_text=
  for arg in "$@"; do
    if [ -n "$command_text" ]; then
      command_text="$command_text $arg"
    else
      command_text=$arg
    fi
  done

  set +e
  "$@"
  status_code=$?
  set -e

  if [ "$status_code" -eq 0 ]; then
    check_status=passed
  else
    check_status=failed
    if [ -n "$note" ]; then
      note="$note; exit $status_code"
    else
      note="exit $status_code"
    fi
  fi

  record_check --command "$command_text" --status "$check_status" --note "$note" --command-log "$log_file" >/dev/null
  printf 'HyperAgent check recorded: %s `%s`\n' "$check_status" "$(redact_text "$command_text")"
  return "$status_code"
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

read_accepted_capabilities() {
  test -f "$registry_file" || return 0
  awk '
    function flush_entry() {
      if (id != "" && status == "accepted") {
        print id "|" title "|" activation "|" verification "|" decision
      }
    }
    /^## / {
      flush_entry()
      id = $0
      sub(/^##[[:space:]]*/, "", id)
      status = title = activation = verification = decision = ""
      next
    }
    id != "" && /^- Status:/ {
      status = $0
      sub(/^- Status:[[:space:]]*/, "", status)
      next
    }
    id != "" && /^- Title:/ {
      title = $0
      sub(/^- Title:[[:space:]]*/, "", title)
      next
    }
    id != "" && /^- Activation mode:/ {
      activation = $0
      sub(/^- Activation mode:[[:space:]]*/, "", activation)
      next
    }
    id != "" && /^- Verification:/ {
      verification = $0
      sub(/^- Verification:[[:space:]]*/, "", verification)
      next
    }
    id != "" && /^- Decision record:/ {
      decision = $0
      sub(/^- Decision record:[[:space:]]*/, "", decision)
      next
    }
    END {
      flush_entry()
    }
  ' "$registry_file"
}

accepted_capability_count() {
  capabilities="$1"
  if [ -z "$capabilities" ]; then
    printf '0'
    return 0
  fi
  printf '%s\n' "$capabilities" | awk 'NF { count++ } END { print count + 0 }'
}

print_accepted_capabilities_text() {
  capabilities="$1"
  prefix="$2"
  if [ -z "$capabilities" ]; then
    printf '%s%s\n' "$prefix" "none"
    return 0
  fi
  printf '%s\n' "$capabilities" | awk -F '|' -v prefix="$prefix" '
    NF {
      printf "%s- %s: %s (activation: %s; verification: %s; decision: %s)\n", prefix, $1, $2, $3, $4, $5
    }
  '
}

print_accepted_capabilities_markdown() {
  capabilities="$1"
  printf '\n## Accepted Capabilities\n\n'
  if [ -z "$capabilities" ]; then
    printf '%s\n' "- none"
    return 0
  fi
  printf '%s\n' "$capabilities" | awk -F '|' '
    NF {
      printf "- `%s` - %s\n", $1, $2
      printf "  - Activation mode: `%s`\n", $3
      printf "  - Verification: %s\n", $4
      printf "  - Decision evidence: %s\n", $5
    }
  '
}

print_accepted_capabilities_json() {
  capabilities="$1"
  if [ -z "$capabilities" ]; then
    printf '[]'
    return 0
  fi
  printf '%s\n' "$capabilities" | awk -F '|' '
    BEGIN { printf "[" }
    NF {
      for (i = 1; i <= NF; i++) {
        gsub(/\\/, "\\\\", $i)
        gsub(/"/, "\\\"", $i)
      }
      if (seen > 0) {
        printf ","
      }
      printf "{\"id\":\"%s\",\"title\":\"%s\",\"activation_mode\":\"%s\",\"verification\":\"%s\",\"decision_record\":\"%s\"}", $1, $2, $3, $4, $5
      seen++
    }
    END { printf "]" }
  '
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
  accepted_capabilities=$(read_accepted_capabilities)

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
  print_accepted_capabilities_markdown "$accepted_capabilities"
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
  accepted_capabilities=$(read_accepted_capabilities)

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
  printf '  "accepted_capabilities": '
  print_accepted_capabilities_json "$accepted_capabilities"
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
  verify_config >/dev/null

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
  verify_config >/dev/null

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

print_ui() {
  case "${1:-}" in
    --help|-h|help)
      cat <<'EOF'
Usage: sh scripts/hyperagent.sh ui [serve --host HOST --port PORT]

Without a subcommand, print local cockpit pointers. Use `serve` to start the optional local UI when the Node runtime file is available.
EOF
      return 0
      ;;
    serve)
      shift
      command -v node >/dev/null 2>&1 || fail "node is required to run the HyperAgent UI"
      test -f "$runtime_root/scripts/hyperagent-ui.mjs" || fail "missing optional UI runtime: $runtime_root/scripts/hyperagent-ui.mjs"
      exec node "$runtime_root/scripts/hyperagent-ui.mjs" "$@"
      ;;
    '')
      ;;
    *)
      fail "unknown ui option or subcommand: $1"
      ;;
  esac

  cat <<'EOF'
HyperAgent UI

The hosted cockpit is not part of this local alpha. Use these local cockpit views:

  sh scripts/hyperagent.sh sense
  sh scripts/hyperagent.sh review digest
  sh scripts/hyperagent.sh review forge audit
  sh scripts/hyperagent.sh ui serve

Product state:
  docs/roadmap.md
EOF
}

verify_tier() {
  tier=${1:-core}
  case "$tier" in
    core|mvp)
      (cd "$runtime_root" && sh scripts/verify-core.sh)
      ;;
    extensions|extension)
      (cd "$runtime_root" && sh scripts/verify-extensions.sh)
      ;;
    release)
      (cd "$runtime_root" && sh scripts/verify-release.sh)
      ;;
    all)
      (cd "$runtime_root" && sh scripts/verify-core.sh)
      (cd "$runtime_root" && sh scripts/verify-extensions.sh)
      (cd "$runtime_root" && sh scripts/verify-release.sh)
      ;;
    help|-h|--help)
      printf '%s\n' "Usage: sh scripts/hyperagent.sh verify core|extensions|release|all"
      ;;
    *)
      fail "unknown verify tier: $tier"
      ;;
  esac
}

create_mission() {
  verify_config >/dev/null

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

create_mission_closeout() {
  request=
  mission_path=
  slug=
  outcome="Task completed; review the evidence below for exact scope."
  risks="No unresolved risks recorded by closeout. Human reviewer should confirm before activation or merge."
  candidate_upgrades="None recorded by closeout."
  command_log="$default_command_log"
  trace_url=
  pr_mode=auto
  workbench_trace_log_override=

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
      --mission)
        shift
        test "$#" -gt 0 || fail "--mission requires a path"
        mission_path=$1
        ;;
      --outcome)
        shift
        test "$#" -gt 0 || fail "--outcome requires text"
        outcome=$1
        ;;
      --risks)
        shift
        test "$#" -gt 0 || fail "--risks requires text"
        risks=$1
        ;;
      --candidate-upgrades)
        shift
        test "$#" -gt 0 || fail "--candidate-upgrades requires text"
        candidate_upgrades=$1
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
        fail "unknown mission-closeout option: $1"
        ;;
    esac
    shift
  done

  test -n "$request" || fail "mission-closeout requires --request"
  test -n "$slug" || slug=$(slugify "$request")
  test -n "$slug" || slug=mission-closeout

  ensure_dirs
  stamp=$(now_stamp)
  if [ -n "$mission_path" ]; then
    file=$mission_path
    case "$file" in
      */*) mkdir -p "$(dirname "$file")" ;;
    esac
  else
    file="$mission_dir/$stamp-$slug.md"
    test ! -e "$file" || fail "mission already exists: $file"
  fi

  workbench_trace_log=$(workbench_trace_log_path "$workbench_trace_log_override")
  branch=$(git_branch)
  git_status=$(git_status_short)
  changed_files=$(git_changed_files)
  recent_commands=$(read_recent_commands "$command_log")
  failure_commands=$(read_failure_commands "$command_log")
  status_counts=$(git_status_counts)
  workbench_status=$(workbench_trace_status "$workbench_trace_log")
  sense_snapshot=$(mktemp)
  print_sense_markdown "$command_log" "$trace_url" "$pr_mode" "$workbench_trace_log" >"$sense_snapshot"

  if [ -n "$recent_commands" ]; then
    verification_status="Recent check evidence captured below. Review failed/retried entries before merge."
  else
    verification_status="No recorded checks found in $command_log. Run hyperagent check or record-check before review."
  fi

  cat >"$file" <<EOF
# Mission Record

- Mission ID: mission-$stamp-$slug
- Date/time: $(now_readable)
- Agent identity: Codex wearing the HyperAgent Suit
- Environment: \`$repo_root\`
- User request: $request

## Auto-Filled Evidence

- Repo path: \`$repo_root\`
- Branch: \`$branch\`
- Git status counts: \`$status_counts\`
- Command log: \`$command_log\`
- Workbench trace status: \`$workbench_status\`

### Git Status

~~~text
$git_status
~~~

### Changed Files

~~~text
$changed_files
~~~

### Recent Commands And Checks

~~~text
${recent_commands:-no command log entries found}
~~~

### Failures And Retries

~~~text
${failure_commands:-none recorded}
~~~

### Sense Snapshot

EOF
  cat "$sense_snapshot" >>"$file"
  rm -f "$sense_snapshot"
  cat >>"$file" <<EOF

## Agent Judgment

- Final outcome: $outcome
- Completion evidence: Auto-filled evidence captured git status, changed files, recent checks, failures/retries, and current sense snapshot.
- Verification status: $verification_status
- Unresolved risks: $risks
- Candidate upgrades: $candidate_upgrades

## Actions

- Agent plan: Review the user request, make focused changes, run checks through \`hyperagent check\` or record them with \`record-check\`, then run closeout.
- Summary of actions taken: See changed files, command evidence, and final response.
- Tools used: HyperAgent helper, local shell, git, and project verification commands.
- Files or systems changed: See changed files.
- Verification performed: See recent commands and checks.

## Workshop Handoff

- Upgrade proposal paths: None created by closeout.
- Follow-up owner: Human reviewer
- Review prompts:
  - Confirm failed or retried checks are resolved or intentionally accepted.
  - Confirm unresolved risks are explicit enough for Human Review.
  - Create a Workshop proposal only if the evidence shows reusable Suit friction.
EOF

  printf '%s\n' "$file"
}

verify_mission() {
  strict=0
  file=

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --strict)
        strict=1
        ;;
      *)
        test -z "$file" || fail "verify-mission accepts one mission path"
        file=$1
        ;;
    esac
    shift
  done

  test -n "$file" || fail "verify-mission requires a mission path"
  test -f "$file" || fail "mission record not found: $file"

  grep -F "Mission ID:" "$file" >/dev/null || fail "mission missing Mission ID"
  grep -F "User request:" "$file" >/dev/null || fail "mission missing User request"
  grep -F "Final outcome:" "$file" >/dev/null || fail "mission missing Final outcome"
  grep -F "Unresolved risks:" "$file" >/dev/null || fail "mission missing Unresolved risks"
  grep -F "Changed Files" "$file" >/dev/null || grep -F "Changed files:" "$file" >/dev/null || fail "mission missing changed files evidence"
  grep -F "Verification status:" "$file" >/dev/null || fail "mission missing Verification status"

  if [ "$strict" -eq 1 ]; then
    if grep -E 'Pending final outcome|Pending unresolved risk review|Replace during mission closeout|Pending verification|Not captured by helper|TODO|TBD|FIXME' "$file" >/dev/null; then
      fail "strict mission verification found placeholder text: $file"
    fi
  fi

  printf 'Mission verification passed: %s\n' "$file"
}

redact_check_file() {
  file="$1"
  test -f "$file" || fail "redact-check path is not a file: $file"

  findings=$(
    grep -nE '(/Users/[^[:space:]`)]+|/private/(tmp|var)/[^[:space:]`)]+|/var/folders/[^[:space:]`)]+|/tmp/[^[:space:]`)]+|https://linear\.app/[^[:space:]`)]+|[A-Z][A-Z0-9]+-[0-9]+|\.hyperagent-evidence/|workbench/traces\.jsonl|api[_-]?key|access[_-]?key|private[_-]?key|bearer[[:space:]]+[A-Za-z0-9._~+/-]+|token[=:][^[:space:]`)]+|secret[=:][^[:space:]`)]+|password[=:][^[:space:]`)]+)' "$file" 2>/dev/null || true
  )

  if [ -n "$findings" ]; then
    printf 'Redaction check failed: %s\n' "$file" >&2
    printf '%s\n' "$findings" >&2
    return 1
  fi

  printf 'Redaction check passed: %s\n' "$file"
}

mission_command() {
  subcommand=${1:-help}
  if [ "$#" -gt 0 ]; then
    shift
  fi

  case "$subcommand" in
    redact-check)
      test "$#" -gt 0 || fail "mission redact-check requires at least one path"
      failed=0
      for file in "$@"; do
        redact_check_file "$file" || failed=1
      done
      test "$failed" -eq 0 || fail "mission redaction check found public-safety findings"
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      usage >&2
      fail "unknown mission subcommand: $subcommand"
      ;;
  esac
}

safety_field_value() {
  file="$1"
  label="$2"
  grep -F -- "- $label:" "$file" | head -n 1 | sed 's/^[^:]*:[[:space:]]*//'
}

safety_require_nonempty_field() {
  file="$1"
  label="$2"
  value=$(safety_field_value "$file" "$label")
  test -n "$value" || fail "missing required safety field in $file: $label"
}

safety_require_field_value() {
  file="$1"
  label="$2"
  expected="$3"
  value=$(safety_field_value "$file" "$label")
  test "$value" = "$expected" || fail "invalid $label in $file: expected '$expected', got '$value'"
}

safety_path_from_field() {
  file="$1"
  label="$2"
  safety_field_value "$file" "$label" | sed 's/`//g'
}

safety_require_existing_path_field() {
  file="$1"
  label="$2"
  path=$(safety_path_from_field "$file" "$label")
  test -n "$path" || fail "missing required path field in $file: $label"
  test -f "$path" || test -f "$repo_root/$path" || fail "path field in $file does not exist: $label=$path"
}

safety_require_field_prompt() {
  file="$1"
  label="$2"
  grep -F -- "- $label:" "$file" >/dev/null || fail "missing safety prompt in $file: $label"
}

verify_proposal_template_safety() {
  file="$1"
  test -f "$file" || fail "proposal template not found: $file"
  safety_require_field_prompt "$file" "Proposed activation mode"
  safety_require_field_prompt "$file" "Allowed activation modes"
  safety_require_field_prompt "$file" "Durable-agency pillar strengthened"
  safety_require_field_prompt "$file" "Feature home"
  safety_require_field_prompt "$file" "Product-creep risk and guardrail"
  safety_require_field_prompt "$file" "Verification for the first step"
  safety_require_field_prompt "$file" "Safety risk"
  safety_require_field_prompt "$file" "Permission or authority changes"
  safety_require_field_prompt "$file" "Filesystem impact"
  safety_require_field_prompt "$file" "Network or account impact"
  safety_require_field_prompt "$file" "Secrets handling impact"
  safety_require_field_prompt "$file" "Human approval required before activation"
  safety_require_field_prompt "$file" "Eval or acceptance test"
  safety_require_field_prompt "$file" "Rollback plan"
}

verify_decision_template_safety() {
  file="$1"
  test -f "$file" || fail "decision template not found: $file"
  safety_require_field_prompt "$file" "Proposal"
  safety_require_field_prompt "$file" "Decision"
  safety_require_field_prompt "$file" "Human approval recorded"
  safety_require_field_prompt "$file" "Silent activation allowed"
  safety_require_field_prompt "$file" "Permission or secrets changes approved"
  safety_require_field_prompt "$file" "Filesystem authority approved"
  safety_require_field_prompt "$file" "Network or account authority approved"
  safety_require_field_prompt "$file" "Verification"
  safety_require_field_prompt "$file" "Rollback path"
}

verify_proposal_safety() {
  proposal="$1"
  test -f "$proposal" || fail "proposal not found: $proposal"

  safety_require_nonempty_field "$proposal" "Evidence source type"
  safety_require_nonempty_field "$proposal" "Proposed activation mode"
  safety_require_nonempty_field "$proposal" "Allowed activation modes"
  safety_require_nonempty_field "$proposal" "Verification for the first step"
  safety_require_nonempty_field "$proposal" "Safety risk"
  safety_require_nonempty_field "$proposal" "Permission or authority changes"
  safety_require_nonempty_field "$proposal" "Filesystem impact"
  safety_require_nonempty_field "$proposal" "Network or account impact"
  safety_require_nonempty_field "$proposal" "Secrets handling impact"
  safety_require_field_value "$proposal" "Human approval required before activation" "yes"
  safety_require_nonempty_field "$proposal" "Eval or acceptance test"
  safety_require_nonempty_field "$proposal" "Rollback plan"

  activation=$(safety_field_value "$proposal" "Proposed activation mode")
  case "$activation" in
    "suggest only"|"draft files only"|"human review required"|"auto-install low risk") ;;
    *) fail "invalid proposed activation mode in $proposal: $activation" ;;
  esac
}

verify_accepted_proposal_safety() {
  proposal="$1"
  verify_proposal_safety "$proposal"
  safety_require_field_value "$proposal" "Proposed activation mode" "human review required"
}

verify_decision_safety() {
  decision_file="$1"
  test -f "$decision_file" || fail "decision record not found: $decision_file"

  safety_require_existing_path_field "$decision_file" "Proposal"
  safety_require_nonempty_field "$decision_file" "Decision"
  safety_require_nonempty_field "$decision_file" "Reviewer"
  safety_require_nonempty_field "$decision_file" "Reason"
  safety_require_field_value "$decision_file" "Human approval recorded" "yes"
  safety_require_field_value "$decision_file" "Silent activation allowed" "no"
  safety_require_nonempty_field "$decision_file" "Permission or secrets changes approved"
  safety_require_nonempty_field "$decision_file" "Filesystem authority approved"
  safety_require_nonempty_field "$decision_file" "Network or account authority approved"
  safety_require_nonempty_field "$decision_file" "Verification"
  safety_require_nonempty_field "$decision_file" "Rollback path"
}

verify_registry_safety() {
  test -f "$registry_file" || fail "missing capability registry: $registry_file"
  tmp="${TMPDIR:-/tmp}/hyperagent-registry-safety-$$.tsv"
  awk '
    /^## / {
      if (in_entry) {
        print id "|" title "|" status "|" proposal "|" decision "|" activation "|" verification "|" rollback
      }
      in_entry = 1
      id = $0
      sub(/^## /, "", id)
      title = status = proposal = decision = activation = verification = rollback = ""
      next
    }
    in_entry && /^- Status:/ { status = $0; sub(/^- Status:[[:space:]]*/, "", status) }
    in_entry && /^- Title:/ { title = $0; sub(/^- Title:[[:space:]]*/, "", title) }
    in_entry && /^- Source proposal:/ { proposal = $0; sub(/^- Source proposal:[[:space:]]*/, "", proposal) }
    in_entry && /^- Proposal:/ { proposal = $0; sub(/^- Proposal:[[:space:]]*/, "", proposal) }
    in_entry && /^- Decision record:/ { decision = $0; sub(/^- Decision record:[[:space:]]*/, "", decision) }
    in_entry && /^- Activation mode:/ { activation = $0; sub(/^- Activation mode:[[:space:]]*/, "", activation) }
    in_entry && /^- Verification:/ { verification = $0; sub(/^- Verification:[[:space:]]*/, "", verification) }
    in_entry && /^- Rollback:/ { rollback = $0; sub(/^- Rollback:[[:space:]]*/, "", rollback) }
    END {
      if (in_entry) {
        print id "|" title "|" status "|" proposal "|" decision "|" activation "|" verification "|" rollback
      }
    }
  ' "$registry_file" >"$tmp"

  while IFS='|' read -r capability_id title status proposal decision activation verification rollback; do
    case "$status" in
      accepted) ;;
      *) continue ;;
    esac

    test -n "$capability_id" || fail "accepted capability missing capability ID"
    test "$capability_id" != "Accepted Capabilities" || fail "accepted capability entry missing capability ID"
    test -n "$title" || fail "accepted capability missing title: $capability_id"
    test -n "$proposal" || fail "accepted capability missing source proposal: $capability_id"
    test -n "$decision" || fail "accepted capability missing decision record: $capability_id"
    test "$activation" = "human review required" || fail "accepted capability has unsafe activation mode: $capability_id"
    test -n "$verification" || fail "accepted capability missing verification evidence: $capability_id"
    test -n "$rollback" || fail "accepted capability missing rollback plan: $capability_id"

    proposal_path=$(printf '%s' "$proposal" | sed 's/`//g')
    decision_path=$(printf '%s' "$decision" | sed 's/`//g')
    test -f "$proposal_path" || test -f "$repo_root/$proposal_path" || fail "accepted capability proposal path missing: $capability_id -> $proposal_path"
    test -f "$decision_path" || test -f "$repo_root/$decision_path" || fail "accepted capability decision path missing: $capability_id -> $decision_path"
    verify_accepted_proposal_safety "$proposal_path"
    verify_decision_safety "$decision_path"
  done <"$tmp"
  rm -f "$tmp"
}

verify_safety() {
  verify_config >/dev/null

  verify_proposal_template_safety templates/upgrade-proposal.md
  verify_decision_template_safety templates/upgrade-decision.md
  verify_registry_safety

  printf 'HyperAgent safety verification passed.\n'
}

create_proposal() {
  verify_config >/dev/null

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
- Verification for the first step: Run the smallest local check that proves the proposed behavior before requesting acceptance.

## Safety

- Safety risk: Pending reviewer assessment before acceptance.
- Permission or authority changes: Document any filesystem, shell, network, deployment, account, or persistent behavior authority changes before acceptance.
- Filesystem impact: None proposed unless listed in the implementation plan.
- Network or account impact: None proposed unless explicitly listed here.
- Secrets handling impact: None proposed; do not add or alter secrets handling without human approval.
- Human approval required before activation: yes

## Evaluation

- Eval or acceptance test: Add or run a local verification command before acceptance.
- Rollback plan: Revert the changed files or remove the accepted registry entry if the upgrade fails review.
- Open questions:

## Decision Handoff

- Recommended decision:
- Decision record path:
- Capability registry ID if accepted:
EOF

  printf '%s\n' "$file"
}

proposal_has_decision() {
  proposal="$1"
  test -d "$decision_dir" || return 1
  for decision_file in "$decision_dir"/*.md; do
    test -f "$decision_file" || continue
    grep -F -e "$proposal" -e "$(basename "$proposal")" "$decision_file" >/dev/null 2>&1 && return 0
  done
  return 1
}

mission_has_proposal_handoff() {
  mission="$1"
  test -d "$proposal_dir" || return 1
  grep -R -F "$mission" "$proposal_dir"/*.md >/dev/null 2>&1 && return 0
  grep -R -F "$(basename "$mission")" "$proposal_dir"/*.md >/dev/null 2>&1
}

mission_has_friction() {
  mission="$1"
  grep -Ei '^- (Candidate upgrades|Unresolved risks|Suit friction observed):' "$mission" \
    | grep -Eiv 'Candidate upgrades:[[:space:]]*(None|None recorded by closeout\.?)\.?$|Unresolved risks:[[:space:]]*(No unresolved|None)|No additional.*friction|No .*friction' >/dev/null 2>&1
}

proposal_is_weak() {
  proposal="$1"
  grep -E 'Eval or acceptance test:[[:space:]]*$|Rollback plan:[[:space:]]*$|Highest-priority plan step:[[:space:]]*$|Recommended decision:[[:space:]]*$' "$proposal" >/dev/null 2>&1
}

print_workshop_digest() {
  verify_config >/dev/null

  limit=12
  draft_proposal=0
  title="Convert recurring mission friction into a Workshop proposal"
  slug=

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --limit)
        shift
        test "$#" -gt 0 || fail "--limit requires a number"
        limit=$1
        ;;
      --draft-proposal)
        draft_proposal=1
        ;;
      --title)
        shift
        test "$#" -gt 0 || fail "--title requires text"
        title=$1
        ;;
      --slug)
        shift
        test "$#" -gt 0 || fail "--slug requires text"
        slug=$(slugify "$1")
        ;;
      *)
        fail "unknown workshop-digest option: $1"
        ;;
    esac
    shift
  done

  ensure_dirs
  tmp_friction=$(mktemp)
  tmp_missing=$(mktemp)
  tmp_stale=$(mktemp)
  tmp_weak=$(mktemp)
  tmp_keyword=$(mktemp)
  recent_markdown_files "$mission_dir" "$limit" | while IFS= read -r mission; do
    if mission_has_friction "$mission"; then
      printf '%s\n' "$mission" >>"$tmp_friction"
      if ! mission_has_proposal_handoff "$mission"; then
        printf '%s\n' "$mission" >>"$tmp_missing"
      fi
      grep -Ei '^- (Candidate upgrades|Unresolved risks|Suit friction observed):' "$mission" \
        | grep -Eiv 'Candidate upgrades:[[:space:]]*(None|None recorded by closeout\.?)\.?$|Unresolved risks:[[:space:]]*(No unresolved|None)|No additional.*friction|No .*friction' \
        | grep -Eio 'friction|brittle|manual|missing proposal|unresolved risk|repeated|weak|stale|proposal handoff|graveyard' \
        | tr '[:upper:]' '[:lower:]' >>"$tmp_keyword" || true
    fi
  done

  recent_markdown_files "$proposal_dir" 0 | while IFS= read -r proposal; do
    if ! proposal_has_decision "$proposal"; then
      printf '%s\n' "$proposal" >>"$tmp_stale"
    fi
    if proposal_is_weak "$proposal"; then
      printf '%s\n' "$proposal" >>"$tmp_weak"
    fi
  done

  friction_count=$(wc -l <"$tmp_friction" | tr -d ' ')
  missing_count=$(wc -l <"$tmp_missing" | tr -d ' ')
  stale_count=$(wc -l <"$tmp_stale" | tr -d ' ')
  weak_count=$(wc -l <"$tmp_weak" | tr -d ' ')
  proposal_count=$(count_markdown_files "$proposal_dir")
  decision_count=$(count_markdown_files "$decision_dir")
  forge_count=$(count_markdown_files "$forge_dir")
  top_keyword=$(sort "$tmp_keyword" | uniq -c | sort -rn | awk 'NR == 1 { print $2 }')
  test -n "$top_keyword" || top_keyword="mission friction"

  printf '# HyperAgent Workshop Digest\n\n'
  printf '%s\n' "- Recent mission limit: $limit"
  printf '%s\n' "- Missions with friction evidence: $friction_count"
  printf '%s\n' "- Friction missions without proposal handoff: $missing_count"
  printf '%s\n' "- Workshop proposals without decision records: $stale_count"
  printf '%s\n' "- Weak proposal process evidence: $weak_count"
  printf '%s\n\n' "- Mission/proposal/decision/Forge counts: $(count_markdown_files "$mission_dir")/$proposal_count/$decision_count/$forge_count"

  printf '## Recent Missions Missing Proposal Handoff\n\n'
  if [ "$missing_count" -eq 0 ]; then
    printf '%s\n\n' "- None found."
  else
    sed 's/^/- `/' "$tmp_missing" | sed 's/$/`/' | head -5
    printf '\n'
  fi

  printf '## Workshop And Forge Cadence\n\n'
  if [ "$stale_count" -gt 0 ]; then
    printf '%s\n' "- Stale proposals need human accept/reject/defer decisions before any capability is treated as accepted."
  fi
  if [ "$weak_count" -gt 0 ]; then
    printf '%s\n' "- Forge cadence is due: at least one proposal lacks rollback, eval, decision, or first-step specificity."
  fi
  if [ "$missing_count" -gt 0 ]; then
    printf '%s\n' "- Workshop cadence is due: recent mission friction exists without proposal handoff."
  fi
  if [ "$stale_count" -eq 0 ] && [ "$weak_count" -eq 0 ] && [ "$missing_count" -eq 0 ]; then
    printf '%s\n' "- Cadence looks current for the scanned window."
  fi
  printf '\n'

  printf '## Recommended Next Actions\n\n'
  if [ "$missing_count" -gt 0 ]; then
    first_mission=$(sed -n '1p' "$tmp_missing")
    printf '1. Draft one Workshop proposal for `%s`, focused on recurring `%s` evidence. Keep activation mode `human review required`.\n' "$first_mission" "$top_keyword"
  elif [ "$stale_count" -gt 0 ]; then
    first_proposal=$(sed -n '1p' "$tmp_stale")
    printf '1. Review `%s` and record an explicit accept/reject/defer decision. Do not update the capability registry unless accepted by a human.\n' "$first_proposal"
  elif [ "$weak_count" -gt 0 ]; then
    first_weak=$(sed -n '1p' "$tmp_weak")
    printf '1. Run Forge review on `%s` to tighten proposal specificity, eval coverage, and rollback evidence.\n' "$first_weak"
  else
    printf '1. No backlog movement required from this digest window.\n'
  fi
  printf '\n'

  if [ "$draft_proposal" -eq 1 ]; then
    test "$missing_count" -gt 0 || fail "--draft-proposal requires at least one friction mission without proposal handoff"
    first_mission=$(sed -n '1p' "$tmp_missing")
    problem="Recent mission evidence shows $top_keyword friction without a Workshop proposal handoff; the digest should move the highest-value repeat pattern into reviewed backlog."
    if [ -n "$slug" ]; then
      proposal=$(create_proposal --mission "$first_mission" --title "$title" --problem "$problem" --slug "$slug")
    else
      proposal=$(create_proposal --mission "$first_mission" --title "$title" --problem "$problem")
    fi
    printf '## Draft Files\n\n'
    printf '%s\n' "- Draft Workshop proposal: \`$proposal\`"
    printf '%s\n' "- Activation mode remains \`human review required\`; no decision record was created."
  fi

  rm -f "$tmp_friction" "$tmp_missing" "$tmp_stale" "$tmp_weak" "$tmp_keyword"
}

print_workshop_prompt() {
  cat <<'EOF'
Use HyperAgent Workshop Mode.

Read recent mission records in missions/. Identify concrete Suit friction supported by evidence. Choose the highest-value friction, then create or update a proposal in workshop/proposals/ using templates/upgrade-proposal.md. Include the linked mission record, proposed capability, safety risk, eval or acceptance test, rollback plan, and an Implementation Plan with the highest-priority step first. If the evidence is a Forge review about Workshop quality, create the proposal with --forge-review instead of --mission. Do not activate the upgrade. Default the activation mode to human review required.
EOF
}

create_forge_review() {
  verify_config >/dev/null

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
  for decision_file in "$decision_dir"/*.md; do
    test -f "$decision_file" || continue
    if grep -F -e "\`$rel\`" -e "$rel" -e "\`$proposal\`" -e "$proposal" -e "$base" "$decision_file" >/dev/null 2>&1; then
      printf '%s\n' "$decision_file"
      return 0
    fi
  done
  return 1
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
  verify_config >/dev/null

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
    verify_accepted_proposal_safety "$proposal"
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
- Filesystem authority approved: no
- Network or account authority approved: no

## Outcome

- Files or instructions changed: see proposal implementation plan.
- Verification: reviewer confirmed the proposal verification evidence before acceptance.
- Registry update: $registry_file
- Rollback path: follow the proposal rollback plan and remove any registry entry associated with \`$capability\`.
EOF

  if [ "$decision" = accepted ]; then
    test -f "$registry_file" || fail "missing capability registry: $registry_file"
    proposal_title=$(field_value "$proposal" "Upgrade title")
    test -n "$proposal_title" || proposal_title=$capability
    cat >>"$registry_file" <<EOF

## $capability

- Status: accepted
- Title: $proposal_title
- Proposal: \`$proposal\`
- Decision record: \`$file\`
- Accepted by: $reviewer
- Date/time: $(now_readable)
- Activation mode: human review required
- Verification: reviewer confirmed the proposal verification evidence before acceptance.
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
  setup-hyperagent)
    exec sh "$repo_root/scripts/setup-hyperagent.sh" "$@"
    ;;
  verify-config)
    verify_config "$@"
    ;;
  verify-safety)
    verify_safety "$@"
    ;;
  verify)
    verify_tier "$@"
    ;;
  status)
    print_status "$@"
    ;;
  sense)
    if [ "${1:-}" = "--doctor" ]; then
      shift
      print_doctor "$@"
    else
      print_sense "$@"
    fi
    ;;
  ui)
    print_ui "$@"
    ;;
  mission)
    subcommand=${1:-help}
    if [ "$#" -gt 0 ]; then
      shift
    fi
    case "$subcommand" in
      new)
        create_mission "$@"
        ;;
      closeout)
        create_mission_closeout "$@"
        ;;
      verify)
        verify_mission "$@"
        ;;
      redact-check)
        test "$#" -gt 0 || fail "mission redact-check requires at least one path"
        failed=0
        for file in "$@"; do
          redact_check_file "$file" || failed=1
        done
        test "$failed" -eq 0 || fail "mission redaction check found public-safety findings"
        ;;
      help|-h|--help)
        usage
        ;;
      *)
        usage >&2
        fail "unknown mission subcommand: $subcommand"
        ;;
    esac
    ;;
  review)
    subcommand=${1:-help}
    if [ "$#" -gt 0 ]; then
      shift
    fi
    case "$subcommand" in
      workshop|proposal)
        create_proposal "$@"
        ;;
      prompt)
        prompt=${1:-}
        case "$prompt" in
          workshop) print_workshop_prompt ;;
          forge) print_forge_prompt ;;
          *) fail "review prompt requires workshop or forge" ;;
        esac
        ;;
      digest)
        print_workshop_digest "$@"
        ;;
      forge)
        forge_subcommand=${1:-help}
        if [ "$#" -gt 0 ]; then
          shift
        fi
        case "$forge_subcommand" in
          new)
            create_forge_review "$@"
            ;;
          --*)
            create_forge_review "$forge_subcommand" "$@"
            ;;
          audit)
            run_forge_audit "$@"
            ;;
          help|-h|--help)
            usage
            ;;
          *)
            usage >&2
            fail "unknown review forge subcommand: $forge_subcommand"
            ;;
        esac
        ;;
      decide|decision)
        record_decision "$@"
        ;;
      help|-h|--help)
        usage
        ;;
      *)
        usage >&2
        fail "unknown review subcommand: $subcommand"
        ;;
    esac
    ;;
  doctor)
    print_doctor "$@"
    ;;
  record-check)
    record_check "$@"
    ;;
  check)
    if [ "${1:-}" = "--record" ]; then
      shift
      record_check "$@"
    else
      run_check "$@"
    fi
    ;;
  new-mission)
    create_mission "$@"
    ;;
  mission-closeout)
    create_mission_closeout "$@"
    ;;
  verify-mission)
    verify_mission "$@"
    ;;
  mission)
    mission_command "$@"
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
  workshop-digest|review-digest)
    print_workshop_digest "$@"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    fail "unknown command: $command"
    ;;
esac
