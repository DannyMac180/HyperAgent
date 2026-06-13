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

require_file docs/extensions.md
require_file scripts/hyperagent-ui.mjs
require_file ui/index.html
require_file ui/styles.css
require_file ui/app.js
require_file evals/sense-smoke.sh
require_file evals/ui-smoke.sh
require_file evals/reliability-gains.sh
require_file evals/reliability-rubric.md
require_file evals/fixtures/reliability/baseline-no-suit.md
require_file evals/fixtures/reliability/hyperagent-suit.md

require_text docs/extensions.md "Local UI Cockpit"
require_text docs/extensions.md "Workbench Trace Enrichment"
require_text docs/extensions.md "Reliability Scoring"
require_text scripts/hyperagent.sh "sense --doctor"
require_text scripts/hyperagent.sh ".hyperagent-evidence"
require_text scripts/hyperagent.sh "workbench/traces.jsonl"
require_text scripts/hyperagent-ui.mjs "HyperAgent UI running at"
require_text ui/index.html "HyperAgent Cockpit"
require_text ui/styles.css "--paper"
require_text ui/app.js "/api/overview"
require_text evals/sense-smoke.sh "HyperAgent sense smoke passed."
require_text evals/ui-smoke.sh "HyperAgent UI smoke passed."
require_text evals/reliability-gains.sh "HyperAgent reliability rubric self-test passed."
require_text evals/reliability-rubric.md "Missed Verification"
require_text evals/fixtures/reliability/hyperagent-suit.md "Condition: with-hyperagent"

printf 'HyperAgent extension verification passed.\n'
