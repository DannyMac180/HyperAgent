#!/usr/bin/env python3
"""Runnable OpenAI Agents SDK demo for the HyperAgent loop.

Live mode uses the Agents SDK for a traced model/tool run.
Dry-run mode exercises the same artifact writer without network access.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WORKFLOW_NAME = "hyperagent-agents-sdk-demo"


def clamp(value: str, limit: int = 4000) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 40] + "\n\n[truncated by demo artifact writer]"


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:48] or "agents-sdk-demo"


def timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S")


def ensure_demo_dirs(output_root: Path) -> None:
    for relative in (
        "missions",
        "workshop/proposals",
        "forge/reviews",
    ):
        (output_root / relative).mkdir(parents=True, exist_ok=True)


def inspect_workspace(output_root: Path) -> dict[str, Any]:
    """Read real local HyperAgent files so the agent has grounded context."""

    def count_markdown(relative: str) -> int:
        path = output_root / relative
        if not path.exists():
            return 0
        return len(list(path.glob("*.md")))

    files = [
        "README.md",
        "hyperagent/operating-prompt.md",
        "templates/mission-record.md",
        "templates/upgrade-proposal.md",
        "templates/forge-review.md",
        "workshop/rubric.md",
    ]
    present = [file for file in files if (output_root / file).is_file()]
    missing = [file for file in files if file not in present]

    return {
        "output_root": str(output_root),
        "present_files": present,
        "missing_files": missing,
        "mission_count": count_markdown("missions"),
        "workshop_proposal_count": count_markdown("workshop/proposals"),
        "forge_review_count": count_markdown("forge/reviews"),
        "safety_boundary": "human review required",
    }


def write_artifacts(
    *,
    output_root: Path,
    mission_summary: str,
    friction_present: bool,
    friction_summary: str,
    workshop_problem: str,
    forge_review_summary: str,
    trace_id: str,
    dry_run: bool,
) -> dict[str, Any]:
    ensure_demo_dirs(output_root)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    stamp = timestamp()
    mission_id = f"{stamp}-agents-sdk-demo"
    mission_path = output_root / "missions" / f"{mission_id}.md"

    proposal_path: Path | None = None
    forge_path: Path | None = None
    proposal_rel = "none"
    forge_rel = "none"
    friction_text = clamp(friction_summary or "No concrete Suit friction was observed.")

    if friction_present:
        proposal_id = f"{stamp}-{slugify(workshop_problem)}"
        proposal_path = output_root / "workshop" / "proposals" / f"{proposal_id}.md"
        proposal_rel = str(proposal_path.relative_to(output_root))

        forge_id = f"{stamp}-agents-sdk-demo-review"
        forge_path = output_root / "forge" / "reviews" / f"{forge_id}.md"
        forge_rel = str(forge_path.relative_to(output_root))

    mission_path.write_text(
        "\n".join(
            [
                "# Mission Record",
                "",
                f"- Mission ID: {mission_id}",
                f"- Date/time: {now} UTC",
                "- Agent identity: OpenAI Agents SDK demo agent",
                f"- Environment: output_root={output_root}",
                "- User request: Demonstrate a runnable HyperAgent model/tool loop.",
                "",
                "## Outcome",
                "",
                f"- Final outcome: {clamp(mission_summary)}",
                f"- Completion evidence: trace workflow `{WORKFLOW_NAME}`, trace id `{trace_id}`, artifacts written by a real function tool.",
                "- Unresolved risks: Live tracing requires a valid OPENAI_API_KEY and OpenAI trace export access.",
                "",
                "## Actions",
                "",
                "- Agent plan: Inspect local HyperAgent context, run a model/tool loop, then write Mission/Workshop/Forge artifacts.",
                "- Summary of actions taken: The demo agent used local tools to inspect repository state and create local Markdown telemetry.",
                "- Tools used: inspect_hyperagent_workspace; write_hyperagent_artifacts",
                f"- Files or systems changed: {mission_path.relative_to(output_root)}; {proposal_rel}; {forge_rel}",
                f"- Verification performed: {'dry-run verifier' if dry_run else 'OpenAI Agents SDK run with SDK tracing enabled'}",
                "",
                "## Friction",
                "",
                "- Failures, retries, and blockers: None recorded by the artifact writer.",
                "- User corrections: None.",
                f"- Suit friction observed: {friction_text}",
                f"- Candidate upgrades: {proposal_rel if friction_present else 'none'}",
                "",
                "## Workshop Handoff",
                "",
                f"- Upgrade proposal paths: {proposal_rel}",
                "- Follow-up owner: Human reviewer",
                "",
            ]
        ),
        encoding="utf-8",
    )

    if proposal_path is not None:
        proposal_path.write_text(
            "\n".join(
                [
                    "# Upgrade Proposal",
                    "",
                    f"- Upgrade title: {clamp(workshop_problem, 200)}",
                    f"- Proposal ID: {proposal_path.stem}",
                    f"- Date/time: {now} UTC",
                    f"- Related mission record: {mission_path.relative_to(output_root)}",
                    "- Proposed activation mode: human review required",
                    "- Allowed activation modes: suggest only; draft files only; human review required; auto-install low risk",
                    "- Backlog priority: draft",
                    "- Workshop rubric score: 10",
                    "",
                    "## Problem",
                    "",
                    f"- Problem observed: {clamp(workshop_problem)}",
                    f"- Evidence from mission records: {mission_path.relative_to(output_root)} records the SDK demo friction and trace metadata.",
                    "- Why the current Suit was insufficient: The Suit needs a runnable reference body in addition to prompts and Markdown templates.",
                    "",
                    "## Proposed Capability",
                    "",
                    "- Type of upgrade: example adapter",
                    "- Proposed capability: Keep an Agents SDK demo path that can generate local HyperAgent artifacts from a traced tool loop.",
                    "- Expected impact: Gives future agents a small executable reference for tool use, tracing, and artifact handoff.",
                    "- Transferability: Useful for future adapters that need to prove the Mission -> Workshop -> Forge loop.",
                    "",
                    "## Implementation Plan",
                    "",
                    "- Highest-priority plan step: Review the demo output and decide whether this reference implementation should become a maintained adapter.",
                    "- Implementation steps: tighten docs; add CI coverage if adopted; consider a stable package pin only after human review.",
                    "- Files or instructions likely to change: examples/agents-sdk-demo/; docs/quickstart.md; scripts/verify-mvp.sh.",
                    "- Verification for the first step: Run `sh examples/agents-sdk-demo/verify.sh` and inspect the generated mission/proposal/review files.",
                    "",
                    "## Safety",
                    "",
                    "- Safety risk: A demo that writes files could be mistaken for an accepted Suit capability.",
                    "- Permission or authority changes: None; the demo writes local Markdown only and does not update the capability registry.",
                    "- Human approval required before activation: yes",
                    "",
                    "## Evaluation",
                    "",
                    "- Eval or acceptance test: `sh examples/agents-sdk-demo/verify.sh` creates a dry-run mission, proposal, and Forge review in a temporary output root.",
                    "- Rollback plan: Remove `examples/agents-sdk-demo/` and the documentation links.",
                    "- Open questions: Should future releases add an official adapter registry entry after human approval?",
                    "",
                    "## Decision Handoff",
                    "",
                    "- Recommended decision: review",
                    "- Decision record path: workshop/decisions/",
                    "- Capability registry ID if accepted: agents-sdk-demo-reference",
                    "",
                ]
            ),
            encoding="utf-8",
        )

    if forge_path is not None:
        forge_path.write_text(
            "\n".join(
                [
                    "# Forge Review",
                    "",
                    f"- Review ID: {forge_path.stem}",
                    f"- Date/time: {now} UTC",
                    f"- Proposals reviewed: {proposal_rel}",
                    "- Reviewer: OpenAI Agents SDK demo agent",
                    "",
                    "## Workshop Quality",
                    "",
                    "- Are proposals specific and evidence-backed? yes",
                    "- Are acceptance tests concrete? yes",
                    "- Are safety risks explicit? yes",
                    "- Are activation modes appropriate? yes; human review required",
                    "- Are repeated friction patterns being missed? unknown from one demo run",
                    "- Proposal quality score: 10",
                    "- Process reliability score: 8",
                    "",
                    "## Process Upgrade Candidates",
                    "",
                    f"- Workshop process friction: {clamp(forge_review_summary)}",
                    "- Proposed process change: Keep demo verification separate from acceptance of persistent Suit behavior.",
                    "- Expected effect: Preserves the safety boundary while making runnable examples easier to inspect.",
                    "- Eval for the process change: Confirm the demo verifier writes artifacts but does not write workshop/decisions or capability-registry entries.",
                    "- Rollback plan: Remove the demo verifier or narrow it to mission-only output.",
                    "",
                    "## Decision",
                    "",
                    "- Recommendation: keep as human review required",
                    "- Human approval needed: yes",
                    "- Follow-up proposal path: none",
                    "",
                ]
            ),
            encoding="utf-8",
        )

    return {
        "mission_record": str(mission_path),
        "workshop_proposal": str(proposal_path) if proposal_path else None,
        "forge_review": str(forge_path) if forge_path else None,
        "trace_workflow": WORKFLOW_NAME,
        "trace_id": trace_id,
        "human_review_required": True,
    }


def run_dry_run(args: argparse.Namespace) -> int:
    friction = args.friction or "Dry-run verifier requested Workshop and Forge artifact generation."
    result = write_artifacts(
        output_root=args.output_root,
        mission_summary="Dry-run verifier exercised the HyperAgent artifact writer without making an API call.",
        friction_present=True,
        friction_summary=friction,
        workshop_problem=friction,
        forge_review_summary="The Workshop process needs to distinguish demo artifacts from accepted Suit capabilities.",
        trace_id="dry-run-no-openai-trace",
        dry_run=True,
    )
    print(json.dumps(result, indent=2))
    return 0


def run_live(args: argparse.Namespace) -> int:
    if not os.environ.get("OPENAI_API_KEY"):
        print(
            "OPENAI_API_KEY is required for the live Agents SDK run. "
            "Use --dry-run for local verification without network access.",
            file=sys.stderr,
        )
        return 2

    try:
        from agents import Agent, Runner, flush_traces, function_tool, trace
    except ImportError as exc:
        print(
            "The OpenAI Agents SDK is not installed. Run: "
            "python3 -m pip install -r examples/agents-sdk-demo/requirements.txt",
            file=sys.stderr,
        )
        print(str(exc), file=sys.stderr)
        return 2

    output_root = args.output_root
    trace_id = "trace_" + secrets.token_hex(16)

    @function_tool
    def inspect_hyperagent_workspace() -> str:
        """Inspect local HyperAgent files and artifact counts."""

        return json.dumps(inspect_workspace(output_root), indent=2)

    @function_tool
    def write_hyperagent_artifacts(
        mission_summary: str,
        friction_present: bool,
        friction_summary: str,
        workshop_problem: str,
        forge_review_summary: str,
    ) -> str:
        """Write local HyperAgent mission, Workshop, and Forge artifacts."""

        result = write_artifacts(
            output_root=output_root,
            mission_summary=mission_summary,
            friction_present=friction_present,
            friction_summary=friction_summary,
            workshop_problem=workshop_problem,
            forge_review_summary=forge_review_summary,
            trace_id=trace_id,
            dry_run=False,
        )
        return json.dumps(result, indent=2)

    agent_kwargs: dict[str, Any] = {}
    if args.model:
        agent_kwargs["model"] = args.model

    agent = Agent(
        name="HyperAgent Demo Agent",
        instructions=(
            "You demonstrate HyperAgent's Mission -> Workshop -> Forge loop. "
            "First call inspect_hyperagent_workspace. Then call "
            "write_hyperagent_artifacts exactly once. Keep the safety boundary "
            "`human review required`; do not claim a proposal is accepted. "
            "If friction is provided in the user prompt, set friction_present=true "
            "and create a Workshop proposal and Forge review. Otherwise set "
            "friction_present=false and write only a mission record."
        ),
        tools=[inspect_hyperagent_workspace, write_hyperagent_artifacts],
        **agent_kwargs,
    )

    friction_prompt = (
        f"\nConcrete friction to record: {args.friction}"
        if args.friction
        else "\nNo concrete friction was provided; write a mission record only."
    )
    prompt = args.prompt + friction_prompt

    with trace(
        WORKFLOW_NAME,
        trace_id=trace_id,
        metadata={"demo": "hyperagent", "human_review_required": "true"},
    ):
        result = Runner.run_sync(agent, prompt)

    flush_traces()
    print(result.final_output)
    print(json.dumps({"trace_workflow": WORKFLOW_NAME, "trace_id": trace_id}, indent=2))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the HyperAgent Agents SDK demo.")
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path.cwd(),
        help="Directory where missions/, workshop/, and forge/ artifacts are written.",
    )
    parser.add_argument(
        "--prompt",
        default="Run a small HyperAgent demo mission and preserve the result as local artifacts.",
        help="Prompt sent to the demo agent in live mode.",
    )
    parser.add_argument(
        "--friction",
        default="",
        help="Optional concrete friction that should trigger a Workshop proposal and Forge review.",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("OPENAI_MODEL", ""),
        help="Optional model override. Defaults to the Agents SDK default unless OPENAI_MODEL is set.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Verify artifact generation without importing the Agents SDK or calling OpenAI.",
    )
    args = parser.parse_args()
    args.output_root = args.output_root.resolve()
    return args


def main() -> int:
    args = parse_args()
    if args.dry_run:
        return run_dry_run(args)
    return run_live(args)


if __name__ == "__main__":
    raise SystemExit(main())
