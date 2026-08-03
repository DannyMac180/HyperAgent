# Contributing to HyperAgent

This repository is HyperAgent's **open data plane** — the observation layer, MIT licensed. Contributions should make observation more faithful, more durable, and more inspectable, without adding runtime weight or reaching into territory the project deliberately keeps out.

The project is pre-release and moving. Opening an issue before a large change will save you work.

## Ground rules

- **Never require the agent's cooperation.** Observation comes from harness telemetry — transcripts and lifecycle hooks. A change that asks the working agent to report on itself will be declined regardless of how well it is implemented; that mechanism was measured, found unreliable exactly where it mattered, and removed.
- **Never install "how to work" instructions.** A capability is admissible only if it is ground truth, actuation/permission, measurement, or persistence (`docs/architecture-v2.md` §4). Advice to the model is the first thing a more capable model makes worthless.
- **Local-first.** No hosted services, no network calls for core behavior. Data lives in local SQLite and markdown, and markdown stays inspectable.
- **Vendor-blind downstream.** Only code under `src/adapters/` may know a vendor's format. Everything else consumes the canonical schema.
- **Human review for persistent behavior changes.** Anything that alters how an agent behaves in future sessions is gated. See `docs/safety-policy.md` and `docs/gates.md`.
- **Report honestly, including gaps.** Surfacing "this adapter can't observe X" or "this could only be detected after it ran" is correct behavior, not a defect to paper over.

## Scope: what belongs here

**In scope:** the event schema, the store, adapters, the daemon, gates and contracts, the memory store and injection renderers, conformance, and the inspection CLI.

**Not in scope:** judging what the record means. Scoring, improvement proposals, decay auditing, and the Cockpit app are a separate proprietary layer (`docs/open-core.md`). If a change needs one of those, it does not belong in this repo — say so in an issue and we will work out where it goes.

Everything merged here is irrevocably MIT.

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun test                # 339 tests
bunx tsc --noEmit       # typecheck
```

Both gate CI, along with a privacy guard that fails the build if `missions/` becomes tracked or an absolute personal path appears under `src/`.

## Adding or changing an adapter

Adapters are the only vendor-aware code, and they break by design when a vendor changes its format — that is a normal event to detect and surface, never to fail silently.

A new adapter needs:

- a parser producing canonical events (`docs/schema.md`);
- **path-independent event ids.** Ids must not derive from an absolute artifact path; moving a directory must not re-ingest history as duplicates. This one has bitten us, and there is a regression test.
- a conformance descriptor plus fixtures recorded from real bytes, not hand-written;
- a passing conformance run.

Capability-matrix rows are **earned by a passing run, never by editing the table**:

```bash
bun src/daemon/cli.ts conformance run <vendor>
bun src/daemon/cli.ts conformance matrix --write
```

The matrix is generated and has a drift test. Hand-edits are rejected.

## Testing expectations

- Tests should exercise behavior, not file presence.
- For a bug fix, add the failing test first and confirm it is red before the fix — a test that passes both before and after proves nothing.
- When a fix removes a defect, check whether it is one instance of a class and sweep for siblings. Several of this project's worst bugs were one-line issues that survived because only the visible instance was fixed.

## Privacy

Session content is sensitive by construction. Never commit real transcripts, real session data, or absolute personal paths. `missions/` is never tracked. Fixtures must be redacted; see `docs/evidence-policy.md`.

## Pull requests

Before opening one:

```bash
bun test && bunx tsc --noEmit
```

A good PR explains the problem, what changed, how it was verified (with real output, not "should work"), anything that could not be verified and why, and the rollback path if behavior changes persist.

Public-facing docs that describe what HyperAgent observes are part of the product's trust surface. If your change alters what is collected or how it is stored, update `docs/schema.md` and `docs/evidence-policy.md` in the same PR.
