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

sh scripts/verify-mvp.sh >/dev/null
sh evals/digest-smoke.sh >/dev/null

sh scripts/hyperagent.sh check --note "smoke wrapper passed" -- sh scripts/hyperagent.sh status >/dev/null
grep -F "passed" .hyperagent-evidence/commands.log >/dev/null || fail "check wrapper did not record passed status"
grep -F "sh scripts/hyperagent.sh status" .hyperagent-evidence/commands.log >/dev/null || fail "check wrapper did not record command"

mission=$(sh scripts/hyperagent.sh new-mission \
  --request "Smoke test the HyperAgent loop" \
  --slug smoke-loop \
  --commands-run "sh scripts/verify-mvp.sh" \
  --verification-status "Smoke verification pending")
test -f "$mission" || fail "mission was not created"
grep -F "Smoke test the HyperAgent loop" "$mission" >/dev/null || fail "mission missing request"
grep -F "Repo path:" "$mission" >/dev/null || fail "mission missing repo path"
grep -F "Branch:" "$mission" >/dev/null || fail "mission missing branch"
grep -F "Git status:" "$mission" >/dev/null || fail "mission missing git status"
grep -F "Changed files:" "$mission" >/dev/null || fail "mission missing changed files"
grep -F "Commands run: sh scripts/verify-mvp.sh" "$mission" >/dev/null || fail "mission missing commands run"
grep -F "Verification status: Smoke verification pending" "$mission" >/dev/null || fail "mission missing verification status"
grep -F "Final outcome: Pending final outcome." "$mission" >/dev/null || fail "mission missing final outcome placeholder"
grep -F "Unresolved risks: Pending unresolved risk review." "$mission" >/dev/null || fail "mission missing unresolved risk placeholder"
if sh scripts/hyperagent.sh verify-mission --strict "$mission" >/dev/null 2>&1; then
  fail "strict mission verification accepted placeholder mission"
fi

closeout=$(sh scripts/hyperagent.sh mission-closeout \
  --request "Smoke test closeout automation" \
  --mission "$mission" \
  --slug smoke-closeout \
  --outcome "Smoke closeout completed" \
  --risks "No unresolved smoke risks" \
  --candidate-upgrades "None")
test "$closeout" = "$mission" || fail "closeout did not update requested mission"
test -f "$closeout" || fail "closeout mission was not created"
grep -F "Auto-Filled Evidence" "$closeout" >/dev/null || fail "closeout missing auto-filled evidence"
grep -F "Sense Snapshot" "$closeout" >/dev/null || fail "closeout missing sense snapshot"
grep -F "Recent Commands And Checks" "$closeout" >/dev/null || fail "closeout missing recent checks"
grep -F "sh scripts/hyperagent.sh status" "$closeout" >/dev/null || fail "closeout missing recorded check"
grep -F "Candidate upgrades: None" "$closeout" >/dev/null || fail "closeout missing candidate upgrades"
sh scripts/hyperagent.sh verify-mission --strict "$closeout" >/dev/null
sh scripts/hyperagent.sh verify-mission --strict docs/examples/missions/public-safe-mission.md >/dev/null
sh scripts/hyperagent.sh mission redact-check docs/examples/missions/public-safe-mission.md >/dev/null

bad_mission="$tmpdir/private-mission.md"
cat >"$bad_mission" <<'EOF'
# Mission Record

- Mission ID: mission-private-path
- User request: Example
- Final outcome: Example
- Unresolved risks: Example
- Verification status: Example
- Changed files: Example
- Repo path: /Users/example/private-repo
EOF
if sh scripts/hyperagent.sh mission redact-check "$bad_mission" >/dev/null 2>&1; then
  fail "redact-check accepted a mission with a private local path"
fi

proposal=$(sh scripts/hyperagent.sh propose-upgrade \
  --mission "$mission" \
  --title "Smoke-test upgrade proposal" \
  --problem "The loop needs proof that proposal creation works")
test -f "$proposal" || fail "proposal was not created"
grep -F "human review required" "$proposal" >/dev/null || fail "proposal missing activation mode"

forge_review=$(sh scripts/hyperagent.sh new-forge-review --slug smoke-loop-forge-review)
test -f "$forge_review" || fail "forge review was not created"
replace_field() {
  perl -0pi -e "s{\Q$1\E}{$2}" "$forge_review"
}

replace_field "Outcome quality score (0-5):" "Outcome quality score (0-5): 3"
replace_field "Outcome quality evidence:" "Outcome quality evidence: Evidence: smoke mission and generated proposal"
replace_field "Proposal specificity score (0-5):" "Proposal specificity score (0-5): 3"
replace_field "Proposal specificity evidence:" "Proposal specificity evidence: Evidence: generated proposal names a problem and activation mode"
replace_field "Eval coverage score (0-5):" "Eval coverage score (0-5): 3"
replace_field "Eval coverage evidence:" "Eval coverage evidence: Evidence: evals/smoke-loop.sh checks generated artifacts"
replace_field "Regression detection score (0-5):" "Regression detection score (0-5): 3"
replace_field "Regression detection evidence:" "Regression detection evidence: Evidence: smoke loop fails on missing Forge fields"
replace_field "Safety boundary preservation score (0-5):" "Safety boundary preservation score (0-5): 3"
replace_field "Safety boundary preservation evidence:" "Safety boundary preservation evidence: Evidence: generated proposal remains human review required"
replace_field "Process bloat risk score (0-5):" "Process bloat risk score (0-5): 3"
replace_field "Process bloat risk evidence:" "Process bloat risk evidence: Evidence: verifier uses local markdown checks only"
replace_field "Every score has evidence: yes/no" "Every score has evidence: yes"
replace_field "Gate result: ready/not ready" "Gate result: ready"
sh scripts/verify-forge-review.sh "$forge_review" >/dev/null
grep -F "Suggested proposal command" "$forge_review" >/dev/null || fail "forge review missing process proposal command"

process_proposal=$(sh scripts/hyperagent.sh propose-upgrade \
  --forge-review "$forge_review" \
  --title "Smoke-test Forge process proposal" \
  --problem "The loop needs proof that Forge reviews can generate process-improvement proposals")
test -f "$process_proposal" || fail "process proposal was not created"
grep -F "Evidence source type: forge review" "$process_proposal" >/dev/null || fail "process proposal missing Forge evidence type"
grep -F "Related Forge review:" "$process_proposal" >/dev/null || fail "process proposal missing related Forge review"

unsafe_proposal=$(sh scripts/hyperagent.sh propose-upgrade \
  --mission "$mission" \
  --title "Unsafe smoke proposal" \
  --problem "The loop needs proof that unsafe accepted proposals are rejected")
perl -0pi -e 's/- Rollback plan: Revert the changed files or remove the accepted registry entry if the upgrade fails review\\./- Rollback plan:/; s/- Proposed activation mode: human review required/- Proposed activation mode: auto-install low risk/' "$unsafe_proposal"
if sh scripts/hyperagent.sh decide-upgrade \
  --proposal "$unsafe_proposal" \
  --decision accepted \
  --reviewer "Smoke Eval" \
  --reason "This should fail because rollback is missing and activation is unsafe" \
  --capability unsafe-smoke-upgrade >/dev/null 2>&1; then
  fail "accepted unsafe proposal without rollback"
fi

decision=$(sh scripts/hyperagent.sh decide-upgrade \
  --proposal "$proposal" \
  --decision accepted \
  --reviewer "Smoke Eval" \
  --reason "The generated proposal is local and reversible" \
  --capability smoke-test-upgrade)
test -f "$decision" || fail "decision was not created"
grep -F "smoke-test-upgrade" hyperagent/capability-registry.md >/dev/null || fail "registry missing accepted capability"

sh scripts/hyperagent.sh status >/dev/null
sh scripts/hyperagent.sh verify-safety >/dev/null

printf 'HyperAgent smoke loop passed.\n'
