#!/bin/sh
set -eu

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: sh evals/reliability-gains.sh [--cases DIR] [--output DIR]

Scores local reliability case records and compares without-HyperAgent and
with-HyperAgent runs. Output defaults to evals/out/reliability-gains/.
USAGE
}

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
cases_dir="$script_dir/fixtures/reliability"
output_dir="$script_dir/out/reliability-gains"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --cases)
      shift
      test "$#" -gt 0 || fail "--cases requires a directory"
      cases_dir="$1"
      ;;
    --output)
      shift
      test "$#" -gt 0 || fail "--output requires a directory"
      output_dir="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
  shift
done

test -d "$cases_dir" || fail "missing cases directory: $cases_dir"

mkdir -p "$output_dir"
scores_file="$output_dir/scores.tsv"
report_file="$output_dir/report.md"

field_value() {
  file="$1"
  label="$2"
  sed -n "s/^- $label: //p" "$file" | sed -n '1p'
}

score_task_completion() {
  case "$1" in
    yes) printf '2' ;;
    partial) printf '1' ;;
    no) printf '0' ;;
    *) fail "unknown task completion value: $1" ;;
  esac
}

score_verification() {
  case "$1" in
    run-with-evidence) printf '2' ;;
    mentioned-only) printf '1' ;;
    missing) printf '0' ;;
    *) fail "unknown verification value: $1" ;;
  esac
}

score_failure_recovery() {
  case "$1" in
    retry-with-resolution) printf '2' ;;
    identified-only) printf '1' ;;
    missing) printf '0' ;;
    *) fail "unknown failure recovery value: $1" ;;
  esac
}

score_proposal_specificity() {
  case "$1" in
    specific) printf '2' ;;
    vague) printf '1' ;;
    missing) printf '0' ;;
    *) fail "unknown proposal specificity value: $1" ;;
  esac
}

score_time_to_artifact() {
  minutes="$1"
  case "$minutes" in
    none) printf '0'; return 0 ;;
    *[!0-9]*|'') fail "time to useful artifact must be a number or none: $minutes" ;;
  esac

  if [ "$minutes" -le 30 ]; then
    printf '2'
  elif [ "$minutes" -le 60 ]; then
    printf '1'
  else
    printf '0'
  fi
}

final_report_contains() {
  file="$1"
  needle="$2"
  awk -v needle="$needle" '
    found && index($0, needle) > 0 { hit = 1 }
    /^## Final Report$/ { found = 1 }
    END { exit hit ? 0 : 1 }
  ' "$file"
}

score_report_quality() {
  file="$1"
  hits=0

  final_report_contains "$file" "Completion evidence:" && hits=$((hits + 1))
  final_report_contains "$file" "Verification:" && hits=$((hits + 1))
  final_report_contains "$file" "Files changed:" && hits=$((hits + 1))
  final_report_contains "$file" "Unresolved risks:" && hits=$((hits + 1))

  if [ "$hits" -ge 4 ]; then
    printf '2'
  elif [ "$hits" -ge 2 ]; then
    printf '1'
  else
    printf '0'
  fi
}

printf 'run_id\tcondition\ttask_completion\tfinal_report_quality\tmissed_verification\tfailure_recovery\tproposal_specificity\ttime_to_artifact\ttotal\tcase_file\n' >"$scores_file"

found_cases=0
for case_file in "$cases_dir"/*.md; do
  test -f "$case_file" || continue
  found_cases=$((found_cases + 1))

  run_id=$(field_value "$case_file" "Run ID")
  condition=$(field_value "$case_file" "Condition")
  task_completed=$(field_value "$case_file" "Task completed")
  verification=$(field_value "$case_file" "Verification")
  failure_recovery=$(field_value "$case_file" "Failure recovery")
  proposal_specificity=$(field_value "$case_file" "Proposal specificity")
  time_minutes=$(field_value "$case_file" "Time to useful artifact minutes")

  test -n "$run_id" || fail "missing Run ID in $case_file"
  test "$condition" = "without-hyperagent" || test "$condition" = "with-hyperagent" || fail "unknown condition in $case_file: $condition"

  task_score=$(score_task_completion "$task_completed")
  report_score=$(score_report_quality "$case_file")
  verification_score=$(score_verification "$verification")
  recovery_score=$(score_failure_recovery "$failure_recovery")
  proposal_score=$(score_proposal_specificity "$proposal_specificity")
  time_score=$(score_time_to_artifact "$time_minutes")
  total=$((task_score + report_score + verification_score + recovery_score + proposal_score + time_score))

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$run_id" "$condition" "$task_score" "$report_score" "$verification_score" \
    "$recovery_score" "$proposal_score" "$time_score" "$total" "$case_file" >>"$scores_file"
done

test "$found_cases" -gt 0 || fail "no Markdown cases found in $cases_dir"

baseline_best=$(awk -F '\t' 'NR > 1 && $2 == "without-hyperagent" && $9 > best { best = $9 } END { if (best == "") exit 1; print best }' "$scores_file") \
  || fail "missing without-hyperagent case"
hyperagent_best=$(awk -F '\t' 'NR > 1 && $2 == "with-hyperagent" && $9 > best { best = $9 } END { if (best == "") exit 1; print best }' "$scores_file") \
  || fail "missing with-hyperagent case"
delta=$((hyperagent_best - baseline_best))
if [ "$delta" -gt 0 ]; then
  delta_display="+$delta"
else
  delta_display="$delta"
fi

{
  printf '# HyperAgent Reliability Gains Eval\n\n'
  printf '%s\n' "- Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  printf '%s\n' "- Cases directory: \`$cases_dir\`"
  printf '%s\n' "- Scores TSV: \`$scores_file\`"
  printf '%s\n' "- Best without HyperAgent: $baseline_best/12"
  printf '%s\n' "- Best with HyperAgent: $hyperagent_best/12"
  printf '%s\n\n' "- Delta: $delta_display"
  printf '## Scores\n\n'
  printf '| Run | Condition | Task | Report | Verification | Recovery | Proposal | Time | Total |\n'
  printf '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n'
  awk -F '\t' 'NR > 1 { printf "| %s | %s | %s | %s | %s | %s | %s | %s | %s |\n", $1, $2, $3, $4, $5, $6, $7, $8, $9 }' "$scores_file"
  printf '\n## Rubric\n\n'
  printf 'Each case is scored out of 12 across task completion, final report quality, missed verification, failure recovery, proposal specificity, and time to useful PR or artifact. See `evals/reliability-rubric.md`.\n'
} >"$report_file"

test "$delta" -gt 0 || fail "with-hyperagent case did not beat without-hyperagent case"

printf 'HyperAgent reliability gains eval passed. Report: %s\n' "$report_file"
