# HyperAgent Canonical Event Schema — v0.1.0

> The vendor-neutral session/event model every adapter translates into, and the contract every downstream component (memory, scoring, Workshop, Forge, Cockpit) consumes. This is the precise spec promised by `docs/architecture-v2.md` §6.1 (DAN-198). Where this document and prose elsewhere disagree, this document wins for schema questions.

## 1. Design rules

1. **Append-only.** Observed history is immutable. The store exposes `append` and read operations only — no update or delete of events, ever. Corrections are new events, not edits.
2. **Everything is an event.** There is one physical log. Higher-level entities (sessions, turns) are *event-delimited spans*, not mutable rows: a session is the span between its `session_start` and `session_end` events. This is what makes append-only workable — "the session ended" is a fact that arrives later, not an update to an old row.
3. **Vendor-blind downstream, vendor-tagged at the edge.** Every event carries `vendor` + `adapter_version`, and a `raw_ref` pointing back into the vendor's own artifact (transcript path + locator) so memories and scores can cite ground-truth evidence. Nothing downstream may branch on `vendor` except for display.
4. **Optional by tier.** Adapters emit what their harness exposes (architecture-v2 §6.3). Only the envelope fields are required; all type-specific payload fields are optional. Absence of a field is "not observed," never "false."
5. **Schema versioned independently.** The schema has its own semver (this doc's version). Every event records the `schema_version` it was written under. Migrations are additive whenever possible; a major bump is a breaking re-shape and requires a migration note in this file.
6. **Local-first.** One SQLite file per user (default `~/.hyperagent/hyperagent.db`), WAL mode, no network.

## 2. Event envelope (required on every event)

| field | type | notes |
|---|---|---|
| `id` | text, ULID | globally unique, lexically time-ordered |
| `ts` | text, ISO-8601 UTC with ms | when the event occurred in the harness (adapter's best knowledge), not when observed |
| `observed_at` | text, ISO-8601 UTC | when the daemon ingested it |
| `type` | text enum | see §3 |
| `session_id` | text | canonical session id (§4.1); every event belongs to a session |
| `vendor` | text | `claude-code`, `codex`, `openclaw`, `amp`, `cursor`, `unknown:<slug>` — open set, unknown vendors are legal |
| `adapter_version` | text | semver of the emitting adapter |
| `schema_version` | text | semver of this schema at write time |
| `raw_ref` | text, nullable | evidence pointer: `<path>#<locator>` into the vendor artifact (e.g. JSONL line number, byte offset) |
| `payload` | JSON | type-specific fields (§4); unknown keys are preserved, never dropped |

## 3. Event types (closed enum, v0.1.0)

`session_start`, `session_end`, `turn_start`, `turn_end`, `tool_call`, `error`, `retry`, `completion_claim`, `verification_event`

The enum is closed per schema version; adding a type is a minor bump. Adapters encountering vendor happenings with no canonical type MUST NOT invent types — map to the closest type or drop with a counted warning (adapter breakage is a normal, visible event).

## 4. Entities and payloads

### 4.1 `session` (span: `session_start` → `session_end`)

`session_id` construction: `<vendor>:<native-session-id>` when the harness has one; else `<vendor>:<sha256(path+start_ts)[0..16]>`. Deterministic, so re-ingesting the same transcript yields the same id (idempotent ingestion dedupes on it, §6).

`session_start` payload: `agent` (harness product name), `model` (as reported), `harness_version`, `repo` (git root path), `git_branch`, `cwd`, `parent_session_id` (nullable — session lineage: set when the harness resumes, forks, or compacts a prior session into this one, e.g. Claude Code `--resume`. Downstream consumers treat a lineage chain as one logical body of work; the DAN-200 adapter must populate it rather than inventing its own linkage).
`session_end` payload: `outcome` (`completed` | `abandoned` | `crashed` | `unknown`), `duration_ms`, `turn_count`, `tool_call_count`. A session with no observed `session_end` is *open*; the daemon may close it with `outcome: unknown` after a timeout — as a new event, never an edit.

### 4.2 `turn` (span: `turn_start` → `turn_end`)

`turn_start` payload: `turn_index` (0-based within session), `role` (`user`), `text_digest` (sha256 of user text), `text_chars`, `is_correction` (boolean, nullable — flagged when the adapter can detect the user correcting/redirecting the agent; a core scoring signal).
`turn_end` payload: `turn_index`, `role` (`agent`), `text_digest`, `text_chars`, `stop_reason` (nullable).

Digests, not raw text: the canonical store carries pointers and measurements; raw text stays in the vendor transcript reachable via `raw_ref`. (Memory extraction reads transcripts directly; the event log is the index, not a copy — keeps the DB small and the privacy surface minimal.)

### 4.3 `tool_call`

Payload: `name`, `input_digest` (sha256 of canonical-JSON input), `input_summary` (≤200 chars, redacted), `status` (`ok` | `error` | `denied` | `aborted`), `duration_ms`, `files_touched` (array of repo-relative paths), `turn_index`.

### 4.4 `error` / `retry`

`error` payload: `source` (`tool` | `harness` | `model` | `adapter`), `message_digest`, `message_summary` (≤200 chars, redacted), `turn_index`, `tool_call_id` (nullable, the `id` of the related `tool_call` event).
`retry` payload: `of_event_id` (the event being retried), `attempt` (1-based), `turn_index`.

### 4.5 `completion_claim`

What the agent *said* it accomplished — the raw material for verification bounce and claim-vs-evidence scoring.
Payload: `claim_text` (verbatim, redacted), `claim_kind` (`done` | `tests_pass` | `deployed` | `fixed` | `other`), `turn_index`.
(Claim text is stored verbatim, unlike turn text, because claims are small and are the product's core evidence artifact.)

### 4.6 `verification_event`

Checks that actually ran — tests, builds, typechecks, gates, lints.
Payload: `kind` (`test` | `build` | `typecheck` | `lint` | `gate` | `other`), `command_digest`, `command_summary` (redacted), `result` (`pass` | `fail` | `error`), `stats` (JSON, e.g. `{passed, failed, skipped}`), `turn_index`, `initiated_by` (`agent` | `suit` | `user` | `unknown`).

## 5. SQLite physical schema

```sql
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;                      -- holds schema_version, created_at

CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,          -- ULID
  ts              TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN (
                    'session_start','session_end','turn_start','turn_end',
                    'tool_call','error','retry','completion_claim','verification_event')),
  session_id      TEXT NOT NULL,
  vendor          TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  schema_version  TEXT NOT NULL,
  raw_ref         TEXT,
  payload         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts, id);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(type, ts);
CREATE INDEX IF NOT EXISTS idx_events_vendor  ON events(vendor, ts);

-- Derived, rebuildable session index (NOT source of truth; the log is).
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  vendor      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  outcome     TEXT,
  repo        TEXT,
  agent       TEXT,
  model       TEXT
) STRICT;
```

- `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;` on open.
- `sessions` is a materialized convenience index maintained transactionally by the store on `session_start`/`session_end` appends. It is derived state: `rebuildSessions()` must reproduce it exactly from `events`, and a doubt about consistency is resolved by rebuilding, never by editing events.
- Append-only enforcement is layered: the TypeScript store exposes no update/delete for `events`, and SQLite triggers back it up:

```sql
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
```

## 6. Store API contract (implemented in `src/store/`)

- `openStore(path?)` — creates file + schema idempotently; safe to call on an existing store; refuses to open a store whose `meta.schema_version` has a *higher major* than the code supports.
- `append(event | event[])` — validates envelope, fills `observed_at`/`schema_version` if absent, transactional for arrays; duplicate `id` is a no-op (idempotent re-ingestion); returns count actually written.
- `getSessions(filter?)` / `getEvents(session_id)` — events return in `(ts, id)` order; unknown vendors are returned like any other (tolerance is a schema-level guarantee, not adapter luck).
- No `update*` / `delete*` exports for events. This absence is contractual.

## 7. Versioning & migration stance

- This document's header version == `meta.schema_version` written by the store.
- **Minor/patch**: additive (new event types, new optional payload fields). Old readers ignore unknown fields (payload keys are preserved opaquely); old events remain valid.
- **Reader rule (binding on every consumer):** unknown event *types* are skipped with a counted warning, never fatal; unknown payload *fields* are preserved and ignored. A v0.1.0 reader must survive a v0.2.0 log. (The store's CHECK constraint pins the *writer* to its own version's enum; readers must be one version more tolerant than writers.)
- **Major**: re-shape. Requires a written migration in `src/store/migrations/` and a migration note appended to this file. The events table is never mutated in place; a major migration writes a new log and preserves the old file.
- The schema is designed to stand alone as a potential open standard for agent telemetry; nothing in it references HyperAgent-internal concepts (missions, Workshop, capabilities) — those are consumers, not schema citizens.

## 8. Known gaps (v0.1.x roadmap, decided before DAN-199/200 build on them)

- **Redaction tombstone.** Append-only currently has no remedy for a secret/PII that reaches an event. Planned (minor bump): a `redaction_tombstone` event type that supersedes a prior event by `id`; readers must treat a tombstoned event's payload as `{}`. Until then, the digest-not-raw-text design (§4.2) keeps the exposure surface to `input_summary`/`claim_text`/`message_summary`, which adapters redact before append.
- **Multi-writer contention.** WAL is specified; the store should also set `PRAGMA busy_timeout` (e.g. 5000ms) before the daemon, CLI, and Cockpit share one file. Decide in DAN-199.
- **Digest algorithm pinning.** All digests in v0.1.0 are sha256; the algorithm is pinned per schema version (a change is a major bump), so undated digests remain interpretable. Adapters must not embed absolute local paths in digested canonical input.

## Changelog

- **v0.1.0** (2026-07-26, DAN-198) — initial spec: envelope, nine event types, six entities, SQLite physical schema, store contract.
