# HyperAgent PRD Faithfulness Review

- Date: 2026-05-23
- Reviewer: Codex wearing the HyperAgent Suit
- Scope: Current local HyperAgent checkout compared with `docs/hyperagent-prd.md`
- Verification run: `sh scripts/verify-mvp.sh`, `sh evals/smoke-loop.sh`, `sh evals/init-smoke.sh`, `sh evals/sense-smoke.sh`, `sh evals/ui-smoke.sh`, `sh evals/reliability-gains.sh`

## Verdict

HyperAgent is faithful to the original PRD as a Codex-first, local, inspectable alpha. It now has the core Mission -> Workshop -> Forge loop, install/update scripts, project init, local sensing, reliability scoring, a local UI cockpit, safety defaults, and smoke tests.

The main gap is no longer "missing files." The gap is that HyperAgent still behaves more like an artifact kit plus operating doctrine than a unified second body. The next phase should simplify the product around one coherent local runtime surface, make product state self-consistent, and turn mission evidence into roadmap movement without relying on manual bookkeeping.

## Strongest Faithfulness

- The PRD's core claim is preserved: models provide intelligence, HyperAgent provides agency.
- The first target remains Codex Mac app, with multi-platform support deferred.
- The product is local-first, markdown-first, inspectable, and human-review-required.
- The required MVP artifacts exist: skill, operating prompt, mission template, proposal template, Forge review template, local memory directories, verifier, docs, and safety model.
- The loop is now behaviorally tested, not just present on disk.
- The architecture diagram and README now explain Codex host, HyperAgent, workspace context, Mission, Workshop, Forge, UI, and Human Review.

## Improve Or Simplify

### 1. Make product state consistent across docs, registry, backlog, and release notes

Current state has drift. `README.md` lists a local UI and UI smoke test, but its Current Limits section still says HyperAgent "does not provide a UI." Release notes still list no polished UI and omit newer `init`, `sense`, UI, and reliability eval surfaces. `hyperagent/capability-registry.md` and `workshop/backlog.md` only show the installer and loop helper, even though mission records show later accepted-looking capabilities such as `init`, sensing, reliability evals, diagram maintenance, and UI.

Recommended fix:
- Add a product-state review checklist or command that compares capabilities, backlog, release notes, README, `.hyperagent`, verifier requirements, and recent mission records.
- Update the registry/backlog after human review for implemented capabilities.
- Treat release notes as versioned truth, not a stale snapshot.

### 2. Collapse the user-facing surface into fewer commands

The helper is useful, but the public surface is sprawling: `init`, `status`, `sense`, `doctor`, `ui`, `record-check`, `new-mission`, `propose-upgrade`, `workshop-prompt`, `new-forge-review`, `forge-prompt`, and `decide-upgrade`.

Recommended simplification:
- Keep the mental model to four primary commands: `init`, `sense`, `mission`, and `review`, with `ui` framed as an optional cockpit helper.
- Move low-level commands behind subcommands or keep them documented as advanced helpers.
- Make `doctor` part of `sense --doctor` unless it stays meaningfully distinct.

### 3. Turn `.hyperagent` into a real contract

The root `.hyperagent` file is the right machine-readable anchor, but the scripts still mostly hard-code paths and do not parse or validate the config as the source of truth.

Recommended fix:
- Define the config schema in docs.
- Add a schema check to `verify-mvp`.
- Make `scripts/hyperagent.sh` read paths and verification commands from `.hyperagent` where practical.
- Add a command like `sh scripts/hyperagent.sh verify-config`.

### 4. Make mission evidence less manual

The PRD asks for reliable mission telemetry. Current sensing helps, but mission records still depend on the agent remembering to run `record-check`, paste `sense`, and replace placeholders in `new-mission` output.

Recommended fix:
- Add a `mission closeout` helper that gathers `sense`, recent checks, changed files, verifier results, and unresolved risk prompts into a near-final record.
- Add a command wrapper for checks, such as `hyperagent check -- sh scripts/verify-mvp.sh`, so command evidence is captured naturally.
- Make placeholder fields fail a strict verifier for mission records intended for review.

### 5. Make Workshop and Forge happen more often

Current local status showed 27 mission records, 2 proposals, 2 decisions, and 1 Forge review. That means the agent is recording missions far more often than it is converting friction into reviewed improvements.

Recommended fix:
- Add a weekly or N-mission Workshop digest command.
- Add a Forge cadence rule: when proposals remain stale or missions outnumber proposals by a threshold, generate a process review.
- Add backlog entries for candidate upgrades already recorded in mission files.

### 6. Upgrade reliability evals from curated examples to real evidence

The reliability-gains eval is good as a first deterministic check, but it compares fixture records rather than replayed tasks, real mission records, or trace-derived runs.

Recommended fix:
- Add a case loader that scores real mission records and final reports.
- Add trace/replay-backed runs when local Workshop traces are available.
- Track reliability deltas over time rather than only passing a fixed positive fixture.

### 7. Clarify the UI's role

The local UI is a useful evidence cockpit, but it creates a product-positioning fork: the PRD warns not to build a complex UI before the markdown loop works, while the repo now includes a real UI.

Recommended fix:
- Describe the UI as an optional local cockpit over markdown, not the product source of truth.
- Update release notes and Current Limits to say "not a polished hosted UI" rather than "does not provide a UI."
- Keep write actions constrained and explicit.
- Add visual regression only if the UI becomes a primary product surface.

### 8. Separate public sample evidence from local/private mission logs

Mission records are useful product evidence, but public repos need a clearer rule for what gets committed. Some mission records contain absolute local paths, Linear issue IDs, and implementation history from side workspaces. That can be acceptable during dogfooding, but it needs an explicit public/private boundary.

Recommended fix:
- Keep `missions/examples/` or `docs/examples/` for public sample missions.
- Keep local dogfooding evidence ignored or opt-in.
- Add a mission redaction checklist for paths, project names, issue metadata, and sensitive context before commit.

### 9. Create a real adapter boundary without building every adapter

The PRD wants model-agnostic, multi-platform potential, while the current implementation is intentionally Codex-first. That is right for the alpha, but adapter seams should be designed before the Codex-specific assumptions harden.

Recommended fix:
- Define `adapters/codex.md` or `adapters/codex.toml`.
- Document what an adapter owns: install path, prompt format, available tools, memory location, verifier commands, and safety constraints.
- Do not implement Claude Code, Cursor, or OpenClaw yet; just prevent Codex assumptions from becoming invisible.

### 10. Strengthen capability discovery

The PRD calls for capability discovery instead of fixed tool assumptions. Current discovery is mostly docs plus the capability registry, but accepted capabilities are not used to drive behavior.

Recommended fix:
- Make `status` or `sense` show installed capabilities and their activation modes.
- Let mission closeout list relevant accepted capabilities.
- Add machine-readable capability metadata while keeping the Markdown registry human-readable.

### 11. Tighten safety from prose into checks

The safety model is clear and human-review-required, but most of it is enforced by instructions rather than local checks. The UI does have a small action allowlist, which is a good start.

Recommended fix:
- Add a safety checklist to proposal and decision verification.
- Add a verifier that rejects accepted capabilities without source proposal, decision record, rollback, activation mode, and verification evidence.
- Consider a small policy file for action classes and activation modes.

### 12. Make first-run less prompt-dependent

The README's copy-paste Codex prompt is practical, but a first-run product should not depend entirely on Codex accurately following a long prompt.

Recommended fix:
- Keep the prompt, but add a one-command bootstrap for humans: clone, verify, install skill, optionally init project.
- Add a `bin/hyperagent setup-codex` wrapper or installer script once the UX is stable.
- Keep the prompt as the assisted path.

### 13. Reconcile "alpha release" with current uncommitted product state

The repo currently has many modified and untracked files, including UI work and mission records. The verifier passes, but release claims should be made from a clean, reviewed tree.

Recommended fix:
- Before the next release note or public claim, get the intended UI/sensing/init changes committed or explicitly parked.
- Run the clean-install UAT in a fresh Codex Desktop session.
- Update `v0.1.0-alpha` notes or prepare a new alpha version if the shipped surface has materially changed.

### 14. Make roadmap ownership visible

The PRD's milestones are still useful, but the repo does not expose a current status table mapping PRD milestones to done, in progress, deferred, or not started.

Recommended fix:
- Add `docs/roadmap.md` with PRD milestone status.
- Include links to mission records, proposals, decisions, and Linear issues where applicable.
- Keep `README.md` short and link to the roadmap instead of trying to carry product state itself.

### 15. Reduce generated-file copying in `init`

`hyperagent init` copies many files into target repos. That is portable, but it risks drift across initialized projects.

Recommended fix:
- Separate stable project-local artifacts from global runtime files.
- Copy templates/config/AGENTS block locally, but prefer invoking the global helper where possible.
- Add an update/migration story for initialized projects.

### 16. Make the Forge more opinionated

The Forge rubric asks the right questions, but the process is still mostly passive.

Recommended fix:
- Add a `forge audit` command that reviews proposal quality, stale decisions, missing rollback plans, and proposal-to-capability traceability.
- Make it produce one process-improvement proposal only when the evidence is strong.
- Track whether Forge changes improve proposal quality over time.

### 17. Protect the "suit, not scaffold" thesis

Some newer surfaces, especially UI and helper commands, are useful but could become today's brittle scaffolding if they are too tied to Codex quirks or local repo assumptions.

Recommended fix:
- For every new feature, ask whether it is durable agency infrastructure: sensing, verification, memory, safety, capability discovery, or upgrade flow.
- Move task-specific convenience into examples or adapters.
- Keep the core product small and composable.

## Suggested Priority Order

1. Product-state reconciliation: registry, backlog, release notes, README Current Limits, roadmap.
2. Mission closeout automation: reduce manual telemetry and placeholder cleanup.
3. Workshop/Forge cadence: convert accumulated mission evidence into reviewed improvements.
4. `.hyperagent` schema and config validation.
5. Real reliability eval ingestion from missions/traces.
6. Public/private mission evidence policy.
7. Command-surface simplification.
8. Adapter boundary design.

## Checks Passed

- `sh scripts/verify-mvp.sh`
- `sh evals/smoke-loop.sh`
- `sh evals/init-smoke.sh`
- `sh evals/sense-smoke.sh`
- `sh evals/ui-smoke.sh`
- `sh evals/reliability-gains.sh`
