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
require_file "$target/hyperagent/operating-prompt.md"
require_file "$target/hyperagent/capability-registry.md"
require_file "$target/hyperagent/README.md"
require_file "$target/scripts/hyperagent.sh"
require_file "$target/AGENTS.md"

require_text "$target/AGENTS.md" "Existing Project Instructions"
require_text "$target/AGENTS.md" "Keep this project-specific note."
require_text "$target/AGENTS.md" "HyperAgent Project Instructions"
require_text "$target/AGENTS.md" "sh scripts/hyperagent.sh status"
require_text "$target/.hyperagent" 'hyperagent_version = "v0.1.0-alpha"'
require_text "$target/.hyperagent" 'install_mode = "copy"'
require_text "$target/.hyperagent" 'project_instructions = "AGENTS.md"'
require_text "$target/.hyperagent" 'evidence_log = ".hyperagent-evidence/commands.log"'
require_text "$target/.hyperagent" 'codex = true'
require_text "$target/.hyperagent" '"sh scripts/hyperagent.sh verify-config"'
require_text "$target/.hyperagent" '"sh scripts/hyperagent.sh status"'
require_text "$target/hyperagent/README.md" "Copy And Symlink Behavior"
require_text "$target/hyperagent/README.md" "machine-readable project anchor"
require_text "$target/hyperagent/README.md" "sh scripts/hyperagent.sh verify-config"
require_text "$target/hyperagent/README.md" "sh scripts/hyperagent.sh sense"
require_text "$target/hyperagent/README.md" "opt-in local command log"
require_text "$target/hyperagent/README.md" "does not symlink project setup files by default"
require_text "$target/hyperagent/README.md" "--forge-review"
require_text "$target/hyperagent/capability-registry.md" "human review required"
require_text "$target/workshop/backlog.md" "HyperAgent Project Upgrade Backlog"
if grep -F "2026-05-16-1216-local-loop-helper-and-smoke-eval" "$target/workshop/backlog.md" >/dev/null; then
  fail "init copied source-repo backlog entries into the target"
fi

sh "$target/scripts/hyperagent.sh" verify-config >/dev/null
sh "$target/scripts/hyperagent.sh" status >/dev/null

bad_config="$tmpdir/bad-project"
mkdir -p "$bad_config"
sh "$repo_root/scripts/hyperagent.sh" init --target "$bad_config" >/dev/null
awk '$1 != "hyperagent_version"' "$bad_config/.hyperagent" >"$bad_config/.hyperagent.tmp"
mv "$bad_config/.hyperagent.tmp" "$bad_config/.hyperagent"
if sh "$bad_config/scripts/hyperagent.sh" verify-config >"$tmpdir/bad-config.out" 2>"$tmpdir/bad-config.err"; then
  fail "verify-config passed with a missing hyperagent_version"
fi
require_text "$tmpdir/bad-config.err" "missing required field hyperagent_version"

custom_paths="$tmpdir/custom-path-project"
mkdir -p "$custom_paths/project-memory/missions" "$custom_paths/project-memory/forge-reviews"
sh "$repo_root/scripts/hyperagent.sh" init --target "$custom_paths" >/dev/null
sed \
  -e 's#missions = "missions"#missions = "project-memory/missions"#' \
  -e 's#forge_reviews = "forge/reviews"#forge_reviews = "project-memory/forge-reviews"#' \
  "$custom_paths/.hyperagent" >"$custom_paths/.hyperagent.tmp"
mv "$custom_paths/.hyperagent.tmp" "$custom_paths/.hyperagent"
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

printf 'local change\n' >>"$target/.hyperagent"
if sh "$repo_root/scripts/hyperagent.sh" init --target "$target" >"$refusal_log" 2>&1; then
  fail "init overwrote changed project config without --force"
fi
require_text "$refusal_log" "refusing to overwrite existing file without --force"

sh "$repo_root/scripts/hyperagent.sh" init --target "$target" --force >/dev/null
if grep -F "local change" "$target/.hyperagent" >/dev/null; then
  fail "--force did not replace the changed project config"
fi

dry_target="$tmpdir/dry-project"
mkdir -p "$dry_target"
sh "$repo_root/scripts/hyperagent.sh" init --target "$dry_target" --dry-run >/dev/null
test ! -e "$dry_target/.hyperagent" || fail "--dry-run created project config"
test ! -e "$dry_target/missions" || fail "--dry-run created files"

printf 'HyperAgent init smoke passed.\n'
