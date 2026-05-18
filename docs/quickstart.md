# HyperAgent Quickstart

This guide proves the Mark I loop locally: install the Codex skill, run a mission, write telemetry, propose an upgrade, and record an explicit human decision.

## 1. Install The Codex Skill

```bash
sh scripts/install-codex-skill.sh "$HOME/.codex/skills"
```

For local development:

```bash
sh scripts/install-codex-skill.sh --symlink "$HOME/.codex/skills"
```

The default mode is `human review required`.

## 2. Check Local Status

```bash
sh scripts/hyperagent.sh status
```

You should see counts for missions, Workshop proposals, Workshop decisions, Forge reviews, and the capability registry path.

## 3. Run A Mission In Codex

Ask Codex:

```text
Use the codex-hyperagent skill. Run a small HyperAgent mission in this repo, verify the result, write a mission record, and propose an upgrade only if there is concrete friction.
```

The mission record belongs in `missions/`.

You can also create a mission record shell:

```bash
sh scripts/hyperagent.sh new-mission --request "Run a small HyperAgent mission" --slug small-hyperagent-mission
```

## 4. Run Workshop Review

Ask Codex:

```bash
sh scripts/hyperagent.sh workshop-prompt
```

Then have Codex follow the printed prompt. Proposals belong in `workshop/proposals/`.

To create a proposal shell:

```bash
sh scripts/hyperagent.sh propose-upgrade \
  --mission missions/2026-05-01-2108-mark-i-build.md \
  --title "Improve first-run verification" \
  --problem "The install step needs a concrete smoke test"
```

## 5. Record Human Approval Or Rejection

Persistent behavior changes are not activated silently.

```bash
sh scripts/hyperagent.sh decide-upgrade \
  --proposal workshop/proposals/2026-05-01-2108-codex-skill-installer.md \
  --decision accepted \
  --reviewer "Human reviewer" \
  --reason "The installer reduces first-run ambiguity and has a local smoke test" \
  --capability codex-skill-installer
```

Accepted decisions are recorded in `workshop/decisions/` and appended to `hyperagent/capability-registry.md`.

## 6. Run Forge Review

Ask Codex:

```bash
sh scripts/hyperagent.sh forge-prompt
```

Forge reviews belong in `forge/reviews/`. The Forge should improve the Workshop process, not silently activate new capabilities.

## 7. Verify

```bash
sh scripts/verify-mvp.sh
sh evals/smoke-loop.sh
```

