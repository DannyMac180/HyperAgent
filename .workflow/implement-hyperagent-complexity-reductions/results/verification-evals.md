# Verification And Evals Result

Implemented:
- Replaced `scripts/verify-mvp.sh` with a compatibility alias for `scripts/verify-core.sh`.
- Added `scripts/verify-core.sh`, `scripts/verify-extensions.sh`, and `scripts/verify-release.sh`.
- Added extension eval wrappers in `evals/extensions/`.
- Updated smoke evals to use the grouped public commands.
- Updated init smoke to assert the reduced-copy init behavior.
- Updated eval docs to describe verification tiers and optional extension evals.

Opportunities covered:
5, 6, 22, 37, 38, 49, 50.
