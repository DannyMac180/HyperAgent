# Data and Privacy Policy

What HyperAgent records about your work, where it goes, what never reaches it, and what can be taken back out. This document covers the **data plane** — the parts that observe. It is a statement about the software's behavior, not a set of instructions for a working agent.

`docs/safety-policy.md` covers what HyperAgent may do to your machine; this covers what it keeps. `docs/schema.md` is the authority on the exact shape of every record.

## Where data lands

Everything is local. Nothing is transmitted anywhere by the daemon, the CLI, or the adapters.

| Surface | What it holds | Where |
|---|---|---|
| Event store | Canonical events: envelope, digests, summaries, pointers | `~/.hyperagent/hyperagent.db` (append-only SQLite) |
| Gate spool | Hook firings awaiting ingest: command summaries, matched paths, verdicts | `~/.hyperagent/gate/outcomes.jsonl`, drained into the store |
| Memory markdown | Installed memories and their evidence links | `~/.hyperagent/memory/<scope>/<id>.md` |

**Nothing in this repo invokes a model or spawns a subprocess.** There is no inference step in the data plane — no code path sends your text to an API or to a locally-installed agent CLI. Components that reason about the record live in the separate judgment plane and are not covered by this document; if you are running one, its own data behavior is its own to state.

## Digests, not transcripts

The store is an **index into your harness's own transcripts**, not a copy of them. Events carry sha256 digests, counts, durations, and a `raw_ref` pointer; the prose stays in the vendor's file, which was already on your disk before HyperAgent existed.

The residual text surface is small and deliberate: `input_summary`, `claim_text`, and `message_summary`. Every one of them passes through the same redaction filter described below before it is appended, and each is length-capped. Two consequences worth stating plainly:

- Deleting the HyperAgent store does not delete your transcripts, and deleting your transcripts does not delete the store — it strips the store's ability to resolve evidence (`docs/schema.md` §8).
- A secret that was never in a transcript cannot reach the store. A secret that *was* is subject to the gap below.

## What is never ingested

- Your source files. Adapters read harness transcripts and hook payloads. Inside a repo, HyperAgent reads exactly one file — `.hyperagent/contract.json`, the verification contract you installed there. Gate policy is read from `~/.hyperagent/policy.json`, outside your repo entirely. Nothing reads, digests, or stores the contents of your code.
- Environment variables, shell history, keychains, credential files.
- Anything outside the configured harness transcript locations and the gate spool.
- Network traffic. Nothing in `src/` opens a socket or makes an HTTP request.

**It does write into your repo, and you should know where.** Injection maintains a managed block in one file per harness — `CLAUDE.local.md` for Claude Code and `AGENTS.md` for Codex. That difference matters to you: `CLAUDE.local.md` is local-only *by convention* — HyperAgent does not gitignore it for you, so verify yours is ignored if memories should not reach collaborators — while `AGENTS.md` is typically tracked, meaning anything injected there is visible to everyone who clones the repo. Installing gate hooks also edits `.claude/settings.local.json`. All of it is byte-idempotent, confined to the managed block, and reversible with an explicit uninstall.

## What redaction actually does

Every text summary — from adapters and from gate events alike — passes through one shared filter before it is appended: recognized key shapes (`sk-…`, `ghp_…`, `AKIA…`), `Bearer` headers, and `password=` / `api_key=` / `token=` assignments are replaced with `[redacted]`, and summaries are length-capped. This is a **known-shape filter, not a secret detector** — a credential in an unrecognized format passes through, which is why the gap below matters.

## The redaction gap — named, owned, not yet closed

**The event store is append-only, and there is currently no supported way to remove a secret that reaches it.** Append-only is what makes the record trustworthy; it is also what makes this hard. The store's triggers reject `UPDATE` and `DELETE`, by design and under test.

The planned remedy is a `redaction_tombstone` event type that supersedes a prior event by id, with readers required to treat a tombstoned payload as `{}` (`docs/schema.md` §8, minor version bump). It is **not built**. Until it is:

- the blunt remedy is deleting `~/.hyperagent/hyperagent.db`, which costs the whole history;
- the mitigations that do exist are structural — digests instead of raw text, and the shared redaction filter above on every summary that is stored;
- there is **no automated preflight**. The v1 `redact-check` and `verify-mission` helpers belonged to the retired bash CLI and are gone; nothing replaced them.

Treat this as the honest state of the art here, not as a solved problem. Closing it is a prerequisite for any feature that widens what gets recorded.

## Your own copy is yours

The store is a SQLite file and the memories are markdown. Both are readable with ordinary tools, both are yours to inspect, copy, or delete. Markdown stays inspectable ground truth on purpose: a record you cannot read is a record you cannot trust.

## For contributors

- Never commit a real store, spool file, memory file, or transcript. Test fixtures are recorded and redacted by hand.
- **`missions/` is never git-tracked.** It is untracked and gitignored, and CI fails the build if any file under it is staged. The directory is a v1 artifact — mission records are now generated, private, and live in the judgment plane — but the guard stays because records committed before 2026-07-26 are already in this repo's public history, and re-tracking would compound that. Never rely on history for privacy: treat everything already pushed as public.
- CI's privacy guard also fails on an absolute personal path (`/Users/…`) anywhere in `src/`.
- Use relative or fictional repo paths in examples and fixtures.
- Summarize verification output rather than pasting raw tool logs.
- If a change widens what is recorded — a new event type, a new payload field, a new surface — say so in the PR explicitly, and check it against the redaction gap above.
