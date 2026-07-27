# Gates and Verification Contracts

> The enforcement organ (architecture-v2 §6.5, DAN-203). One policy, written once, compiled per harness at whatever fidelity that harness supports — with every outcome recorded as canonical evidence.

The suit already observes and remembers. Gates are how it *acts*: a forbidden action is blocked at the hook point where the harness allows it, a completion claim without the promised checks bounces back to the agent in-flight, and everything that could not be blocked in real time is still detected afterwards.

## The two doctrines (they are deliberately asymmetric)

**Fail open on infrastructure.** Bad stdin, a missing or malformed policy, an overrun deadline — any internal problem that prevents *reaching* a decision allows the action. A bug in HyperAgent must never brick your agent.

**But a computed decision is never inverted by bookkeeping.** Once a block rule has matched or a contract failure is established, recording the outcome (spool append, bounce counter) is telemetry — if it fails, the deny/block stands and a diagnostic goes to stderr. Fail-open applies only to errors upstream of the decision; otherwise a full disk or a tampered spool directory would silently disarm every enabled block rule.

**Fail closed on policy.** An actual match against an enabled `block` rule denies, even when that is inconvenient.

Everything below follows from those two sentences. When they conflict, infrastructure wins: a policy that fails to load degrades to a flag-only baseline, so a broken policy file can never start blocking things.

## Policy model

Vendor-neutral, versioned, and yours to edit: `~/.hyperagent/policy.json`.

```json
{
  "schema_version": "0.1.0",
  "rules": [
    {
      "id": "secrets-file-write.env",
      "description": "Write to an environment secrets file.",
      "action": "flag",
      "enabled": true,
      "match": { "pathPattern": "**/.env*", "pathAccess": "write" }
    }
  ]
}
```

| field | meaning |
|---|---|
| `action` | `block` (deny in real time where possible) or `flag` (record only) |
| `enabled` | whether the rule participates in real-time evaluation |
| `match.toolNamePattern` | regex, case-insensitive, against the canonical tool name |
| `match.commandPattern` | regex, case-insensitive, against the command string |
| `match.pathPattern` | glob (`*` does not cross `/`, `**` does, `?` is one char) |
| `match.pathAccess` | `read`, `write`, or `any` (default) — the read/write distinction |

### How path globs are matched

Harnesses report **absolute** paths; humans naturally write **repo-relative** globs. So every path glob — `match.pathPattern` in a policy rule and `protectedPaths` in a contract — is matched against **both** the absolute path and, when the file lives inside the repo, its repo-relative form.

```
touched:  /home/you/code/app/secrets/key.pem
repo:     /home/you/code/app

"secrets/**"           ✓ matches (repo-relative form)
"**/secrets/**"        ✓ matches (absolute form)
"/home/you/code/app/secrets/**"  ✓ matches (absolute form)
```

Without this, `"secrets/**"` would silently never fire — a rule that looks configured but is dead. Two consequences worth knowing:

- A path **outside** the repo is only compared against the absolute form, so a relative pattern cannot reach across into unrelated directories.
- When no repo context is available, only the absolute form is comparable. Every shipped default rule is written with a leading `**/` so it stays correct either way; prefer that style for rules meant to be portable.

Real-time evaluation and post-hoc detection use the same matcher, so they cannot disagree about whether a rule fired.

A rule needs at least one matcher. All matchers present must match for the rule to fire.

### Load states

| state | when | effect |
|---|---|---|
| `default` | no `policy.json` | the built-in default policy below |
| `loaded` | valid file | your policy |
| `invalid` | unreadable, bad JSON, unknown `schema_version`, malformed rule, uncompilable regex, duplicate rule id | **flag-only baseline** + a named error surfaced by `gate policy validate` and `hyperagentd status` |

A malformed policy never silently becomes "no policy", and it never gains blocking authority from bad input. Check it with `hyperagent gate policy validate`.

### The shipped default

Encodes v1's authority boundary as **flag** rules, plus gate-disarm detection:

- `secrets-file-write.*` — writes to `.env*`, `*.pem`, `id_rsa*`, `credentials*`, `*.key`
- `permission-config-edit.*` — writes to `.claude/settings.json`, `.claude/settings.local.json`, `.hyperagent/policy.json`, `.hyperagent/contract.json`
- `external-publish-command` — `git push`, `npm publish`, `gh pr|release create`, `docker push`
- `destructive-recursive-delete` — the one **block** rule, and it ships **disabled**

Tightening enforcement is your decision, not the suit's. HyperAgent will never silently broaden *or* narrow what it enforces; turning on a block rule is an edit you make.

### Gate-disarm detection, and why config files are not exempt

The self-gating exemption is deliberately **narrow**. Exempt from path rules: the spool, the per-session bounce counters, and `hyperagent.db`. Not exempt: `policy.json`, `contract.json`, and `.claude/settings*.json`.

Claude Code applies settings edits **live** via a file watcher — there is no session-start snapshot — so an agent genuinely can disarm the gate mid-session. We may not always be able to stop that, but we must always be able to *see* it. Hence flag rules plus post-hoc detection on exactly those paths.

## Verification contracts

Per repo, optional: `<repo>/.hyperagent/contract.json`. **An absent contract means Stop always passes.**

> **Upgrading from v1:** early v1 installs wrote `<repo>/.hyperagent` as a config *file*, which occupies the path this directory needs. `gate contract validate` reports `CONTRACT_PATH_TYPE_ERROR` in that case. Retire the v1 config file (or migrate it to `.hyperagent/config.toml`, the layout later v1 versions already use) to free the path.

```json
{
  "schema_version": "0.1.0",
  "requiredChecks": [
    { "id": "tests", "description": "the repo test suite must pass", "commandPattern": "bun\\s+test" }
  ],
  "protectedPaths": ["**/*.lock", "docs/architecture-v2.md"]
}
```

Evaluated at Stop, against **spooled session context only**:

- A `requiredCheck` passes when a matching command **ran and passed after the last file the session mutated**. An earlier green test run says nothing about the code as it now stands.
- A `protectedPath` fails when a **session-touched** file matches it, on either path basis (see [How path globs are matched](#how-path-globs-are-matched)) — `secrets/**` and `**/secrets/**` both work. Deliberately not `git diff HEAD`: your pre-existing uncommitted work is not the agent's doing and must never bounce it.
- **A session that mutated nothing satisfies every required check vacuously.** A read-only session has nothing to verify, and demanding tests from it would be a false bounce of the same class.

Bounce reasons name the failed check and nothing else. The pilot flies; the suit reports facts, never instructions on how to work.

### Bounce loop guard

A blocked Stop increments `~/.hyperagent/gate/sessions/<session>.bounce`. After `2` bounces the gate allows the stop through and records a `gate_gave_up` outcome. Claude Code's stdin `stop_hook_active` is honored as belt-and-braces, and the harness's own 8-consecutive-block cap sits well above our limit.

A counter file, not a spool scan: rotation would break counting.

## Per-harness compilation matrix

| Harness | PreToolUse block | Stop bounce | Post-hoc detection | Status |
|---|---|---|---|---|
| Claude Code | yes | yes | yes | **full** |
| Codex | no (approval config only) | no | yes | post-hoc only, DAN-205 |
| OpenClaw | likely achievable | likely achievable | yes | post-hoc only, DAN-207 |
| Amp | no | no | yes | post-hoc only |
| Cursor | no | no | yes | post-hoc only |

**Post-hoc detection is the universal floor.** It replays canonical events against the same policy, so every harness gets violation visibility even where blocking is impossible — no adapter required, because it reads the canonical schema rather than a vendor format.

Violations land in `policy_violations`: a **derived, rebuildable** table keyed by `detector_version`, exactly like `session_scores`. They are re-derivable interpretation, not observed fact, so they are not events. Improving detection is a version bump plus a rebuild — never a mutation of the append-only log.

## Runtime architecture

```
harness hook → hyperagent gate eval → decision on stdout
                       │
                       └→ ~/.hyperagent/gate/outcomes.jsonl  (O_APPEND, one line)
                                        │
                          daemon → verification_event (kind=gate, initiated_by=suit)
                                 → post-hoc detection on session close
```

The hook path is deliberately austere: deterministic in-process evaluation, a hard 2s self-timeout, **no model call, no network, no daemon dependency, and no SQLite**. Hooks are short-lived and run alongside a daemon holding the database writer; opening the db from a hook would contend with it.

So outcomes go to an append-only JSONL spool. **Rotation is daemon-only** — a rename racing a hook's append would lose lines — and an unconsumed rotated generation is never clobbered.

Ingestion converts each outcome into a canonical `verification_event` with deterministic ids, so re-ingestion dedupes. Outcomes for sessions the observer has not caught up with yet are **parked in the spool and retried**, never dropped.

### Installation is always an explicit human act

The daemon has **no code path** to install or uninstall hooks, and a test asserts it. Installing hooks into a repo is a persistent behavior change, which architecture rule 7 reserves for human review.

Install writes to `<repo>/.claude/settings.local.json` — personal and auto-gitignored — because the committed `settings.json` would push your gate wiring onto collaborators.

**Managed ownership rides the command string.** An entry is HyperAgent's if and only if it is `type: "command"` and its command contains the marker `hyperagent gate eval`, which sits in a trailing shell comment (inert at execution). Extra JSON keys on hook entries are undocumented in Claude Code, so relying on them would be a guess. Install and uninstall touch only owned entries; every other key, matcher group and entry in your file is preserved. Invalid JSON is refused and surfaced, never guessed at or overwritten.

## CLI

```bash
hyperagent gate install   [--repo P] [--harness H] [--data-dir D]
hyperagent gate uninstall [--repo P] [--harness H] [--data-dir D]
hyperagent gate status    [--repo P] [--harness H] [--data-dir D]

hyperagent gate policy   show|validate [--data-dir D]
hyperagent gate contract show|validate [--repo P]

hyperagent gate test --hook <PreToolUse|PostToolUse|Stop> [--stdin-file F]
hyperagent violations [--session S] [--days N]
```

`gate status` is truthful about five states: `installed`, `stale` (the recorded CLI path no longer resolves), `not-installed`, `foreign` (the settings file is not valid JSON), and `refused` (the target is permanently ineligible — no `.git`, or under `~/.claude` or `~/.hyperagent`). It never reports a false `installed`, and it never reports `not-installed` for a target that could never accept an install: `refused` is checked first, using the same validation `install` enforces.

`gate test` dry-runs an evaluation against a fixture stdin and prints what would have happened. `gate eval` is the hook runtime itself — it always exits 0, prints only decision JSON on stdout, and sends diagnostics to stderr.

## Deferred

- **DAN-204** — Workshop-proposed policy and contract edits (still human-reviewed).
- **DAN-205 / DAN-207** — Codex approval-config emission and OpenClaw hooks; both are post-hoc-only today.
- **DAN-209** — Cockpit surfacing of violations. DAN-203 ships the data and the CLI.
- **Eval latency** — each hook spawns a Bun process (tens of ms). Acceptable at v0; a compiled binary is the optimization if it ever bites.
- **Semantic diff-vs-claim matching** — v0 contracts are deterministic checks only. Matching a diff against what the agent *said* it did needs a model, and the hook path deliberately has none.
