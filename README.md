# HyperAgent

**A flight recorder for your AI agents.**

HyperAgent watches the coding agents you already use — Claude Code, Codex, and others — and turns what they actually did into one durable, local, vendor-neutral record. It never asks an agent to report on itself.

> Models provide intelligence. HyperAgent provides agency.

This repository is the **open data plane**: the observation layer, MIT licensed. Recording is open because trust requires that observation be inspectable — you should be able to read exactly what is collected about your work rather than take a vendor's word for it.

## Why involuntary observation

The obvious design is to have the agent write down what it did. We built that first, and measured it: **60 of 66 recorded missions produced nothing usable** — the ceremony ran, the auto-closeout template filled the agent's own judgment fields with boilerplate, and the handoff that was supposed to justify the whole loop never happened. Self-assessment written by the thing being assessed degrades toward whatever passes the check.

So HyperAgent reads the harness's own telemetry instead: the transcript files each tool already writes, plus lifecycle hooks where the harness offers them. The agent is not asked, not instructed, and cannot edit the record after the fact. It also means the working agent carries **zero ceremony** — no prompt to wear, no loop to run, no files to maintain.

## What it does

- **Observes** every session across every supported harness, continuously, in the background.
- **Normalizes** vendor-specific telemetry into one canonical event schema in append-only SQLite (`docs/schema.md`). Only adapters know vendor formats; everything downstream is vendor-blind.
- **Remembers across agents** — a memory store plus an injection layer that writes managed blocks into each harness's own memory file, so something learned in one agent is available in the next.
- **Gates** — verification contracts and safety policy evaluated at harness hook points, honest about what can be blocked in flight versus only detected after the fact.
- **Proves its own coverage** — an adapter conformance suite generates `docs/capability-matrix.md`. A row is earned by a passing run, never by editing the table.

## Status

Working software, pre-release. It runs continuously on the author's machine: 1,523 sessions and ~46k events across Claude Code and Codex, with zero parse failures. There is no installer or packaged release yet — you run it from a clone, and the schema is v0.1.0 and may still move.

| Harness | Observe | Inject | Gate | Tier |
|---|---|---|---|---|
| Claude Code | verified | verified | verified | 1 |
| Codex | verified | verified | not claimed | 2 |

"Verified" means a conformance run passed against recorded real-world bytes — never a claim typed into a table. Other harnesses appear in `docs/capability-matrix.md` as *claimed, unverified*, and are labelled that way on purpose; that file is generated and is the authority.

## Quick start

Requires [Bun](https://bun.sh). Nothing is sent anywhere; everything stays under `~/.hyperagent`.

```bash
git clone https://github.com/DannyMac180/HyperAgent
cd HyperAgent
bun install

# Read your existing agent history once, then see what was found.
bun src/daemon/cli.ts ingest --once
bun src/daemon/cli.ts status

# Keep specific projects out of the record entirely — skipped before parse,
# so nothing from them enters the store, not even digests.
bun src/daemon/cli.ts ingest --once --exclude-projects -Users-you-dev-private-repo

# Or record that choice once, so every later read honours it — including the
# background daemon, which never sees your flags.
bun src/daemon/cli.ts scope set --exclude-projects -Users-you-dev-private-repo
bun src/daemon/cli.ts scope show

# Keep a whole agent out of the record. Its artifacts are never opened, so
# nothing about it reaches the store. Recorded like the exclusions above, so
# the daemon's next pass honours it too. An unknown vendor name is refused
# rather than silently excluding nothing.
bun src/daemon/cli.ts scope set --exclude-vendors codex
bun src/daemon/cli.ts scope set --exclude-vendors ""     # clears it

# Only go back so far. The cut-off is on each transcript's last-modified time,
# so it means "sessions active since then" — a session resumed after the
# cut-off is read whole, older turns included.
bun src/daemon/cli.ts ingest --once --since 30d      # or --since 2026-01-01

# Record the cut-off too, so later reads keep honouring it. This one matters:
# a session skipped for being too old leaves no state entry, so to a later
# flagless read it looks unseen — without the stored cut-off, the background
# daemon backfills exactly what the window left out.
bun src/daemon/cli.ts scope set --since 30d
```

Both are prospective: they decide what future reads take in, and leave whatever
is already recorded alone. A flag overrides the stored scope for one run and
never rewrites it; passing an empty value to `scope set` is how you clear a
half, because omission must never widen what gets recorded.

To keep watching in the background:

```bash
bun src/daemon/cli.ts watch
```

On macOS, `bun src/daemon/cli.ts install-plist --write` installs that as a launchd job.

Other commands:

```bash
bun src/daemon/cli.ts memory list                 # cross-agent memory, human-gated
bun src/daemon/cli.ts memory sync --repo <path>   # write memory into a repo's agent file
bun src/daemon/cli.ts gate install --repo <path>  # hook-point gates for a repo
bun src/daemon/cli.ts gate status --repo <path>
bun src/daemon/cli.ts violations --days 7         # what was detected after the fact
bun src/daemon/cli.ts conformance run             # prove adapter coverage
bun src/daemon/cli.ts --help
```

## Design rules

1. **The pilot flies; the suit records.** Nothing may require the working agent's cooperation.
2. **Durability test.** A capability is admissible only if it is ground truth, actuation/permission, measurement, or persistence. Never install "how to think" or "how to work" instructions — a more capable model makes those worthless.
3. **Local-first.** Local SQLite and markdown; markdown stays inspectable ground truth.
4. **Vendor-blind downstream.** Only adapters know vendor formats.
5. **Adapter breakage is a normal event.** Version-detect and surface "adapter needs update" — never fail silently, never claim coverage you do not have.
6. **Human review for persistent behavior changes**, enforced in code rather than requested in prose.

## Open core

This repo — observation, schema, store, adapters, daemon, gates, the memory store and injection layer, conformance — is **MIT and stays that way**.

Judgment is a separate, proprietary layer: scoring sessions, proposing improvements, auditing which capabilities a smarter model has made unnecessary, and the Cockpit Mac app. The boundary is recorded in `docs/open-core.md`.

The split is deliberate rather than a licensing convenience. You should never have to trust a closed binary about what it records from your work — so the part that watches is the part that is open.

## Documentation

- `docs/schema.md` — the canonical event schema; wins over prose elsewhere on schema questions.
- `docs/architecture-v2.md` — the rearchitecture rationale.
- `docs/open-core.md` — what is open, what is paid, and why observation is the open half.
- `docs/gates.md` — gates, policy, and verification contracts.
- `docs/memory.md` — the memory store and injection layer.
- `docs/capability-matrix.md` — generated adapter coverage.
- `docs/evidence-policy.md` — what is collected, what is never collected, and redaction.
- `docs/archive/` — the retired v1 prototype, kept for history.

## History

HyperAgent v1 (through mid-2026) was a markdown-and-shell prototype built around Codex wearing a Suit prompt and writing its own mission records. That mechanism was measured, found unreliable in exactly the cases that mattered most, and retired on 2026-08-03. Its documentation is in `docs/archive/`; its code remains in git history. The essay behind the original idea is `docs/archive/article-outline.md`.

## Contributing

See `CONTRIBUTING.md`. Tests are `bun test`; typecheck is `bunx tsc --noEmit`. Both gate CI.

## License

MIT. See [LICENSE](LICENSE).
