# Memory

HyperAgent memory is curated, mutable state derived from closed sessions or
added manually. It is deliberately different from the append-only `events`
table: events preserve observations, while memories can be reviewed, corrected,
approved, rejected, retired, and re-rendered into an agent's local context.

## Storage schema

The SQLite `memories` table has these columns:

| Column | Meaning |
| --- | --- |
| `id` | ULID primary key |
| `claim` | The durable claim |
| `kind` | `factual`, `gotcha`, `preference`, or `behavior` |
| `scope` | `global`, `repo`, or `agent` |
| `scope_key` | Repository path or agent vendor for keyed scopes; `NULL` for global |
| `confidence` | Number from 0 through 1 |
| `status` | `candidate`, `approved`, `rejected`, or `retired` |
| `evidence` | Non-empty JSON array of `{session_id, raw_ref}` references |
| `source` | `extraction` or `manual` |
| `claim_hash` | SHA-256 of the normalized claim |
| `created_at` | ISO timestamp for creation |
| `updated_at` | ISO timestamp for the latest mutation |
| `last_validated_at` | ISO timestamp for the latest validation, or `NULL` |

Every database mutation also writes a readable Markdown mirror at
`~/.hyperagent/memory/<scope>/<id>.md`. SQLite remains the source of truth.

## Status and authority

Status changes happen only through `approve`, `reject`, and `retire`. The
general `update` operation cannot change status. This is an authority boundary:
status controls whether a memory is eligible for injection, and the dedicated
transition commands are also where injection re-rendering is triggered.

`candidate` is the review queue. `approved` is eligible for injection.
`rejected` is a durable human refusal. `retired` removes a formerly useful claim
while allowing the system to learn it again later.

## Extraction

When enabled by the daemon, a newly closed session is placed on a
concurrency-one extraction queue alongside mission processing. HyperAgent's own
spawned model-run sessions are rejected before extraction, preventing recursive
self-ingestion.

Extraction uses the user's own agent CLI in
`~/.hyperagent/modelruns/`. The model receives structured session facts and is
asked for at most five candidates. Parsing is defensive: malformed JSON,
unsupported fields, invalid kinds, invalid confidence, overlong output, and
model failures yield no stored candidates. The pipeline stamps each evidence
reference with the closed session's `session_id`; `session_id` is never accepted
from model output.

Extraction does not inject context. Injection occurs after an explicit status
transition or `memory sync`, so a session never receives a surprise mid-session
context change.

## Dedupe

Claims are lowercased, punctuation is removed, whitespace is collapsed, and the
normalized text is hashed. New extraction candidates are checked against every
non-retired memory and against earlier candidates in the same extraction batch.

A match against a rejected memory is dropped. Rejection is a tombstone: a claim
that a human rejected must not resurface as review spam. Retired claims are
excluded from dedupe and may be learned again.

## Promotion policy

The promotion configuration lives at `~/.hyperagent/config.json`:

```json
{
  "autoPromoteFactual": false
}
```

Automatic promotion is off by default. `behavior` and `preference` memories
never auto-promote, unconditionally. `factual` and `gotcha` candidates promote
only when `autoPromoteFactual === true` and confidence is at least `0.8`.

Setting `autoPromoteFactual` to `true` means trusting the model-assigned kind and
confidence despite transcript-borne prompt injection. That risk is exactly why
the default is off.

## Managed-block contract

Claude Code injection owns only the block between these exact marker lines:

```text
<!-- hyperagent:memory:begin -->
<!-- hyperagent:memory:end -->
```

Markers match as full lines only. Bytes outside the managed block are preserved.
Missing, duplicated, nested, or reversed markers are treated as corruption and
the edit is refused rather than guessed. Memory ordering is deterministic by
scope and ID, and rendered content contains no timestamps. Writes use a
same-directory temporary file followed by an atomic rename. Byte-identical
content skips the write.

## Why `CLAUDE.local.md`

A repository-committed `CLAUDE.md` could exfiltrate personal memories to remotes
and collaborators. Claude Code reads `CLAUDE.local.md`, and that file is
conventionally gitignored, so it is the deliberate Claude Code injection target.

## Target set and validation

The target set is the union of:

- repositories with at least one approved repo-scoped memory; and
- an explicit repository supplied with `memory sync --repo <path>`.

Approved global memories render into every target, but global memories never
create targets by themselves. Approved agent-scoped memories render when their
scope key matches the renderer vendor.

### Orphaned targets

Because global memories never sustain a target, retiring or rejecting a
repository's last approved repo-scoped memory drops that repository out of the
target set. Its managed block would otherwise keep whatever global bullets it
last rendered forever, because no later mutation or `memory sync` would ever
visit it again.

So the re-render set for a mutation is `(target set before) ∪ (target set
after)`. A repository in before-but-not-after is re-rendered to an **empty**
managed block — markers and the warning comment only, no bullets. The file is
never deleted. The same rule covers approve flows that change membership: a
newly approved repo-scoped memory pulls the repository into the target set and
the global bullets render into it on that same mutation.

Before rendering, each target is canonicalized with `realpath`. Validation
refuses non-directories, paths without a `.git` entry, `~/.claude`,
`~/.hyperagent`, and anything beneath those protected directories. Because
validation uses canonical paths, symlink escapes are refused too.

Fanout is best-effort and the database is authoritative. A refused or failed
target is reported and skipped; it does not roll back the approval or prevent
other targets from rendering.

## CLI

```text
memory list [--status S] [--scope S] [--stale --days N]
memory show <id>
memory approve <id>
memory reject <id>
memory retire <id>
memory add --claim C --kind K --scope S [--scope-key K]
memory sync [--repo <path>]
```

All commands also accept `--data-dir D`. `memory add` creates an approved manual
memory with a synthetic evidence `session_id` of `manual`. For stale listing,
`NULL` validation timestamps count as stale.

## Deferred work

- Workshop clustering: DAN-204
- Decay audit: DAN-208
- Other renderers: DAN-205 and DAN-207
- Gates: DAN-203
