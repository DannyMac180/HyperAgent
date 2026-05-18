#!/bin/sh
set -eu

usage() {
  cat <<'USAGE'
Usage: sh scripts/update-codex-skill.sh [--symlink] [DEST_SKILLS_DIR]

Updates the installed codex-hyperagent skill after pulling repo changes.

Defaults:
  DEST_SKILLS_DIR=$HOME/.codex/skills

Options:
  --symlink   Install as a symlink instead of a copy.
  -h, --help  Show this help.
USAGE
}

mode=
dest_root="${HOME}/.codex/skills"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --symlink)
      mode=--symlink
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      printf 'FAIL: unknown option: %s\n' "$1" >&2
      exit 1
      ;;
    *)
      dest_root=$1
      ;;
  esac
  shift
done

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)

if [ -n "$mode" ]; then
  sh "$script_dir/install-codex-skill.sh" "$mode" --force "$dest_root"
else
  sh "$script_dir/install-codex-skill.sh" --force "$dest_root"
fi

printf 'HyperAgent skill update complete. Restart Codex Desktop or open a fresh thread if needed.\n'
