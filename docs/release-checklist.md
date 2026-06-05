# HyperAgent Early Release Checklist

This checklist defines the bar for an early open-source HyperAgent release.

Release posture: `v0.1.0-alpha`, developer preview, Codex-first, markdown-first, local, inspectable, human-review-required.

## Release Claim

HyperAgent Mark I should be released only as an early alpha that proves the Mission -> Workshop -> Forge loop.

The release should claim:

- HyperAgent installs a Codex-compatible skill.
- HyperAgent gives Codex a Suit operating loop.
- HyperAgent writes local mission records.
- HyperAgent can create evidence-backed Workshop proposals.
- HyperAgent records human approval or rejection before persistent behavior changes.
- HyperAgent can run a local smoke eval for the loop.

The release should not claim:

- autonomous self-modification,
- hosted memory,
- a polished hosted UI,
- multi-platform support beyond Codex,
- automatic upgrades across every user project,
- production-grade safety automation.

## Alpha Readiness Bar

Before tagging an alpha release:

- [x] `main` is clean and up to date with `origin/main` before tagging.
- [x] `sh scripts/verify-mvp.sh` / `sh scripts/verify-core.sh` passes.
- [x] `sh scripts/verify-extensions.sh` passes when optional extension surfaces changed.
- [x] `sh scripts/verify-release.sh` passes before public release.
- [x] `sh evals/smoke-loop.sh` passes.
- [x] A clean clone can install the skill with `sh scripts/install-codex-skill.sh "$HOME/.codex/skills"`.
- [x] A clean clone can install the skill in development mode with `--symlink`.
- [x] A fresh Codex thread can invoke `codex-hyperagent` after install or app refresh.
- [x] The first-run flow in `docs/quickstart.md` works without hidden local assumptions.
- [x] At least one real mission record exists in `missions/`.
- [x] At least one Workshop proposal exists in `workshop/proposals/`.
- [x] At least one human approval or rejection exists in `workshop/decisions/`.
- [x] At least one Forge review exists in `forge/reviews/`.
- [x] The Forge quality rubric explains how Workshop output is evaluated.
- [x] The release notes explain that the Forge improves the improvement process, not the user's code directly.
- [x] The README states the current limits plainly.
- [x] The release notes state that persistent behavior changes require human review.

## Forge Readiness

The Forge is part of the alpha release, but only as a file-based process layer.

For `v0.1.0-alpha`, the Forge should be able to:

- review recent Workshop proposals,
- judge whether proposals are specific, evidence-backed, testable, safe, and worth installing,
- identify weak evals, vague upgrade ideas, missing safety notes, or repeated friction patterns,
- write Forge reviews in `forge/reviews/`,
- propose process improvements to the Workshop without silently activating them.

The Forge should not yet:

- autonomously change the Workshop process,
- approve its own process upgrades,
- install new persistent behavior without human review,
- act as a general-purpose project manager or hosted analytics layer.

Before release, verify:

- [x] `forge/process/quality-rubric.md` defines proposal quality metrics.
- [x] `templates/forge-review.md` includes proposal quality and process reliability fields.
- [x] At least one real Forge review exists in `forge/reviews/`.
- [x] `scripts/verify-core.sh` fails if the Forge rubric or review template is missing.
- [x] `docs/quickstart.md` shows how to run a Forge review prompt.
- [x] README and release notes describe the Forge as "improves the Workshop."

## Required Docs Before Release

- [x] `README.md` has a clear alpha positioning section.
- [x] `docs/quickstart.md` has a complete first-run walkthrough.
- [x] `docs/release-checklist.md` is present and current.
- [x] `CONTRIBUTING.md` explains how to propose Suit upgrades, add evals, and change templates.
- [x] `SECURITY.md` explains the authority boundary, no-secrets policy, and how to report security issues.
- [x] GitHub issue templates exist for bugs, Suit friction, upgrade proposals, and eval ideas.

## Update And Upgrade Model

HyperAgent is mostly text files, prompts, shell scripts, and local markdown artifacts, so updates use normal Git workflows.

For users who cloned the repo:

```bash
git pull
sh scripts/verify-mvp.sh
sh scripts/verify-extensions.sh
sh scripts/verify-release.sh
```

How the installed Codex skill receives updates depends on install mode:

- Copy install: `sh scripts/install-codex-skill.sh --force "$HOME/.codex/skills"` after `git pull`.
- Symlink install: `git pull` updates the installed skill automatically because `~/.codex/skills/codex-hyperagent` points back to the clone.

Recommended early-alpha guidance:

- Use copy install for normal users because it is explicit and less surprising.
- Use `--symlink` for contributors and active testers who want repo changes reflected immediately in Codex.
- Document that users may need to restart Codex Desktop or open a fresh thread after skill updates.

Completed for alpha:

- `scripts/update-codex-skill.sh` wraps reinstall after `git pull`.
- version metadata is recorded in `skills/codex-hyperagent/SKILL.md`.

Future release work may add:

- release tags and changelog entries that tell users when reinstall is needed.

## Clean-Clone Test

Run this outside the development checkout before tagging:

```bash
tmpdir=$(mktemp -d)
git clone https://github.com/DannyMac180/HyperAgent.git "$tmpdir/HyperAgent"
cd "$tmpdir/HyperAgent"
sh scripts/verify-mvp.sh
sh scripts/verify-extensions.sh
sh scripts/verify-release.sh
sh evals/smoke-loop.sh
tmpskills=$(mktemp -d)
sh scripts/install-codex-skill.sh "$tmpskills"
test -f "$tmpskills/codex-hyperagent/SKILL.md"
```

## Suggested Release Sequence

1. Finish the required docs. Done.
2. Run the clean-clone test. Done before tagging.
3. Update README with alpha status and release notes link. Done.
4. Create a GitHub release tag:

   ```bash
   git tag v0.1.0-alpha
   git push origin v0.1.0-alpha
   ```

5. Draft GitHub release notes with install, update, verification, limitations, and safety boundary sections.

## Release Notes Outline

Use this outline for the first GitHub release:

- What HyperAgent is.
- What works in `v0.1.0-alpha`.
- Install instructions.
- Update instructions.
- First-run walkthrough.
- Verification commands.
- Forge review flow.
- Current limitations.
- Safety and human-review policy.
- How to contribute.
