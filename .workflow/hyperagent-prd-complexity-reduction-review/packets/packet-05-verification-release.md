# Packet 05: Verification And Release

Objective: Review eval complexity, release burden, public/private evidence, and maintenance surface.

Sources:
- `scripts/verify-mvp.sh`
- `evals/README.md`
- `evals/smoke-loop.sh`
- `evals/init-smoke.sh`
- `evals/sense-smoke.sh`
- `evals/ui-smoke.sh`
- `evals/reliability-gains.sh`
- `docs/release-checklist.md`
- `docs/reviews/2026-05-23-prd-faithfulness-review.md`

Findings:
- `verify-mvp.sh` has grown into a broad file/text presence verifier for optional surfaces, including UI and sensing.
- The eval suite now covers loop, init, sensing, UI, and reliability fixtures; useful, but bigger than the PRD's minimal MVP verifier.
- Reliability gains are fixture-based rather than derived from real repeated mission outcomes.
- Public repo mission records include local paths and work history; useful dogfooding evidence, but not all mission telemetry should be public sample evidence.
- Release checklist and release notes can lag as product surfaces change.

Simplification candidates:
- Split verification into core MVP, optional extensions, and release checks.
- Keep one required loop smoke eval for MVP and make UI/sense/reliability extension checks opt-in.
- Move public sample evidence into examples and keep local mission logs ignored or explicitly curated.
- Make release state generated from a roadmap/product-state doc where possible.
