# Summary

<!-- What changed, and why? -->

## Verification

<!-- What you actually ran, with real output. "Should work" is not verification. -->

```bash
bun test && bunx tsc --noEmit
```

<!-- Note anything you could not verify, and why. -->

## Checklist

- [ ] No change requires the working agent to report on itself (observation stays involuntary).
- [ ] No "how to think / how to work" instruction is installed by this change.
- [ ] Nothing judgment-plane was added to this repo (scoring, workshop, forge, memory extraction/promotion).
- [ ] Safety or authority-boundary implications are called out.
- [ ] If this changes what is observed or how it is stored, `docs/schema.md` and `docs/evidence-policy.md` are updated in this PR.
- [ ] If an adapter changed, conformance was re-run and the capability matrix regenerated (never hand-edited).
- [ ] Rollback path is clear when persistent behavior changes are introduced.
