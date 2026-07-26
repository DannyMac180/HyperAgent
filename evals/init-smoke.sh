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

require_dir "$target/.hyperagent"
require_dir "$target/.hyperagent/missions"
require_dir "$target/.hyperagent/workshop/proposals"
require_dir "$target/.hyperagent/workshop/decisions"
require_dir "$target/.hyperagent/forge/reviews"
require_dir "$target/.hyperagent/templates"
require_dir "$target/.hyperagent/hyperagent"
require_dir "$target/.hyperagent/evidence"
require_dir "$target/scripts"

test ! -f "$target/.hyperagent" || fail ".hyperagent should be a directory, not a config file"
require_file "$target/.hyperagent/config.toml"
require_file "$target/.hyperagent/missions/.gitkeep"
require_file "$target/.hyperagent/workshop/proposals/.gitkeep"
require_file "$target/.hyperagent/workshop/decisions/.gitkeep"
require_file "$target/.hyperagent/forge/reviews/.gitkeep"
require_file "$target/.hyperagent/templates/mission-record.md"
require_file "$target/.hyperagent/templates/upgrade-proposal.md"
require_file "$target/.hyperagent/templates/upgrade-decision.md"
require_file "$target/.hyperagent/templates/forge-review.md"
require_file "$target/.hyperagent/workshop/rubric.md"
require_file "$target/.hyperagent/workshop/backlog.md"
require_file "$target/.hyperagent/forge/process/quality-rubric.md"
require_file "$target/.hyperagent/hyperagent/capability-registry.md"
require_file "$target/.hyperagent/hyperagent/README.md"
require_file "$target/scripts/hyperagent.sh"
require_file "$target/AGENTS.md"
test ! -e "$target/missions" || fail "init created top-level missions"
test ! -e "$target/workshop" || fail "init created top-level workshop"
test ! -e "$target/forge" || fail "init created top-level forge"
test ! -e "$target/templates" || fail "init created top-level templates"
test ! -e "$target/hyperagent" || fail "init created top-level hyperagent"

require_text "$target/AGENTS.md" "Existing Project Instructions"
require_text "$target/AGENTS.md" "Keep this project-specific note."
require_text "$target/AGENTS.md" "HyperAgent Project Instructions"
require_text "$target/AGENTS.md" "sh scripts/hyperagent.sh status"
require_text "$target/.hyperagent/config.toml" 'hyperagent_version = "v0.1.0-alpha"'
require_text "$target/.hyperagent/config.toml" 'install_mode = "global-runtime"'
require_text "$target/.hyperagent/config.toml" 'project_instructions = "AGENTS.md"'
require_text "$target/.hyperagent/config.toml" 'missions = ".hyperagent/missions"'
require_text "$target/.hyperagent/config.toml" 'templates = ".hyperagent/templates"'
require_text "$target/.hyperagent/config.toml" 'evidence_log = ".hyperagent/evidence/commands.log"'
require_text "$target/.hyperagent/config.toml" 'override_env = "HYPERAGENT_RUNTIME_ROOT"'
require_text "$target/.hyperagent/config.toml" 'codex = true'
require_text "$target/.hyperagent/config.toml" '"sh scripts/hyperagent.sh verify-config"'
require_text "$target/.hyperagent/config.toml" '"sh scripts/hyperagent.sh status"'
require_text "$target/.hyperagent/hyperagent/README.md" "Copy And Symlink Behavior"
require_text "$target/.hyperagent/hyperagent/README.md" "Init Output Categories"
require_text "$target/.hyperagent/hyperagent/README.md" "Four Primary Flows"
require_text "$target/.hyperagent/hyperagent/README.md" "Global runtime dependency"
require_text "$target/.hyperagent/hyperagent/README.md" "Updating Existing Projects"
require_text "$target/.hyperagent/hyperagent/README.md" "machine-readable project anchor"
require_text "$target/.hyperagent/hyperagent/README.md" ".hyperagent/config.toml"
require_text "$target/.hyperagent/hyperagent/README.md" "sh scripts/hyperagent.sh verify-config"
require_text "$target/.hyperagent/hyperagent/README.md" "sh scripts/hyperagent.sh sense"
require_text "$target/.hyperagent/hyperagent/README.md" "sh scripts/hyperagent.sh mission closeout"
require_text "$target/.hyperagent/hyperagent/README.md" "sh scripts/hyperagent.sh review workshop"
require_text "$target/.hyperagent/hyperagent/README.md" "Compatibility aliases remain available"
require_text "$target/.hyperagent/hyperagent/README.md" "opt-in local command log"
require_text "$target/.hyperagent/hyperagent/README.md" "global HyperAgent runtime"
require_text "$target/.hyperagent/hyperagent/README.md" "--forge-review"
require_text "$target/.hyperagent/hyperagent/capability-registry.md" "human review required"
require_text "$target/.hyperagent/workshop/backlog.md" "HyperAgent Project Upgrade Backlog"
if grep -F "2026-05-16-1216-local-loop-helper-and-smoke-eval" "$target/.hyperagent/workshop/backlog.md" >/dev/null; then
  fail "init copied source-repo backlog entries into the target"
fi
test ! -e "$target/.hyperagent/hyperagent/operating-prompt.md" || fail "init copied the runtime operating prompt into the target"
if grep -F "generate_init_config()" "$target/scripts/hyperagent.sh" >/dev/null; then
  fail "init copied the full runtime helper instead of the project shim"
fi

sh "$target/scripts/hyperagent.sh" verify-config >/dev/null
sh "$target/scripts/hyperagent.sh" status >/dev/null

bad_config="$tmpdir/bad-project"
mkdir -p "$bad_config"
sh "$repo_root/scripts/hyperagent.sh" init --target "$bad_config" >/dev/null
awk '$1 != "hyperagent_version"' "$bad_config/.hyperagent/config.toml" >"$bad_config/.hyperagent/config.toml.tmp"
mv "$bad_config/.hyperagent/config.toml.tmp" "$bad_config/.hyperagent/config.toml"
if sh "$bad_config/scripts/hyperagent.sh" verify-config >"$tmpdir/bad-config.out" 2>"$tmpdir/bad-config.err"; then
  fail "verify-config passed with a missing hyperagent_version"
fi
require_text "$tmpdir/bad-config.err" "missing required field hyperagent_version"

custom_paths="$tmpdir/custom-path-project"
mkdir -p "$custom_paths/project-memory/missions" "$custom_paths/project-memory/forge-reviews"
sh "$repo_root/scripts/hyperagent.sh" init --target "$custom_paths" >/dev/null
sed \
  -e 's#missions = ".hyperagent/missions"#missions = "project-memory/missions"#' \
  -e 's#forge_reviews = ".hyperagent/forge/reviews"#forge_reviews = "project-memory/forge-reviews"#' \
  "$custom_paths/.hyperagent/config.toml" >"$custom_paths/.hyperagent/config.toml.tmp"
mv "$custom_paths/.hyperagent/config.toml.tmp" "$custom_paths/.hyperagent/config.toml"
custom_mission=$(sh "$custom_paths/scripts/hyperagent.sh" new-mission --request "Verify configured mission path" --slug configured-mission-path)
case "$custom_mission" in
  "$custom_paths/project-memory/missions/"*) ;;
  *) fail "new-mission did not honor configured missions path: $custom_mission" ;;
esac
test -f "$custom_mission" || fail "configured mission path did not create a mission"
custom_review=$(sh "$custom_paths/scripts/hyperagent.sh" new-forge-review --slug configured-forge-path)
case "$custom_review" in
  "$custom_paths/project-memory/forge-reviews/"*) ;;
  *) fail "new-forge-review did not honor configured forge_reviews path: $custom_review" ;;
esac
test -f "$custom_review" || fail "configured forge review path did not create a review"

printf 'local change\n' >>"$target/.hyperagent/config.toml"
if sh "$repo_root/scripts/hyperagent.sh" init --target "$target" >"$refusal_log" 2>&1; then
  fail "init overwrote changed project config without --force"
fi
require_text "$refusal_log" "refusing to overwrite existing file without --force"

sh "$repo_root/scripts/hyperagent.sh" init --target "$target" --force >/dev/null
if grep -F "local change" "$target/.hyperagent/config.toml" >/dev/null; then
  fail "--force did not replace the changed project config"
fi

legacy_target="$tmpdir/legacy-project"
mkdir -p \
  "$legacy_target/scripts" \
  "$legacy_target/hyperagent" \
  "$legacy_target/missions" \
  "$legacy_target/workshop/proposals" \
  "$legacy_target/workshop/decisions" \
  "$legacy_target/forge/reviews" \
  "$legacy_target/forge/process" \
  "$legacy_target/templates" \
  "$legacy_target/.hyperagent-evidence/workbench"
cp "$repo_root/scripts/hyperagent.sh" "$legacy_target/scripts/hyperagent.sh"
cp "$repo_root/hyperagent/operating-prompt.md" "$legacy_target/hyperagent/operating-prompt.md"
cp "$repo_root/templates/mission-record.md" "$legacy_target/templates/mission-record.md"
cp "$repo_root/templates/upgrade-proposal.md" "$legacy_target/templates/upgrade-proposal.md"
cp "$repo_root/templates/upgrade-decision.md" "$legacy_target/templates/upgrade-decision.md"
cp "$repo_root/templates/forge-review.md" "$legacy_target/templates/forge-review.md"
cp "$repo_root/workshop/rubric.md" "$legacy_target/workshop/rubric.md"
cp "$repo_root/forge/process/quality-rubric.md" "$legacy_target/forge/process/quality-rubric.md"
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
require_dir "$legacy_target/.hyperagent"
require_text "$legacy_target/.hyperagent/config.toml" 'install_mode = "global-runtime"'
require_text "$legacy_target/.hyperagent/config.toml" 'missions = ".hyperagent/missions"'
require_file "$legacy_target/.hyperagent/missions/.gitkeep"
require_file "$legacy_target/.hyperagent/templates/mission-record.md"
require_file "$legacy_target/.hyperagent/workshop/rubric.md"
require_file "$legacy_target/.hyperagent/forge/process/quality-rubric.md"
require_file "$legacy_target/.hyperagent/hyperagent/capability-registry.md"
require_file "$legacy_target/.hyperagent/hyperagent/README.md"
test ! -e "$legacy_target/missions" || fail "--update kept top-level missions"
test ! -e "$legacy_target/workshop" || fail "--update kept top-level workshop"
test ! -e "$legacy_target/forge" || fail "--update kept top-level forge"
test ! -e "$legacy_target/templates" || fail "--update kept top-level templates"
test ! -e "$legacy_target/hyperagent/operating-prompt.md" || fail "--update kept copied runtime prompt"
test ! -e "$legacy_target/.hyperagent-evidence" || fail "--update kept legacy evidence directory"
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
