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
require_file CONTRIBUTING.md
require_file SECURITY.md
require_file .github/pull_request_template.md
require_file .hyperagent
require_file .github/ISSUE_TEMPLATE/bug_report.md
require_file .github/ISSUE_TEMPLATE/suit_friction.md
require_file .github/ISSUE_TEMPLATE/upgrade_proposal.md
require_file .github/ISSUE_TEMPLATE/eval_idea.md
require_file docs/architecture/hyperagent.mmd
require_file docs/assets/hyperagent-architecture.svg
require_file docs/hyperagent-prd.md
require_file docs/iron-man-suit-essence.md
require_file docs/concepts.md
require_file docs/article-outline.md
require_file docs/quickstart.md
require_file docs/clean-install-uat.md
require_file docs/release-checklist.md
require_file docs/releases/v0.1.0-alpha.md
require_file skills/codex-hyperagent/SKILL.md
require_file skills/codex-hyperagent/agents/openai.yaml
require_file bin/hyperagent
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
require_file evals/README.md
require_file evals/smoke-loop.sh
require_file evals/init-smoke.sh
require_file evals/reliability-gains.sh
require_file evals/reliability-rubric.md
require_file evals/fixtures/reliability/baseline-no-suit.md
require_file evals/fixtures/reliability/hyperagent-suit.md
require_file evals/sense-smoke.sh
require_file workshop/backlog.md
require_file workshop/rubric.md
require_file forge/process/quality-rubric.md

require_dir missions
require_dir workshop/proposals
require_dir workshop/decisions
require_dir forge/reviews

require_text skills/codex-hyperagent/SKILL.md "Workshop Review Prompt"
require_text skills/codex-hyperagent/SKILL.md "Forge Review Prompt"
require_text skills/codex-hyperagent/SKILL.md "Relevance Triage"
require_text skills/codex-hyperagent/SKILL.md "workshop/rubric.md"
require_text skills/codex-hyperagent/SKILL.md "name: codex-hyperagent"
require_text skills/codex-hyperagent/SKILL.md "version: v0.1.0-alpha"
require_text skills/codex-hyperagent/agents/openai.yaml "display_name: \"HyperAgent\""
require_text AGENTS.md "HyperAgent triage on every task"
require_text AGENTS.md "README Architecture Diagram"
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
require_text scripts/install-codex-skill.sh "Usage: sh scripts/install-codex-skill.sh"
require_text scripts/install-codex-skill.sh "--dry-run"
require_text scripts/install-codex-skill.sh "--force"
require_text scripts/update-codex-skill.sh "update complete"
require_text bin/hyperagent "scripts/hyperagent.sh"
require_text scripts/hyperagent.sh "init [--target DIR] [--force] [--dry-run]"
require_text scripts/hyperagent.sh "generate_init_config"
require_text scripts/hyperagent.sh "HyperAgent Project Upgrade Backlog"
require_text scripts/hyperagent.sh "decide-upgrade"
require_text scripts/hyperagent.sh "sense [--format markdown|json]"
require_text scripts/hyperagent.sh "doctor [--workbench-trace-log PATH]"
require_text scripts/hyperagent.sh "record-check --command TEXT"
require_text scripts/hyperagent.sh "Does not inspect file contents"
require_text scripts/hyperagent.sh ".hyperagent-evidence/commands.log"
require_text scripts/hyperagent.sh ".hyperagent-evidence/workbench/traces.jsonl"
require_text scripts/hyperagent.sh "human review required"
require_text scripts/hyperagent.sh "--commands-run"
require_text scripts/hyperagent.sh "git_status_short"
require_text scripts/hyperagent.sh "Copy And Symlink Behavior"
require_text scripts/verify-forge-review.sh "Forge review verification passed."
require_text .hyperagent 'hyperagent_version = "v0.1.0-alpha"'
require_text .hyperagent 'install_mode = "copy"'
require_text .hyperagent 'project_instructions = "AGENTS.md"'
require_text .hyperagent 'evidence_log = ".hyperagent-evidence/commands.log"'
require_text .hyperagent 'workbench_trace_log = ".hyperagent-evidence/workbench/traces.jsonl"'
require_text .hyperagent 'codex = true'
require_text README.md "v0.1.0-alpha"
require_text README.md "docs/releases/v0.1.0-alpha.md"
require_text README.md "Try HyperAgent In Codex Mac"
require_text README.md "https://github.com/DannyMac180/HyperAgent"
require_text README.md "~/HyperAgent"
require_text README.md "Do not modify my global Codex custom instructions"
require_text README.md "docs/quickstart.md"
require_text README.md "docs/clean-install-uat.md"
require_text README.md "sh scripts/update-codex-skill.sh"
require_text README.md "docs/release-checklist.md"
require_text README.md "docs/assets/hyperagent-architecture.svg"
require_text README.md "docs/architecture/hyperagent.mmd"
require_text docs/quickstart.md "Manual Quickstart"
require_text docs/quickstart.md "sh scripts/hyperagent.sh init --target"
require_text docs/quickstart.md "sh scripts/install-codex-skill.sh"
require_text docs/quickstart.md "sh scripts/hyperagent.sh status"
require_text docs/quickstart.md "sh scripts/hyperagent.sh sense"
require_text docs/quickstart.md "sh scripts/hyperagent.sh doctor"
require_text docs/quickstart.md ".hyperagent-evidence/"
require_text docs/quickstart.md "--symlink"
require_text docs/quickstart.md "Capture Local Senses"
require_text docs/quickstart.md "sh scripts/hyperagent.sh sense --format json --pr off"
require_text docs/quickstart.md "Workbench trace"
require_text docs/clean-install-uat.md "Clean-Install UAT"
require_text docs/clean-install-uat.md "Try HyperAgent In Codex Mac"
require_text docs/clean-install-uat.md "~/.codex/skills/codex-hyperagent/SKILL.md"
require_text docs/clean-install-uat.md "Codex does not edit global Codex custom instructions"
require_text docs/release-checklist.md "Update And Upgrade Model"
require_text docs/release-checklist.md "Forge Readiness"
require_text docs/release-checklist.md "Forge review flow"
require_text docs/release-checklist.md "outcome, proposal, eval, safety, process bloat, structured summary, gate, and payoff fields"
require_text docs/release-checklist.md "v0.1.0-alpha"
require_text docs/release-checklist.md "Clean-Clone Test"
require_text docs/releases/v0.1.0-alpha.md "Forge Review Flow"
require_text docs/releases/v0.1.0-alpha.md "Persistent behavior changes require human review."
require_text docs/quickstart.md "--forge-review"
require_text evals/README.md "Installer Smoke Eval"
require_text evals/README.md "Init Smoke Eval"
require_text evals/README.md "Reliability Gains Eval"
require_text evals/smoke-loop.sh "HyperAgent smoke loop passed."
require_text evals/smoke-loop.sh "mission missing repo path"
require_text evals/smoke-loop.sh "mission missing verification status"
require_text evals/init-smoke.sh "HyperAgent init smoke passed."
require_text evals/reliability-gains.sh "HyperAgent reliability gains eval passed."
require_text evals/reliability-rubric.md "Missed Verification"
require_text evals/fixtures/reliability/hyperagent-suit.md "Condition: with-hyperagent"
require_text evals/README.md "Sense Smoke Eval"
require_text evals/smoke-loop.sh "HyperAgent smoke loop passed."
require_text evals/smoke-loop.sh "Evidence source type: forge review"
require_text evals/smoke-loop.sh "verify-forge-review.sh"
require_text evals/init-smoke.sh "HyperAgent init smoke passed."
require_text evals/sense-smoke.sh "HyperAgent sense smoke passed."
require_text evals/sense-smoke.sh "Workbench trace status"
require_text hyperagent/operating-prompt.md "human review required"
require_text hyperagent/operating-prompt.md "relevance triage"
require_text hyperagent/operating-prompt.md "workshop/decisions"
require_text hyperagent/operating-prompt.md "--forge-review"
require_text hyperagent/capability-registry.md "human review required"
require_text hyperagent/capability-registry.md "codex-skill-installer"
require_text templates/mission-record.md "Mission ID"
require_text templates/mission-record.md "Repository Evidence"
require_text templates/mission-record.md "Verification status"
require_text templates/mission-record.md "Agent plan"
require_text templates/mission-record.md "Tools used"
require_text templates/mission-record.md "Suit friction observed"
require_text templates/upgrade-proposal.md "Evidence from mission records"
require_text templates/upgrade-proposal.md "Eval or acceptance test"
require_text templates/upgrade-proposal.md "Rollback plan"
require_text templates/upgrade-proposal.md "Allowed activation modes"
require_text templates/upgrade-proposal.md "Decision Handoff"
require_text templates/upgrade-proposal.md "Related Forge review"
require_text templates/upgrade-proposal.md "Evidence from Forge reviews"
require_text templates/forge-review.md "Are proposals specific and evidence-backed?"
require_text templates/forge-review.md "Outcome Quality"
require_text templates/forge-review.md "Eval Quality"
require_text templates/forge-review.md "Safety Quality"
require_text templates/forge-review.md "Structured Summary"
require_text templates/forge-review.md "Deterministic Gates"
require_text templates/forge-review.md "payoff_metrics"
require_text templates/forge-review.md "Suggested proposal command"
require_text templates/upgrade-decision.md "Silent activation allowed: no"
require_text workshop/backlog.md "This backlog tracks"
require_text workshop/rubric.md "Decision Bands"
require_text forge/process/quality-rubric.md "Proposal Quality Metrics"
require_text forge/process/quality-rubric.md "Outcome Quality Metrics"
require_text forge/process/quality-rubric.md "Eval Quality Metrics"
require_text forge/process/quality-rubric.md "Safety Quality Metrics"
require_text forge/process/quality-rubric.md "Score Scale"
require_text forge/process/quality-rubric.md "Deterministic Gates"
require_text scripts/hyperagent.sh "--forge-review"

sh scripts/hyperagent.sh status >/dev/null

printf 'HyperAgent MVP artifact verification passed.\n'
