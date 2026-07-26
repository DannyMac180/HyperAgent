# HyperAgent Extensions

Extensions are useful HyperAgent capabilities that are not required for the PRD core. They must preserve markdown source of truth, local inspectability, and human review.

## Extension Rules

- Extensions must be optional.
- Extensions must not be required for initialized user-project verification or for the markdown Mission -> Workshop -> Forge loop. The HyperAgent testbed may still pin extension files or boundary checks in repo-integrity gates.
- Extensions must not silently activate persistent behavior changes.
- Extension state must be derived from or written back to local markdown artifacts.
- Extension evidence should follow `docs/evidence-policy.md`.

## Current Extensions

### Workbench Trace Enrichment

Source: `.hyperagent-evidence/workbench/traces.jsonl`

Trace enrichment is local and optional. It is surfaced through `sh scripts/hyperagent.sh sense` and `sense --doctor`, but the lightweight sensing summary and command/check evidence are core alpha support. HyperAgent must continue to work when the trace log is absent.

### Local UI Cockpit

Command: `sh scripts/hyperagent.sh ui`

The UI is an optional local cockpit over markdown artifacts. It is not the product source of truth and not required for the MVP core.

### Reliability Scoring

Command: `sh evals/reliability-gains.sh`

Reliability scoring is a research/eval extension until it uses real repeated mission evidence or trace-backed runs.

## Verification

Run extension checks with:

```bash
sh scripts/verify-extensions.sh
```
