# Open core — what is open, what is paid, and why

This project is split on **plane, not surface**. The part that watches your agents is open source and stays that way. The part that judges what it saw is a paid product.

## The boundary

| Plane | What it covers | Terms |
|---|---|---|
| **Open — the data plane ("the armor")** | The canonical event schema · the `hyperagentd` observer daemon · every harness adapter · the SQLite event store · the memory store and injection layer · safety and verification gates · post-hoc policy detection · the CLI for raw inspection and query · the markdown ground-truth artifacts | **MIT** — this repository |
| **Paid — the judgment plane ("the cockpit")** | Session scoring · comparative agent measurement and routing recommendations · memory extraction and promotion pipelines · improvement-proposal generation · the replay-eval harness · the decay audit · the human review queue · the Cockpit Mac app | Proprietary |

Two consequences of that line worth stating plainly, because they are the ones people ask about:

- **Anything that can block your agent is open.** Gates are actuation and permission — armor, not cockpit. You must be able to read the code that can stop a tool call, so it is MIT and it is here.
- **Detection is open; interpretation is paid.** The daemon flags policy violations in transcripts, including on harnesses where nothing could be blocked in flight. That detection lives in the observation path. Turning a stream of violations into trends and recommendations is the paid layer's job.

## Why observation is the part that is open

HyperAgent reads every transcript your coding agents produce. That is an unusual amount of access to grant a piece of software, and no amount of assurance in a README earns it.

So the components that touch your work — the daemon, the adapters, the schema, the store — are open source, and the record they build is local SQLite and markdown you can read with your own tools. You should never have to trust a closed binary about what it records from your work. Nothing is sent anywhere, and you can verify that claim by reading the code rather than believing the sentence.

That argument requires open *eyes*. It does not require an open *brain*. The analysis on top of the record is a product, and it is priced like one.

## What this commits to

This boundary is a commitment, not a current-state description that moves when convenient:

1. **The observation layer stays open and inspectable.** Schema, daemon, adapters, store, gates, memory store and injection — MIT, permanently.
2. **The schema is MIT on its own.** `docs/schema.md` is a spec, not an implementation detail; it is free to implement, free to fork, and free to become something other people's tools speak.
3. **The open daemon runs standalone.** The free product is a working flight recorder — observe, store, gate, inspect — not a demo that stops working until you pay. The judgment plane attaches through a typed plugin seam; it is not load-bearing for anything above.
4. **The methodology ships free even where the machinery does not.** The durability test, the decay-audit concept, and the reasoning behind involuntary observation are written up publicly, including in this repo. Publishing how something works does not obligate publishing the pipeline that does it.

## The vocabulary

"The armor" is what you wear and can inspect. "The cockpit" is where the judgment happens. The one-line version: **charge for the cockpit, not the armor** — where the cockpit means the judgment layer, not the pixels.
