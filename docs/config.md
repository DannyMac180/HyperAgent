# HyperAgent Project Config

The root `.hyperagent` file is the machine-readable project contract for a HyperAgent workspace. Local commands use it to find mission records, Workshop artifacts, Forge reviews, adapter settings, and verification commands.

Validate the contract with:

```bash
sh scripts/hyperagent.sh verify-config
```

The format is a small TOML subset on purpose:

- blank lines and `#` comments are allowed,
- scalar values are strings, integers, or booleans,
- sections use `[section]`,
- `verification.commands` is an array of quoted strings,
- nested tables, inline tables, multiline strings, escapes, and dotted keys are not part of the supported contract, except for the documented `[verification.*]` tier subtables.

## Stable Fields

These fields are stable for `config_version = 1` and are validated by `verify-config`:

```toml
hyperagent_version = "v0.1.0-alpha"
config_version = 1
install_mode = "copy"
```

- `hyperagent_version`: the HyperAgent release expected by this workspace.
- `config_version`: the schema version. Version `1` is the only supported version.
- `install_mode`: how project-local files were initialized. Supported values are `copy` and `symlink`; the default remains `copy`.

## Stable Paths

All configured paths must be project-relative and must stay inside the project. Core markdown and helper paths must exist. Runtime evidence paths may point to files that do not exist yet, but their parent paths must be valid when present.

```toml
[paths]
project_instructions = "AGENTS.md"
missions = "missions"
workshop_proposals = "workshop/proposals"
workshop_decisions = "workshop/decisions"
workshop_backlog = "workshop/backlog.md"
workshop_rubric = "workshop/rubric.md"
forge_reviews = "forge/reviews"
forge_quality_rubric = "forge/process/quality-rubric.md"
templates = "templates"
operating_prompt = "hyperagent/operating-prompt.md"
capability_registry = "hyperagent/capability-registry.md"
project_readme = "README.md"
local_helper = "scripts/hyperagent.sh"
evidence_log = ".hyperagent-evidence/commands.log"
workbench_trace_log = ".hyperagent-evidence/workbench/traces.jsonl"
```

`status`, mission creation, proposal creation, decision creation, Forge review creation, command evidence, and Workbench trace defaults read these paths.

## Adapter-Owned Fields

Adapters own their own keys under `[adapters]`. In `config_version = 1`, the Codex adapter must be enabled:

```toml
[adapters]
codex = true
```

Future adapters should add their own booleans or adapter-specific sections without changing the meaning of the Codex key.

Adapter responsibilities are documented outside the config file:

- `adapters/contract.md`: generic requirements for any future platform adapter.
- `adapters/codex.md`: Codex-specific install, prompt, tools, memory, verification, safety, status, and sensing boundaries.

The config flag says which adapter is enabled. The adapter docs explain what that adapter owns. Non-Codex adapter docs or flags should not be added until a reviewed issue authorizes that platform.

## Verification Commands

Verification commands are workspace guidance for humans and agents. The verifier requires the array to be present and to include the config verifier and status command:

```toml
[verification]
commands = [
  "sh scripts/hyperagent.sh verify-config",
  "sh scripts/hyperagent.sh status",
]
```

Projects can add stronger local checks, such as `sh scripts/verify-mvp.sh`, `sh evals/init-smoke.sh`, or product-specific test commands.

## Experimental Paths

The evidence paths are intentionally local and ignored by git:

- `evidence_log`
- `workbench_trace_log`

They are experimental runtime evidence surfaces. They should not contain secrets, should remain project-local, and can be pruned by local retention policy.
