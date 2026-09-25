"""Bobby backend — FastAPI entrypoint for the multi-agent developer workflow.

Exposes:
    GET  /health              -> liveness/readiness probe for the REST clients.
    POST /api/start-workflow  -> trigger the LangGraph agent workflow.
    WS   /ws/agent-stream     -> server -> client log stream for agent activity.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import logging
import math
import time
import urllib.parse
from collections.abc import AsyncIterator
from typing import Any, Dict, List, Tuple

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from agents.graph import run_workflow
from tools.log_bus import emit_agent_event, sanitize_text, stream

APP_NAME = "bobby-backend"
APP_VERSION = "0.2.0"

FRONTEND_ORIGIN = "http://localhost:3000"
START_WORKFLOW_PATH = "/api/start-workflow"

ALLOWED_REPO_SCHEMES = frozenset({"http", "https"})
ALLOWED_REPO_HOSTS = frozenset({"github.com", "www.github.com"})
MAX_REPO_URL_LENGTH = 2048
MAX_ISSUE_DESCRIPTION_LENGTH = 4000

RATE_LIMIT_REQUESTS = 5
RATE_LIMIT_WINDOW_SECONDS = 60.0
MAX_RATE_LIMIT_BUCKETS = 1024

logger = logging.getLogger(APP_NAME)


class StartWorkflowRequest(BaseModel):
    """Validated payload for POST /api/start-workflow (both fields required).

    ``repo_url`` is an allowlist: only public ``github.com`` repository URLs
    survive, which inherently rejects localhost, loopback/private/link-local
    addresses and cloud metadata endpoints. ``issue_description`` is sanitised
    here so nothing downstream ever sees raw markup.
    """

    model_config = ConfigDict(extra="forbid")

    repo_url: str = Field(
        ...,
        max_length=MAX_REPO_URL_LENGTH,
        description="GitHub repo URL (http(s)://github.com/owner/repo)",
    )
    issue_description: str = Field(
        ...,
        min_length=1,
        max_length=MAX_ISSUE_DESCRIPTION_LENGTH,
    )

    @field_validator("repo_url")
    @classmethod
    def validate_repo_url(cls, value: str) -> str:
        """Allow only public github.com repository URLs."""
        raw = value.strip()
        parsed = urllib.parse.urlsplit(raw)

        if parsed.scheme.lower() not in ALLOWED_REPO_SCHEMES:
            raise ValueError("repo_url must use the http or https scheme")
        if parsed.username or parsed.password:
            raise ValueError("repo_url must not embed credentials")
        if not parsed.path.strip("/"):
            raise ValueError("repo_url must include an owner/repository path")

        host = (parsed.hostname or "").lower().rstrip(".")
        if not host:
            raise ValueError("repo_url must include a host")

        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            raise ValueError(
                "repo_url must not target a loopback, private, link-local, "
                "or metadata address"
            )

        if host not in ALLOWED_REPO_HOSTS:
            allowed = ", ".join(sorted(ALLOWED_REPO_HOSTS))
            raise ValueError(f"repo_url host '{host}' is not allowed (allowed: {allowed})")

        return raw

    @field_validator("issue_description")
    @classmethod
    def validate_issue_description(cls, value: str) -> str:
        """Sanitise untrusted text and reject payloads with nothing left."""
        cleaned = sanitize_text(value, max_length=MAX_ISSUE_DESCRIPTION_LENGTH)
        if not cleaned:
            raise ValueError(
                "issue_description must contain text outside of HTML/control characters"
            )
        return cleaned


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Start the log-bus broadcaster; cancel it on shutdown."""
    task = asyncio.create_task(_broadcast_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(title=APP_NAME, version=APP_VERSION, lifespan=lifespan)

_rate_limit_buckets: Dict[str, List[float]] = {}


def _client_ip(request: Request) -> str:
    """Peer address used for rate limiting.

    Only the transport peer is trusted, so a spoofable ``X-Forwarded-For``
    cannot be used to sidestep the limit.
    """
    if request.client is not None and request.client.host:
        return request.client.host
    return "unknown"


def check_rate_limit(key: str) -> Tuple[bool, int]:
    """Consume one request slot for ``key``; returns (allowed, retry_after)."""
    now = time.monotonic()
    window_start = now - RATE_LIMIT_WINDOW_SECONDS
    bucket = [ts for ts in _rate_limit_buckets.get(key, ()) if ts > window_start]

    if len(bucket) >= RATE_LIMIT_REQUESTS:
        _rate_limit_buckets[key] = bucket
        return False, max(1, math.ceil(now - bucket[0]))

    bucket.append(now)
    _rate_limit_buckets[key] = bucket
    if len(_rate_limit_buckets) > MAX_RATE_LIMIT_BUCKETS:
        stale_keys = [k for k, v in _rate_limit_buckets.items() if not v or v[-1] <= window_start]
        for stale in stale_keys:
            _rate_limit_buckets.pop(stale, None)
    return True, 0


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Per-IP request ceiling on the workflow trigger endpoint."""

    async def dispatch(self, request: Request, call_next: Any) -> Any:
        if request.method == "POST" and request.url.path == START_WORKFLOW_PATH:
            allowed, retry_after = check_rate_limit(_client_ip(request))
            if not allowed:
                return JSONResponse(
                    status_code=429,
                    content={
                        "status": "rate_limited",
                        "message": "Too many workflow requests. Please retry shortly.",
                        "retry_after_seconds": retry_after,
                    },
                    headers={"Retry-After": str(retry_after)},
                )
        return await call_next(request)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add conservative security headers to every HTTP response."""

    async def dispatch(self, request: Request, call_next: Any) -> Any:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response


app.add_middleware(RateLimitMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Retry-After"],
)


class ConnectionManager:
    """Tracks connected agent-stream clients and fans out log events to them.

    Log events are structured JSON objects shaped as::

        {
            "type": "agent_event", "level": "info",
            "agent": "investigator", "current_node": "investigator",
            "action": "...", "message": "...",
            "file_path": "src/...", "diff_snippet": "...",
            "progress_percentage": 55.0, "status": "active",
        }

    Sockets are capped at ``MAX_CONNECTIONS`` and reaped when they have been
    silent — in either direction — for longer than ``IDLE_TIMEOUT_SECONDS``.
    The frontend reconnects with backoff, so a reaped socket recovers on its own.
    """

    MAX_CONNECTIONS = 20
    IDLE_TIMEOUT_SECONDS = 300.0

    def __init__(self) -> None:
        self._connections: Dict[WebSocket, float] = {}
        self._lock = asyncio.Lock()

    @property
    def active_connections(self) -> int:
        return len(self._connections)

    async def _close(self, websocket: WebSocket, code: int) -> None:
        with contextlib.suppress(Exception):
            await websocket.close(code=code)

    async def connect(self, websocket: WebSocket) -> bool:
        """Accept and register ``websocket``; False when the cap is reached."""
        await websocket.accept()
        async with self._lock:
            if len(self._connections) >= self.MAX_CONNECTIONS:
                accepted = False
            else:
                self._connections[websocket] = time.monotonic()
                accepted = True
        if not accepted:
            await self._close(websocket, code=1013)
        return accepted

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.pop(websocket, None)

    async def refresh_last_seen(self, websocket: WebSocket) -> None:
        """Record activity on ``websocket``; resets the idle timer."""
        async with self._lock:
            if websocket in self._connections:
                self._connections[websocket] = time.monotonic()

    async def prune_idle(self) -> int:
        """Close sockets idle past the timeout; returns how many were closed."""
        now = time.monotonic()
        async with self._lock:
            idle = [
                websocket
                for websocket, last_seen in self._connections.items()
                if now - last_seen > self.IDLE_TIMEOUT_SECONDS
            ]
            for websocket in idle:
                self._connections.pop(websocket, None)
        for websocket in idle:
            await self._close(websocket, code=1001)
        return len(idle)

    async def broadcast(self, event: Dict[str, Any]) -> None:
        """Send ``event`` to every connected client, dropping dead sockets."""
        await self.prune_idle()
        async with self._lock:
            targets = list(self._connections)

        stale: List[WebSocket] = []
        for connection in targets:
            try:
                await connection.send_json(event)
            except Exception:
                stale.append(connection)
            else:
                await self.refresh_last_seen(connection)

        for connection in stale:
            await self.disconnect(connection)


manager = ConnectionManager()


@app.get("/health")
async def health() -> JSONResponse:
    """Liveness/readiness probe."""
    return JSONResponse(
        {
            "status": "ok",
            "service": APP_NAME,
            "version": APP_VERSION,
            "active_streams": manager.active_connections,
        }
    )


@app.post(START_WORKFLOW_PATH)
async def start_workflow(payload: StartWorkflowRequest) -> JSONResponse:
    """Trigger the LangGraph developer workflow.

    Runs orchestrator -> investigator -> remediation -> validator, with
    conditional retries back to investigator/remediation on test failure.
    Each node publishes rich progress events to ``tools.log_bus`` which are
    forwarded in real time to ``/ws/agent-stream`` clients.
    """
    repo_url = payload.repo_url
    issue_description = payload.issue_description

    emit_agent_event(
        "system",
        f"Workflow started for {repo_url}",
        current_node="system",
        status="started",
        progress_percentage=0.0,
        extra={"repo_url": repo_url, "issue_description": issue_description},
    )
    try:
        final_state = await run_workflow(repo_url, issue_description)
    except Exception:
        logger.exception("workflow run failed for %s", repo_url)
        return JSONResponse(
            status_code=500,
            content={
                "status": "error",
                "service": APP_NAME,
                "message": "Workflow failed unexpectedly. See the agent log stream for details.",
            },
        )
    emit_agent_event(
        "system",
        "Workflow finished",
        current_node="system",
        status="complete",
        progress_percentage=100.0,
        extra={"repo_url": repo_url, "validation_status": final_state.get("validation_status")},
    )
    return JSONResponse(
        {
            "status": "ok",
            "service": APP_NAME,
            "workflow": final_state,
        }
    )


@app.websocket("/ws/agent-stream")
async def agent_stream(websocket: WebSocket) -> None:
    """Pipe live LangGraph state transitions and log-bus events to the client."""
    if not await manager.connect(websocket):
        return

    await websocket.send_json(
        {
            "type": "agent_event",
            "level": "info",
            "agent": "system",
            "current_node": "system",
            "action": "agent-stream connected",
            "message": "agent-stream connected",
            "status": "connected",
            "progress_percentage": 0.0,
        }
    )

    try:
        while True:
            try:
                payload = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=ConnectionManager.IDLE_TIMEOUT_SECONDS,
                )
            except (asyncio.TimeoutError, WebSocketDisconnect):
                break
            await manager.refresh_last_seen(websocket)
            # Inbound control messages (e.g. run/pause/cancel) get an ack.
            try:
                await websocket.send_json(
                    {
                        "type": "ack",
                        "level": "debug",
                        "agent": "system",
                        "message": f"received: {payload}",
                    }
                )
            except Exception:
                break
    finally:
        await manager.disconnect(websocket)


async def _broadcast_loop() -> None:
    """Forward every event on the log bus to all connected frontend clients."""
    async for event in stream():
        await manager.broadcast(event)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
