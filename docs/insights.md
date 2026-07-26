# HyperAgent — Product Insights, One-Liners, and Demo Ideas

> Captured 2026-07-26 from the v2 rearchitecture session. These are the ideas that make HyperAgent different from every other meta-harness or agent tool on the market. Companion to `docs/architecture-v2.md` (the technical source of truth) — this file is the *why it's special* record, for launch copy, essays, demos, and product decisions.

## The one-liners

The canon (already established):

- **"Models provide intelligence. HyperAgent provides agency."**
- **"A scaffold decays as models improve; a suit evolves as agents act."**

New from the v2 design:

- **"The pilot flies; the suit records."** — the core v2 principle in five words: zero ceremony on the working agent, involuntary observation underneath it.
- **"A scaffold accumulates; this suit sheds weight as the pilot gets stronger."** — the decay audit as a sentence.
- **"Agents are interchangeable bodies; HyperAgent is the nervous system that persists across them."** — the meta-harness thesis.
- **"Agents come and go; the suit is yours."** — same idea, consumer register.
- **"Stop asking the agent to wear the suit — build the suit around the agent."** — the v1→v2 pivot in one line.
- **"The flight recorder and memory for your AI agents."** — the day-one value proposition (sell the mirror first).
- **"See everything they did, catch what they broke, never let them make the same mistake twice."** — the mirror pitch, expanded.
- **"Charge for the cockpit, not the armor."** — the open-core boundary as a sentence.
- **"Your team's agents share one nervous system."** — the Teams tier.
- **"The harness's intelligence is the model's intelligence."** — Workshop cognition dispatched through the user's own agent CLI: the suit automatically gets smarter every time their agent does, at zero marginal cost.

## The differentiators — why nothing else on the market is this

1. **Involuntary observation.** Every other agent-improvement tool asks the agent to self-report (write logs, fill templates, reflect). HyperAgent reads the harness's own transcripts and hooks after the fact. This kills both failure modes at once: ceremony overhead (the agent does nothing extra) and self-report bias (the agent can't flatter its own record). v1 proved the voluntary version fails — 60 of 66 missions self-reported "no friction."

2. **The durability test as an admission rule.** The suit only installs capabilities a model *cannot* get better at on its own: ground truth (your history), actuation/permission (gates), measurement (external verification), persistence (cross-session, cross-vendor). Anything that tells the model *how to think* is rejected by policy. This is the Felix Rieseberg warning turned into an enforceable gate rather than a vibe.

3. **The decay audit — self-deleting scaffolding.** Every installed capability carries a falsifiable "still needed?" test; the Forge periodically replays scenarios without it and retires capabilities the current model has outgrown — per agent. Nobody else builds software designed to shrink as models improve. It's a one-line demo of the entire worldview, and it makes the anti-scaffold claim *checkable* instead of rhetorical.

4. **Cross-vendor memory as a structural moat.** A lesson learned in one agent's session is present in every other agent's next session. No vendor can build this — Anthropic will never write Codex's memory. The moat isn't a feature; it's a conflict of interest the incumbents cannot resolve.

5. **Comparative agent measurement — data nobody else can have.** All agents' sessions score through one rubric on *your* workload, producing per-repo, per-task-type comparisons ("Codex wins on test-writing here; Claude Code on debugging") and routing recommendations. Vendors will never benchmark themselves against competitors on your private work; the meta-harness does it as a side effect.

6. **The canonical schema is the LSP move.** N adapters × M features collapses to N + M because everything downstream is written once against a vendor-neutral event schema. Long-term, the schema itself can become the open standard for agent telemetry — a bigger strategic position than any single app.

7. **Zero-marginal-cost cognition.** The Workshop's analysis dispatches through the user's own installed agent CLI (headless `claude -p` / `codex exec`), riding the subscription they already pay for. No hosted inference bill, no margin decay, and the suit's intelligence upgrades automatically with the user's models.

8. **Replay evals from real history.** Upgrade proposals are tested by replaying *captured real sessions* against the upgraded suit — not hand-authored fixtures (v1's reliability eval was fixture-vs-fixture and arithmetically incapable of failing). The user's own past failures become the test suite.

9. **Vendor churn is a tailwind, not a risk.** Transcript formats and hook APIs break constantly. For a per-vendor scaffold that's fatal; for the meta-harness it's the recurring value that update revenue pays for — adapter maintenance is a feature of the business model.

10. **Detection without enforcement still counts.** Where a harness offers no blocking hooks, policy violations are detected post-hoc in transcripts and surfaced ("Amp violated policy X twice this week"). Governance degrades gracefully instead of binarily — and tells you which agents to trust with what.

## Demo ideas

- **The cross-agent transfer (launch video).** Codex trips over a repo gotcha on Monday. On Tuesday, Claude Code opens the same repo already knowing it. Split screen, two days, one lesson. Visceral and impossible for any vendor to replicate.
- **The decay audit, live.** Watch the suit retire a capability on camera: the replay eval runs without it, the model passes anyway, the capability is tombstoned with evidence. "This is software deleting its own scaffolding because the model got smarter."
- **The verification bounce.** Agent claims "done, tests pass." The Stop gate checks the transcript — tests never ran — and bounces it back. The agent fixes it before the user ever sees the false claim. The suit catching a lie in real time.
- **The comparative dashboard.** Same repo, three agents, two weeks of real work: per-agent scores by task type, with a routing recommendation. "Which of your agents is actually best? Now you know."
- **Fleet week.** Give the identical task to Claude Code, Codex, and OpenClaw; watch the meta-harness score all three side by side from their own transcripts.
- **"What my suit learned this week."** Weekly dogfooding posts during the build: real memories extracted, real proposals approved/rejected, real capabilities retired. Marketing that is also public proof the loop closes — the thing v1 never demonstrated.

## Strategic framings worth keeping

- **Sell the mirror first.** Nobody pays for a promise of future recursion. Day-one value is observability + memory ("what did my agents do, and what have they learned"). The self-improvement loop is the compounding reason to *stay*, not the reason to buy.
- **The kill criterion discipline.** From the v1 post-mortem: dogfooding must be run to *falsify*, not celebrate. The loop's success metric is one full cycle — friction → proposal → decision → installed capability → measurably better next session. v1 never completed it once; v2's dashboard makes completing it visible.
- **Vendor-neutrality is the identity.** The suit that follows you when you switch models is precisely the product no model vendor will ever build. Every roadmap decision should protect that neutrality.
- **Honest audience sequencing.** "Anyone who uses AI agents" is the 2027 market; 2026 buyers are technical agent power users. Build the accessible Mac app from day one; aim the launch at builders and let accessibility widen the funnel as agent adoption does.
