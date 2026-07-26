# PRD-Faithfulness Complexity Review — 2026-06-11

## 1. Context

This review measures the HyperAgent repo against its own PRD (`docs/hyperagent-prd.md`)
and asks one question per finding: *does this complexity earn its place in the MVP loop,
or can it be removed/merged/reworded without loss of faithfulness?*

The loop being protected is **Mission → Workshop → Forge**:

> The agent does the mission. The Workshop upgrades the suit. The Forge upgrades the Workshop. (PRD L64)

and the harness principles behind it: *"Models provide intelligence. HyperAgent provides
agency"* (C1, L9), *"A scaffold decays as models improve. A suit evolves as agents act"*
(C2, L49), file-based and inspectable memory (C11/C19), human-review-by-default (C12,
L293-294), and *"Do not build a complex new UI before the underlying loop works in
markdown"* (C9, L233).

### How to read this report

Findings were produced over five phases. **Phase 4 adversarial verification pruned roughly
twelve Phase-3 findings** as factually wrong or out of scope. The two most important catches:

- **Fe2 — the alleged C9 "co-ship" violation was FALSE.** Phase 3 claimed the UI shipped
  alongside (or before) the loop. `git log --reverse` shows every `ui/` file first appeared
  in commit `7220da8` (2026-06-05) — 18 days *after* the loop helper landed (`4484cac`,
  2026-05-18) and 35 days after `missions/` was seeded (`998af89`, 2026-05-01). The Phase-3
  grep had matched the substring "ui" inside `docs/quickstart.md`. C9's "loop works first"
  precondition was satisfied; the finding was dropped.
- **Ff6 — the proposal to delete `docs/iron-man-suit-essence.md` was rejected.** That file
  is `require_file`'d in `verify-release.sh:33` *and* named in PRD L400/L477 as required
  bootstrapping reading. Deleting it would break both the release gate and the PRD contract.

The surviving findings below are authoritative — Phase 4 verdicts are not re-litigated here.
Each is tagged **NEW** or **KNOWN-UNFIXED** against the prior-work baseline (43 findings
A1-A43, 13 claimed fixes B1-B13). Confirmed this cycle: B2/B3/B4/B6/B9 landed; B1/B5/B8/B10/B12
partial; **B7 not landed** (init still uses heredocs; `templates/project-*` are dead shadows);
**B11 not landed** (UI proposalStatus still string-heuristic).

Items examined and consciously **kept** (mentioned once, no action): compat command aliases
Fa5 (load-bearing — `verify-core` executes `verify-config`/`status`/`verify-safety`);
`update-codex-skill.sh` Fa6 (deliberately added, documented across 10+ refs, verify-pinned);
`adapters/contract.md` "Future Adapter Issue Checklist" Fb5 (PRD L467-474 directs future
platform work to start here; inert, zero cost); `forge/process/quality-rubric.md` Fg4
(correct C4 layer separation vs `workshop/rubric.md`); `docs/examples/missions/` Fg6
(verify-pinned redaction fixture); `docs/ui-architecture.md` Ff7 (governed PR#24/DAN-187
guardrail content; merging yields ~0 simplification and orphans 4 live links).

Ranking within each section is by **faithfulness impact × ease of removal**, highest first.

---

## 2. DELETE — remove with no MVP loss

### 2.1 Duplicate function defs + a latent correctness bug in `scripts/hyperagent.sh` — **Fa2** (NEW) — diff **S**

**Complexity observed.** Three duplications, one of which is a latent bug:

- `git_changed_files()` defined twice: `scripts/hyperagent.sh:1264` (dead) and `:1408` (wins).
  Keep `:1408`.
- `proposal_has_decision()` defined twice: `:2608` (dead, boolean-only) and `:2939` (wins,
  path-printing). Keep `:2939` — call site `:3001` depends on the path-printing body.
- **Latent bug:** the `mission)` case arm is duplicated. `:3373` is an inline handler that
  **wins**; `:3484` (`mission) mission_command "$@"`) is unreachable, and its target
  `mission_command()` (`:2266`) is an **incomplete refactor** — confirmed to handle only
  `redact-check` and `help|-h|--help`, with `new`, `closeout`, and `verify` missing entirely.
  If the arms were ever reordered so `:3484` won, `mission new/closeout/verify` would break.
  `verify-core.sh:122` passes today only because the inline `:3373` arm wins.

All three trace to commit `7220da8` "Simplify HyperAgent core" — not a merge artifact.

**PRD evidence.** C2 (no brittle scaffolds, L49) and C19 (file-based, inspectable, L424-426):
a script with a shadowed, broken second definition of its primary command path is exactly the
silent decay the suit is supposed to resist.

**Proposed simplification.** Delete the dead `git_changed_files()` (`:1264`), the dead
`proposal_has_decision()` (`:2608`), the unreachable `mission)` arm (`:3484`), and the dead,
incomplete `mission_command()` (`:2266`). Script remains `sh -n` clean (verified clean now).

**Diff size.** S. **Risk / what's lost.** None — all four targets are unreachable today. The
value is eliminating a latent break in the core `mission` command path. *Highest impact×ease
item in this section: a correctness bug fixed by deletion.*

### 2.2 Dead `templates/project-*` shadow templates (5 files, ~165 lines) — **Fc2** (NEW) — diff **S**

**Complexity observed.** `templates/project-{agents-block.md, backlog.md,
capability-registry.md, config.toml, readme.md}` have **zero consumers** (grep-verified
repo-wide; the only hit is a `.claude/settings.local.json` permission entry). They are not in
init's copy list, not `require_file`'d, have no decision record, were introduced in `7220da8`,
and have already **diverged/stale** vs the live heredocs (e.g. `project-agents-block.md` has
an obsolete "lighter cadence" line and bare `hyperagent status`; `project-config.toml` uses
`install_mode="copy"` and an old `[paths]` shape).

**PRD evidence.** C14 (exactly three templates, L367-369 — these are not among them); C13
(required repo contents, L359-370 — not listed); C10 (no brittle task-specific scaffolds as
core product, L234).

**Proposed simplification.** Delete the 5 files. No doc edits needed (`dogfooding.md:30`
"optional UI" line is generic prose, not a reference). These were the un-landed B7 wiring
targets; because the init heredocs are static text with zero interpolation (see Fa1 below),
completing B7 — converting heredocs to file-reads — would *add* runtime dependencies for no
gain, so it is explicitly closed as **won't-fix-by-design**.

**Diff size.** S (delete-only). **Risk / what's lost.** None.

> **Closing Fa1 (downgraded):** the Phase-3 "3,533-line monolith, rewrite to read templates"
> action is dropped. The `generate_init_*` heredocs are pure static text (`cat <<'EOF'`, no
> interpolation), and init *does* rely on `templates/` at runtime for the four real templates
> (`init_install_file` copies mission-record/upgrade-proposal/upgrade-decision/forge-review).
> No standalone CLI action; residual folds into Fc2.

### 2.3 `verify-core.sh` requires release-packaging artifacts — **Fa4** (KNOWN-UNFIXED) — diff **S**

**Complexity observed.** `verify-core.sh:27-34` requires `.github/pull_request_template.md`,
four `.github/ISSUE_TEMPLATE/*.md`, plus (further down) `CONTRIBUTING.md`, `SECURITY.md`,
`clean-install-uat.md`, and release notes — all **release-packaging artifacts**, none in the
C13 loop-contents list, and **already checked by `verify-release.sh`**.

**PRD evidence.** C5 (MVP first-implementation deliverables, L394-430); C13 (required
repo contents, L359-370). These artifacts are release process, not loop substance.

**Proposed simplification.** Remove the `.github`/packaging `require_file`/`require_text`
lines from `verify-core.sh`, leaving them in `verify-release.sh` where they belong. This also
resolves the duplication in Fa3 (§3.1) **in the correct direction**.

**Diff size.** S. **Risk / what's lost.** None at alpha (alpha gates on `verify-mvp`/`verify-core`
for loop substance; release artifacts are still gated by `verify-release`). *Lead item of this
sub-group because it both deletes noise and unblocks the §3.1 dedup.*

### 2.4 `.workflow/` — 24 tracked files of orchestration exhaust with private-path leaks — **Fg3** (NEW) — diff **M**

**Complexity observed.** `git ls-files .workflow/` confirms **24 tracked files** of internal
multi-agent orchestration exhaust from two completed review runs, with real private-path
leaks: `state.json:42` contains
`python3 /Users/danielmcateer/.codex/skills/codex-dynamic-workflows/scripts/verify_workflow.py`;
both `plan.md` files contain `- Repo: /Users/danielmcateer/Desktop/dev/HyperAgent`. Nothing
reads `.workflow/` programmatically; it depends on a private workflow engine external
contributors cannot reproduce.

**PRD evidence.** C13 (not in required contents); C19 (file-based *inspectable* memory — this
is the opposite: opaque private-tooling exhaust in a public repo).

**Proposed simplification.** Archive the two `final-report.md` files to `docs/` (they preserve
the provenance of the complexity-reduction reasoning), `git rm` the other 22, and add
`.workflow/` to `.gitignore`. Committed in a single unmerged branch commit (`7220da8`), so a
history scrub is cheap **now**, before the branch merges.

**Diff size.** M (mostly deletions + one gitignore line). **Risk / what's lost.** Loss of
internal run scaffolding that no consumer depends on; provenance is preserved via the two
archived reports.

---

## 3. COLLAPSE — merge / dedup

### 3.1 `verify-core.sh` / `verify-release.sh` duplicate assertions — **Fa3** (NEW) — diff **S**

**Complexity observed.** `verify-core.sh` (196 L) and `verify-release.sh` (57 L) share **12
`require_file` + 4 `require_text` assertions verbatim**. Because `verify all` runs both, the
shared assertions fire twice — a maintenance trap: rename a path and you must edit two files,
or one tier silently rots.

**PRD evidence.** C5 (verification deliverables, L394-430): one assertion should live in one
place.

**Proposed simplification.** Resolve in the direction set by §2.3 (Fa4): the release-packaging
artifacts move out of core and live only in `verify-release`. That removes the duplicated
assertions without inventing a new shared-include mechanism. Reclassify the two non-tier
scripts noted alongside this finding: `verify-mvp.sh` is a 6-line `exec` redirect to
`verify-core.sh` (harmless alias — leave it, but note in docs it is an alias); and
`verify-forge-review.sh` is a per-file validator **called by `evals/smoke-loop.sh:110`** — keep
it, reclassified as a utility, not a verification tier.

**Diff size.** S. **Risk / what's lost.** None — this is the same edit as §2.3 viewed from the
dedup angle. *Highest impact×ease item in this section.*

### 3.2 Two pages both claiming "canonical product state" — **Ff2** (KNOWN-UNFIXED, B1 partial) — diff **M**

**Complexity observed.** `docs/product-state.md:3` calls itself *"the canonical local summary"*;
`docs/roadmap.md:3` calls itself *"the repo source of truth"* (both quoted verbatim above).
`roadmap.md:46` (the DAN-181 entry) even says *"Keep roadmap as the canonical product-state
page"*, and `product-state.md:52` admits *"This document and docs/roadmap.md describe current
product state."* They duplicate the same extension rows.

Provenance defeats any "intentional division of labor" defense: `roadmap.md` was created
2026-05-23 by the **accepted DAN-181 reconciliation**, which named *only* roadmap canonical;
`product-state.md` was created 13 days later (2026-06-05, `7220da8` "Simplify"),
re-introducing a second canonical page — a regression in the very commit that claimed to
simplify.

**PRD evidence.** C15 (four required docs; others must earn their place, L359-370): two pages
asserting canonicity over the same content is the failure mode C15 guards against.

**Proposed simplification.** Make `roadmap.md` the single source. Move `product-state.md`'s
unique content (the core/extension/release classification table + the Current Simplification
Policy) into `roadmap.md` as a section; reduce `product-state.md` to a pointer or delete it.
Requires editing 3 `verify-core` pins that reference `product-state.md` strings ("PRD core",
"Verification Tiers", "Optional extension").

**Diff size.** M. **Risk / what's lost.** Moderate doc churn + 3 verifier pin edits; the
upside is a single canonical product-state page, ending the recurring auditor confusion.

### 3.3 Eval `extensions/` wrappers duplicate canonical top-level scripts — **Fd3+Fd5** (KNOWN-UNFIXED) — diff **S-M**

**Complexity observed.** `evals/extensions/{reliability-gains,sense-smoke,ui-smoke}.sh` are
cosmetic 7-line `exec` wrappers back to the canonical top-level scripts (confirmed: each is a
`set -eu` + `exec sh "$repo_root/evals/<name>.sh" "$@"`). `verify-extensions.sh:24-29` requires
**both** layers — duplication, not separation. They were born in a single commit (`7220da8`),
so they are not transition shims.

**Constraint on the fix (verified):** `verify-core.sh:75-76` requires top-level
`evals/sense-smoke.sh` *and* `evals/reliability-gains.sh` — the repo treats sense + reliability
as **core-tier**. So you cannot "just move scripts under `extensions/` and delete the
wrappers": that breaks core verification and 6+ docs (quickstart L339, README L224,
extensions.md L37, product-state.md L30, evals/README, dogfooding.md).

**PRD evidence.** C10 (no brittle scaffolds): two paths to the same script is dead weight.

**Proposed simplification.** Pick **one** canonical location and update all references + both
verifiers, **or** delete the `extensions/` wrappers and their three `verify-extensions`
require-lines. Also fix the adjacent factual defect: `docs/releases/next-alpha.md:95` falsely
states *"No `evals/ui-smoke.sh` exists in this repo"* (verbatim) — it exists, is tracked, and
is required by `verify-extensions.sh:25`.

**Diff size.** S-M (the reference sweep dominates). **Risk / what's lost.** If wrappers are
deleted, any doc/user invoking the `extensions/` path breaks — hence the reference sweep is
mandatory.

---

## 4. REWRITE — reword / relabel / reframe

### 4.1 UI framed as a co-equal primary flow — **Fe5** (KNOWN-UNFIXED) — diff **S** (+ PRD change, §5)

**Complexity observed.** `README.md` puts `sh scripts/hyperagent.sh ui` in the main Quick-start
block and (L151 area) describes *"five user-facing flows: init, sense, mission, review, and
ui"*; `hyperagent.sh:8/:52` list `ui` under "Primary flows". But governance defines the UI as
**optional / in-review**: DAN-187/PR#24; `docs/ui-architecture.md` ("until the cockpit becomes
a primary product surface"); `roadmap.md` ("In review", "Keep UI optional and subordinate");
no `workshop/decisions` record; not in the capability-registry accepted section. Doubly wrong
because the shipped `ui` command merely prints pointers (verified: it prints "The hosted
cockpit is not part of this local alpha" and points users to `sense` / `review digest`).

**PRD evidence.** C9 (no complex UI before the loop works in markdown, L233); C5 (MVP scope).
Promoting a pointer-printing command to co-equal with the four loop flows misrepresents the
product surface.

**Proposed simplification.** Reframe to *"four primary flows (init/sense/mission/review) + an
optional `ui` cockpit"* in `README.md` (Quick-start + the "flows" sentence) and
`hyperagent.sh:8/:52`. *Highest impact×ease item in this section — pure wording, corrects a
visible C9 misframe.* The deeper reconciliation belongs in the PRD (see §5).

### 4.2 Single combined doctrine-ownership fix for triple-copied prompts — **Fb1+Fb3+Fb4** (KNOWN-UNFIXED) — diff **S**

**Complexity observed.** Triage criteria, loop steps, and Workshop/Forge prompts appear across
`SKILL.md` (105 L), `AGENTS.md` (89 L), `operating-prompt.md` (63 L), and the
`print_workshop_prompt`/`print_forge_prompt` functions.

**Do not collapse to one file** — Phase 4 established three reasons: (a) default install is
**copy, not symlink** (`install-codex-skill.sh:27` `copy_mode=copy`, L121 `cp -R`), so the
installed `SKILL.md` in `~/.codex/skills/` has no access to `operating-prompt.md` and must be
self-contained; (b) the three files target three different consumers (AGENTS.md project-scoped;
SKILL.md installed skill; operating-prompt.md runtime Suit prompt) — documented in
`adapters/codex.md` "Prompt And Skill Surface"; (c) `verify-core.sh` pins phrases in all three
(SKILL.md L99-105, AGENTS.md L107-108, operating-prompt.md L166-169). The "regression" tag was
false (SKILL.md + operating-prompt.md were born in the same commit `998af89`), and the
`propose-upgrade` reference in `print_forge_prompt` is a **working compat alias**, not broken.

**PRD evidence.** C1/C2 — hand-maintained triple copies of operating doctrine sit in tension
with "a suit evolves" (drift risk), but copy-mode install forbids a thin-pointer SKILL.md.

**Proposed simplification (REWRITE).** Add a doctrine **ownership table** to `adapters/codex.md`
(which surface owns triage/loop wording) plus a verify **drift-check** that canonical phrasing
matches across surfaces. Optional tidy: align the terser `SKILL.md:69-73` Workshop snippet and
swap the cosmetic `propose-upgrade` mention to `review workshop`.

**Diff size.** S. **Risk / what's lost.** None; the drift-check converts the implicit
triple-copy invariant into an enforced one. (If single-sourcing is ever desired, that is a
PRD/roadmap decision — see §5.)

### 4.3 Reframe `reliability-gains.sh` as a rubric self-test — **Fd4** (KNOWN-UNFIXED) — diff **S**

**Complexity observed.** The pass condition (`evals/reliability-gains.sh:386`,
`test "$delta" -gt 0`) compares two hand-authored fixtures (one engineered to score low, one
high), and all 62 mission-derived cases are hard-coded `Condition: with-hyperagent`
(L250, verified). So the gate **cannot fail** and proves nothing about whether upgrades
improve behavior.

**PRD evidence.** C13 (evals as required contents). But the repo **already disclaims** the
proof claim everywhere: `reliability-rubric.md:135-136` ("trend evidence... not precise
measurements"); the report prints "Interpretation Limits"; `product-state.md:30` ("Optional
research extension"); `roadmap.md` P2 ("fixture-based"); next-alpha + release-checklist list it
in-review/deferred. No release doc overclaims it.

**Proposed simplification.** Rename/reframe the fixture pass-gate as a rubric **self-test /
known-answer test** (in the report header and a README line). Keep the real paired-comparison
ambition on roadmap P2. **Do not delete** — it is well-engineered and governance-adjacent.

**Diff size.** S. **Risk / what's lost.** None — relabeling only.

### 4.4 `evals/ui-smoke.sh` asserts `missionCount >= 1` against the live repo — **Fe4** (NEW) — diff **S**

**Complexity observed.** `evals/ui-smoke.sh` asserts `overview.missionCount` is a number `>= 1`
(verified L47-49) against the **live repo** (`cd repo_root`, no sandbox), so it fails on a clean
install with an empty `missions/` — unlike `smoke-loop.sh`, which builds its own fixtures. The
testbed has 62 records, so the failure is latent today and unreachable in any documented
clean-install flow.

**PRD evidence.** C19 (inspectable, reproducible) in spirit: a smoke test should be
self-sufficient, not dependent on undocumented testbed state.

**Proposed simplification.** Make `ui-smoke.sh` self-sufficient — seed a temp fixture mission,
or relax the assertion to `missionCount >= 0`.

**Diff size.** S. **Risk / what's lost.** None.

### 4.5 Smaller relabels (grouped) — diff **S** each

- **Fb6 (DOCUMENT, never delete)** `skills/codex-hyperagent/agents/openai.yaml` (5 L,
  `interface:` block) is `verify-core`-pinned (L52 require_file, L106 require_text
  display_name) and is the plausible C5/C20 Codex skill-registration extension point. Version
  `v0.1.0-alpha` is **not** stale. **Fix:** add 2-3 sentences to `adapters/codex.md` near L14
  explaining what Codex reads from it, the `interface:` schema, and that it is verify-pinned.
- **Fb2 (testbed labels)** `AGENTS.md` Symphony/Linear handoff (L58-68), architecture-diagram
  paths (L70-90), and verify tiers (L42-55) are testbed-specific but not marked so. Phase-3
  "users inherit these" was false: `generate_init_agents_block` (`hyperagent.sh:881-917`) emits
  a separate generic block. **Fix:** add "(testbed-only)" labels; preserve the `verify-core`
  L107-108 pinned phrases. Low priority.
- **Fb7 (file-path over Linear ID)** `hyperagent/capability-registry.md:48` cites bare
  "DAN-181" as evidence (verified). **Fix:** replace with the file path
  `missions/2026-05-23-2234-dan-181-product-state-reconciliation.md`. Do not add an
  aging-policy. (Interacts with the repo-wide DAN-ID decision — §5 Fg5.)
- **Ff8 (correct a false "stale" claim)** `docs/clean-install-uat.md` (112 L) overlaps
  quickstart §1-2, but its L9 status box is the **live** state of an open pre-tag release gate,
  not stale. It is `require_file` in both core and release verifiers. **Fix:** trim duplication
  only — have the install step point at quickstart §1; keep the file, the gate, and the status
  box.
- **Ff3 (install/update dedup)** The one genuine byte-identical duplicate is the "For copy
  installs"/"For symlink installs" block in README §12 and quickstart §12 — collapse one into a
  pointer. Release notes (`v0.1.0-alpha.md`) are time-capsules: add a historical banner, do not
  rewrite the body. Keep a short README "Updating" section. Note hygiene: many docs still invoke
  `scripts/verify-mvp.sh` (now an alias).
- **Ff4 (relabel maintainer prereqs)** `docs/dogfooding.md:8-19` lists 9 "Read these first"
  docs, but dogfooding.md is a maintainer/reviewer doc; C5's one-doc rule governs the *user*
  path (README→quickstart). **Fix:** relabel the list as a "Reference Index (read as needed)";
  fix L85 `review prompt workshop` → `review workshop`. Do not collapse the list.
- **Ff5 (cross-link, do not merge)** `safety-policy.md`, `SECURITY.md`, and README L167-169 each
  carry an "Authority Boundary". The "may" lists differ in substance, serve different audiences,
  and both files are verifier-pinned (incl. the C12 "human review required" pin in
  `verify-core.sh:98`). **Fix:** keep both; ensure `SECURITY.md` keeps pointing at
  `safety-policy.md` as canonical; optionally trim the README prose copy to a pointer.
- **Ff1 (1-line doc fix)** `docs/config.md:17` says nested tables "are not part of the supported
  contract", but `.hyperagent` ships `[verification.core/.extensions/.release]` subtables and
  `config_array_values` (`hyperagent.sh:185`) reads them correctly (the "parser silently falls
  through" claim was false). **Fix:** amend config.md L17 to acknowledge the `[verification.*]`
  tier subtables as the supported exception.
- **Fg7 (private path in a review doc)** `docs/reviews/2026-05-23-prd-faithfulness-review.md:5`
  contains `/Users/danielmcateer/Desktop/dev/HyperAgent`; not pinned anywhere. Replace with
  "local HyperAgent checkout". Fold into the Fg1 redaction sweep (one pass; same git-history
  caveat).

### 4.6 Forward redaction infrastructure for `missions/` leaks — **Fg1** (KNOWN-UNFIXED) — diff **S-M**

**Complexity observed.** 61 of 62 `missions/` records contain `/Users/` paths (30 with the
HyperAgent dev path, 31 with a `…/symphony-workspaces/DAN-NNN` path; 36 contain DAN- IDs in
bodies), violating `docs/evidence-policy.md:29-35`. The repo is **public**.

Two Phase-3 framings were corrected: (a) the eval does **not** break —
`reliability-gains.sh field_value()` reads only labeled scored fields, never the
Environment/Repo-path/Command-log fields where the leaks live; (b) forward-only grandfathering
**fails** — evidence-policy shipped 2026-05-24, yet 26 of the 61 leaking records were committed
*after* that (including a 2026-06-05 batch). Critical reframe: in-place redaction does **not**
scrub git history, so for a public repo it is **norm-setting**, not exposure removal. Leak
content is machine topology + issue IDs, not credentials.

**PRD evidence.** C11 (local file-based memory) and C19 (inspectable) + the evidence-policy
contract itself.

**Proposed simplification (forward infrastructure).** Add `missions/` to `.gitignore` (or route
dogfooding to the already-ignored `.hyperagent-evidence/`) **and** wire the existing-but-
unenforced `redact-check` into a verifier gate. Today `verify-core.sh:84` only checks the dir
exists; nothing scans committed records. Optional norm-setting: redact the ~14 highest-value
records in place (labeled as norm-setting, not secret-removal).

**Diff size.** S-M. **Risk / what's lost.** Note clearly: history scrub is out of scope for an
in-place edit; the durable fix is preventing *future* leaks via gitignore + enforced
redact-check.

---

## 5. Where the PRD itself should change

These are cases where the right fix is amending `docs/hyperagent-prd.md` (or the governance
docs the PRD blesses), **not** changing the repo. Auditors keep re-flagging accepted
architecture because the PRD does not yet describe it.

1. **Verify-core's role (Fa7).** State plainly that `verify-core.sh` is the **HyperAgent
   testbed repo-integrity gate**, and that the per-project C5 *"smallest local verification
   run"* is `verify-config` + `sense`. (Corrected count: `verify-core` has ~169 assertions over
   ~60 distinct files, far above C13's ~9-item list — *because* it is the testbed gate, not a
   user-project check. The Phase-3 "a freshly initialized project running verify-core would
   fail" scenario is false: init never copies or invokes verify-core into user projects.)
   **Do not** split core into minimal-vs-integrity tiers — that re-introduces tier
   proliferation with no consumer.

2. **Tiered verification + sensing classification (Fd2/Fd5).** C5 (L394-430) should say the
   "smallest local verification run" is the MVP's *first* deliverable, and that a tiered
   core/extension/release verification model is the intended **post-MVP evolution** (the repo
   already adopted it via its own governance loop, total 1,242 L). Also reconcile whether local
   sensing is **core or an extension**: `verify-core` requires `sense-smoke`, yet docs frame
   sensing as an extension.

3. **The optional UI cockpit (Fe5).** C9 / the MVP non-goals (L233) should be updated to
   describe the accepted **optional, read-mostly, local-only cockpit** (DAN-187) and its
   boundary, so the shipped `ui` command stops reading as a silent C9 breach. (The repo-side
   wording fix is §4.1; this is the contract-side counterpart.)

4. **Linear issue IDs in public artifacts (Fg5).** `evidence-policy.md:33` flatly prohibits
   *"private Linear URLs and issue IDs"*, yet `roadmap.md` openly uses **26** DAN- IDs (plus
   capability-registry and proposals). Singling out `backlog.md` (DAN-174/181/197 at L49/L53/L54)
   is incoherent. **Reconcile repo-wide:** amend `evidence-policy.md:33` to permit bare IDs but
   not URLs, **or** scrub repo-wide. Resolving this collapses Fg5 and the DAN-ID halves of Fg1
   and Fb7. (`backlog.md` is pinned only on "This backlog tracks" in `verify-core.sh:187`, so no
   verifier edit is needed.)

5. **Forge cadence (Fg2).** The loop ratio is 62 missions : 6 proposals : 2 decisions : 1 forge
   review (counts verified; loop mechanics verified working — `smoke-loop.sh` exercises the full
   Forge arm; forge-audit is a release gate). The low cadence may be faithful **restraint**
   (C12: proposals only on concrete friction), not dysfunction. The PRD does **not** define a
   target Forge cadence, so any "loop dysfunction" claim is unfalsifiable. If the PRD intends a
   target cadence, state it; absent that, drop the dysfunction framing. (Context note only — the
   remedy would *add* artifacts, which is out of scope for a delete/collapse report.)

6. **Single-sourcing operating doctrine (Fb1).** If single-sourcing the triple-copied operating
   doctrine is ever desired, the PRD/roadmap should authorize a **build-time generation step**
   (`operating-prompt.md` → `SKILL.md`), since hand-maintained triple copies sit in tension with
   C2/C10 but copy-mode install forbids a thin-pointer SKILL.md. Until then, the §4.2 ownership
   table + drift-check is the faithful interim.

---

### Appendix — hygiene footnotes (below the bar for standalone findings)

- **Fd1.** `evals/out/` (68 files) is correctly gitignored / untracked; the only cross-run
  residue is intentional manually-saved screenshots (no regenerator). The Phase-3 `rm -rf
  evals/out` proposal was harmful and is dropped.
