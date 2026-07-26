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
require_file adapters/contract.md
require_file adapters/codex.md
require_file docs/hyperagent-prd.md
require_file docs/concepts.md
require_file docs/config.md
require_file docs/product-state.md
require_file docs/roadmap.md
require_file docs/adapters.md
require_file docs/evidence-policy.md
require_file docs/safety-policy.md
require_file docs/quickstart.md
require_file docs/examples/missions/public-safe-mission.md
require_file skills/codex-hyperagent/SKILL.md
require_file skills/codex-hyperagent/agents/openai.yaml
require_file bin/hyperagent
require_file scripts/setup-hyperagent.sh
require_file scripts/install-codex-skill.sh
require_file scripts/update-codex-skill.sh
require_file scripts/hyperagent.sh
require_file scripts/verify-forge-review.sh
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
require_file evals/cli-help-smoke.sh
require_file evals/digest-smoke.sh
require_file evals/setup-hyperagent-smoke.sh
require_file evals/forge-audit-smoke.sh
require_file evals/init-smoke.sh
require_file evals/sense-smoke.sh
require_file evals/reliability-gains.sh
require_file evals/reliability-rubric.md
require_file evals/fixtures/reliability/baseline-no-suit.md
require_file evals/fixtures/reliability/hyperagent-suit.md
require_file evals/fixtures/reliability-traces/workbench-trace-case.md
require_file evals/fixtures/forge-audit/good-proposal.md
require_file evals/fixtures/forge-audit/weak-proposal.md

require_dir missions
require_dir workshop/proposals
require_dir workshop/decisions
require_dir forge/reviews

require_text docs/product-state.md "compatibility pointer"
require_text docs/roadmap.md "PRD core"
require_text docs/roadmap.md "Verification Tiers"
require_text docs/roadmap.md "Optional extension"
require_text docs/roadmap.md "PRD Milestone Map"
require_text docs/roadmap.md "PRD Faithfulness Improvement Map"
require_text docs/roadmap.md "Current Focus"
require_text docs/roadmap.md "Deferred By Design"
require_text docs/adapters.md "Adapter Responsibilities"
require_text docs/evidence-policy.md "Default Boundary"
require_text docs/safety-policy.md "human review required"
require_text skills/codex-hyperagent/SKILL.md "Workshop Review Prompt"
require_text skills/codex-hyperagent/SKILL.md "Forge Review Prompt"
require_text skills/codex-hyperagent/SKILL.md "Relevance Triage"
require_text skills/codex-hyperagent/SKILL.md "mission closeout"
require_text skills/codex-hyperagent/SKILL.md "mission verify --strict"
require_text skills/codex-hyperagent/SKILL.md 'Keep persistent behavior changes `human review required`.'
require_text skills/codex-hyperagent/SKILL.md "name: codex-hyperagent"
require_text skills/codex-hyperagent/SKILL.md "version: v0.1.0-alpha"
require_text skills/codex-hyperagent/agents/openai.yaml "display_name: \"HyperAgent\""
require_text AGENTS.md "HyperAgent triage on every task"
require_text AGENTS.md "README Architecture Diagram"
require_text AGENTS.md 'Keep persistent behavior changes `human review required`.'
require_text scripts/setup-hyperagent.sh "Usage: sh scripts/setup-hyperagent.sh"
require_text scripts/setup-hyperagent.sh "Global Codex custom instructions: unchanged"
require_text scripts/install-codex-skill.sh "Usage: sh scripts/install-codex-skill.sh"
require_text scripts/install-codex-skill.sh "--dry-run"
require_text scripts/install-codex-skill.sh "--force"
require_text scripts/update-codex-skill.sh "update complete"
require_text bin/hyperagent "scripts/hyperagent.sh"
require_text scripts/hyperagent.sh "Primary flows:"
require_text scripts/hyperagent.sh "mission new"
require_text scripts/hyperagent.sh "review proposal"
require_text scripts/hyperagent.sh "review workshop"
require_text scripts/hyperagent.sh "review forge audit"
require_text scripts/hyperagent.sh "verify core"
require_text scripts/hyperagent.sh "verify-config"
require_text scripts/hyperagent.sh "verify-safety"
require_text scripts/hyperagent.sh "check --"
require_text scripts/hyperagent.sh "human review required"
require_text scripts/hyperagent.sh "HYPERAGENT_RUNTIME_ROOT"
require_text scripts/verify-forge-review.sh "Forge review verification passed."
require_text .hyperagent 'hyperagent_version = "v0.1.0-alpha"'
require_text .hyperagent '"sh scripts/hyperagent.sh verify-config"'
require_text .hyperagent 'install_mode = "copy"'
require_text .hyperagent 'project_instructions = "AGENTS.md"'
require_text .hyperagent '[verification]'
require_text .hyperagent '[verification.core]'
require_text .hyperagent '[verification.extensions]'
require_text .hyperagent '[verification.release]'
require_text .hyperagent 'codex = true'
require_text adapters/contract.md "HyperAgent Adapter Contract"
require_text adapters/codex.md "Codex Adapter"
require_text adapters/codex.md "Doctrine Ownership"
require_text adapters/codex.md 'keep persistent behavior changes `human review required`'
require_text README.md "v0.1.0-alpha"
require_text README.md "docs/roadmap.md"
require_text README.md "docs/extensions.md"
require_text README.md "docs/config.md"
require_text README.md "docs/dogfooding.md"
require_text README.md "https://github.com/DannyMac180/HyperAgent"
require_text README.md "~/HyperAgent"
require_text docs/quickstart.md "Manual Quickstart"
require_text docs/quickstart.md "sh scripts/hyperagent.sh init --target"
require_text docs/quickstart.md "sh scripts/hyperagent.sh mission new"
require_text docs/quickstart.md "sh scripts/hyperagent.sh review workshop"
require_text docs/quickstart.md "sh scripts/hyperagent.sh verify-config"
require_text evals/README.md "Verification Tiers"
require_text evals/README.md "CLI Help Smoke Eval"
require_text evals/README.md "Forge Audit Smoke Eval"
require_text evals/smoke-loop.sh "HyperAgent smoke loop passed."
require_text evals/smoke-loop.sh "check wrapper did not record passed status"
require_text evals/init-smoke.sh "HyperAgent init smoke passed."
require_text evals/sense-smoke.sh "HyperAgent sense smoke passed."
require_text evals/forge-audit-smoke.sh "HyperAgent Forge audit smoke passed."
require_text evals/reliability-gains.sh "HyperAgent reliability rubric self-test passed."
require_text hyperagent/operating-prompt.md "human review required"
require_text hyperagent/operating-prompt.md "relevance triage"
require_text hyperagent/operating-prompt.md "configured decisions directory"
require_text hyperagent/operating-prompt.md "mission closeout"
require_text hyperagent/operating-prompt.md 'Keep persistent behavior changes `human review required`.'
require_text hyperagent/capability-registry.md "human review required"
require_text hyperagent/capability-registry.md "codex-skill-installer"
require_text hyperagent/capability-registry.md "In Review Capabilities"
require_text templates/mission-record.md "Mission ID"
require_text templates/mission-record.md "Repository Evidence"
require_text templates/mission-record.md "Verification status"
require_text templates/mission-record.md "Auto-Filled Evidence"
require_text templates/mission-record.md "Agent Judgment"
require_text templates/upgrade-proposal.md "Evidence from mission records"
require_text templates/upgrade-proposal.md "Artifact type: proposal"
require_text templates/upgrade-proposal.md "Eval or acceptance test"
require_text templates/upgrade-proposal.md "Rollback plan"
require_text templates/forge-review.md "Are proposals specific and evidence-backed?"
require_text templates/forge-review.md "Structured Summary"
require_text templates/forge-review.md "Deterministic Gates"
require_text templates/upgrade-decision.md "Silent activation allowed: no"
require_text templates/upgrade-decision.md "Artifact type: decision"
require_text workshop/backlog.md "This backlog tracks"
require_text workshop/rubric.md "Decision Bands"
require_text forge/process/quality-rubric.md "Proposal Quality Metrics"
require_text forge/process/quality-rubric.md "Deterministic Gates"

sh scripts/hyperagent.sh verify-config >/dev/null
sh scripts/hyperagent.sh status >/dev/null
sh scripts/hyperagent.sh verify-safety >/dev/null
sh scripts/hyperagent.sh mission redact-check docs/examples/missions/public-safe-mission.md >/dev/null
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  changed_missions=$(git diff --name-only --diff-filter=ACMRT HEAD -- missions docs/examples/missions 2>/dev/null || true)
  if [ -n "$changed_missions" ]; then
    # shellcheck disable=SC2086
    sh scripts/hyperagent.sh mission redact-check $changed_missions >/dev/null
  fi
fi

printf 'HyperAgent core verification passed.\n'
