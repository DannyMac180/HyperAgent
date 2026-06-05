# Orchestration: HyperAgent PRD complexity reduction review

## Execution Rules

- Keep the original objective intact.
- Ask for approval before risky, expensive, external, or destructive actions.
- Keep immediate blocking work local.
- Delegate only bounded, disjoint, materially useful packets.
- Integrate packet results before final verification.
- Preserve the PRD contract: Codex-first installability, local markdown evidence, human review, and Mission -> Workshop -> Forge.

## Branching Rules
- If a simplification removes Codex-first installability, local markdown evidence, human review, or the Mission -> Workshop -> Forge loop, reject or reframe it.
- If a component is useful but not MVP-critical, classify it as demote/defer/isolate rather than delete.
- If two artifacts encode the same truth, prefer one canonical source and derived/generated views.

## Packet Prompts
- PRD contract: identify non-negotiable requirements and non-goals.
- Product surface: inspect user-facing commands, UI, docs, install/update, and public story.
- Runtime implementation: inspect scripts, config, template generation, parsing, and copied runtime files.
- Evidence/process: inspect mission/proposal/decision/Forge state, backlog, registry, cadence, and safety.
- Verification/release: inspect verifier, evals, release notes, and public/private evidence boundary.

## Completion Audit
- Integrated final report written.
- MVP verifier run.
- Workflow artifact verifier run.
- Mission record written.
