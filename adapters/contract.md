# HyperAgent Adapter Contract

HyperAgent is model-agnostic at the product level, but each agent platform needs a small, explicit adapter surface. An adapter explains how HyperAgent enters that platform, what the platform can do, what local artifacts it owns, and which checks prove the adapter is healthy.

This contract is a design boundary, not a platform registry. The current alpha ships only the Codex adapter described in `adapters/codex.md`.

## Adapter Responsibilities

Every platform adapter must document these fields before implementation:

| Field | Requirement |
| --- | --- |
| Platform identity | Name the platform, supported app or CLI surface, and whether support is shipped, in review, or deferred. |
| Install path | Describe how HyperAgent instructions, skills, prompts, or shims are installed or updated. |
| Prompt format | Identify the platform instruction format and where the HyperAgent operating prompt enters the agent context. |
| Tool capabilities | List expected filesystem, shell, network, browser, MCP, and connector capabilities, including unsupported capabilities. |
| Memory location | Name durable memory surfaces, local project artifacts, and any platform-specific memory or skill directories. |
| Verification commands | List the local checks that prove the adapter and project contract are present. |
| Safety constraints | State the default activation mode, approval boundaries, and forbidden behavior. |
| Status reporting | Explain how the adapter reports task state, validation, risks, PRs, issue links, and user-facing handoff notes. |
| UI and sensing integration | Document any platform UI, browser, trace, screen, or workbench sensing surfaces the adapter may read. |
| Ownership boundary | Clarify what belongs to the adapter versus HyperAgent core markdown, templates, helper scripts, and evals. |

## Required Adapter Document Shape

Create `adapters/<platform>.md` with these sections:

- `Status`
- `Install And Update`
- `Prompt And Skill Surface`
- `Tool Capability Assumptions`
- `Memory And Artifacts`
- `Verification`
- `Safety And Authority`
- `Status Reporting`
- `UI And Sensing`
- `Future Adapter Work`

The document should be enough for a future implementer to open a Linear issue with a concrete scope. It should not add runnable support until the issue explicitly authorizes that platform.

## Current Alpha Scope

For `v0.1.0-alpha`:

- Codex is the only enabled adapter.
- `.hyperagent` records `[adapters] codex = true`.
- Non-Codex adapters remain deferred.
- Adapter docs preserve the PRD's model-agnostic thesis without expanding the MVP beyond Codex-first local operation.

## Future Adapter Issue Checklist

A new platform issue should answer:

- Which platform surface is being targeted?
- What install path is available without global hidden state?
- What prompt, skill, or instruction format does the platform accept?
- Which tool capabilities differ from Codex?
- Where should local and cross-project memory live?
- Which verification command proves adapter readiness?
- What human approval is required before activation?
- How will the user see status, validation, risks, and handoff links?
- What is explicitly out of scope for the first adapter pass?
