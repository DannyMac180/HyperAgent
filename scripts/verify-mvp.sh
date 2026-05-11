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

require_file README.md
require_file docs/hyperagent-prd.md
require_file docs/iron-man-suit-essence.md
require_file docs/concepts.md
require_file docs/article-outline.md
require_file skills/codex-hyperagent/SKILL.md
require_file scripts/install-codex-skill.sh
require_file hyperagent/operating-prompt.md
require_file hyperagent/capability-registry.md
require_file templates/mission-record.md
require_file templates/upgrade-proposal.md
require_file templates/forge-review.md
require_file evals/README.md

require_dir missions
require_dir workshop/proposals
require_dir forge/reviews

require_text skills/codex-hyperagent/SKILL.md "Workshop Review Prompt"
require_text skills/codex-hyperagent/SKILL.md "Forge Review Prompt"
require_text scripts/install-codex-skill.sh "Usage: sh scripts/install-codex-skill.sh"
require_text scripts/install-codex-skill.sh "--dry-run"
require_text scripts/install-codex-skill.sh "--force"
require_text README.md "sh scripts/install-codex-skill.sh"
require_text README.md "--symlink"
require_text evals/README.md "Installer Smoke Eval"
require_text hyperagent/operating-prompt.md "human review required"
require_text hyperagent/capability-registry.md "human review required"
require_text templates/mission-record.md "Mission ID"
require_text templates/mission-record.md "Agent plan"
require_text templates/mission-record.md "Tools used"
require_text templates/mission-record.md "Suit friction observed"
require_text templates/upgrade-proposal.md "Evidence from mission records"
require_text templates/upgrade-proposal.md "Eval or acceptance test"
require_text templates/upgrade-proposal.md "Rollback plan"
require_text templates/upgrade-proposal.md "Allowed activation modes"
require_text templates/forge-review.md "Are proposals specific and evidence-backed?"

printf 'HyperAgent MVP artifact verification passed.\n'
