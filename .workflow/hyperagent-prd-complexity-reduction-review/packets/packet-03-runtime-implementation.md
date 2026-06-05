# Packet 03: Runtime Implementation

Objective: Review implementation complexity in scripts, config, artifact generation, and parsing.

Sources:
- `scripts/hyperagent.sh`
- `.hyperagent`
- `templates/`
- `scripts/hyperagent-ui.mjs`
- `ui/app.js`
- `ui/styles.css`

Findings:
- `scripts/hyperagent.sh` is 1,461 lines and contains init, status, sensing, doctor, UI launch, artifact creation, proposal creation, Forge review creation, decision recording, redaction, JSON generation, git inspection, and embedded template text.
- `.hyperagent` names many paths and verification commands, but the shell helper mostly hard-codes paths rather than treating the config as the source of truth.
- Templates exist as files, but the helper also embeds mission/proposal/review/decision markdown through heredocs, creating duplication.
- `git_changed_files` appears twice in the shell script.
- `init` copies the local helper, UI server, and frontend into target projects, which increases drift risk across initialized repositories.
- The UI server parses markdown with simple field matching and proposal status heuristics, which adds another place that must understand artifact formats.

Simplification candidates:
- Either make `.hyperagent` a real config contract or shrink it to a simple marker.
- Use templates as the only artifact source, with placeholder substitution.
- Reduce `init` to project-local memory plus instructions; keep global runtime global.
- Split optional/advanced capabilities out of the core helper or hide them behind advanced subcommands.
- Remove duplicated shell functions and generated docs embedded in runtime code.
