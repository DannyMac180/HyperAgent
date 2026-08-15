# HyperAgent Canonical Event Schema — v0.1.0

> The vendor-neutral session/event model every adapter translates into, and the contract every downstream component (memory, scoring, Workshop, Forge, Cockpit) consumes. This is the precise spec promised by `docs/architecture-v2.md` §6.1. Where this document and prose elsewhere disagree, this document wins for schema questions.

## 1. Design rules

1. **Append-only.** Observed history is immutable. The store exposes `append` and read operations only — no update or delete of events, ever. Corrections are new events, not edits.
2. **Everything is an event.** There is one physical log. Higher-level entities (sessions, turns) are *event-delimited spans*, not mutable rows: a session is the span between its `session_start` and `session_end` events. This is what makes append-only workable — "the session ended" is a fact that arrives later, not an update to an old row.
3. **Vendor-blind downstream, vendor-tagged at the edge.** Every event carries `vendor` + `adapter_version`, and a `raw_ref` pointing back into the vendor's own artifact (session id + in-artifact locator, never a filesystem path — §4.1) so memories and scores can cite ground-truth evidence. Nothing downstream may branch on `vendor` except for display.
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
| `raw_ref` | text, nullable | evidence pointer: `<session-id>#<locator>` into the vendor artifact (e.g. `claude-code:9f3e…#L42`). **Never a filesystem path** — see §4.1 |
| `payload` | JSON | type-specific fields (§4); unknown keys are preserved, never dropped |

## 3. Event types (closed enum, v0.1.0)

`session_start`, `session_end`, `turn_start`, `turn_end`, `tool_call`, `error`, `retry`, `completion_claim`, `verification_event`

The enum is closed per schema version; adding a type is a minor bump. Adapters encountering vendor happenings with no canonical type MUST NOT invent types — map to the closest type or drop with a counted warning (adapter breakage is a normal, visible event).

## 4. Entities and payloads

### 4.1 `session` (span: `session_start` → `session_end`)

`session_id` construction: `<vendor>:<native-session-id>` when the harness has one. When it does not, the id must still be derived from **artifact content** — e.g. `<vendor>:<sha256(first-record-digest + start_ts)[0..16]>` — never from the file's location. Deterministic either way, so re-ingesting the same transcript yields the same id (idempotent ingestion dedupes on it, §6). Both shipped adapters take the native-id branch; the fallback is specified but unexercised.

**Identity is content-derived, never location-derived — binding on every adapter.** An event id is `deterministicEventId({ts, sessionId, rawRef, type, discriminator})`, and `raw_ref` is built from the *session id* plus an in-artifact locator (`<session-id>#L<n>`), not from the file that happens to hold it. Moving a transcript directory therefore changes no id and produces no duplicates. This rule is not a preference: the earlier path-bearing design was falsified on the live store, where a directory move re-ingested 73 events as 146. An adapter that puts an absolute path into `raw_ref` re-introduces that defect and corrupts the record silently.

`session_start` payload: `agent` (harness product name), `model` (as reported), `harness_version`, `repo` (git root path — see the attribution note below; omitted when no repo is honestly derivable, never the raw cwd), `git_branch`, `cwd`, `parent_session_id` (nullable — session lineage: set when the harness resumes, forks, or compacts a prior session into this one, e.g. Claude Code `--resume`. Downstream consumers treat a lineage chain as one logical body of work; the Claude Code adapter must populate it rather than inventing its own linkage).
`session_end` payload: `outcome` (`completed` | `abandoned` | `crashed` | `unknown`), `duration_ms`, `turn_count`, `tool_call_count`, `repo` (optional — the adapter's full-session attribution, see below; when present it supersedes the `session_start` value in the sessions index, because a live session's start may have been emitted from a thin first incremental chunk). A session with no observed `session_end` is *open*; the daemon may close it with `outcome: unknown` after a timeout — as a new event, never an edit.

**Repo attribution (`repo`) is derived evidence, not the launch directory.** A session launched from the home directory whose real subject is `~/dev/tool` must not wear `~` as a repo identity. Adapters derive `repo` from the session's whole artifact: working directories occupied (including mid-session moves), and file-tool touch paths resolved against the cwd in force at touch time, with mutations weighted above reads. The winning git root must hold a strict majority of the weighted evidence; otherwise the fallback is the git root of the session's own cwd; otherwise `repo` is omitted — "no repo" is a truthful, first-class state that downstream surfaces render deliberately. Git-root resolution touches the live filesystem, so adapter constructors accept an injected resolver and conformance runs a stub: fixture parses stay byte-deterministic on any machine. (2026-08-15, DAN-225.)

**`session_end` is advisory, not terminal.** Harness sessions resume (Claude Code `--resume`, wake-after-sleep) and a quiescence-closed session may append further events afterward. Consumers (memory extraction, scoring) MUST be idempotent per session and MUST NOT treat `session_end` as a promise that no more events arrive; re-derive on new activity after a close.

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

## 8. Known gaps (v0.1.x roadmap, decided before the daemon and first adapter built on them)

- **Redaction tombstone.** Append-only currently has no remedy for a secret/PII that reaches an event. Planned (minor bump): a `redaction_tombstone` event type that supersedes a prior event by `id`; readers must treat a tombstoned event's payload as `{}`. Until then, the digest-not-raw-text design (§4.2) keeps the exposure surface to `input_summary`/`claim_text`/`message_summary`, which adapters redact before append.
- **Multi-writer contention.** WAL is specified; the store should also set `PRAGMA busy_timeout` (e.g. 5000ms) before the daemon, CLI, and Cockpit share one file. Decide before multi-process access becomes routine.
- **Consumer cursor.** Downstream tailing ("events since my last position") uses SQLite `rowid`: monotonic here *because* deletes are impossible (append-only triggers) — that guarantee is load-bearing, revisit if the triggers ever change. Event `ts` is NOT a cursor: events arrive out of ingest order across sessions.
- **Derived-event re-derivation — DECIDED 2026-07-27: forward-only extraction + rebuildable derivation.** `completion_claim`/`verification_event` are heuristic extractions whose extractor version rides `adapter_version`. The resolution has four parts, binding on every consumer:
  1. **Appended heuristic events are immutable.** No supersede event type, no extractor-versioned id scheme. An improved heuristic never rewrites history; the append-only guarantee is not weakened for the convenience of scoring.
  2. **All scoring intelligence lives in the derived, rebuildable `session_scores` table**, keyed by `scorer_version`. Improving a scoring heuristic is a `scorer_version` bump plus a rebuild — never an event mutation. The reader rule below is part of the scoring function, so changing *it* also bumps `scorer_version`.
  3. **Reader rule (dedupe):** among heuristic events sharing the same non-null `raw_ref`, a consumer keeps only those carrying the highest `adapter_version` present for that `raw_ref`, and discards the rest. This is required because ids are content-derived: when a resumed session's transcript is re-walked after an adapter upgrade, the old and new extractor's output legitimately coexist in the log for the same underlying transcript record. Deduping at read time makes double-counting impossible without touching the log.
  4. **Adapter-extraction improvements apply forward-only.** Historical re-extraction is an explicit non-goal: old sessions keep the events the extractor of their day produced, and scoring is honest about the extractor version that observed them.

  Note on identity: ids are content-derived and location-independent (§4.1), so a resumed transcript re-walked from a different directory still dedupes correctly. An earlier revision of this section asserted the opposite — that ids derive from path+line, and that this was acceptable because transcripts do not move in practice. That was wrong, and it was wrong in the direction that corrupts data. See the 2026-07-28 changelog entry.
- **The record indexes artifacts someone else owns.** §4.2's digests-not-raw-text design keeps the store small and the privacy surface minimal, but it means evidence resolution depends on vendor transcripts that the vendor writes, rotates, and may delete or change format on. Events and measurements survive; the ability to open the underlying text does not. **Current disposition: raw retention is deliberately out of scope for v0.1.x**, because copying every transcript would invert the privacy property that makes local-first observation defensible — HyperAgent would become a second, unmanaged copy of everything an agent ever read. The honest consequence is that `raw_ref` is a best-effort pointer, not a guarantee, and consumers must degrade gracefully when it no longer resolves. An opt-in archival mode (pilot-enabled, scoped, with its own retention setting) is the expected answer if durability turns out to matter more than surface area; it is not built.
- **Digest algorithm pinning.** All digests in v0.1.0 are sha256; the algorithm is pinned per schema version (a change is a major bump), so undated digests remain interpretable. Adapters must not embed absolute local paths in digested canonical input.

## Changelog

- **2026-08-15** — **§4.1 repo attribution enforced and extended (additive payload field).** `session_start.repo` was specified as a git root but both adapters recorded the raw cwd; adapters now derive it from whole-session evidence (weighted cwd + file-touch git roots, strict majority, honest omission). `session_end` gains an optional `repo` carrying the full-session attribution, applied non-null-wins in the sessions index so incrementally-ingested live sessions settle on the honest value at close. Historical rows re-attribute via a store rebuild.
- **v0.1.0** (2026-07-26) — initial spec: envelope, nine event types, six entities, SQLite physical schema, store contract.
- **2026-08-03** — §8 gains the vendor-owned-artifact durability gap with its disposition (raw retention deliberately out of scope; `raw_ref` is best-effort). No schema shape change.
- **2026-07-28** — **§4.1 identity rule corrected (no schema shape change).** Event ids and `raw_ref` are content-derived, never path-derived. The prior spec asserted path-bearing ids and judged the relocation hazard acceptable; that was falsified on the live store (a directory move re-ingested 73 events as 146). Five emitting sites were fixed and the live store rebuilt — 41,128 events, 41,128 distinct ids, zero absolute paths in `raw_ref`. §1's rule 3, §2's envelope row, and §8's closing note carried the same error and are corrected with it. §4.1's no-native-id fallback still specified a path-derived session id — unexercised by both shipped adapters, but it would have re-introduced the defect in the next adapter, so it is now content-derived too.
- **2026-07-27** — §8 derived-event re-derivation gap resolved (no schema shape change): forward-only extraction + rebuildable derivation. Heuristic events stay immutable; scoring intelligence moves to the derived `session_scores` table keyed by `scorer_version`; consumers dedupe same-`raw_ref` heuristic events to the highest `adapter_version`; historical re-extraction is a non-goal.
