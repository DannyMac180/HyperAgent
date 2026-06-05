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
require_file AGENTS.md
require_file .hyperagent
require_file docs/hyperagent-prd.md
require_file docs/concepts.md
require_file docs/product-state.md
require_file docs/roadmap.md
require_file docs/adapters.md
require_file docs/evidence-policy.md
require_file docs/safety-policy.md
require_file docs/quickstart.md
require_file skills/codex-hyperagent/SKILL.md
require_file skills/codex-hyperagent/agents/openai.yaml
require_file bin/hyperagent
require_file scripts/install-codex-skill.sh
require_file scripts/update-codex-skill.sh
require_file scripts/hyperagent.sh
require_file hyperagent/operating-prompt.md
require_file hyperagent/capability-registry.md
require_file templates/mission-record.md
require_file templates/upgrade-proposal.md
require_file templates/forge-review.md
require_file templates/upgrade-decision.md
require_file workshop/backlog.md
require_file workshop/rubric.md
require_file forge/process/quality-rubric.md
require_file evals/README.md
require_file evals/smoke-loop.sh

require_dir missions
require_dir workshop/proposals
require_dir workshop/decisions
require_dir forge/reviews

require_text docs/product-state.md "PRD core"
require_text docs/product-state.md "Verification Tiers"
require_text docs/product-state.md "Optional extension"
require_text docs/roadmap.md "Milestone Status"
require_text docs/adapters.md "Adapter Responsibilities"
require_text docs/evidence-policy.md "Evidence Classes"
require_text docs/safety-policy.md "human review required"
require_text skills/codex-hyperagent/SKILL.md "Workshop Review Prompt"
require_text skills/codex-hyperagent/SKILL.md "Forge Review Prompt"
require_text skills/codex-hyperagent/SKILL.md "Relevance Triage"
require_text skills/codex-hyperagent/SKILL.md "name: codex-hyperagent"
require_text skills/codex-hyperagent/SKILL.md "version: v0.1.0-alpha"
require_text skills/codex-hyperagent/agents/openai.yaml "display_name: \"HyperAgent\""
require_text AGENTS.md "HyperAgent triage on every task"
require_text scripts/install-codex-skill.sh "Usage: sh scripts/install-codex-skill.sh"
require_text scripts/install-codex-skill.sh "--dry-run"
require_text scripts/install-codex-skill.sh "--force"
require_text scripts/update-codex-skill.sh "update complete"
require_text bin/hyperagent "scripts/hyperagent.sh"
require_text scripts/hyperagent.sh "mission new"
require_text scripts/hyperagent.sh "review proposal"
require_text scripts/hyperagent.sh "verify core"
require_text scripts/hyperagent.sh "check --"
require_text scripts/hyperagent.sh "human review required"
require_text .hyperagent 'hyperagent_version = "v0.1.0-alpha"'
require_text .hyperagent 'install_mode = "copy"'
require_text .hyperagent 'project_instructions = "AGENTS.md"'
require_text .hyperagent '[verification.core]'
require_text .hyperagent '[verification.extensions]'
require_text .hyperagent '[verification.release]'
require_text .hyperagent 'codex = true'
require_text README.md "v0.1.0-alpha"
require_text README.md "docs/product-state.md"
require_text README.md "docs/roadmap.md"
require_text README.md "docs/extensions.md"
require_text README.md "https://github.com/DannyMac180/HyperAgent"
require_text README.md "~/HyperAgent"
require_text docs/quickstart.md "Manual Quickstart"
require_text docs/quickstart.md "sh scripts/hyperagent.sh init --target"
require_text docs/quickstart.md "sh scripts/hyperagent.sh mission new"
require_text docs/quickstart.md "sh scripts/hyperagent.sh review prompt workshop"
require_text docs/quickstart.md "sh scripts/hyperagent.sh verify core"
require_text evals/README.md "Verification Tiers"
require_text evals/smoke-loop.sh "HyperAgent smoke loop passed."
require_text hyperagent/operating-prompt.md "human review required"
require_text hyperagent/operating-prompt.md "relevance triage"
require_text hyperagent/operating-prompt.md "workshop/decisions"
require_text hyperagent/capability-registry.md "human review required"
require_text hyperagent/capability-registry.md "codex-skill-installer"
require_text templates/mission-record.md "Mission ID"
require_text templates/mission-record.md "Artifact type: mission"
require_text templates/mission-record.md "Repository Evidence"
require_text templates/mission-record.md "Verification status"
require_text templates/upgrade-proposal.md "Evidence from mission records"
require_text templates/upgrade-proposal.md "Artifact type: proposal"
require_text templates/upgrade-proposal.md "Eval or acceptance test"
require_text templates/upgrade-proposal.md "Rollback plan"
require_text templates/forge-review.md "Are proposals specific and evidence-backed?"
require_text templates/forge-review.md "Artifact type: forge-review"
require_text templates/upgrade-decision.md "Silent activation allowed: no"
require_text templates/upgrade-decision.md "Artifact type: decision"
require_text workshop/backlog.md "This backlog tracks"
require_text workshop/rubric.md "Decision Bands"
require_text forge/process/quality-rubric.md "Proposal Quality Metrics"

sh scripts/hyperagent.sh status >/dev/null

printf 'HyperAgent core verification passed.\n'
