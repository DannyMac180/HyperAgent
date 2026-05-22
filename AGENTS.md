# HyperAgent Project Instructions

This repository is the testbed for HyperAgent. In this project, Codex should run HyperAgent triage on every task.

## Default Behavior

At the start of each task, decide whether the full HyperAgent loop is relevant.

Use the full HyperAgent Mission -> Workshop -> Forge loop by default when the task:

- changes files, docs, scripts, templates, skills, evals, or product behavior,
- asks about the HyperAgent PRD, architecture, setup, install flow, skill behavior, or repo status,
- requires investigation across multiple files or commands,
- involves verification, debugging, failing checks, or repeated friction,
- could reveal an improvement to the Suit, Workshop, Forge, installer, docs, or evals,
- explicitly asks to use HyperAgent or to run a HyperAgent mission.

For full-loop tasks:

1. Use the `codex-hyperagent` skill instructions.
2. Read `hyperagent/operating-prompt.md`.
3. Complete the user task with focused changes and explicit verification.
4. Write a mission record in `missions/`.
5. Create a Workshop proposal in `workshop/proposals/` only when there is concrete Suit friction or a worthwhile improvement.
6. Create a Forge review in `forge/reviews/` only when the Workshop process itself needs review.
7. Keep persistent behavior changes `human review required`.

Skip the full loop only when the task is clearly isolated and low-signal, such as:

- answering a simple factual question that does not depend on repo state,
- running a trivial one-line command,
- restating prior status without new investigation,
- small conversational clarification,
- simple formatting or wording that does not affect project behavior.

When skipping the full loop, mention briefly that HyperAgent triage classified the task as an isolated one-off and no mission record was written.

## Testing Posture

Because this repo is the HyperAgent testbed, prefer recording mission telemetry for borderline cases. The goal is to learn which tasks deserve the loop and where the loop feels too heavy.

## README Architecture Diagram

The GitHub README is the initial user-facing landing page. Keep its high-level architecture diagram current when user-visible HyperAgent modules are added, removed, renamed, or materially changed.

When a task changes user-visible modules, review and update these files as needed:

- `docs/architecture/hyperagent.mmd`: editable diagram source.
- `docs/assets/hyperagent-architecture.svg`: rendered README asset.
- `README.md`: surrounding architecture copy if the public story changes.

For PRs that change user-visible modules, confirm that the architecture diagram was reviewed or updated.

Run the strongest relevant local verification before final response:

```bash
sh scripts/verify-mvp.sh
sh evals/smoke-loop.sh
```

Use narrower checks when the change is documentation-only or when the full smoke loop is not relevant.
