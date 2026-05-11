#!/bin/sh
set -eu

usage() {
  cat <<'USAGE'
Usage: sh scripts/install-codex-skill.sh [--symlink] [--force] [--dry-run] DEST_SKILLS_DIR

Installs the codex-hyperagent skill into DEST_SKILLS_DIR.

Options:
  --symlink   Create a symlink instead of copying the skill directory.
  --force     Replace an existing codex-hyperagent install.
  --dry-run   Print the actions that would be taken without writing files.
  -h, --help  Show this help.
USAGE
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

info() {
  printf '%s\n' "$1"
}

copy_mode=copy
force=0
dry_run=0
dest_root=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --symlink)
      copy_mode=symlink
      ;;
    --force)
      force=1
      ;;
    --dry-run)
      dry_run=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      fail "unknown option: $1"
      ;;
    *)
      if [ -n "$dest_root" ]; then
        fail "expected exactly one destination skills directory"
      fi
      dest_root=$1
      ;;
  esac
  shift
done

if [ "$#" -gt 0 ]; then
  if [ -n "$dest_root" ]; then
    fail "expected exactly one destination skills directory"
  fi
  dest_root=$1
  shift
fi

if [ "$#" -gt 0 ] || [ -z "$dest_root" ]; then
  usage >&2
  exit 1
fi

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd)
source_dir="$repo_root/skills/codex-hyperagent"
source_skill="$source_dir/SKILL.md"
target_dir="$dest_root/codex-hyperagent"
target_skill="$target_dir/SKILL.md"

test -d "$source_dir" || fail "missing source skill directory: $source_dir"
test -f "$source_skill" || fail "missing source skill file: $source_skill"
grep -F "Source Of Truth" "$source_skill" >/dev/null || fail "source skill missing Source Of Truth section"
grep -F "hyperagent/operating-prompt.md" "$source_skill" >/dev/null || fail "source skill missing operating prompt link"

info "HyperAgent Codex skill installer"
info "Source: $source_dir"
info "Destination: $target_dir"
info "Mode: $copy_mode"

if [ -e "$target_dir" ] || [ -L "$target_dir" ]; then
  if [ "$force" -ne 1 ]; then
    fail "destination already exists: $target_dir (use --force to replace it)"
  fi
  if [ "$dry_run" -eq 1 ]; then
    info "Would remove existing destination: $target_dir"
  else
    rm -rf "$target_dir"
  fi
fi

if [ "$dry_run" -eq 1 ]; then
  info "Would create destination root: $dest_root"
  if [ "$copy_mode" = symlink ]; then
    info "Would symlink $source_dir -> $target_dir"
  else
    info "Would copy $source_dir -> $target_dir"
  fi
  info "Dry run complete."
  exit 0
fi

mkdir -p "$dest_root"

if [ "$copy_mode" = symlink ]; then
  ln -s "$source_dir" "$target_dir"
else
  cp -R "$source_dir" "$target_dir"
fi

test -f "$target_skill" || fail "installed skill is missing SKILL.md: $target_skill"
grep -F "Source Of Truth" "$target_skill" >/dev/null || fail "installed skill missing Source Of Truth section"
grep -F "templates/upgrade-proposal.md" "$target_skill" >/dev/null || fail "installed skill missing upgrade proposal link"

info "Installed: $target_skill"
info "Verification: passed"
