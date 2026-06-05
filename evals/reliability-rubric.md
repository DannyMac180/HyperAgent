# HyperAgent Reliability Gains Rubric

This rubric scores whether HyperAgent improves reliability on a repeated local
task. It intentionally measures behavior, not artifact presence.

Run:

```bash
sh evals/reliability-gains.sh
```

The eval reads Markdown case records from `evals/fixtures/reliability/` and
mission records from `missions/` by default. It writes inspectable generated
cases, Markdown, and TSV output to `evals/out/reliability-gains/`.

To score trace-derived case files exported from local Workbench or Raindrop
evidence, pass a directory of explicit Markdown cases:

```bash
sh evals/reliability-gains.sh --traces evals/fixtures/reliability-traces
```

## Case Format

Each case is a Markdown file with these metadata lines:

```text
- Run ID: readable-id
- Evidence source type: fixture | mission-derived | trace-derived
- Condition: without-hyperagent | with-hyperagent
- Task completed: yes | partial | no
- Verification: run-with-evidence | mentioned-only | missing
- Failure recovery: retry-with-resolution | identified-only | missing
- Proposal specificity: specific | vague | missing
- Time to useful artifact minutes: NUMBER | none
```

The case should also include a `## Final Report` section. The report quality
score is derived from whether the report names completion evidence,
verification, files changed, and unresolved risks.

Fixture cases may omit `Evidence source type`; they are treated as `fixture`.

## Mission-Derived Cases

Mission records are converted into generated cases under
`evals/out/reliability-gains/generated-cases/mission-derived/`.

Minimum mission metadata for scoring:

- `Mission ID`
- `User request`
- `Final outcome`
- `Completion evidence`
- `Verification performed` or recent command/check evidence
- `Files or systems changed`
- `Unresolved risks`
- `Candidate upgrades` or `Upgrade proposal paths`

Automated inference is intentionally conservative. Add these optional
annotation lines to a mission record when a human reviewer has better evidence
than the structural metadata:

```text
- Reliability task completed: yes | partial | no
- Reliability verification: run-with-evidence | mentioned-only | missing
- Reliability failure recovery: retry-with-resolution | identified-only | missing
- Reliability proposal specificity: specific | vague | missing
- Reliability time to useful artifact minutes: NUMBER | none
```

## Trace-Derived Cases

Trace ingestion is opt-in with `--traces DIR`. The eval currently accepts
Markdown case files derived from Workbench or Raindrop traces rather than
claiming to understand every trace schema automatically. Each trace-derived
case must declare:

```text
- Evidence source type: trace-derived
- Source path: path-to-local-trace-or-export
```

Use trace-derived scores as directional evidence. Manual annotations are
required whenever the trace does not honestly prove completion, verification,
failure recovery, proposal quality, or time to useful artifact.

## Scoring

Each dimension is worth 0-2 points, for a maximum score of 12.

### Task Completion

- `2`: The requested task is complete and the case names useful evidence.
- `1`: The task is partly complete or needs a small follow-up.
- `0`: The task is incomplete.

### Final Report Quality

- `2`: The final report names completion evidence, verification, files changed,
  and unresolved risks.
- `1`: The final report names at least two of those fields.
- `0`: The final report is vague or omits most of those fields.

### Missed Verification

- `2`: Verification was run and evidence is recorded.
- `1`: Verification was mentioned but not actually run.
- `0`: Verification was omitted.

### Failure Recovery

- `2`: A failure or blocker was identified, retried, and resolved or bounded.
- `1`: A failure or blocker was identified but recovery was incomplete.
- `0`: Failures and blockers were ignored or absent despite task risk.

### Proposal Specificity

- `2`: The case includes a specific, evidence-backed proposal with plan, eval,
  and activation policy.
- `1`: The case includes a vague proposal or follow-up.
- `0`: No proposal or reusable improvement is captured.

### Time To Useful PR Or Artifact

- `2`: A useful PR or artifact was produced in 30 minutes or less.
- `1`: A useful PR or artifact was produced in 60 minutes or less.
- `0`: No useful artifact was produced, or it took longer than 60 minutes.

## Pass Condition

The built-in comparison passes when the highest-scoring `with-hyperagent` case
beats the highest-scoring `without-hyperagent` case. Future cases can raise this
bar by requiring a minimum absolute score or minimum delta.

Reports distinguish fixture, mission-derived, and trace-derived source types.
They should be interpreted as trend evidence over repeated local work, not as
precise measurements of agent quality.
