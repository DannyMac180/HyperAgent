# Packet 02: Product Surface

Objective: Review user-facing complexity: commands, docs, UI, install/update flow, and public-facing story.

Sources:
- `README.md`
- `docs/quickstart.md`
- `docs/clean-install-uat.md`
- `docs/releases/v0.1.0-alpha.md`
- `scripts/hyperagent.sh`
- `scripts/hyperagent-ui.mjs`
- `ui/`

Findings:
- Public command surface is wide: `init`, `status`, `sense`, `doctor`, `ui`, `record-check`, `new-mission`, `propose-upgrade`, `workshop-prompt`, `new-forge-review`, `forge-prompt`, and `decide-upgrade`.
- The UI is useful as an evidence cockpit but adds a second product surface with a Node server, API parsing, frontend code, and its own smoke test.
- README, quickstart, UAT, release notes, and concepts duplicate the same install, loop, and safety story.
- Release notes still say no polished UI while README describes a UI, creating state drift.
- The first-run prompt is long and agent-dependent; this is practical for Codex but complex as a public product surface.

Simplification candidates:
- Collapse public commands into a smaller facade.
- Treat UI as optional experimental cockpit over markdown, not required MVP.
- Consolidate onboarding docs around one canonical quickstart and one release note.
- Add a small setup command only after reducing prompt complexity, not as another parallel flow.
