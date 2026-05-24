# Reliability Eval Case: Workbench Trace Case

- Run ID: workbench-trace-case
- Evidence source type: trace-derived
- Source path: .hyperagent-evidence/workbench/traces.jsonl
- Condition: with-hyperagent
- Scenario: Score a trace-derived case exported from local Workbench evidence.
- Task completed: yes
- Verification: run-with-evidence
- Failure recovery: identified-only
- Proposal specificity: vague
- Time to useful artifact minutes: none

## Run Notes

This fixture stands in for a trace-derived case file produced from local trace
evidence. The reliability eval does not infer trace semantics directly yet; it
accepts explicit Markdown case files so reviewers can keep human judgment in
the loop.

## Final Report

Completion evidence: the trace case names a useful artifact and source path.

Verification: local trace evidence was present and converted into this case.

Files changed: none; this is a scoring input.

Unresolved risks: trace-derived scoring still depends on honest manual export
or annotation until a reviewed trace schema exists.
