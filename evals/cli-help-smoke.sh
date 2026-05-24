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

help_out="$tmpdir/help.txt"
sh scripts/hyperagent.sh help >"$help_out"

require_text "$help_out" "Primary flows:"
require_text "$help_out" "init [--target DIR]"
require_text "$help_out" "sense [--format markdown|json]"
require_text "$help_out" "mission new --request TEXT"
require_text "$help_out" "mission closeout --request TEXT"
require_text "$help_out" "review workshop (--mission PATH | --forge-review PATH)"
require_text "$help_out" "review forge new [--slug SLUG]"
require_text "$help_out" "review decide --proposal PATH"
require_text "$help_out" "ui"
require_text "$help_out" "Compatibility and diagnostics:"
require_text "$help_out" "mission-closeout --request TEXT [--mission PATH]"
require_text "$help_out" "propose-upgrade (--mission PATH | --forge-review PATH)"
require_text "$help_out" "decide-upgrade --proposal PATH"

sense_doctor="$tmpdir/sense-doctor.txt"
doctor_alias="$tmpdir/doctor.txt"
sh scripts/hyperagent.sh sense --doctor >"$sense_doctor"
sh scripts/hyperagent.sh doctor >"$doctor_alias"
cmp "$sense_doctor" "$doctor_alias" >/dev/null || fail "sense --doctor differed from doctor alias"

mission=$(sh scripts/hyperagent.sh mission new \
  --request "CLI grouped mission alias smoke" \
  --slug cli-grouped-mission-alias \
  --commands-run "sh evals/cli-help-smoke.sh" \
  --verification-status "pending")
test -f "$mission" || fail "mission grouped command did not create a mission"
grep -F "CLI grouped mission alias smoke" "$mission" >/dev/null || fail "mission grouped command wrote unexpected content"

closeout=$(sh scripts/hyperagent.sh mission closeout \
  --request "CLI grouped mission closeout smoke" \
  --mission "$mission" \
  --slug cli-grouped-mission-closeout \
  --outcome "Grouped mission closeout passed" \
  --risks "No unresolved CLI grouped command risks" \
  --candidate-upgrades "None")
test "$closeout" = "$mission" || fail "mission closeout did not update requested mission"
sh scripts/hyperagent.sh mission verify --strict "$closeout" >/dev/null

proposal=$(sh scripts/hyperagent.sh review workshop \
  --mission "$closeout" \
  --title "CLI grouped review smoke" \
  --problem "The CLI needs grouped review command coverage")
test -f "$proposal" || fail "review workshop grouped command did not create a proposal"
grep -F "human review required" "$proposal" >/dev/null || fail "grouped proposal missing activation mode"

forge_review=$(sh scripts/hyperagent.sh review forge new --slug cli-grouped-forge-review)
test -f "$forge_review" || fail "review forge new grouped command did not create a Forge review"

sh scripts/hyperagent.sh review digest --limit 3 >/dev/null
sh scripts/hyperagent.sh review forge audit >/dev/null
sh scripts/hyperagent.sh ui >/dev/null

legacy_mission=$(sh scripts/hyperagent.sh new-mission \
  --request "CLI compatibility mission alias smoke" \
  --slug cli-compatibility-mission-alias)
test -f "$legacy_mission" || fail "legacy new-mission alias did not create a mission"

legacy_proposal=$(sh scripts/hyperagent.sh propose-upgrade \
  --mission "$closeout" \
  --title "CLI compatibility review smoke" \
  --problem "The CLI needs compatibility alias coverage")
test -f "$legacy_proposal" || fail "legacy propose-upgrade alias did not create a proposal"

printf 'HyperAgent CLI help smoke passed.\n'
