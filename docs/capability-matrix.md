<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->

# Capability Matrix

Regenerate with `bun src/daemon/cli.ts conformance matrix --write`. Generation runs the conformance suite LIVE against every registered descriptor; there is no cached-report path.

| Harness | Observe | Inject | Gate | Tier | Evidence |
|---|---|---|---|---|---|
| claude-code | verified | verified | verified | 1 | verified as of adapter v0.1.0 / dialect claude-code-jsonl-2026-07-26-v1 |
| OpenClaw | Open-source, hackable | AGENTS.md-style, MCP | Likely achievable | 1 — full suit | claimed, unverified — architecture-v2 §6.3 |
| Codex | Session rollouts | AGENTS.md, skills | Approval config only | 2 — observe + inject | claimed, unverified — architecture-v2 §6.3 |
| Amp | Thread storage | AGENTS.md | No | 2 | claimed, unverified — architecture-v2 §6.3 |
| Cursor | Weak (app-internal) | Rules files | No | 3 — inject-only | claimed, unverified — architecture-v2 §6.3 |

To earn a row, add a `ConformanceDescriptor` beside the adapter, register it in `src/conformance/registry.ts`, and pass the suite. A row is earned by a passing run, never by editing this table.
