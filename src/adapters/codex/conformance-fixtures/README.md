# Synthetic Codex rollout fixtures

These fixtures were hand-authored for DAN-205 in the verified Codex rollout JSONL envelope shape. They are synthetic: session ids, timestamps, repository paths, messages, tool inputs, and outputs were invented for conformance and were not copied from `~/.codex` or any user session.

`clean.jsonl` is the golden-source fixture. The remaining files isolate unknown-record counting, corrupted-known-record signaling, byte-offset resume, and truncated trailing-line behavior.
