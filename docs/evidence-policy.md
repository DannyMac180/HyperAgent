# Mission Evidence Policy

Mission records are product evidence for the Mission -> Workshop -> Forge loop. They are also logs from real work. Treat them as reviewable source artifacts, not raw transcripts.

## Default Boundary

- Commit public-safe examples in `docs/examples/missions/`.
- Commit mission records in `missions/` only when they are intentionally useful project evidence and have passed the redaction checklist below. The directory is ignored by default so new local dogfooding records do not become public evidence accidentally.
- Keep local dogfooding evidence in `.hyperagent-evidence/` or another ignored local path.
- Do not commit raw Workbench traces, local trace payloads, shell history, environment dumps, credentials, or private account data.
- When evidence is useful but too local, convert it into a public example that preserves the learning and removes the private details.

## Public Examples

Public examples should show the shape of the loop without depending on one maintainer's machine, issue tracker, or private workspace history.

Good public examples:

- use relative or fictional repo paths,
- avoid private issue IDs, URLs, and account names,
- summarize checks instead of pasting raw tool output,
- explain unresolved risks without exposing unrelated side context,
- keep enough detail for contributors to understand what the mission proved.

The sample mission in `docs/examples/missions/public-safe-mission.md` is the reference shape for committed public examples.

## Redaction Checklist

Before committing a mission record, review for:

- absolute local paths such as `/Users/name/...`, `/private/tmp/...`, `/var/folders/...`, or `/tmp/...`,
- private project names, internal workspace names, side-workspace history, or unrelated customer/user context,
- issue metadata that is not meant for the public sample, including private Linear URLs and issue IDs,
- secrets, tokens, passwords, API keys, bearer tokens, private keys, or credential-like command fragments,
- raw local trace payloads, `.hyperagent-evidence/` contents, Workbench payloads, screenshots, or command logs,
- network, deployment, filesystem, or account-authority details that would change the safety interpretation of the mission,
- long raw command output that can be summarized as verification evidence instead.

Run the quick preflight before committing public mission examples:

```bash
sh scripts/hyperagent.sh mission redact-check docs/examples/missions/public-safe-mission.md
```

This helper flags obvious local paths, Linear metadata, local evidence payload references, and secret-like strings. Core verification runs it on the public-safe example and on changed mission files visible to git, so new public evidence gets a forward safety gate. Passing the helper is not a guarantee that a mission is public-safe; human review is still required.

## Dogfooding Records

Private dogfooding records can be more specific than public examples, but they should still be inspectable and safe by default.

- Keep raw local evidence in ignored paths.
- Prefer concise summaries over pasted payloads.
- Keep persistent behavior changes `human review required`.
- If a private dogfooding record teaches a reusable lesson, extract the lesson into a redacted public example or a Workshop proposal.

## Contributor Workflow

1. Decide whether the record belongs in `missions/`, `docs/examples/missions/`, or an ignored local path.
2. Remove local paths, private issue metadata, secrets, raw traces, and unrelated side context.
3. Run `sh scripts/hyperagent.sh verify-mission --strict PATH` when the file is a mission record.
4. Run `sh scripts/hyperagent.sh mission redact-check PATH` before proposing a public commit.
5. In the PR, say whether mission evidence was committed, redacted, converted to a public example, or kept local.
