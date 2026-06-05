# Forge Review

- Review ID:
- Date/time:
- Proposals reviewed:
- Decisions reviewed:
- Evals reviewed:
- Accepted capabilities reviewed:
- Prior Forge score history reviewed:
- Reviewer:

## Structured Summary

```json
{
  "reviewed_artifacts": {
    "missions": [],
    "proposals": [],
    "decisions": [],
    "evals": [],
    "accepted_capabilities": [],
    "prior_forge_reviews": []
  },
  "scores": {
    "outcome_quality": {"score": null, "evidence": []},
    "proposal_specificity": {"score": null, "evidence": []},
    "eval_coverage": {"score": null, "evidence": []},
    "safety_boundary_preservation": {"score": null, "evidence": []},
    "regression_detection": {"score": null, "evidence": []},
    "process_bloat_risk": {"score": null, "evidence": []}
  },
  "pass_fail_gates": {
    "testable_behavior_claim": null,
    "owner_surface_named": null,
    "eval_or_check_plan": null,
    "rollback_or_human_review_boundary": null,
    "scores_have_evidence": null
  },
  "payoff_metrics": {
    "regressions_caught": 0,
    "repeat_friction_seen_again": 0,
    "manual_steps_removed": 0,
    "evals_added": 0,
    "artifacts_retired": 0
  },
  "recommendation": "",
  "confidence": "",
  "follow_up_required": false,
  "upgrade_id": ""
}
```

## Outcome Quality

- Did accepted upgrades improve agent behavior?
- Which upgrades paid off?
- Which upgrades created process bloat?
- What behavior evidence supports the outcome judgment?
- Outcome quality score (0-5):
- Outcome quality evidence:

## Proposal Quality

- Are proposals specific and evidence-backed?
- Which templates or proposal sections produced vague output?
- Are priorities and decision handoffs clear?
- Are repeated friction patterns being missed?
- Proposal specificity score (0-5):
- Proposal specificity evidence:

## Eval Quality

- Are acceptance tests concrete enough to catch regressions?
- Did evals verify behavior instead of file presence only?
- Which regressions would current evals miss?
- Eval coverage score (0-5):
- Eval coverage evidence:
- Regression detection score (0-5):
- Regression detection evidence:

## Safety Quality

- Are safety risks explicit?
- Are activation modes appropriate?
- Are authority, permission, secrets, deployment, and rollback boundaries clear?
- Are rejected or deferred upgrades recorded with reasons?
- Safety boundary preservation score (0-5):
- Safety boundary preservation evidence:

## Process Quality

- Are process costs proportionate to the value of the upgrade?
- Are accepted capabilities traceable from mission evidence to proposal, decision, eval, and registry entry?
- Process bloat risk score (0-5):
- Process bloat risk evidence:

## Deterministic Gates

- Testable behavior claim present: yes/no
- Owner surface named: yes/no
- Eval or check plan present: yes/no
- Rollback or human-review boundary present: yes/no
- Every score has evidence: yes/no
- Gate result: ready/not ready

## Process Improvement Proposal

- Workshop process friction:
- Proposed process change:
- Expected effect:
- Eval for the process change:
- Rollback plan:
- Generate proposal when:
- Suggested proposal command: `sh scripts/hyperagent.sh propose-upgrade --forge-review PATH --title "..." --problem "..."`

## Decision

- Recommendation:
- Human approval needed:
- Follow-up proposal path:
