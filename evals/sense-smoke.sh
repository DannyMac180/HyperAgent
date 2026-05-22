#!/bin/sh
set -eu

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
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

cp -R "$repo_root" "$tmpdir/HyperAgent"
cd "$tmpdir/HyperAgent"

printf '\nSense smoke change.\n' >>README.md

log_path=$(sh scripts/hyperagent.sh record-check --status passed --command "sh scripts/verify-mvp.sh" --note "artifact verifier passed")
test -f "$log_path" || fail "record-check did not create command log"

sh scripts/hyperagent.sh record-check \
  --status failed \
  --command "SECRET_TOKEN=super-secret sh evals/smoke-loop.sh" \
  --note "Intentional smoke failure with API_KEY=hidden" >/dev/null

mkdir -p .hyperagent-evidence/workbench
printf '%s\n' '{"trace_id":"trace-secret-token=visible","url":"local-trace://sense-smoke","status":"ok"}' >.hyperagent-evidence/workbench/traces.jsonl

markdown="$tmpdir/sense.md"
json="$tmpdir/sense.json"
doctor="$tmpdir/doctor.txt"

sh scripts/hyperagent.sh sense --pr off >"$markdown"
sh scripts/hyperagent.sh sense --format json --pr off --trace-url "local-trace://sense-smoke" >"$json"
sh scripts/hyperagent.sh doctor >"$doctor"

require_text "$markdown" "HyperAgent Sense Summary"
require_text "$markdown" "Branch:"
require_text "$markdown" 'README.md'
require_text "$markdown" "Recent Commands And Checks"
require_text "$markdown" "Failures And Retries"
require_text "$markdown" "Workbench Traces"
require_text "$markdown" "healthy: 1 local trace entries available"
require_text "$markdown" "SECRET_TOKEN=[REDACTED]"
require_text "$markdown" "API_KEY=[REDACTED]"
require_text "$markdown" "trace-secret-token=[REDACTED]"

if grep -F "super-secret" "$markdown" >/dev/null; then
  fail "markdown summary leaked a secret-like token value"
fi
if grep -F "hidden" "$markdown" >/dev/null; then
  fail "markdown summary leaked a secret-like note value"
fi

require_text "$json" '"branch"'
require_text "$json" '"changed_files"'
require_text "$json" '"recent_commands"'
require_text "$json" '"failures_and_retries"'
require_text "$json" '"workbench"'
require_text "$json" 'healthy: 1 local trace entries available'
require_text "$json" 'local-trace://sense-smoke'
require_text "$json" 'SECRET_TOKEN=[REDACTED]'
require_text "$json" 'trace-secret-token=[REDACTED]'

require_text "$doctor" "HyperAgent doctor"
require_text "$doctor" "Workbench trace status: healthy: 1 local trace entries available"
require_text "$doctor" "Fallback: sense remains usable without Workbench traces."

if grep -F "super-secret" "$json" >/dev/null; then
  fail "json summary leaked a secret-like token value"
fi
if grep -F "visible" "$json" >/dev/null; then
  fail "json summary leaked a Workbench secret-like token value"
fi

printf 'HyperAgent sense smoke passed.\n'
