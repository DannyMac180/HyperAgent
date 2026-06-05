# Security Policy

HyperAgent is an early alpha local agent-operating layer. It is not a hosted service and should not handle secrets by default.

Canonical local policy:

- `docs/safety-policy.md`
- `docs/evidence-policy.md`

## Supported Versions

Security review currently applies to `main` and tagged alpha releases.

## Authority Boundary

HyperAgent's default activation mode is `human review required`.

Agents may:

- propose upgrades,
- draft local low-risk files when asked,
- write mission records,
- write Workshop proposals,
- write Forge reviews.

Agents may not silently:

- activate persistent behavior changes,
- broaden filesystem access,
- broaden shell access,
- add network, deployment, account, or secrets access,
- alter secrets handling,
- approve their own upgrades.

## Secrets Policy

Do not put secrets in:

- mission records,
- Workshop proposals,
- Forge reviews,
- templates,
- capability registry entries,
- issue reports,
- PR descriptions.

If a task involves secrets, describe the workflow and authority boundary without copying secret values.

## Reporting Security Issues

For now, report security issues privately to the repository owner before opening a public issue.

Include:

- affected file or workflow,
- what authority boundary is at risk,
- reproduction steps if safe,
- expected behavior,
- suggested mitigation if known.

## Out Of Scope For Alpha

The alpha release does not provide:

- sandboxing,
- hosted policy enforcement,
- automatic permission auditing,
- production-grade secrets management,
- autonomous self-modification safeguards beyond local human-review policy.
