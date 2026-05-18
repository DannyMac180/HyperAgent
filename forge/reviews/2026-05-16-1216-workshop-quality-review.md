# Forge Review

- Review ID: forge-2026-05-16-1216-workshop-quality-review
- Date/time: 2026-05-16 12:16 EDT
- Proposals reviewed: `workshop/proposals/2026-05-01-2108-codex-skill-installer.md`; `workshop/proposals/2026-05-16-1216-local-loop-helper-and-smoke-eval.md`
- Reviewer: Codex wearing the HyperAgent Suit

## Workshop Quality

- Are proposals specific and evidence-backed? Yes. Both proposals link to mission evidence and name the observed friction.
- Are acceptance tests concrete? Mostly yes. The installer proposal has temp-directory smoke checks; the local loop proposal has `evals/smoke-loop.sh`.
- Are safety risks explicit? Yes. Both proposals keep local writes bounded and preserve `human review required`.
- Are activation modes appropriate? Yes. Both use `human review required` and decision records before registry promotion.
- Are repeated friction patterns being missed? The main pattern is now visible: artifact presence checks are not enough; behavior smoke checks must exercise the loop.
- Proposal quality score: 9/10
- Process reliability score: 8/10

## Process Upgrade Candidates

- Workshop process friction: Proposal quality depends on agents remembering to score and backlog items consistently.
- Proposed process change: Keep `workshop/rubric.md`, `workshop/backlog.md`, and `evals/smoke-loop.sh` as required artifacts in `scripts/verify-mvp.sh`.
- Expected effect: Future proposals stay tied to evidence, priority, safety, evals, and approval decisions.
- Eval for the process change: `sh scripts/verify-mvp.sh` must fail if rubric, backlog, Forge quality rubric, decision template, helper, or smoke eval are missing.
- Rollback plan: Remove the verifier requirements and process files if they prove too heavy for Mark I.

## Decision

- Recommendation: Keep the new Workshop/Forge process active for Mark I.
- Human approval needed: Required before changing activation policy or broadening permissions.
- Follow-up proposal path: None needed now; the process change is included in `workshop/proposals/2026-05-16-1216-local-loop-helper-and-smoke-eval.md`.
