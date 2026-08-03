# Mission Evidence Policy

Mission records are product evidence for the Mission -> Workshop -> Forge loop. They are also logs from real work. Treat them as reviewable source artifacts, not raw transcripts.

## Default Boundary

- Commit public-safe examples in `docs/examples/missions/`.
- `missions/` is private, full stop. As of 2026-07-26 the directory is untracked (`git rm --cached`) and ignored; nothing under it may be committed. Records that were tracked before this date remain in git history — treat everything already pushed as public, and never rely on history for privacy. If a mission teaches a reusable lesson, convert it into a redacted public example under `docs/examples/missions/`.
- Keep local dogfooding evidence in `.hyperagent-evidence/` or another ignored local path.
- Do not commit raw Workbench traces, local trace payloads, shell history, environment dumps, credentials, or private account data.
- When evidence is useful but too local, convert it into a public example that preserves the learning and removes the private details.

## Public Examples

Public examples should show the shape of the loop without depending on one maintainer's machine, issue tracker, or private workspace history.

Good public examples:

- use relative or fictional repo paths,
- avoid private issue URLs, account names, and non-public tracker context,
- use bare planning IDs such as `DAN-NNN` only when they are intentional public roadmap or provenance labels,
- summarize checks instead of pasting raw tool output,
- explain unresolved risks without exposing unrelated side context,
- keep enough detail for contributors to understand what the mission proved.

The sample mission in `docs/examples/missions/public-safe-mission.md` is the reference shape for committed public examples.

## Redaction Checklist

Before committing a mission record, review for:

- absolute local paths such as `/Users/name/...`, `/private/tmp/...`, `/var/folders/...`, or `/tmp/...`,
- private project names, internal workspace names, side-workspace history, or unrelated customer/user context,
- issue metadata that is not meant for the public sample, including private Linear URLs, account names, comments, and full tracker payloads,
- bare issue IDs only when they are not intentional public roadmap or provenance labels,
- secrets, tokens, passwords, API keys, bearer tokens, private keys, or credential-like command fragments,
- raw local trace payloads, `.hyperagent-evidence/` contents, Workbench payloads, screenshots, or command logs,
- network, deployment, filesystem, or account-authority details that would change the safety interpretation of the mission,
- long raw command output that can be summarized as verification evidence instead.

> **Note (2026-08-03):** the `redact-check` / `verify-mission` helpers referenced by earlier revisions of this document belonged to the v1 bash CLI, which has been retired. Redaction is currently a **manual review step** with no automated preflight. Restoring a check scoped to the event store — and closing the redaction-tombstone gap described in `docs/schema.md` §8 — is tracked as open work; until then, human review is the only gate.

## Dogfooding Records

Private dogfooding records can be more specific than public examples, but they should still be inspectable and safe by default.

- Keep raw local evidence in ignored paths.
- Prefer concise summaries over pasted payloads.
- Keep persistent behavior changes `human review required`.
- If a private dogfooding record teaches a reusable lesson, extract the lesson into a redacted public example or a Workshop proposal.

## Contributor Workflow

1. Decide whether the record belongs in `docs/examples/missions/` (public, redacted) or stays in an ignored local path (`missions/`, `.hyperagent-evidence/`). `missions/` is never committed.
2. Remove local paths, private issue metadata, secrets, raw traces, and unrelated side context; keep bare issue IDs only when they are intentional public labels.
3. Review by hand for the categories listed above; there is no automated preflight at present.
4. In the PR, say whether mission evidence was committed, redacted, converted to a public example, or kept local.
