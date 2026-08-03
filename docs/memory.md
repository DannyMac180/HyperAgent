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

## Where candidates come from

This repository stores, transitions, and injects memories. It does not produce
them. Deriving candidate memories from a closed session — and deciding whether
any candidate may reach `approved` without a human — is judgment-plane work and
lives outside this repo (`docs/open-core.md`).

Two guarantees hold regardless of what produced a candidate, and both are
enforced here rather than requested of the producer:

- A memory reaches `approved` only through the `approve` transition, and
  `update` cannot move status. Injection eligibility is not something a
  producer can grant itself.
- Nothing is injected as a side effect of extraction. Injection happens on an
  explicit status transition or an explicit `memory sync`, so a running session
  never receives a surprise mid-session context change.

## Dedupe

Claims are lowercased, punctuation is removed, whitespace is collapsed, and the
normalized text is hashed (`normalizeClaim` / `claimHash` in
`src/memory/store.ts`); the hash is stored on the row and indexed. That gives
any producer a stable identity for a claim to check against.

Retired claims are excluded from dedupe and may be learned again — retirement
removes a formerly useful claim without forbidding it. Rejection is the
opposite: a durable human refusal, and a tombstone a producer is expected to
respect.

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

## Not yet built

- Injection renderers beyond Claude Code and Codex. The store is
  vendor-neutral; the renderer set is not yet complete.
- A decay clock that does anything. Memories carry `last_validated_at`, and
  `memory list --stale --days N` will show you what has gone quiet, but nothing
  acts on it automatically.
