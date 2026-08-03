<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->

# Capability Matrix

Regenerate with `bun src/daemon/cli.ts conformance matrix --write`. Generation runs the conformance suite LIVE against every registered descriptor; there is no cached-report path.

## Measured

Every row below is the output of a conformance run against a registered adapter. This is the authority on what HyperAgent can actually do.

| Harness | Observe | Inject | Gate | Tier | Evidence |
|---|---|---|---|---|---|
| claude-code | verified | verified | verified | 1 | verified as of adapter v0.1.0 / dialect claude-code-jsonl-2026-07-26-v1 |
| codex | verified | verified | not claimed | 2 | verified as of adapter v0.1.0 / dialect codex-rollout-jsonl-2026-07-27-v1 |

## Not yet measured

No adapter, no conformance run, no evidence. These rows carry **no tier and no capability verdicts** — only where the surface is expected to be, from the fleet assessment in `architecture-v2.md` §6.3. Nothing here is a claim about what HyperAgent supports today.

| Harness | Expected surface (unverified) |
|---|---|
| OpenClaw | open-source and hackable; AGENTS.md-style injection, MCP |
| Amp | thread storage; AGENTS.md injection |
| Cursor | app-internal state; rules-file injection |

To earn a row in **Measured**, add a `ConformanceDescriptor` beside the adapter, register it in `src/conformance/registry.ts`, and pass the suite. A row is earned by a passing run, never by editing this table.
