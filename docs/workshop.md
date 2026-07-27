# Workshop

> The improvement organ (DAN-204). It turns repeated, observed friction into reviewable capability proposals, tests those proposals against stored history, and leaves every persistent change behind an explicit human approval boundary.

## What the Workshop is

The Workshop proposes upgrades from friction observed in real sessions, proves what it honestly can by replaying proposals against stored session history, and requires a human to approve anything persistent. It is not a self-editing agent: the automated run ends with proposals in `draft` or `pending`, never `approved` or `installed`.

## Pipeline stages

The pipeline is:

```text
friction → propose → replay eval → queue → human approve → install → measure
```

### Friction

Consumes stored sessions, canonical events, and session scores. It extracts normalized signals for errors, retries, gate blocks, failed contract checks, policy violations, low scores, bounce loops, and repeated rediscovery, then groups them by friction kind and normalized signature.

Produces all observed clusters plus a forwarded set. A cluster is forwarded only when it spans the configured number of distinct sessions; the default is `2`. Sessions created by the Suit itself are excluded before extraction.

It is not allowed to treat a one-session pattern as durable multi-session evidence under the default threshold, or to learn recursively from the Suit's own model runs.

### Propose

Consumes a forwarded friction cluster and its stored evidence. When a cluster spans at least three sessions, the final sorted third, rounded down but never below one session, is reserved as holdout; the remaining session IDs are supplied to the drafter.

Produces zero or more typed proposal drafts plus rejected-candidate reasons and diagnostics.

It is not allowed to invent replay fixtures, accept generic advice about how an agent should think or work, or admit a proposal that does not provide external ground truth, actuation, measurement, or cross-session persistence.

### Replay eval

Consumes a typed draft, stored positive session history, and passing sessions selected as negative controls. Holdouts replace the other failing sessions as positive fixtures when holdouts exist.

Produces a versioned `ReplayEval`: fixtures with exact event-ID provenance, per-fixture outcomes, counts, diagnostics, a pass bit, and a failure reason.

It is not allowed to use proposal text to choose fixtures, run arbitrary shell checks, claim causal improvement, or pass without both positive and negative-control fixtures.

### Queue

Consumes drafts and their replay evaluations. It stores every accepted draft in SQLite and promotes only passing evaluations from `draft` to `pending`.

Produces durable proposal rows, an append-only transition history, and a derived Markdown mirror.

It is not allowed to approve or install. The run orchestrator neither constructs nor imports the human-approval token.

### Human approve

Consumes a `pending` proposal, its expected content hash, and a `HumanApproval` token issued after explicit CLI confirmation.

Produces an `approved` proposal.

It is not allowed to approve a changed proposal, a proposal in another status, or a proposal using a caller-constructed or runtime-forged approval object.

### Install

Consumes an `approved` proposal and type-specific installation context.

Produces either an automatic installation receipt with exact writes, or a manual receipt containing an artifact for a human to place. A successful caller then records `approved → installed`.

It is not allowed to install an unapproved proposal, write after a content-hash mismatch, widen an unrenderable predicate, replace an existing verification contract wholesale, or auto-write instruction and skill content.

### Measure

Consumes installed proposals and scoreable sessions in each proposal's repository and agent scope, partitioned around `installedAt`.

Produces before and after sample counts and means, a delta when both samples are large enough, and a versioned status.

It is not allowed to fabricate a delta when either side lacks enough sessions.

## Proposal schema

Every draft contains:

| Field | Meaning |
| --- | --- |
| `type` | `memory`, `verification_check`, `instruction_edit`, or `skill` |
| `durability` | `ground_truth`, `actuation`, `measurement`, or `persistence` |
| `title` | Non-empty proposal title |
| `rationale` | Non-empty explanation grounded in the supplied evidence |
| `body` | Type-tagged content; verification checks also carry a description and predicate |
| `evidence.sessionIds` | Sessions supporting the proposal |
| `evidence.eventIds` | Canonical events supporting the proposal |
| `evidence.clusterSignature` | The normalized friction signature |
| `holdoutSessionIds` | Reserved sessions not shown to the drafter |
| `drafterVersion` | Version of the drafting boundary |

The queue stores `holdoutSessionIds` as `holdout`. Proposal IDs and content hashes are the SHA-256 digest of canonicalized `type`, `durability`, `title`, `body`, `evidence`, `repo`, and `agent`; rationale and holdout are not part of that hash. Scope (`repo`/`agent`) is hashed because it determines what install writes and where — approval binds the exact artifact install will produce, including its scope.

Proposals inherit scope from their friction cluster: a cluster confined to one repo (or one agent) produces a proposal scoped to it; sessions with no known repo are ignored for this purpose, and a cluster spanning multiple repos yields a null-scoped (global) proposal. **Named consequence:** a multi-repo memory proposal evaluates under global scope, where membership is scored `no_effect`, so it is held at `draft` — the most widely corroborated frictions are deliberately barred from producing memories in v0 rather than shipping an unprovable global memory. Revisit when the replay eval can carry outcome evidence.

The four proposal bodies are:

```json
{"type":"memory","content":"..."}
{"type":"verification_check","description":"...","predicate":{"type":"..."}}
{"type":"instruction_edit","content":"..."}
{"type":"skill","content":"..."}
```

## The predicate DSL

Predicates are data evaluated deterministically in-process against canonical events. A command predicate inspects recorded command summaries; it does not execute the command.

| Type and JSON parameters | Exact semantics |
| --- | --- |
| `{"type":"command_ran_matching","pattern":"..."}` | Satisfied when any recorded command summary matches the case-insensitive regular expression. Pass status and mutation order do not matter. |
| `{"type":"command_after_last_mutation","pattern":"..."}` | If no file was touched, satisfied vacuously. Otherwise satisfied only by a matching command recorded as passing strictly after the greatest touched-file sequence. |
| `{"type":"event_present","eventType":"...","payloadMatch":{"key":"value"}}` | Satisfied when at least one event has the exact `eventType` and, when `payloadMatch` is supplied, every named own payload property stringifies to the requested string. |
| `{"type":"event_absent","eventType":"...","payloadMatch":{"key":"value"}}` | Satisfied when no event matches the same event-type and optional payload rules used by `event_present`. |
| `{"type":"path_untouched","glob":"..."}` | Satisfied when no recorded touched file matches the glob. With a repository root, matching uses the gate path matcher against its supported absolute and repository-relative forms. |

`pattern` must be a non-empty valid regular expression. `eventType` and `glob` must be non-empty strings. `payloadMatch` is optional, but when present it must be an object whose values are strings. Unknown fields are rejected.

Arbitrary shell-command predicates are deferred until post-approval sandboxing exists. There is deliberately no `shell_command` predicate in the DSL.

### The losslessness boundary

Only two predicates have exact representations in `.hyperagent/contract.json`:

- `command_after_last_mutation` renders as a `requiredCheck`.
- `path_untouched` renders as a `protectedPath`.

The other three return `unrenderable`:

- `command_ran_matching` cannot be converted to a required check because the contract requires a passing command after the last mutation, which is stronger and different.
- `event_present` cannot be expressed as a contract requirement for a canonical event or payload.
- `event_absent` cannot be expressed as a contract prohibition on a canonical event or payload.

They are refused at install time and are not widened into weaker or merely similar checks.

## Status lifecycle and the authority boundary

The normal evaluated path is:

```text
draft → pending → approved → installed
          └────→ rejected
draft ─────────→ rejected
```

`draft → pending` is performed by the automated queue only after replay passes. `pending → approved` requires a branded `HumanApproval`. The brand symbol is module-private, so code outside the queue module cannot construct a token that typechecks. The factory also records every issued token in a module-private `WeakSet`; `approve` rejects a forged object even if a caller bypasses TypeScript. Approval re-computes the proposal hash and checks both the caller's expected hash and the stored hash before transitioning.

Rejection is terminal in this implementation and is accepted from either `draft` or `pending`. Installation accepts only `approved`.

Every creation and status change appends a transition row. SQLite triggers reject updates and deletes against that log. `statusFromTransitions` checks continuity from the initial `(none) → draft` entry and derives current status from the final transition.

## Replay-eval honesty

The four fixture verdicts are `would_have_caught`, `no_effect`, `false_flag`, and `error`. Their meaning depends on proposal type.

| Proposal type | Verdict behavior and limits |
| --- | --- |
| `verification_check` | On a positive fixture, an unsatisfied predicate is `would_have_caught`; on a passing negative control, the same failure is `false_flag`. A satisfied predicate is `no_effect` on either role. Invalid predicates, missing provenance, unreadable events, or evaluation exceptions are `error`. This proves only how the predicate evaluates against recorded history; it does not prove that the check fixes the underlying cause. |
| `memory` | For a non-global scope, membership in the historical injection set on a positive fixture is labeled `would_have_caught`, but this means only that the memory would have been available for injection; it is not outcome evidence that the memory would have helped. Absence from selection is `no_effect`. Membership on a passing control is also `no_effect`, never `false_flag`, because advisory injection alone cannot establish harm. Invalid scope resolution, timestamps, provenance, or runtime failures are `error`. |
| `instruction_edit` | No fixtures are evaluated and no fixture verdicts are emitted. The evaluation fails with `failureReason: "unsupported"` because there is no honest deterministic automated replay. |
| `skill` | No fixtures are evaluated and no fixture verdicts are emitted. The evaluation fails with `failureReason: "unsupported"` because there is no honest deterministic automated replay. |

Global-memory selection has an additional hard honesty limit:

> `selectMemoriesForRepo has no K-limit and selects every approved global memory; membership alone is not evidence that the memory would have helped.`

For that reason, a selected global memory is reported as `no_effect`, including on a positive fixture. Injection-set membership is not a claim of causal help.

An eval passes only when it has at least one positive, at least one negative control, at least one `would_have_caught` positive, zero false flags, and zero errors. Because unsupported `instruction_edit` and `skill` evaluations do not pass, the automated pipeline currently keeps those proposal types at `draft`; the CLI exposes no separate command to promote them to `pending`.

## Negative controls and holdout

Negative controls are required. The fixture builder looks for recent, non-cluster sessions in the target repository set whose `verification_pass_rate` is at least `0.6`, selecting at most `3` by default. An evaluation with no passing negative-control fixture cannot pass.

When a friction cluster spans at least three sessions, proposal drafting reserves a deterministic holdout: the final sorted third of session IDs, rounded down with a minimum of one. During replay, non-empty holdouts replace the other failing sessions as positive fixtures. All cluster failure IDs remain excluded from negative-control selection.

Fixture construction accepts stored session IDs and scalar selection controls only. Proposal claims and draft text cannot influence fixture selection.

## Install behavior per type

### Memory

The installer derives a `behavior` memory with confidence `1`, manual source, scope from the proposal's repository or agent, and evidence from the proposal. It deduplicates against existing memories by normalized claim hash. If the claim hash already exists, installation succeeds as a no-write operation; otherwise it adds an approved memory and its managed mirror.

### Verification check

The target must be an eligible repository: it must canonicalize to a directory with a `.git` entry and must not be at or under the protected Claude or HyperAgent data directories.

The installer loads the existing contract and merges one rendered `requiredCheck` or `protectedPath`; it never overwrites the contract with a proposal-only document. An invalid existing contract is refused. An exact duplicate is a successful no-op. A duplicate required-check ID with different description or command content is refused. The merged contract is validated and written atomically.

Only losslessly renderable predicates can reach this write.

### Instruction edit and skill

These are manual installations. The installer returns the approved body content as `renderedArtifact`, records no writes, and tells the human to place it in the approved target. It never writes instruction or skill files automatically.

For every type, the content hash is re-verified immediately before the write or successful no-write/manual result. A mismatch is refused.

## Measurement

Measurement compares mean session scores before and after `installedAt`, scoped to the proposal's repository and, when present, agent. Sessions starting before installation are in `before`; sessions starting at or after installation are in `after`.

The default minimum is `5` scoreable sessions on each side. If either side is short, status is `insufficient_data`, `delta` is `null`, and the reason names the shortage; no delta is fabricated.

With enough data, a delta greater than `0.01` is `improved`, less than `-0.01` is `regressed`, and movement within that inclusive range is `no_movement`. `no_movement` is the retirement signal consumed by DAN-208.

Measurement uses `verification_pass_rate` because `SessionScore` exposes no aggregate scalar. Unscoreable or malformed sessions are skipped and reported in the reason.

## CLI verbs

The six Workshop commands are:

```text
workshop run [--until cluster|propose] [--repo P] [--data-dir D]
workshop list [--status S] [--type T] [--data-dir D]
workshop show <id> [--data-dir D]
workshop approve <id> [--yes] [--data-dir D]
workshop reject <id> [--data-dir D]
workshop measure [--data-dir D]
```

`run --until cluster` does not invoke the proposer and does not open or mutate the proposal queue. It still acquires and releases `<dataDir>/workshop/run.lock` and appends start and terminal records to the run ledger, so “read-only” here means read-only with respect to proposal state, not zero filesystem writes.

`approve` without `--yes` prints the target and proposed write plan, refuses to proceed, and tells the user to rerun with explicit confirmation. With `--yes`, it approves, installs, and then marks a successful install as `installed`.

## Daemon trigger

Daemon Workshop runs are off by default. `watch --workshop` enables the trigger on the periodic 60-second rescan timer; ordinary `watch` does not run it. An in-process in-flight flag coalesces overlapping timer requests, and `<dataDir>/workshop/run.lock` is the cross-process concurrency guard.

Each `runWorkshop` call appends a `started` record and then a `completed` or `failed` record to:

```text
<dataDir>/workshop/runs.jsonl
```

The terminal record includes the stages reached, proposal counts, and any error. Ledger-write failures become run diagnostics, and the daemon prints run summaries or caught errors, so failure is surfaced rather than silently discarded.

There is a current daemon-path defect: `triggerWorkshop` acquires the Workshop lock and then calls `runWorkshop`, which tries to acquire the same lock again. The inner guard sees an active run and returns a failed result with `Workshop is already running`; the ledger records that failure. Direct `workshop run` calls use only the inner guard and do not hit this nested-lock path.

## The Markdown mirror is derived

SQLite is the source of truth for the Workshop queue. Markdown files under:

```text
<dataDir>/workshop/
```

are derived, rebuildable output. `rebuildMirror` removes the existing `.md` and `.md.tmp` mirror files and regenerates them from SQLite proposal rows. The mirror is safe to delete and must never be treated as authoritative.
