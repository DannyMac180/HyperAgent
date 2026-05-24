#!/bin/sh
set -eu

usage() {
  cat <<'USAGE'
Usage: sh scripts/setup-codex.sh [options]

Clone or update HyperAgent, verify it, install the Codex skill, and optionally
initialize a target project after confirmation.

Defaults:
  --install-dir $HOME/HyperAgent
  --skills-dir  $HOME/.codex/skills
  --repo-url    https://github.com/DannyMac180/HyperAgent.git

Options:
  --install-dir DIR   Local HyperAgent clone/update path.
  --skills-dir DIR    Codex skills directory.
  --repo-url URL      Git URL used when cloning a missing install dir.
  --init-target DIR   Offer to initialize HyperAgent in DIR after skill setup.
  --force-init        Pass --force to hyperagent init after confirmation.
  --skip-smoke        Run verify-mvp only; skip smoke evals.
  --no-update         Do not run git pull for an existing install dir.
  --dry-run           Print actions without writing files.
  -h, --help          Show this help.
USAGE
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

info() {
  printf '%s\n' "$1"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

path_is_unsafe() {
  candidate=$1
  home_dir=${HOME:-}

  test -n "$candidate" || return 0
  test "$candidate" != "/" || return 0
  if [ -n "$home_dir" ] && [ "$candidate" = "$home_dir" ]; then
    return 0
  fi
  return 1
}

is_hyperagent_repo() {
  candidate=$1
  test -f "$candidate/scripts/install-codex-skill.sh" || return 1
  test -f "$candidate/scripts/verify-mvp.sh" || return 1
  test -f "$candidate/docs/hyperagent-prd.md" || return 1
  test -f "$candidate/skills/codex-hyperagent/SKILL.md" || return 1
  return 0
}

same_dir() {
  left=$(CDPATH= cd "$1" 2>/dev/null && pwd || true)
  right=$(CDPATH= cd "$2" 2>/dev/null && pwd || true)
  test -n "$left" && test "$left" = "$right"
}

confirm_init() {
  target=$1
  printf 'Initialize HyperAgent in %s? [y/N] ' "$target"
  answer=
  if read answer; then
    case "$answer" in
      y|Y|yes|YES) return 0 ;;
      *) return 1 ;;
    esac
  fi
  return 1
}

home=${HOME:-}
test -n "$home" || fail "HOME is not set"

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
source_repo=$(CDPATH= cd "$script_dir/.." && pwd)

install_dir="${HYPERAGENT_HOME:-$home/HyperAgent}"
skills_dir="$home/.codex/skills"
repo_url="https://github.com/DannyMac180/HyperAgent.git"
init_target=
force_init=0
skip_smoke=0
no_update=0
dry_run=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      shift
      test "$#" -gt 0 || fail "--install-dir requires a directory"
      install_dir=$1
      ;;
    --skills-dir)
      shift
      test "$#" -gt 0 || fail "--skills-dir requires a directory"
      skills_dir=$1
      ;;
    --repo-url)
      shift
      test "$#" -gt 0 || fail "--repo-url requires a URL or local path"
      repo_url=$1
      ;;
    --init-target)
      shift
      test "$#" -gt 0 || fail "--init-target requires a directory"
      init_target=$1
      ;;
    --force-init)
      force_init=1
      ;;
    --skip-smoke)
      skip_smoke=1
      ;;
    --no-update)
      no_update=1
      ;;
    --dry-run)
      dry_run=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
  shift
done

require_command git
require_command sh

if path_is_unsafe "$install_dir"; then
  fail "unsafe install dir: $install_dir"
fi

if path_is_unsafe "$skills_dir"; then
  fail "unsafe skills dir: $skills_dir"
fi

info "HyperAgent Codex setup"
info "Install dir: $install_dir"
info "Skills dir: $skills_dir"
info "Repo URL: $repo_url"
info "Global Codex custom instructions: unchanged"

if [ "$dry_run" -eq 1 ]; then
  info "Dry run: no files will be changed."
fi

if [ -e "$install_dir" ]; then
  test -d "$install_dir" || fail "install dir exists but is not a directory: $install_dir"
  is_hyperagent_repo "$install_dir" || fail "install dir exists but is not a HyperAgent repo: $install_dir"
  if [ "$no_update" -eq 1 ]; then
    info "Skipped update: --no-update"
  elif same_dir "$install_dir" "$source_repo"; then
    info "Skipped update: setup script is running from install dir"
  elif ! git -C "$install_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail "install dir is not a git repo and cannot be updated: $install_dir"
  elif [ "$dry_run" -eq 1 ]; then
    info "Would update existing repo: git -C \"$install_dir\" pull --ff-only"
  else
    info "Updating existing repo..."
    git -C "$install_dir" pull --ff-only
  fi
else
  parent=$(dirname "$install_dir")
  if [ "$dry_run" -eq 1 ]; then
    info "Would create parent dir: $parent"
    info "Would clone: git clone \"$repo_url\" \"$install_dir\""
  else
    mkdir -p "$parent"
    info "Cloning HyperAgent..."
    git clone "$repo_url" "$install_dir"
  fi
fi

if [ "$dry_run" -eq 1 ]; then
  info "Would run: sh \"$install_dir/scripts/verify-mvp.sh\""
  if [ "$skip_smoke" -eq 0 ]; then
    info "Would run: sh \"$install_dir/evals/init-smoke.sh\""
    info "Would run: sh \"$install_dir/evals/smoke-loop.sh\""
  fi
  info "Would run: sh \"$install_dir/scripts/install-codex-skill.sh\" --force \"$skills_dir\""
else
  is_hyperagent_repo "$install_dir" || fail "clone/update did not produce a valid HyperAgent repo: $install_dir"

  info "Running MVP verification..."
  sh "$install_dir/scripts/verify-mvp.sh"

  if [ "$skip_smoke" -eq 0 ]; then
    info "Running init smoke..."
    sh "$install_dir/evals/init-smoke.sh"
    info "Running Mission -> Workshop smoke loop..."
    sh "$install_dir/evals/smoke-loop.sh"
  fi

  info "Installing Codex skill..."
  sh "$install_dir/scripts/install-codex-skill.sh" --force "$skills_dir"
fi

if [ -n "$init_target" ]; then
  test -d "$init_target" || fail "init target does not exist: $init_target"
  if [ "$dry_run" -eq 1 ]; then
    info "Would ask before initializing target: $init_target"
  elif confirm_init "$init_target"; then
    init_args=
    if [ "$force_init" -eq 1 ]; then
      init_args=--force
    fi
    sh "$install_dir/scripts/hyperagent.sh" init --target "$init_target" $init_args
  else
    info "Project init skipped by user."
  fi
else
  info "Project init: not requested. Use --init-target DIR to opt in."
fi

info "Setup complete."
if [ "$dry_run" -eq 1 ]; then
  info "Changed: none; dry run only."
  info "Passed: git/sh availability checks."
  info "Dry run: verification and install checks were not executed."
else
  info "Changed: HyperAgent repo cloned or updated when needed; Codex skill installed or updated at $skills_dir/codex-hyperagent."
  info "Passed: git/sh availability checks, MVP verification, and selected install checks."
  if [ "$skip_smoke" -eq 0 ]; then
    info "Passed: init smoke and Mission -> Workshop smoke loop."
  else
    info "Skipped: smoke evals because --skip-smoke was set."
  fi
fi
info "Next: restart Codex Desktop or open a fresh thread if the skill does not appear."
