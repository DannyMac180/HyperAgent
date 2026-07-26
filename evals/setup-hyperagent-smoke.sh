#!/bin/sh
set -eu

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

require_file() {
  test -f "$1" || fail "missing file: $1"
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

skills_dir="$tmpdir/skills"
target="$tmpdir/target"
mkdir -p "$target"

setup_log="$tmpdir/setup.log"
printf 'y\n' | sh "$repo_root/scripts/setup-hyperagent.sh" \
  --install-dir "$repo_root" \
  --skills-dir "$skills_dir" \
  --init-target "$target" \
  --skip-smoke \
  --no-update >"$setup_log"

require_file "$skills_dir/codex-hyperagent/SKILL.md"
require_file "$target/.hyperagent/config.toml"
require_file "$target/AGENTS.md"
test ! -e "$target/missions" || fail "setup init created top-level missions"
test ! -e "$target/workshop" || fail "setup init created top-level workshop"
test ! -e "$target/forge" || fail "setup init created top-level forge"
test ! -e "$target/templates" || fail "setup init created top-level templates"
test ! -e "$target/hyperagent" || fail "setup init created top-level hyperagent"
require_text "$setup_log" "Global Codex custom instructions: unchanged"
require_text "$setup_log" "Setup complete."
require_text "$target/AGENTS.md" "HyperAgent Project Instructions"

skip_target="$tmpdir/skip-target"
mkdir -p "$skip_target"
skip_log="$tmpdir/skip.log"
printf 'n\n' | sh "$repo_root/scripts/setup-hyperagent.sh" \
  --install-dir "$repo_root" \
  --skills-dir "$tmpdir/skip-skills" \
  --init-target "$skip_target" \
  --skip-smoke \
  --no-update >"$skip_log"

test ! -e "$skip_target/.hyperagent" || fail "project init ran without yes confirmation"
require_text "$skip_log" "Project init skipped by user."

dry_log="$tmpdir/dry.log"
sh "$repo_root/scripts/setup-hyperagent.sh" \
  --install-dir "$tmpdir/DryHyperAgent" \
  --skills-dir "$tmpdir/dry-skills" \
  --repo-url "$repo_root" \
  --skip-smoke \
  --dry-run >"$dry_log"

test ! -e "$tmpdir/DryHyperAgent" || fail "dry run created install dir"
test ! -e "$tmpdir/dry-skills" || fail "dry run created skills dir"
require_text "$dry_log" "Would clone:"
require_text "$dry_log" "Would run: sh"
require_text "$dry_log" "Dry run: verification and install checks were not executed."

env_home_log="$tmpdir/env-home.log"
HYPERAGENT_HOME="$repo_root" sh "$repo_root/scripts/setup-hyperagent.sh" \
  --skills-dir "$tmpdir/env-home-skills" \
  --skip-smoke \
  --no-update \
  --dry-run >"$env_home_log"
require_text "$env_home_log" "Install dir: $repo_root"

unsafe_log="$tmpdir/unsafe.log"
if sh "$repo_root/scripts/setup-hyperagent.sh" \
  --install-dir "$repo_root" \
  --skills-dir / \
  --skip-smoke \
  --no-update >"$unsafe_log" 2>&1; then
  fail "setup accepted unsafe skills dir"
fi
require_text "$unsafe_log" "unsafe skills dir: /"

printf 'HyperAgent setup-hyperagent smoke passed.\n'
