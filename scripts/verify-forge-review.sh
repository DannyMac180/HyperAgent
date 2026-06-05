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

require_score() {
  file="$1"
  label="$2"
  line=$(grep -F -e "$label" "$file" || true)
  test -n "$line" || fail "missing score field: $label"
  printf '%s\n' "$line" | grep -E ': [0-5]($|[^0-9])' >/dev/null || fail "score must be 0-5 for: $label"
}

review=${1:-}
test -n "$review" || fail "usage: sh scripts/verify-forge-review.sh forge/reviews/REVIEW.md"
test -f "$review" || fail "missing Forge review: $review"

require_text "$review" "## Structured Summary"
require_text "$review" '"reviewed_artifacts"'
require_text "$review" '"scores"'
require_text "$review" '"pass_fail_gates"'
require_text "$review" '"payoff_metrics"'
require_text "$review" '"recommendation"'
require_text "$review" '"confidence"'
require_text "$review" '"follow_up_required"'
require_text "$review" '"upgrade_id"'

require_score "$review" "Outcome quality score (0-5):"
require_score "$review" "Proposal specificity score (0-5):"
require_score "$review" "Eval coverage score (0-5):"
require_score "$review" "Safety boundary preservation score (0-5):"
require_score "$review" "Regression detection score (0-5):"
require_score "$review" "Process bloat risk score (0-5):"

require_text "$review" "Outcome quality evidence:"
require_text "$review" "Proposal specificity evidence:"
require_text "$review" "Eval coverage evidence:"
require_text "$review" "Safety boundary preservation evidence:"
require_text "$review" "Regression detection evidence:"
require_text "$review" "Process bloat risk evidence:"
require_text "$review" "Every score has evidence:"
require_text "$review" "Gate result:"

grep -E "Evidence:|evidence:|missing-artifact" "$review" >/dev/null || fail "review must cite evidence or a missing-artifact reason"

printf 'Forge review verification passed.\n'
