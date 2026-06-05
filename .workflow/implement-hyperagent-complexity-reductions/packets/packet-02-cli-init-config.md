# Packet 02: CLI, Init, And Config

Objective:
Collapse the public CLI surface and reduce project init copying without breaking legacy evals.

Files:
- `scripts/hyperagent.sh`
- `.hyperagent`
- `docs/quickstart.md`
- `evals/init-smoke.sh`

Expected output:
- Public commands: `init`, `status`, `sense`, `mission`, `review`, `verify`, `check`, `ui`.
- Legacy aliases remain for old commands.
- `doctor` becomes `sense --doctor` with a compatibility alias.
- `record-check` becomes a compatibility alias around `check --record`.
- `init` creates local memory/setup and no longer copies UI assets or the full helper by default.
- `.hyperagent` distinguishes core, extension, and release verification.
