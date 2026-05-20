# HyperAgent Agents SDK Demo

This example gives HyperAgent a small runnable agent body using the OpenAI Agents SDK. It demonstrates one agent, two real local tools, SDK tracing, mission record generation, optional Workshop proposal generation, optional Forge review generation, and a no-network verifier.

The live run uses:

- `Agent`
- `Runner.run_sync`
- `function_tool`
- `trace`
- `flush_traces`

The demo preserves the HyperAgent safety boundary: generated proposals stay `human review required`, and the demo does not write decision records or update `hyperagent/capability-registry.md`.

## Setup

From a fresh clone:

```bash
python3.10 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r examples/agents-sdk-demo/requirements.txt
export OPENAI_API_KEY="sk-..."
```

Optionally set a model:

```bash
export OPENAI_MODEL="your-preferred-model"
```

If `OPENAI_MODEL` is unset, the demo uses the Agents SDK default model.

## Run The Live Demo

From the repository root:

```bash
python3 examples/agents-sdk-demo/demo.py \
  --friction "The markdown-first Suit needs a runnable Agents SDK reference body."
```

The command writes:

- a mission record in `missions/`
- a Workshop proposal in `workshop/proposals/` when `--friction` is present
- a Forge review in `forge/reviews/` when `--friction` is present

It also prints the SDK trace workflow name and trace id. Open the OpenAI dashboard trace viewer and search for workflow `hyperagent-agents-sdk-demo` or the printed trace id.

To write only a mission record, omit `--friction`.

## Local Verification

The verifier does not require an API key or network access:

```bash
sh examples/agents-sdk-demo/verify.sh
```

It compiles the demo, runs dry-run artifact generation in a temporary output root, verifies that mission/proposal/review files are produced, and confirms the demo does not create decision records or accepted capability registry entries.

## Dry Run

Use dry-run mode to inspect generated artifacts without installing the Agents SDK:

```bash
python3 examples/agents-sdk-demo/demo.py \
  --dry-run \
  --output-root /tmp/hyperagent-demo \
  --friction "The project needs an executable agent reference."
```
