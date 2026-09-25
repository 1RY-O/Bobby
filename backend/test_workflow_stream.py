"""Automated verification for the Bobby multi-agent workflow.

Spins up ``uvicorn main:app`` as a subprocess, opens a WebSocket to
``/ws/agent-stream`` *before* triggering ``POST /api/start-workflow``,
then asserts the full ``orchestrator -> investigator -> remediation ->
validator`` transition sequence streams in real time with rich metrics.

Also covers the security hardening: the ``repo_url`` allowlist, issue-text
sanitisation, the per-IP rate limit, the WebSocket connection cap, and idle
socket reaping.

Run from the ``backend/`` directory::

    python test_workflow_stream.py
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

import httpx

BASE_HOST = "127.0.0.1"
BASE_PORT = 8000
BASE_HTTP = f"http://{BASE_HOST}:{BASE_PORT}"
BASE_WS = f"ws://{BASE_HOST}:{BASE_PORT}/ws/agent-stream"

PAYLOAD = {
    "repo_url": "https://github.com/example/demo",
    "issue_description": "Login endpoint returns 500 in src/auth/login.py",
}

EXPECTED_ORDER = ["orchestrator", "investigator", "remediation", "validator"]

WS_MAX_CONNECTIONS = 20
RATE_LIMIT_REQUESTS = 5

REJECTED_REPO_URLS = [
    "http://localhost:8000/admin",
    "http://127.0.0.1/admin",
    "http://10.0.0.5/admin",
    "http://192.168.1.10/admin",
    "http://172.16.5.4/admin",
    "http://169.254.169.254/latest/meta-data/",
    "https://user:pass@github.com/example/demo",
    "https://github.com.evil.example/demo",
    "file:///etc/passwd",
]


async def wait_for_health(timeout: float = 25.0) -> None:
    deadline = time.time() + timeout
    async with httpx.AsyncClient() as client:
        while time.time() < deadline:
            try:
                resp = await client.get(f"{BASE_HTTP}/health")
                if resp.status_code == 200:
                    return
            except Exception:
                pass
            await asyncio.sleep(0.4)
    raise RuntimeError("backend /health never became ready")


async def collect_websocket_events(stop: asyncio.Event, out: list) -> None:
    import websockets

    async with websockets.connect(BASE_WS) as ws:
        # Consume the connect greeting, then every streamed agent event.
        while not stop.is_set():
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            try:
                out.append(json.loads(raw))
            except Exception:
                continue


async def run_checks() -> None:
    # Verify CORS preflight for the frontend origin.
    async with httpx.AsyncClient() as client:
        preflight = await client.options(
            f"{BASE_HTTP}/api/start-workflow",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert preflight.headers.get("access-control-allow-origin") in (
            "http://localhost:3000",
            "*",
        ), f"CORS missing for localhost:3000: {dict(preflight.headers)}"
        print("PASS cors preflight allows http://localhost:3000")

    events: list[dict] = []
    stop = asyncio.Event()
    listener = asyncio.create_task(collect_websocket_events(stop, events))
    await asyncio.sleep(0.5)  # ensure WS is subscribed before triggering work

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{BASE_HTTP}/api/start-workflow",
            json=PAYLOAD,
            headers={"Origin": "http://localhost:3000"},
        )
    assert resp.status_code == 200, f"POST failed: {resp.status_code} {resp.text}"
    assert resp.headers.get("x-content-type-options") == "nosniff", dict(resp.headers)
    body = resp.json()
    workflow = body.get("workflow", {})
    assert workflow.get("validation_status") == "passed", workflow
    assert workflow.get("current_agent") == "validator", workflow
    assert workflow.get("status") == "complete", workflow
    print("PASS POST /api/start-workflow returned complete validator state")

    # Give the broadcast loop a moment to flush trailing events.
    await asyncio.sleep(1.5)
    stop.set()
    await listener

    seq = [e.get("current_node") or e.get("agent") for e in events]
    print(f"collected {len(events)} websocket events: {seq}")

    # Assert ordered agent transitions.
    positions = {}
    for idx, name in enumerate(seq):
        if name in EXPECTED_ORDER and name not in positions:
            positions[name] = idx
    missing = [a for a in EXPECTED_ORDER if a not in positions]
    assert not missing, f"missing agent transitions on WS: {missing} (got {seq})"
    ordered = [positions[a] for a in EXPECTED_ORDER]
    assert ordered == sorted(ordered), f"bad transition order: {seq}"
    print("PASS websocket order orchestrator -> investigator -> remediation -> validator")

    agent_events = [e for e in events if e.get("type") == "agent_event"]
    assert agent_events, "no agent_event frames received"
    assert any(e.get("file_path") for e in agent_events), "no file_path metric streamed"
    assert any(e.get("diff_snippet") for e in agent_events), "no diff_snippet metric streamed"
    assert any(
        isinstance(e.get("progress_percentage"), (int, float)) for e in agent_events
    ), "no progress_percentage metric streamed"
    print("PASS rich metrics present (file_path, diff_snippet, progress_percentage)")

    await check_security_hardening()
    await check_ws_connection_cap()
    await check_idle_reaping()


async def check_security_hardening() -> None:
    """Allowlisted repo URLs, sanitised issue text, and a clean 429.

    The allowlist itself is checked against the request model so it costs no
    rate-limit budget; HTTP then proves the model is wired to the endpoint.
    """
    from pydantic import ValidationError

    from main import StartWorkflowRequest

    for repo_url in REJECTED_REPO_URLS:
        try:
            StartWorkflowRequest(repo_url=repo_url, issue_description="anything")
        except ValidationError:
            continue
        raise AssertionError(f"repo_url was accepted: {repo_url}")
    StartWorkflowRequest(repo_url=PAYLOAD["repo_url"], issue_description="anything")
    print(f"PASS repo_url allowlist rejected {len(REJECTED_REPO_URLS)} unsafe URLs")

    hostile_issue = (
        "<script>alert('xss')</script>Login returns 500\x00\x07 "
        "<b>GET /login</b> [fail-investigator]"
    )
    async with httpx.AsyncClient(timeout=30.0) as client:
        rejected = await client.post(
            f"{BASE_HTTP}/api/start-workflow",
            json={"repo_url": REJECTED_REPO_URLS[0], "issue_description": "anything"},
        )
        assert rejected.status_code == 422, f"expected 422: {rejected.text}"
        assert "traceback" not in rejected.text.lower(), rejected.text
        print("PASS unsafe repo_url rejected over HTTP with 422")

        resp = await client.post(
            f"{BASE_HTTP}/api/start-workflow",
            json={"repo_url": PAYLOAD["repo_url"], "issue_description": hostile_issue},
        )
        assert resp.status_code == 200, f"sanitised POST failed: {resp.status_code} {resp.text}"
        sanitized = resp.json()["workflow"]["issue_description"]
        assert "<" not in sanitized and ">" not in sanitized, sanitized
        assert "script" not in sanitized.lower(), sanitized
        assert "\x00" not in sanitized, repr(sanitized)
        assert "[fail-investigator]" in sanitized, sanitized
        assert "GET /login" in sanitized, sanitized
        assert resp.json()["workflow"]["validation_status"] == "passed"
        print(f"PASS issue_description sanitised, fail token preserved: {sanitized!r}")

        statuses: list[int] = []
        limited = None
        for _ in range(RATE_LIMIT_REQUESTS + 3):
            resp = await client.post(
                f"{BASE_HTTP}/api/start-workflow",
                json={"repo_url": REJECTED_REPO_URLS[0], "issue_description": "anything"},
                headers={"Origin": "http://localhost:3000"},
            )
            statuses.append(resp.status_code)
            if resp.status_code == 429:
                limited = resp
                break
    assert limited is not None, f"rate limit never triggered: {statuses}"
    body = limited.json()
    assert body.get("status") == "rate_limited", body
    assert int(limited.headers.get("retry-after", "0")) > 0, dict(limited.headers)
    assert limited.headers.get("access-control-allow-origin") == "http://localhost:3000", (
        dict(limited.headers)
    )
    assert "traceback" not in json.dumps(body).lower(), body
    print(f"PASS rate limit returned clean 429 after {len(statuses)} requests: {body}")


async def check_ws_connection_cap() -> None:
    """The 21st concurrent stream socket is rejected."""
    import websockets

    sockets = await asyncio.gather(
        *(websockets.connect(BASE_WS) for _ in range(WS_MAX_CONNECTIONS))
    )
    try:
        await asyncio.sleep(0.5)
        async with httpx.AsyncClient() as client:
            health = await client.get(f"{BASE_HTTP}/health")
        assert health.json()["active_streams"] >= WS_MAX_CONNECTIONS, health.text

        extra = await websockets.connect(BASE_WS)
        closed = False
        try:
            await asyncio.wait_for(extra.recv(), timeout=3.0)
        except websockets.exceptions.ConnectionClosed:
            closed = True
        finally:
            await extra.close()
        assert closed, "agent stream accepted a socket past the connection cap"
        print(f"PASS agent stream capped at {WS_MAX_CONNECTIONS} concurrent connections")
    finally:
        await asyncio.gather(*(ws.close() for ws in sockets), return_exceptions=True)


async def check_idle_reaping() -> None:
    """Sockets silent past the idle timeout are closed and unregistered."""
    from main import ConnectionManager

    class _StubSocket:
        def __init__(self) -> None:
            self.closed_with: int | None = None

        async def close(self, code: int = 1000) -> None:
            self.closed_with = code

    manager = ConnectionManager()
    idle, fresh = _StubSocket(), _StubSocket()
    manager._connections[idle] = time.monotonic() - (ConnectionManager.IDLE_TIMEOUT_SECONDS + 1)
    manager._connections[fresh] = time.monotonic()

    removed = await manager.prune_idle()
    assert removed == 1, removed
    assert idle.closed_with == 1001, idle.closed_with
    assert fresh.closed_with is None, fresh.closed_with
    assert list(manager._connections) == [fresh], manager._connections
    print(f"PASS idle sockets reaped after {ConnectionManager.IDLE_TIMEOUT_SECONDS:.0f}s")


def main() -> int:
    backend_dir = Path(__file__).resolve().parent
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--host", BASE_HOST, "--port", str(BASE_PORT)],
        cwd=str(backend_dir),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        asyncio.run(_main_async())
        print("ALL CHECKS PASSED")
        return 0
    except AssertionError as exc:
        print(f"FAIL: {exc}")
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}")
        return 2
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


async def _main_async() -> None:
    await wait_for_health()
    await asyncio.sleep(1.0)  # settle: let the ASGI app finish startup routing
    print("backend ready, running checks...")
    await run_checks()


if __name__ == "__main__":
    raise SystemExit(main())
