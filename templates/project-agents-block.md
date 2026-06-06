<!-- hyperagent-init:start -->

## HyperAgent Project Instructions

Use HyperAgent triage for substantial work in this repository.

Run the full Mission -> Workshop -> Forge loop when a task:

- changes files, docs, scripts, templates, tests, product behavior, or workflow behavior,
- requires investigation across multiple files or commands,
- involves verification, debugging, or failing checks,
- reveals friction worth turning into a reusable improvement,
- explicitly asks for HyperAgent.

For full-loop tasks:

1. Complete the task with focused changes and explicit verification.
2. Write a mission record in `missions/`.
3. Create a Workshop proposal in `workshop/proposals/` only when there is concrete Suit friction or a worthwhile improvement.
4. Create a Forge review in `forge/reviews/` only when the Workshop process itself needs review.
5. Keep persistent behavior changes `human review required`.

Use a lighter cadence for ordinary installed-project work: Workshop or Forge reviews are most useful after repeated friction, after several missions, or when the user asks for them.

Skip the full loop only for clearly isolated one-off tasks such as simple factual answers, trivial commands, small clarifications, or status restatements without new investigation. When skipping, say that HyperAgent triage classified the task as an isolated one-off and no mission record was written.

Local verification guidance:

```bash
hyperagent status
```

Add project-specific build, test, lint, or smoke commands here as they become known.

<!-- hyperagent-init:end -->
