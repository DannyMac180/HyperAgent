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

rm -f missions/*.md workshop/proposals/*.md workshop/decisions/*.md forge/reviews/*.md

mission_one=$(sh scripts/hyperagent.sh new-mission \
  --request "Digest smoke mission with repeated manual handoff friction" \
  --slug digest-friction-one \
  --commands-run "sh scripts/verify-mvp.sh" \
  --verification-status "Fixture verification")
sh scripts/hyperagent.sh mission-closeout \
  --request "Digest smoke mission with repeated manual handoff friction" \
  --mission "$mission_one" \
  --slug digest-friction-one \
  --outcome "Fixture mission recorded recurring manual Workshop handoff friction" \
  --risks "Unresolved risk: mission evidence can become a graveyard without proposal handoff" \
  --candidate-upgrades "Add a digest that converts repeated manual handoff friction into a reviewed Workshop proposal" >/dev/null

mission_two=$(sh scripts/hyperagent.sh new-mission \
  --request "Digest smoke mission with repeated missing proposal handoff" \
  --slug digest-friction-two \
  --commands-run "sh scripts/verify-mvp.sh" \
  --verification-status "Fixture verification")
sh scripts/hyperagent.sh mission-closeout \
  --request "Digest smoke mission with repeated missing proposal handoff" \
  --mission "$mission_two" \
  --slug digest-friction-two \
  --outcome "Fixture mission recorded repeated missing proposal handoff" \
  --risks "Unresolved risk: backlog movement remains weak" \
  --candidate-upgrades "Add Workshop cadence audit for missing proposal handoff" >/dev/null

proposal=$(sh scripts/hyperagent.sh propose-upgrade \
  --mission "$mission_one" \
  --title "Existing stale fixture proposal" \
  --problem "Fixture proposal intentionally remains undecided")
test -f "$proposal" || fail "fixture proposal missing"

digest=$(sh scripts/hyperagent.sh workshop-digest --limit 5)
printf '%s\n' "$digest" | grep -F "Friction missions without proposal handoff: 1" >/dev/null || fail "digest did not identify missing proposal handoff"
printf '%s\n' "$digest" | grep -F "Workshop proposals without decision records: 1" >/dev/null || fail "digest did not identify stale proposal"
printf '%s\n' "$digest" | grep -F "Forge cadence is due" >/dev/null || fail "digest did not surface Forge cadence"
printf '%s\n' "$digest" | grep -F "Recommended Next Actions" >/dev/null || fail "digest missing recommendation section"

draft=$(sh scripts/hyperagent.sh workshop-digest \
  --limit 5 \
  --draft-proposal \
  --title "Digest smoke cadence proposal" \
  --slug digest-smoke-cadence-proposal)
printf '%s\n' "$draft" | grep -F "Draft Workshop proposal:" >/dev/null || fail "digest did not draft proposal"
printf '%s\n' "$draft" | grep -F "human review required" >/dev/null || fail "digest did not preserve human review boundary"
test -f workshop/proposals/*digest-smoke-cadence-proposal.md || fail "draft proposal file missing"
test "$(find workshop/decisions -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')" = "0" || fail "digest created a decision record"

printf 'HyperAgent digest smoke passed.\n'
