#!/bin/sh
set -eu

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
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

cp evals/fixtures/forge-audit/good-proposal.md workshop/proposals/2026-05-23-forge-audit-good-fixture.md
cp evals/fixtures/forge-audit/weak-proposal.md workshop/proposals/2026-05-23-forge-audit-weak-fixture.md

cat >workshop/decisions/2026-05-23-rejected-forge-audit-good-fixture.md <<'EOF'
# Upgrade Decision

- Decision ID: decision-2026-05-23-rejected-forge-audit-good-fixture
- Date/time: 2026-05-23 10:02 EDT
- Proposal: `workshop/proposals/2026-05-23-forge-audit-good-fixture.md`
- Decision: rejected
- Reviewer: Forge Audit Smoke Eval
- Reason: The fixture is intentionally complete but not an installed capability.
- Capability registry ID:

## Authority Boundary

- Human approval recorded: yes
- Silent activation allowed: no
- Permission or secrets changes approved: no

## Rollback

- Rollback path: remove the fixture decision.
EOF

cat >>hyperagent/capability-registry.md <<'EOF'

## forge-audit-broken-fixture

- Status: accepted
- Title: Broken registry fixture
- Activation mode: human review required
EOF

output=$(sh scripts/hyperagent.sh forge audit)
printf '%s\n' "$output" | grep -F "# Forge Audit" >/dev/null || fail "audit did not print a report"
printf '%s\n' "$output" | grep -F "[weak-proposal]" >/dev/null || fail "audit did not flag the weak proposal"
printf '%s\n' "$output" | grep -F "2026-05-23-forge-audit-weak-fixture.md" >/dev/null || fail "audit did not name the weak fixture"
printf '%s\n' "$output" | grep -F "[stale-proposal]" >/dev/null || fail "audit did not flag proposals needing decisions"
printf '%s\n' "$output" | grep -F "[registry-traceability]" >/dev/null || fail "audit did not flag broken registry traceability"
printf '%s\n' "$output" | grep -F "forge-audit-broken-fixture" >/dev/null || fail "audit did not name the broken registry fixture"
printf '%s\n' "$output" | grep -F "Finding count:" >/dev/null || fail "audit missing finding count"

proposal_output=$(sh scripts/hyperagent.sh forge audit --write-proposal)
printf '%s\n' "$proposal_output" | grep -F "Process proposal created:" >/dev/null || fail "audit did not create a process proposal when requested"
created=$(printf '%s\n' "$proposal_output" | awk -F'`' '/Process proposal created:/ { print $2; exit }')
test -n "$created" || fail "created proposal path was not reported"
test -f "$created" || fail "created process proposal is missing"
grep -F "Proposed activation mode: human review required" "$created" >/dev/null || fail "created proposal changed activation boundary"
grep -F "Evidence source type: forge audit" "$created" >/dev/null || fail "created proposal missing audit evidence type"

printf 'HyperAgent Forge audit smoke passed.\n'
