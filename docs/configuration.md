# Configuration observation

`hyperagent configuration` records a bounded, redacted inventory of selected
Claude Code and Codex configuration. It is an observation tool: it does not
call a model, alter a harness, install anything, or start automatically. No
other daemon command scans configuration.

Run a scan explicitly:

```sh
bun src/daemon/cli.ts configuration scan --home /selected/home --repo /selected/repo --data-dir /selected/data
```

`--repo` is optional. With no `--home`, the command selects the current user's
home directory. Repository roots are never discovered automatically. The
command writes one append-only snapshot to `configuration.db` under `--data-dir`
(default `~/.hyperagent`) and prints JSON only.

Read the saved report without scanning:

```sh
bun src/daemon/cli.ts configuration report --data-dir /selected/data
```

Report opens an existing history database read-only. If none exists, it returns
an empty JSON report and creates no directory or database.

## JSON contract

`configuration scan` returns:

```ts
{
  schemaVersion: "1.0.0";
  snapshot: {
    id: number;
    observedAt: string;
    scopes: Array<{ id: string; kind: "home" | "repo"; root: string }>;
    entries: ConfigurationEntry[];
  };
  changes: {
    added: ConfigurationEntry[];
    removed: ConfigurationEntry[];
    changed: ConfigurationEntry[];
  };
}
```

`configuration report` returns:

```ts
{
  schemaVersion: "1.0.0";
  latestSnapshot: ConfigurationSnapshot | null;
  history: Array<{ snapshot: ConfigurationSnapshot; changes: ConfigurationChanges }>;
  latestByScope: Array<{
    scope: ConfigurationScope;
    snapshotId: number;
    observedAt: string;
    entries: ConfigurationEntry[];
    changes: ConfigurationChanges;
  }>;
}
```

`history` and `latestByScope` are each bounded to twenty records, newest first.
Every scan has its own history row. A scan compares each selected scope only
with the earlier scan of that same scope, so scanning home alone cannot make an
unscanned repository look removed. `scopes[].root` is the user-selected path,
stored only to distinguish explicitly selected roots; it is not read from a
configuration file.

An entry contains the stable key, selected `scopeId`, product (`claude-code` or
`codex`), known source and category, optional projected name, state,
allowlisted structural metadata, and a `redactedHash`. The hash is SHA-256 of
that redacted representation, never of a configuration file or discarded
identifier.

## Observed layout

The scanner reads only named, direct locations below selected roots:

- Claude Code global `.claude.json` MCP/hook shape, settings
  (`.claude/settings.json`, `.claude/settings.local.json`), repository
  `.mcp.json`, `CLAUDE.md`, and direct `.claude/agents` and `.claude/skills`
  children.
- Codex `.codex/config.toml` including declared `[agents.<name>]` records,
  `AGENTS.md`, direct `.codex/agents/*.toml`, current `.agents/skills` and
  legacy `.codex/skills` children. It never follows an agent `config_file`.

This is a deliberately narrow subset. It does not observe Claude Code plugins,
rules, commands, or any other `.claude.json` field beyond the safe MCP/hook
shape. It does not recursively walk agent or skill directories.

For JSON settings, global `.claude.json`, and a repository `.mcp.json`, it retains only counts and
validated MCP-server and hook-event names, and creates a named safe entry for
each validated MCP registration. Codex TOML is parsed with Bun's TOML parser;
only top-level object-valued `mcp_servers` keys and structural hook metadata reach the
record. Instructions are represented only by presence and a coarse size bucket;
their bodies are not read. Agent and skill folders are represented by validated direct child names
and bounded counts. A name is retained only if it is at most 80 ASCII letters,
digits, dots, underscores, or hyphens, begins with a letter or digit, and
passes identifier projection.

The scanner checks every component below each selected root and rejects final
or intermediate symlinks present when it checks them. These are best-effort
filesystem checks, not a guarantee against an adversary replacing a path
concurrently. It reads at most 256 KiB from a known
configuration file, examines at most 256 direct collection children, bounds
names and count output, and never follows paths named inside a configuration
file. It reports `absent`, `unavailable`, or `malformed` instead of persisting
parser or operating-system messages. Configuration values and bodies are always
discarded: hook commands, instruction and prompt bodies, URLs, environment
values, tokens, credentials, and arbitrary configuration values are never
retained or emitted.

Identifiers are projected before they enter an entry, metadata, key, or hash.
The projection rejects known token forms, AWS access keys, and obvious
high-entropy strings, recording only bounded redacted-name counts. Accepted
selected roots and accepted identifiers are stored verbatim so scopes and safe
names remain inspectable; they can still be sensitive in a particular local
environment, and a UI must disclose that before display or export.

## Change semantics and limits

Changes are factual statements about safe entries only. A newly present named
entry is `added`; an explicitly absent named file or a missing member of a
successfully complete collection is `removed`; and a changed redacted
representation is `changed`. An unreadable, malformed, oversized, symlinked,
or truncated source does not cause a prior entry to be called removed.

This deliberately cannot say whether a configuration is useful, active,
harmful, stale, or unused. It also cannot report changes that affect only a
discarded value such as an instruction body, command, URL, or credential.
