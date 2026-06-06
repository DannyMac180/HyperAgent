# CLI, Init, And Config Result

Implemented:
- Added grouped public commands: `mission`, `review`, `verify`, and `check`.
- Kept compatibility aliases for `new-mission`, `propose-upgrade`, `new-forge-review`, `decide-upgrade`, `record-check`, `workshop-prompt`, `forge-prompt`, and `doctor`.
- Merged diagnostics into `sense --doctor`.
- Added `check --` to run and record command evidence in one step.
- Added `mission closeout --mission PATH` to audit pending closeout placeholders and print a local sense summary.
- Reduced `hyperagent init` copying: no full helper runtime or UI assets are copied into initialized projects by default.
- Split `.hyperagent` verification commands into `[verification.core]`, `[verification.extensions]`, and `[verification.release]`.
- Removed the duplicate `git_changed_files` helper.
- Moved generated project setup text into template files under `templates/`.

Opportunities covered:
3, 7, 8, 9, 14, 15, 19, 20, 28, 29, 30, 35, 36, 43.
