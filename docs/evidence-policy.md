# HyperAgent Evidence Policy

HyperAgent learns from local evidence, but not every local mission record belongs in public product history.

## Evidence Classes

| Class | Location | Commit posture |
| --- | --- | --- |
| Public examples | `docs/examples/` or curated mission fixtures | Safe to commit after review |
| Product telemetry | `missions/`, `workshop/`, `forge/` in this repo | Commit only when intentionally part of dogfooding evidence |
| Local runtime evidence | `.hyperagent-evidence/` | Ignored by default |
| Private/project-specific traces | local worktrees, Workbench logs, external issue state | Do not commit unless explicitly scrubbed and approved |

## Redaction Checklist

Before committing evidence, check for:

- secrets, tokens, credentials, or private keys,
- sensitive personal details,
- private customer/account data,
- accidental shell history or environment values,
- unnecessary absolute local paths,
- irrelevant issue metadata from unrelated projects,
- raw trace payloads that contain prompts, tool outputs, or file contents.

## Public Examples

Prefer small, curated examples that demonstrate the loop:

1. user request,
2. mission evidence,
3. verification,
4. friction,
5. proposal,
6. human decision.

Do not use public examples as a dumping ground for local dogfooding logs.
