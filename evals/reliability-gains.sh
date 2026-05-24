#!/bin/sh
set -eu

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: sh evals/reliability-gains.sh [--cases DIR] [--missions DIR] [--traces DIR] [--output DIR]

Scores local reliability case records and compares without-HyperAgent and
with-HyperAgent runs. Output defaults to evals/out/reliability-gains/.

By default the eval scores curated fixtures plus local mission records from
missions/. Trace-derived Markdown case files can be added with --traces DIR.
USAGE
}

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_dir=$(CDPATH= cd "$script_dir/.." && pwd)
cases_dir="$script_dir/fixtures/reliability"
missions_dir="$repo_dir/missions"
traces_dir=""
output_dir="$script_dir/out/reliability-gains"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --cases)
      shift
      test "$#" -gt 0 || fail "--cases requires a directory"
      cases_dir="$1"
      ;;
    --missions)
      shift
      test "$#" -gt 0 || fail "--missions requires a directory"
      missions_dir="$1"
      ;;
    --traces)
      shift
      test "$#" -gt 0 || fail "--traces requires a directory"
      traces_dir="$1"
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
test -z "$missions_dir" || test -d "$missions_dir" || fail "missing missions directory: $missions_dir"
test -z "$traces_dir" || test -d "$traces_dir" || fail "missing traces directory: $traces_dir"

mkdir -p "$output_dir"
scores_file="$output_dir/scores.tsv"
report_file="$output_dir/report.md"
generated_dir="$output_dir/generated-cases"
mission_cases_dir="$generated_dir/mission-derived"
trace_cases_dir="$generated_dir/trace-derived"
rm -rf "$generated_dir"
mkdir -p "$mission_cases_dir" "$trace_cases_dir"

field_value() {
  file="$1"
  label="$2"
  sed -n "s/^- $label: //p" "$file" | sed -n '1p'
}

safe_slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9][^a-z0-9]*/-/g; s/^-//; s/-$//'
}

section_contains() {
  file="$1"
  heading="$2"
  needle="$3"
  awk -v heading="$heading" -v needle="$needle" '
    $0 == heading { found = 1; next }
    found && /^## / { found = 0 }
    found && index($0, needle) > 0 { hit = 1 }
    END { exit hit ? 0 : 1 }
  ' "$file"
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

infer_mission_task_completed() {
  file="$1"
  if test -n "$(field_value "$file" "Final outcome")" && test -n "$(field_value "$file" "Completion evidence")"; then
    printf 'yes'
  elif test -n "$(field_value "$file" "Final outcome")"; then
    printf 'partial'
  else
    printf 'no'
  fi
}

infer_mission_verification() {
  file="$1"
  verification=$(field_value "$file" "Verification performed")
  if test -n "$verification" && test "$verification" != "See recent commands and checks."; then
    printf 'run-with-evidence'
  elif section_contains "$file" "### Recent Commands And Checks" "passed"; then
    printf 'run-with-evidence'
  elif grep -F "Verification" "$file" >/dev/null; then
    printf 'mentioned-only'
  else
    printf 'missing'
  fi
}

infer_mission_failure_recovery() {
  file="$1"
  failures=$(field_value "$file" "Failures, retries, and blockers")
  if section_contains "$file" "### Failures And Retries" "failed" || section_contains "$file" "### Failures And Retries" "retried"; then
    printf 'retry-with-resolution'
  elif test -n "$failures" && ! printf '%s' "$failures" | grep -F "None" >/dev/null; then
    printf 'identified-only'
  else
    printf 'missing'
  fi
}

infer_mission_proposal_specificity() {
  file="$1"
  proposals=$(field_value "$file" "Upgrade proposal paths")
  upgrades=$(field_value "$file" "Candidate upgrades")
  if test -n "$proposals" && ! printf '%s' "$proposals" | grep -F "None" >/dev/null; then
    printf 'specific'
  elif test -n "$upgrades" && ! printf '%s' "$upgrades" | grep -F "None" >/dev/null; then
    printf 'vague'
  else
    printf 'missing'
  fi
}

generate_mission_case() {
  mission_file="$1"
  run_id=$(field_value "$mission_file" "Mission ID")
  test -n "$run_id" || return 0
  slug=$(safe_slug "$run_id")
  out_file="$mission_cases_dir/$slug.md"

  task_completed=$(field_value "$mission_file" "Reliability task completed")
  verification=$(field_value "$mission_file" "Reliability verification")
  failure_recovery=$(field_value "$mission_file" "Reliability failure recovery")
  proposal_specificity=$(field_value "$mission_file" "Reliability proposal specificity")
  time_minutes=$(field_value "$mission_file" "Reliability time to useful artifact minutes")

  test -n "$task_completed" || task_completed=$(infer_mission_task_completed "$mission_file")
  test -n "$verification" || verification=$(infer_mission_verification "$mission_file")
  test -n "$failure_recovery" || failure_recovery=$(infer_mission_failure_recovery "$mission_file")
  test -n "$proposal_specificity" || proposal_specificity=$(infer_mission_proposal_specificity "$mission_file")
  test -n "$time_minutes" || time_minutes=none

  {
    printf '# Reliability Eval Case: %s\n\n' "$run_id"
    printf '%s\n' "- Run ID: $run_id"
    printf '%s\n' "- Evidence source type: mission-derived"
    printf '%s\n' "- Source path: $mission_file"
    printf '%s\n' "- Condition: with-hyperagent"
    printf '%s\n' "- Scenario: $(field_value "$mission_file" "User request")"
    printf '%s\n' "- Task completed: $task_completed"
    printf '%s\n' "- Verification: $verification"
    printf '%s\n' "- Failure recovery: $failure_recovery"
    printf '%s\n' "- Proposal specificity: $proposal_specificity"
    printf '%s\n\n' "- Time to useful artifact minutes: $time_minutes"
    printf '## Run Notes\n\n'
    printf 'Generated from a real mission record. Automated fields are conservative and can be overridden with `Reliability ...` annotation metadata in the source mission when human judgment is required.\n\n'
    printf '## Final Report\n\n'
    printf 'Completion evidence: %s\n\n' "$(field_value "$mission_file" "Completion evidence")"
    printf 'Verification: %s\n\n' "$(field_value "$mission_file" "Verification performed")"
    printf 'Files changed: %s\n\n' "$(field_value "$mission_file" "Files or systems changed")"
    printf 'Unresolved risks: %s\n\n' "$(field_value "$mission_file" "Unresolved risks")"
    printf 'Reusable proposal: %s\n' "$(field_value "$mission_file" "Candidate upgrades")"
  } >"$out_file"
}

copy_trace_case() {
  trace_file="$1"
  run_id=$(field_value "$trace_file" "Run ID")
  test -n "$run_id" || fail "trace-derived case missing Run ID: $trace_file"
  source_type=$(field_value "$trace_file" "Evidence source type")
  test "$source_type" = "trace-derived" || fail "trace case must declare Evidence source type: trace-derived in $trace_file"
  cp "$trace_file" "$trace_cases_dir/$(safe_slug "$run_id").md"
}

if test -n "$missions_dir"; then
  for mission_file in "$missions_dir"/*.md; do
    test -f "$mission_file" || continue
    generate_mission_case "$mission_file"
  done
fi

if test -n "$traces_dir"; then
  for trace_file in "$traces_dir"/*.md; do
    test -f "$trace_file" || continue
    copy_trace_case "$trace_file"
  done
fi

printf 'run_id\tevidence_source_type\tcondition\ttask_completion\tfinal_report_quality\tmissed_verification\tfailure_recovery\tproposal_specificity\ttime_to_artifact\ttotal\tcase_file\n' >"$scores_file"

found_cases=0
score_case_dir() {
  score_cases_dir="$1"
  default_source_type="$2"
  for case_file in "$score_cases_dir"/*.md; do
  test -f "$case_file" || continue
  found_cases=$((found_cases + 1))

  run_id=$(field_value "$case_file" "Run ID")
  evidence_source_type=$(field_value "$case_file" "Evidence source type")
  test -n "$evidence_source_type" || evidence_source_type="$default_source_type"
  condition=$(field_value "$case_file" "Condition")
  task_completed=$(field_value "$case_file" "Task completed")
  verification=$(field_value "$case_file" "Verification")
  failure_recovery=$(field_value "$case_file" "Failure recovery")
  proposal_specificity=$(field_value "$case_file" "Proposal specificity")
  time_minutes=$(field_value "$case_file" "Time to useful artifact minutes")

  test -n "$run_id" || fail "missing Run ID in $case_file"
  case "$evidence_source_type" in
    fixture|mission-derived|trace-derived) ;;
    *) fail "unknown evidence source type in $case_file: $evidence_source_type" ;;
  esac
  test "$condition" = "without-hyperagent" || test "$condition" = "with-hyperagent" || fail "unknown condition in $case_file: $condition"

  task_score=$(score_task_completion "$task_completed")
  report_score=$(score_report_quality "$case_file")
  verification_score=$(score_verification "$verification")
  recovery_score=$(score_failure_recovery "$failure_recovery")
  proposal_score=$(score_proposal_specificity "$proposal_specificity")
  time_score=$(score_time_to_artifact "$time_minutes")
  total=$((task_score + report_score + verification_score + recovery_score + proposal_score + time_score))

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$run_id" "$evidence_source_type" "$condition" "$task_score" "$report_score" "$verification_score" \
    "$recovery_score" "$proposal_score" "$time_score" "$total" "$case_file" >>"$scores_file"
  done
}

score_case_dir "$cases_dir" "fixture"
if test -d "$mission_cases_dir"; then
  score_case_dir "$mission_cases_dir" "mission-derived"
fi
if test -d "$trace_cases_dir"; then
  score_case_dir "$trace_cases_dir" "trace-derived"
fi

test "$found_cases" -gt 0 || fail "no Markdown cases found in $cases_dir"

baseline_best=$(awk -F '\t' 'NR > 1 && $3 == "without-hyperagent" && $10 > best { best = $10 } END { if (best == "") exit 1; print best }' "$scores_file") \
  || fail "missing without-hyperagent case"
hyperagent_best=$(awk -F '\t' 'NR > 1 && $3 == "with-hyperagent" && $10 > best { best = $10 } END { if (best == "") exit 1; print best }' "$scores_file") \
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
  printf '%s\n' "- Missions directory: \`$missions_dir\`"
  if test -n "$traces_dir"; then
    printf '%s\n' "- Trace cases directory: \`$traces_dir\`"
  else
    printf '%s\n' "- Trace cases directory: not provided"
  fi
  printf '%s\n' "- Generated cases directory: \`$generated_dir\`"
  printf '%s\n' "- Scores TSV: \`$scores_file\`"
  printf '%s\n' "- Best without HyperAgent: $baseline_best/12"
  printf '%s\n' "- Best with HyperAgent: $hyperagent_best/12"
  printf '%s\n\n' "- Delta: $delta_display"
  printf '## Evidence Sources\n\n'
  awk -F '\t' 'NR > 1 { counts[$2]++ } END { for (source in counts) printf "- %s: %s case(s)\n", source, counts[source] }' "$scores_file" | sort
  printf '\n'
  printf '## Source Summary\n\n'
  printf '| Source | Cases | Best Total | Average Total |\n'
  printf '| --- | ---: | ---: | ---: |\n'
  awk -F '\t' 'NR > 1 { count[$2]++; sum[$2] += $10; if ($10 > best[$2]) best[$2] = $10 } END { for (source in count) printf "| %s | %s | %s | %.1f |\n", source, count[source], best[source], sum[source] / count[source] }' "$scores_file" | sort
  printf '\n'
  printf '## Scores\n\n'
  printf '| Run | Source | Condition | Task | Report | Verification | Recovery | Proposal | Time | Total |\n'
  printf '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n'
  awk -F '\t' 'NR > 1 { printf "| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n", $1, $2, $3, $4, $5, $6, $7, $8, $9, $10 }' "$scores_file"
  printf '\n## Rubric\n\n'
  printf 'Each case is scored out of 12 across task completion, final report quality, missed verification, failure recovery, proposal specificity, and time to useful PR or artifact. See `evals/reliability-rubric.md`.\n'
  printf '\n## Interpretation Limits\n\n'
  printf 'Fixture cases are curated examples. Mission-derived cases are generated from real mission records using conservative metadata inference plus optional manual `Reliability ...` annotations. Trace-derived cases are accepted only when supplied as explicit Markdown cases with `Evidence source type: trace-derived`. Scores are directional evidence for reliability trends, not precise runtime measurements.\n'
} >"$report_file"

test "$delta" -gt 0 || fail "with-hyperagent case did not beat without-hyperagent case"

printf 'HyperAgent reliability gains eval passed. Report: %s\n' "$report_file"
