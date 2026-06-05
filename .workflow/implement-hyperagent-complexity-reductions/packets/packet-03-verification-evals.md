# Packet 03: Verification And Evals

Objective:
Split verification into core, extension, and release tiers.

Files:
- `scripts/verify-mvp.sh`
- `scripts/verify-core.sh`
- `scripts/verify-extensions.sh`
- `scripts/verify-release.sh`
- `evals/README.md`
- `evals/*`

Expected output:
- `verify-mvp.sh` checks only the PRD core or delegates to `verify-core.sh`.
- Extension checks cover UI, sense, Workbench trace enrichment, and reliability fixtures.
- Release checks cover GitHub templates, architecture assets, UAT/release docs, and other public release readiness.
- Existing eval entrypoints keep working.
