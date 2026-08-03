# HyperAgent Safety Policy

**Scope.** This document states what *HyperAgent* may and may not do to your machine and your agents. It is not a list of permissions granted to a working agent — HyperAgent does not instruct agents, and an agent working in a repo is not a participant in this policy.

Enforcement lives in code rather than here. `docs/gates.md` is the operative document: policy shape, hook-point evaluation, contracts, and the tests that hold the boundary. Where this document and `gates.md` disagree, `gates.md` wins.

## The boundary

**HyperAgent never installs or retires a capability behind the pilot's back.** Any persistent change to how an agent behaves requires explicit human approval before it takes effect. This is a permanent commitment, not a default that some future component is expected to relax.

It is enforced structurally rather than promised. The daemon has **no code path** to install or uninstall hooks, and a test asserts that; installing hooks into a repo is an explicit CLI action by the pilot.

**HyperAgent does not:**

- install, activate, or retire a persistent behavior change without recorded human approval;
- broaden filesystem, shell, network, deployment, account, or secrets access;
- alter secrets handling;
- deploy, publish, email, post, or change any external system;
- modify its own enforcement surface.

**HyperAgent may, without asking:**

- read the harness telemetry it has been pointed at, and append to its own local store;
- compute derived measurements over that store;
- report — including reporting that it could not observe, or could not block, something.

Reporting is unrestricted because reports are inert. Anything that changes future agent behavior is gated.

## Enforcement posture

Gates ship **flag-only by default**: violations are recorded and nothing is blocked. Blocking rules exist but ship disabled. Tightening enforcement is the pilot's decision, not the suit's.

Two asymmetries are deliberate:

- **A computed decision is never inverted by bookkeeping.** Once a block has been decided, recording it is telemetry — if that write fails, the block still stands. Otherwise a full disk or a tampered spool directory would silently disarm every enabled rule.
- **A broken policy degrades to flag-only, never to blocking.** An unreadable or malformed policy file cannot start blocking things; it falls back to the baseline and surfaces a named error.

Honesty about coverage is part of the safety model, not a UX detail. Some harnesses expose no pre-execution hook, so a risky action there can only be detected after it ran. HyperAgent reports that distinction explicitly instead of implying uniform protection. A record that advertises its own gaps cannot be gamed; one that quietly overstates coverage is worse than no record at all.

## What an approved capability carries

Anything installed keeps enough provenance to be audited and reversed:

- the evidence it was derived from;
- the human decision that approved it, and the scope that decision covered;
- where it was installed and at what scope;
- a rollback path.

## Activation modes

- `suggest only`
- `draft files only`
- `human review required` — **the default, and the only mode under which a persistent change takes effect**

Unattended installation is not an available mode. A prior version of this document listed `auto-install low risk` as allowed-but-deferred, pending a future safety verifier. That framing was withdrawn on 2026-08-03: the door is closed by commitment, not by a missing component, and enumerating the mode invited a future implementer to read it as sanction.
