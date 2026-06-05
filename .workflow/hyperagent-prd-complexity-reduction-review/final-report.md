# Final Report: HyperAgent PRD complexity reduction review

## Outcome
HyperAgent is faithful to the PRD, but it has accumulated more product surface than the MVP contract requires. The simplest integrity-preserving direction is to define a smaller core, make one artifact own each truth, and move useful but non-core capabilities into optional extensions.

The PRD core to preserve:

- Codex-first installable Suit.
- Mission records as local, inspectable evidence.
- Workshop proposals backed by mission evidence.
- Forge reviews that improve the Workshop process.
- Explicit human review for persistent behavior changes.
- Local markdown-first memory with lightweight verification.
- Model-agnostic posture without implementing every adapter yet.

## Accepted Results
- Packet 01 established the non-negotiable PRD contract.
- Packet 02 identified user-facing surface complexity across commands, UI, and docs.
- Packet 03 identified implementation duplication in shell helpers, templates, config, copied runtime, and UI parsing.
- Packet 04 identified process/state duplication across missions, proposals, decisions, backlog, registry, safety prose, and repo-specific rules.
- Packet 05 identified verification and release complexity from optional surfaces entering MVP checks.

## Complexity-Reduction Opportunities

### P0: Highest-Leverage Simplifications

1. Define a formal `core` product boundary.
   Preserve: Suit, Mission, Workshop, Forge, human review, local markdown.
   Reduce: optional features being treated as required product surface.

2. Split the repo into `core` and optional extensions conceptually, even before moving files.
   Core: skill, operating prompt, templates, mission/proposal/Forge loop, minimal helper, MVP verifier.
   Extensions: UI, sensing, Workbench traces, reliability scoring, release/UAT tooling.

3. Collapse the public CLI surface.
   Current surface has 12 commands. Aim for 4 or 5 user-facing commands: `init`, `sense`, `mission`, `review`, `verify`.
   Keep low-level commands as internal or advanced subcommands.

4. Demote the local UI to an optional cockpit.
   The PRD explicitly says not to build a complex UI before the markdown loop works. Keep UI read-only/read-mostly and exclude it from MVP identity.

5. Remove UI from core verification.
   `verify-mvp.sh` currently requires UI files and UI text. Move UI checks to `verify-extensions` or `evals/ui-smoke.sh`.

6. Split verification into three tiers.
   `verify-core`: PRD MVP.
   `verify-extensions`: UI, sensing, Workbench, reliability.
   `verify-release`: docs, issue templates, architecture asset, release notes.

7. Decide whether `.hyperagent` is real config or a simple marker.
   Right now it names paths and commands, but scripts mostly hard-code paths. Either make scripts read it or shrink it.

8. Stop copying the whole runtime into initialized projects.
   Copy project-local artifacts only: `.hyperagent`, `AGENTS.md` block, directories, templates, maybe local README. Keep global helper/UI global.

9. Use template files as the only source for generated artifacts.
   `scripts/hyperagent.sh` embeds mission/proposal/Forge/decision markdown despite having templates. Use placeholders in templates instead.

10. Create one canonical product-state source.
    Current state is spread across README, release notes, backlog, registry, proposals, decisions, mission records, `.hyperagent`, and verifier expectations.

11. Make backlog and capability registry derived or strictly final-state artifacts.
    Avoid hand-maintaining the same capability status in proposal, decision, backlog, and registry.

12. Separate testbed rules from installed-user rules.
    Root `AGENTS.md` is rightly heavy for this repo, but installed users should not inherit Symphony handoff, architecture-diagram, or always-heavy telemetry behavior.

13. Add Workshop/Forge cadence instead of mission-by-mission pressure.
    The PRD needs learning from friction, not a proposal or review every time. Use thresholds like "after N missions" or "when repeated friction appears."

14. Make mission closeout stricter but less manual.
    Replace placeholder-heavy records with a closeout helper that gathers sense, checks, changed files, outcome, risks, and candidate upgrades.

15. Replace manual `record-check` with a natural `check -- <command>` wrapper.
    Evidence should be captured as work happens, not as a second bookkeeping step.

16. Move public mission evidence to curated examples.
    Keep real dogfooding logs local or opt-in. Public examples should be scrubbed and intentionally selected.

17. Convert safety prose into one compact policy/check.
    Templates and docs repeat safety. Add a small policy artifact or verifier that checks activation mode, authority changes, rollback, and human approval.

18. Keep the adapter boundary as docs/schema, not implementation.
    The PRD wants model-agnostic durability, but Codex-first alpha does not need Claude/Cursor/OpenClaw code yet.

### P1: Strong Simplifications

19. Merge `doctor` into `sense --doctor`.
    It is diagnostics for sensing, not a separate product concept.

20. Hide `new-mission`, `propose-upgrade`, `new-forge-review`, and `decide-upgrade` behind `mission`, `review`, or `artifact` groups.

21. Treat Workbench/Raindrop trace enrichment as optional integration.
    It helps sensing but is not required by the PRD and adds privacy/retention complexity.

22. Move reliability-gains eval out of MVP verification.
    Keep it as research until it scores real repeated missions or trace-backed runs.

23. Consolidate onboarding docs.
    README should explain the offer and point to one quickstart. Avoid repeating install/update/safety flow across README, quickstart, UAT, release notes, and concepts.

24. Turn `docs/release-checklist.md` into a release-only checklist.
    Do not let release-readiness artifacts define the day-to-day product core.

25. Reconcile release notes with current product state.
    They currently omit newer surfaces and still say no polished UI while README documents a UI.

26. Add `docs/roadmap.md` mapping PRD milestones to done, deferred, and optional.
    This reduces README and release-note drift.

27. Make architecture diagram updates release-gated unless modules materially change.
    Keep `docs/architecture/hyperagent.mmd` canonical; render SVG at release or when public story changes.

28. Reduce `scripts/hyperagent.sh` to a smaller core helper.
    The current 1,461-line shell script mixes runtime, init, sensing, UI launch, JSON, redaction, artifact creation, and decisions.

29. Remove duplicate shell functions.
    `git_changed_files` appears twice; similar cleanup likely exists after deeper pass.

30. Move generated project docs out of shell heredocs.
    `generate_init_readme`, `generate_init_agents_block`, registry/backlog generation, and templates should live as files.

31. Use structured artifact metadata.
    A tiny frontmatter block or stable key-value schema would simplify UI/API parsing and status detection.

32. Replace heuristic proposal status parsing.
    The UI currently treats any content containing accepted/rejected as status. Status should derive from linked decision records.

33. Make accepted capabilities traceable from decisions.
    Registry entries should be generated from accepted decisions or checked against them to avoid drift.

34. Remove "auto-install low risk" from operational affordances until policy exists.
    The mode can remain listed because the PRD names it, but it should not imply current implementation support.

35. Make `init` install less.
    Project init should not copy UI assets or a full helper unless the user asks for a self-contained local runtime.

36. Add an update/migration story for initialized projects.
    If copying remains, provide a simple migration/check command or the copies will drift.

### P2: Useful Cleanups

37. Rename extension evals by capability.
    Example: `evals/extensions/ui-smoke.sh`, `evals/extensions/sense-smoke.sh`.

38. Keep `.github` issue templates outside MVP verification.
    They matter for open source readiness, not the product loop.

39. Separate Symphony/Linear handoff from HyperAgent generic instructions.
    Keep it in this repo's local instructions or project memory, not generated init docs.

40. Shorten the README first-run prompt.
    The prompt is practical but long. Prefer a short assisted path plus a manual quickstart.

41. Avoid one-off product docs for every new capability.
    Use a product-state/roadmap document and link to detailed docs only when the capability becomes stable.

42. Treat the UI as a view over markdown, never a second source of truth.
    If retained, document that all writes still resolve to local markdown artifacts and constrained commands.

43. Keep capability discovery lightweight.
    Show accepted capabilities and activation modes in status/sense, but avoid a complex registry database.

44. Use one redaction policy across command logs, traces, mission records, and UI output.
    This reduces duplicated safety language and inconsistent behavior.

45. Keep Forge passive by default.
    It should review Workshop quality and propose process improvements, not act as an always-on manager.

46. Make "suit, not scaffold" a feature gate.
    New features should qualify as durable agency infrastructure: sensing, verification, memory, safety, capability discovery, or upgrade flow.

47. Reduce committed local-path artifacts.
    Absolute paths are useful mission evidence locally but should not accumulate in public product history unless intentionally curated.

48. Keep release notes versioned, not living-state docs.
    Use current docs for current product state; release notes should describe what shipped at that version.

49. Prefer markdown plus small scripts over new runtime dependencies.
    Node UI is acceptable as optional; the core should remain dependency-light.

50. Make extension adoption explicit.
    A user should be able to run HyperAgent core without UI, Workbench traces, reliability evals, or PR/CI lookup.

## Rejected Results
Rejected simplifications:

- Removing Workshop or Forge entirely. That would compromise the PRD's self-improving product definition.
- Removing mission records. That would eliminate local telemetry and evidence-backed learning.
- Removing human review. That would violate the authority boundary.
- Building every adapter now. That would increase complexity while the PRD only needs Codex-first alpha plus future extensibility.
- Replacing markdown artifacts with a database or hosted service. That would violate the MVP's local, inspectable model.

## Conflicts Resolved
- UI is not inherently anti-PRD, but making it core too early conflicts with the MVP non-goal. Resolution: optional cockpit, markdown remains source of truth.
- Full telemetry is useful in the HyperAgent testbed, but too heavy for installed users. Resolution: keep aggressive telemetry local to this repo; ship lighter cadence defaults.
- `.hyperagent` can reduce complexity only if it is authoritative. Resolution: either enforce it as config or shrink it to a marker.

## Verification Evidence
- Source review completed against `docs/hyperagent-prd.md`, `README.md`, `docs/quickstart.md`, `docs/releases/v0.1.0-alpha.md`, `.hyperagent`, `scripts/hyperagent.sh`, `scripts/hyperagent-ui.mjs`, templates, eval docs, verifier, and prior PRD faithfulness review.
- `sh scripts/hyperagent.sh status` passed and reported current artifact counts.
- Final command verification is recorded in the mission record.

## Remaining Risks
- This report is a review, not an implementation. Some opportunities may conflict with pending branch or PR intent.
- The checkout has many modified/untracked files, so recommendations should be applied with care against the intended branch state.
- "All opportunities" is bounded by the files inspected in this run; deeper code-level cleanup might find more small implementation issues.

## Reusable Follow-up
Recommended next implementation sequence:

1. Create a `core vs extensions` product-state/roadmap doc.
2. Split verification into core, extension, and release tiers.
3. Collapse CLI public surface and move low-level commands behind grouped subcommands.
4. Make templates the single source for generated artifacts.
5. Reduce project init to local memory/setup only.
6. Demote UI/sensing/reliability to explicit optional extensions.
