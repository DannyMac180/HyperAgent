# Claude Code conformance fixtures

`clean.jsonl` is copied byte-for-byte from the repository's recorded-dialect
corpus at
`../fixtures/projects/-home-user-project/11111111-1111-4111-8111-111111111111.jsonl`.
The other files are small, committed byte variants used to exercise unknown,
corrupted, resume, and truncated-record behavior.

These files are literal fixture bytes. Nothing may regenerate them by importing
or calling Claude Code adapter parsing or serialization code; that independence
is what makes the golden snapshot meaningful.
