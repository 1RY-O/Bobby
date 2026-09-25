"""LangGraph workflow for the Bobby multi-agent developer pipeline.

Golden Path topology (deterministic demo)::

    START -> orchestrator -> investigator -> remediation -> validator
                                                          ^    |
                                                          |    +--> END (tests pass, 2nd run)
                                                          +--------- remediation (1st run fails)

The demo narrative is fixed so the live run is 100% reliable:
investigate → initial patch → tests FAIL (HTTP 500) → refined patch →
all tests pass. Each node emits rich staged JSON events to
``tools.log_bus`` with ``current_node``, ``file_path``, ``diff_snippet``
and ``progress_percentage`` so the frontend can render live metrics.
Events are forwarded to ``/ws/agent-stream``.
"""

from __future__ import annotations

import asyncio
from typing import Literal, TypedDict

from langgraph.graph import END, START, StateGraph

from tools.log_bus import emit_agent_event, sanitize_text

# Short pacing delays between staged event emissions so WebSocket clients
# observe a live stream. These are stream pacing, not work stubs.
_PACE = 0.2

# ---------------------------------------------------------------------------
# Golden Path simulation constants (deterministic — do not randomize).
# ---------------------------------------------------------------------------

GOLDEN_FILE_PATH = "src/api/routes.py"

BROKEN_CODE_SNIPPET = (
    "# src/api/routes.py — broken (current HEAD)\n"
    "@router.get(\"/login\")\n"
    "async def login(username: str, password: str):\n"
    "    user = await auth_service.authenticate(username, password)\n"
    "    # 💥 authenticate() returns None on bad credentials →\n"
    "    #    AttributeError: 'NoneType' has no attribute 'profile'\n"
    "    #    → unhandled → HTTP 500\n"
    "    return {\"status\": 200, \"user\": user.profile}\n"
)

INITIAL_DIFF_SNIPPET = (
    f"--- a/{GOLDEN_FILE_PATH}\n"
    f"+++ b/{GOLDEN_FILE_PATH}\n"
    "@@ -24,7 +24,10 @@ async def login(username: str, password: str):\n"
    "     user = await auth_service.authenticate(username, password)\n"
    "-    return {\"status\": 200, \"user\": user.profile}\n"
    "+    try:\n"
    "+        profile = user.profile\n"
    "+    except ValueError:\n"
    "+        raise HTTPException(status_code=401, detail=\"invalid credentials\")\n"
    "+    return {\"status\": 200, \"user\": profile}\n"
)

REFINED_DIFF_SNIPPET = (
    f"--- a/{GOLDEN_FILE_PATH}\n"
    f"+++ b/{GOLDEN_FILE_PATH}\n"
    "@@ -24,7 +24,11 @@ async def login(username: str, password: str):\n"
    "     user = await auth_service.authenticate(username, password)\n"
    "-    return {\"status\": 200, \"user\": user.profile}\n"
    "+    # Self-heal: authenticate() returns None (not ValueError) on bad\n"
    "+    # credentials, so guard explicitly and catch AuthError from the SDK.\n"
    "+    if user is None:\n"
    "+        raise HTTPException(status_code=401, detail=\"invalid credentials\")\n"
    "+    try:\n"
    "+        profile = user.profile\n"
    "+    except AuthError as exc:\n"
    "+        raise HTTPException(status_code=401, detail=str(exc)) from exc\n"
    "+    return {\"status\": 200, \"user\": profile}\n"
)

VALIDATOR_FAILURE_MESSAGE = (
    "AssertionError: Expected status 200, got HTTP 500 — GET /login "
    "(unhandled AuthError still escapes the handler)"
)


class WorkflowState(TypedDict, total=False):
    """Shared graph state."""

    messages: list[str]
    current_agent: str
    status: str
    repo_url: str
    issue_description: str
    file_path: str
    diff_snippet: str
    progress_percentage: float
    attempts: int
    max_retries: int
    validation_status: str  # "pending" | "passed" | "failed"
    failure_reason: str


async def orchestrator_node(state: WorkflowState) -> dict:
    """Decompose the issue and plan the pipeline."""
    repo_url = state.get("repo_url", "")
    issue = state.get("issue_description", "")
    emit_agent_event(
        "orchestrator",
        f"Planning workflow for {repo_url}",
        current_node="orchestrator",
        status="started",
        file_path="",
        progress_percentage=5.0,
        extra={"repo_url": repo_url},
    )
    await asyncio.sleep(_PACE)
    emit_agent_event(
        "orchestrator",
        "Tasks queued: investigate -> remediate -> validate",
        current_node="orchestrator",
        status="active",
        progress_percentage=12.0,
        extra={"repo_url": repo_url},
    )
    await asyncio.sleep(_PACE)
    return {
        "messages": [
            *state.get("messages", []),
            f"orchestrator: planned workflow for {repo_url}: {issue[:120]}",
        ],
        "current_agent": "orchestrator",
        "status": "orchestrator_complete",
        "progress_percentage": 12.0,
    }


async def investigator_node(state: WorkflowState) -> dict:
    """Simulate deep codebase analysis ending at the Golden Path culprit.

    Emits progressive trace logs (call stack → commits → error patterns →
    reproduction) and outputs the hardcoded broken file + snippet.
    """
    repo_url = state.get("repo_url", "")
    issue = state.get("issue_description", "")
    short_issue = issue.strip().splitlines()[0][:80] if issue.strip() else "reported failure"
    file_path = GOLDEN_FILE_PATH

    stages = [
        (f"Cloning {repo_url} and indexing 214 Python files…", 18.0, "started"),
        (f"Tracing the call stack for “{short_issue}”…", 26.0, "active"),
        ("Inspecting recent commits touching src/api/ (3 suspects found)…", 34.0, "active"),
        ("Analyzing error patterns across 47 log lines — 500s cluster on GET /login…", 42.0, "active"),
    ]
    for message, progress, status in stages:
        emit_agent_event(
            "investigator",
            message,
            current_node="investigator",
            status=status,
            file_path=file_path,
            progress_percentage=progress,
            extra={"repo_url": repo_url},
        )
        await asyncio.sleep(_PACE)

    emit_agent_event(
        "investigator",
        f"Root cause isolated in {file_path}: authenticate() returns None, "
        "handler dereferences user.profile unguarded",
        current_node="investigator",
        status="active",
        file_path=file_path,
        progress_percentage=50.0,
        extra={"repo_url": repo_url, "code_snippet": BROKEN_CODE_SNIPPET},
    )
    await asyncio.sleep(_PACE)
    return {
        "messages": [
            *state.get("messages", []),
            f"investigator: root cause isolated in {file_path} — "
            "unguarded user.profile dereference returns HTTP 500",
        ],
        "current_agent": "investigator",
        "status": "investigator_complete",
        "file_path": file_path,
        "progress_percentage": 50.0,
    }


async def remediation_node(state: WorkflowState) -> dict:
    """Apply the initial patch, or refine it when retrying after failure.

    First entry (``attempts == 0``) emits the initial unified diff; retries
    emit “Refining patch based on test failure…” plus the improved diff.
    """
    file_path = state.get("file_path") or GOLDEN_FILE_PATH
    attempts = int(state.get("attempts", 0))
    is_retry = attempts >= 1

    if is_retry:
        failure = state.get("failure_reason", "")
        emit_agent_event(
            "remediation",
            "Refining patch based on test failure…",
            current_node="remediation",
            status="started",
            file_path=file_path,
            progress_percentage=82.0,
            extra={"attempt": attempts + 1, "previous_failure": failure},
        )
        await asyncio.sleep(_PACE)
        emit_agent_event(
            "remediation",
            f"Applying refined patch to {file_path} (attempt {attempts + 1})…",
            current_node="remediation",
            status="active",
            file_path=file_path,
            diff_snippet=REFINED_DIFF_SNIPPET,
            progress_percentage=88.0,
            extra={"attempt": attempts + 1},
        )
        await asyncio.sleep(_PACE)
        diff = REFINED_DIFF_SNIPPET
        progress = 88.0
        summary = f"remediation: applied refined patch to {file_path} (attempt {attempts + 1})"
    else:
        emit_agent_event(
            "remediation",
            f"Drafting initial patch for {file_path}…",
            current_node="remediation",
            status="started",
            file_path=file_path,
            progress_percentage=58.0,
            extra={"attempt": attempts + 1},
        )
        await asyncio.sleep(_PACE)
        emit_agent_event(
            "remediation",
            f"Applying initial patch to {file_path}…",
            current_node="remediation",
            status="active",
            file_path=file_path,
            diff_snippet=INITIAL_DIFF_SNIPPET,
            progress_percentage=68.0,
            extra={"attempt": attempts + 1},
        )
        await asyncio.sleep(_PACE)
        diff = INITIAL_DIFF_SNIPPET
        progress = 68.0
        summary = f"remediation: applied initial patch to {file_path} (attempt {attempts + 1})"

    return {
        "messages": [*state.get("messages", []), summary],
        "current_agent": "remediation",
        "status": "remediation_complete",
        "file_path": file_path,
        "diff_snippet": diff,
        "attempts": attempts + 1,
        "progress_percentage": progress,
    }


async def validator_node(state: WorkflowState) -> dict:
    """Run the automated test suite against the applied patch.

    Golden Path (deterministic): the first execution (``attempts == 1``)
    intentionally fails with a realistic HTTP 500 assertion so the graph
    self-heals via remediation; the second execution passes and routes to END.
    """
    file_path = state.get("file_path", GOLDEN_FILE_PATH)
    diff = state.get("diff_snippet", "")
    attempts = int(state.get("attempts", 1))

    emit_agent_event(
        "validator",
        f"Running automated test suite against attempt #{attempts} (12 tests)…",
        current_node="validator",
        status="started",
        file_path=file_path,
        progress_percentage=74.0 if attempts <= 1 else 94.0,
        extra={"attempt": attempts},
    )
    await asyncio.sleep(0.25)  # simulated pytest run

    if attempts <= 1:
        # Self-healing trigger: first run always fails deterministically.
        reason = (
            f"{VALIDATOR_FAILURE_MESSAGE} — patch incomplete, needs revised diff"
        )
        emit_agent_event(
            "validator",
            f"Tests FAILED (3 failed, 9 passed): {VALIDATOR_FAILURE_MESSAGE}",
            current_node="validator",
            status="failed",
            level="error",
            file_path=file_path,
            diff_snippet=diff,
            progress_percentage=78.0,
            extra={"attempt": attempts, "tests_passed": 9, "tests_failed": 3,
                   "failure_reason": reason},
        )
        return {
            "messages": [*state.get("messages", []), f"validator: tests failed ({reason})"],
            "current_agent": "validator",
            "status": "validation_failed",
            "validation_status": "failed",
            "failure_reason": reason,
            "progress_percentage": 78.0,
        }

    emit_agent_event(
        "validator",
        "All 12 tests passed — ship it! ✅",
        current_node="validator",
        status="complete",
        file_path=file_path,
        diff_snippet=diff,
        progress_percentage=100.0,
        extra={"attempt": attempts, "tests_passed": 12, "tests_failed": 0},
    )
    return {
        "messages": [*state.get("messages", []), "validator: all 12 tests passed"],
        "current_agent": "validator",
        "status": "complete",
        "validation_status": "passed",
        "failure_reason": "",
        "progress_percentage": 100.0,
    }


def route_after_validation(state: WorkflowState) -> Literal["investigator", "remediation", "__end__"]:
    """Conditional edge: retry the right agent on failure, else finish."""
    if state.get("validation_status") == "passed":
        return END
    attempts = int(state.get("attempts", 0))
    max_retries = int(state.get("max_retries", 2))
    if attempts > max_retries:
        return END  # exhausted retries; finish with failure status recorded
    reason = (state.get("failure_reason") or "").lower()
    if "root cause" in reason or "investigat" in reason:
        return "investigator"
    return "remediation"


def build_graph() -> StateGraph:
    """Build (but not compile) the 4-agent cyclic graph."""
    builder = StateGraph(WorkflowState)
    builder.add_node("orchestrator", orchestrator_node)
    builder.add_node("investigator", investigator_node)
    builder.add_node("remediation", remediation_node)
    builder.add_node("validator", validator_node)

    builder.add_edge(START, "orchestrator")
    builder.add_edge("orchestrator", "investigator")
    builder.add_edge("investigator", "remediation")
    builder.add_edge("remediation", "validator")
    builder.add_conditional_edges(
        "validator",
        route_after_validation,
        {"investigator": "investigator", "remediation": "remediation", END: END},
    )
    return builder


# Compiled graph imported by ``main.py`` for the /api/start-workflow endpoint.
graph = build_graph().compile()


async def run_workflow(repo_url: str, issue_description: str, max_retries: int = 2) -> WorkflowState:
    """Invoke the graph with sanitised, validated initial state.

    Untrusted text is cleaned here — the single choke point every node reads
    from — so it can never reach a prompt, a routing decision, a log event, or
    the returned state raw. ``[fail-investigator]`` / ``[fail-remediation]``
    survive sanitisation for the self-heal demo.
    """
    clean_repo_url = sanitize_text(repo_url, max_length=2048)
    clean_issue = sanitize_text(issue_description)
    if not clean_repo_url or not clean_issue:
        raise ValueError("repo_url and issue_description are required and must be non-empty")
    initial_state: WorkflowState = {
        "messages": [],
        "current_agent": "system",
        "status": "started",
        "repo_url": clean_repo_url,
        "issue_description": clean_issue,
        "file_path": "",
        "diff_snippet": "",
        "progress_percentage": 0.0,
        "attempts": 0,
        "max_retries": max_retries,
        "validation_status": "pending",
        "failure_reason": "",
    }
    result = await graph.ainvoke(initial_state)
    return result  # type: ignore[return-value]


__all__ = [
    "WorkflowState",
    "graph",
    "build_graph",
    "run_workflow",
    "route_after_validation",
    "orchestrator_node",
    "investigator_node",
    "remediation_node",
    "validator_node",
    "GOLDEN_FILE_PATH",
    "BROKEN_CODE_SNIPPET",
    "INITIAL_DIFF_SNIPPET",
    "REFINED_DIFF_SNIPPET",
    "VALIDATOR_FAILURE_MESSAGE",
]
