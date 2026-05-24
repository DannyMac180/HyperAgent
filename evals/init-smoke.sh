#!/bin/sh
set -eu

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

require_file() {
  test -f "$1" || fail "missing file: $1"
}

require_dir() {
  test -d "$1" || fail "missing directory: $1"
}

require_text() {
  file="$1"
  text="$2"
  grep -F -e "$text" "$file" >/dev/null || fail "missing text in $file: $text"
}

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd)
tmpdir=$(mktemp -d)

cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT INT TERM

target="$tmpdir/project"
mkdir -p "$target"
cd "$target"
git init >/dev/null 2>&1 || true
printf '# Existing Project Instructions\n\nKeep this project-specific note.\n' >"$target/AGENTS.md"

init_log="$tmpdir/hyperagent-init-smoke.log"
refusal_log="$tmpdir/hyperagent-init-refusal.log"

sh "$repo_root/scripts/hyperagent.sh" init --target "$target" >"$init_log"
sh "$repo_root/bin/hyperagent" init --target "$target" >/dev/null

require_dir "$target/missions"
require_dir "$target/workshop/proposals"
require_dir "$target/workshop/decisions"
require_dir "$target/forge/reviews"
require_dir "$target/templates"
require_dir "$target/hyperagent"
require_dir "$target/scripts"

require_file "$target/.hyperagent"
require_file "$target/missions/.gitkeep"
require_file "$target/workshop/proposals/.gitkeep"
require_file "$target/workshop/decisions/.gitkeep"
require_file "$target/forge/reviews/.gitkeep"
require_file "$target/templates/mission-record.md"
require_file "$target/templates/upgrade-proposal.md"
require_file "$target/templates/upgrade-decision.md"
require_file "$target/templates/forge-review.md"
require_file "$target/workshop/rubric.md"
require_file "$target/workshop/backlog.md"
require_file "$target/forge/process/quality-rubric.md"
require_file "$target/hyperagent/capability-registry.md"
require_file "$target/hyperagent/README.md"
require_file "$target/scripts/hyperagent.sh"
require_file "$target/AGENTS.md"

require_text "$target/AGENTS.md" "Existing Project Instructions"
require_text "$target/AGENTS.md" "Keep this project-specific note."
require_text "$target/AGENTS.md" "HyperAgent Project Instructions"
require_text "$target/AGENTS.md" "sh scripts/hyperagent.sh status"
require_text "$target/.hyperagent" 'hyperagent_version = "v0.1.0-alpha"'
require_text "$target/.hyperagent" 'install_mode = "global-runtime"'
require_text "$target/.hyperagent" 'project_instructions = "AGENTS.md"'
require_text "$target/.hyperagent" 'evidence_log = ".hyperagent-evidence/commands.log"'
require_text "$target/.hyperagent" 'override_env = "HYPERAGENT_RUNTIME_ROOT"'
require_text "$target/.hyperagent" 'codex = true'
require_text "$target/.hyperagent" '"sh scripts/hyperagent.sh status"'
require_text "$target/hyperagent/README.md" "Copy And Symlink Behavior"
require_text "$target/hyperagent/README.md" "Init Output Categories"
require_text "$target/hyperagent/README.md" "Global runtime dependency"
require_text "$target/hyperagent/README.md" "Updating Existing Projects"
require_text "$target/hyperagent/README.md" "machine-readable project anchor"
require_text "$target/hyperagent/README.md" "sh scripts/hyperagent.sh sense"
require_text "$target/hyperagent/README.md" "opt-in local command log"
require_text "$target/hyperagent/README.md" "global HyperAgent runtime"
require_text "$target/hyperagent/README.md" "--forge-review"
require_text "$target/hyperagent/capability-registry.md" "human review required"
require_text "$target/workshop/backlog.md" "HyperAgent Project Upgrade Backlog"
if grep -F "2026-05-16-1216-local-loop-helper-and-smoke-eval" "$target/workshop/backlog.md" >/dev/null; then
  fail "init copied source-repo backlog entries into the target"
fi
test ! -e "$target/hyperagent/operating-prompt.md" || fail "init copied the runtime operating prompt into the target"
if grep -F "generate_init_config()" "$target/scripts/hyperagent.sh" >/dev/null; then
  fail "init copied the full runtime helper instead of the project shim"
fi

sh "$target/scripts/hyperagent.sh" status >/dev/null

printf 'local change\n' >>"$target/.hyperagent"
if sh "$repo_root/scripts/hyperagent.sh" init --target "$target" >"$refusal_log" 2>&1; then
  fail "init overwrote changed project config without --force"
fi
require_text "$refusal_log" "refusing to overwrite existing file without --force"

sh "$repo_root/scripts/hyperagent.sh" init --target "$target" --force >/dev/null
if grep -F "local change" "$target/.hyperagent" >/dev/null; then
  fail "--force did not replace the changed project config"
fi

legacy_target="$tmpdir/legacy-project"
mkdir -p "$legacy_target/scripts" "$legacy_target/hyperagent"
cp "$repo_root/scripts/hyperagent.sh" "$legacy_target/scripts/hyperagent.sh"
cp "$repo_root/hyperagent/operating-prompt.md" "$legacy_target/hyperagent/operating-prompt.md"
cat >"$legacy_target/.hyperagent" <<'EOF'
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
sh "$repo_root/scripts/hyperagent.sh" init --target "$legacy_target" --update >/dev/null
require_text "$legacy_target/.hyperagent" 'install_mode = "global-runtime"'
test ! -e "$legacy_target/hyperagent/operating-prompt.md" || fail "--update kept copied runtime prompt"
if grep -F "generate_init_config()" "$legacy_target/scripts/hyperagent.sh" >/dev/null; then
  fail "--update kept copied runtime helper"
fi
sh "$legacy_target/scripts/hyperagent.sh" status >/dev/null

dry_target="$tmpdir/dry-project"
mkdir -p "$dry_target"
sh "$repo_root/scripts/hyperagent.sh" init --target "$dry_target" --dry-run >/dev/null
test ! -e "$dry_target/.hyperagent" || fail "--dry-run created project config"
test ! -e "$dry_target/missions" || fail "--dry-run created files"

printf 'HyperAgent init smoke passed.\n'
