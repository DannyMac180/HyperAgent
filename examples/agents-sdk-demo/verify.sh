#!/bin/sh
set -eu

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/../.." && pwd)
tmpdir=$(mktemp -d)

cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT INT TERM

cd "$repo_root"

PYTHONPYCACHEPREFIX="$tmpdir/pycache" python3 -m py_compile examples/agents-sdk-demo/demo.py

PYTHONDONTWRITEBYTECODE=1 python3 examples/agents-sdk-demo/demo.py \
  --dry-run \
  --output-root "$tmpdir" \
  --friction "The repo needs a runnable OpenAI Agents SDK reference body." \
  >"$tmpdir/output.json"

mission_count=$(find "$tmpdir/missions" -name '*.md' -type f | wc -l | tr -d ' ')
proposal_count=$(find "$tmpdir/workshop/proposals" -name '*.md' -type f | wc -l | tr -d ' ')
forge_count=$(find "$tmpdir/forge/reviews" -name '*.md' -type f | wc -l | tr -d ' ')

test "$mission_count" = "1" || fail "expected one mission record, found $mission_count"
test "$proposal_count" = "1" || fail "expected one Workshop proposal, found $proposal_count"
test "$forge_count" = "1" || fail "expected one Forge review, found $forge_count"

grep -R "dry-run-no-openai-trace" "$tmpdir/missions" >/dev/null || fail "mission missing dry-run trace marker"
grep -R "human review required" "$tmpdir/workshop/proposals" >/dev/null || fail "proposal missing human review boundary"
grep -R "Human approval needed: yes" "$tmpdir/forge/reviews" >/dev/null || fail "Forge review missing human approval boundary"

test ! -d "$tmpdir/workshop/decisions" || fail "demo verifier should not create decision records"
test ! -f "$tmpdir/hyperagent/capability-registry.md" || fail "demo verifier should not modify capability registry"

printf 'HyperAgent Agents SDK demo verification passed.\n'
