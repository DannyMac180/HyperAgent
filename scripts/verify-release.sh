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

require_file CONTRIBUTING.md
require_file SECURITY.md
require_file .github/pull_request_template.md
require_file .github/ISSUE_TEMPLATE/bug_report.md
require_file .github/ISSUE_TEMPLATE/suit_friction.md
require_file .github/ISSUE_TEMPLATE/upgrade_proposal.md
require_file .github/ISSUE_TEMPLATE/eval_idea.md
require_file docs/architecture/hyperagent.mmd
require_file docs/assets/hyperagent-architecture.svg
require_file docs/clean-install-uat.md
require_file docs/dogfooding.md
require_file docs/release-checklist.md
require_file docs/releases/v0.1.0-alpha.md
require_file docs/releases/next-alpha.md
require_file docs/article-outline.md
require_file docs/iron-man-suit-essence.md

require_text CONTRIBUTING.md "How To Propose A Suit Upgrade"
require_text CONTRIBUTING.md "architecture diagram update"
require_text SECURITY.md "Authority Boundary"
require_text .github/pull_request_template.md "README architecture diagram was reviewed or updated"
require_text .github/ISSUE_TEMPLATE/bug_report.md "Bug report"
require_text .github/ISSUE_TEMPLATE/suit_friction.md "Suit friction report"
require_text .github/ISSUE_TEMPLATE/upgrade_proposal.md "Upgrade proposal"
require_text .github/ISSUE_TEMPLATE/eval_idea.md "Eval idea"
require_text docs/architecture/hyperagent.mmd "flowchart LR"
require_text docs/assets/hyperagent-architecture.svg "HyperAgent high-level architecture"
require_text docs/clean-install-uat.md "Clean-Install UAT"
require_text docs/clean-install-uat.md "Try HyperAgent In Codex Mac"
require_text docs/clean-install-uat.md "~/.codex/skills/codex-hyperagent/SKILL.md"
require_text docs/dogfooding.md "Two-Week Dogfooding Cadence"
require_text docs/dogfooding.md "human review"
require_text docs/release-checklist.md "Update And Upgrade Model"
require_text docs/release-checklist.md "Forge Readiness"
require_text docs/release-checklist.md "v0.1.0-alpha"
require_text docs/releases/v0.1.0-alpha.md "Forge Review Flow"
require_text docs/releases/v0.1.0-alpha.md "Optional Extensions"
require_text docs/releases/v0.1.0-alpha.md "Persistent behavior changes require human review."

printf 'HyperAgent release verification passed.\n'
