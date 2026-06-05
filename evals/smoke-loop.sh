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

sh scripts/hyperagent.sh verify core >/dev/null

mission=$(sh scripts/hyperagent.sh mission new \
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

proposal=$(sh scripts/hyperagent.sh review proposal \
  --mission "$mission" \
  --title "Smoke-test upgrade proposal" \
  --problem "The loop needs proof that proposal creation works")
test -f "$proposal" || fail "proposal was not created"
grep -F "human review required" "$proposal" >/dev/null || fail "proposal missing activation mode"

forge_review=$(sh scripts/hyperagent.sh review forge --slug smoke-loop-forge-review)
test -f "$forge_review" || fail "forge review was not created"
grep -F "Proposal quality score" "$forge_review" >/dev/null || fail "forge review missing quality score"

decision=$(sh scripts/hyperagent.sh review decision \
  --proposal "$proposal" \
  --decision accepted \
  --reviewer "Smoke Eval" \
  --reason "The generated proposal is local and reversible" \
  --capability smoke-test-upgrade)
test -f "$decision" || fail "decision was not created"
grep -F "smoke-test-upgrade" hyperagent/capability-registry.md >/dev/null || fail "registry missing accepted capability"

sh scripts/hyperagent.sh status >/dev/null

printf 'HyperAgent smoke loop passed.\n'
