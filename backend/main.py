"""Bobby backend — FastAPI entrypoint for the multi-agent developer workflow.

Exposes:
    GET  /health              -> liveness/readiness probe for the REST clients.
    POST /api/start-workflow  -> trigger the LangGraph agent workflow.
    WS   /ws/agent-stream     -> server -> client log stream for agent activity.

Security posture (see ``tools/guardrails.py`` for the untrusted-text helpers):
    - CORS is an explicit origin allowlist (never a wildcard), driven by env.
    - ``/api/start-workflow`` is rate limited per transport peer.
    - The WebSocket upgrade is origin-checked, so only the real frontend may
      subscribe to the agent stream.
    - Request bodies are size-capped before parsing.
    - Untrusted text is sanitised *and* injection-neutralised at the edge.
    - Interactive API docs and the autoreloader are disabled when APP_ENV is
      production, so the schema and tracebacks are not publicly readable.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import logging
import math
import os
import time
import urllib.parse
from collections.abc import AsyncIterator
from typing import Any, Dict, List, Tuple

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from agents.graph import run_workflow
from tools.guardrails import (
    contains_injection,
    neutralize_prompt_injection,
    redact_secrets,
)
from tools.log_bus import emit_agent_event, sanitize_text, stream

APP_NAME = "bobby-backend"
APP_VERSION = "0.2.0"

START_WORKFLOW_PATH = "/api/start-workflow"
AGENT_STREAM_PATH = "/ws/agent-stream"


def _env_flag(name: str, default: bool = False) -> bool:
    """Parse a boolean env var without ever raising on a malformed value."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, *, minimum: int = 0, maximum: int | None = None) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        value = default
    else:
        try:
            value = int(raw.strip())
        except ValueError:
            # Deliberately not `logger.warning`: this runs at import time, before
            # the module logger exists, and a misconfigured env var must degrade
            # to the default rather than abort the process with a NameError.
            print(f"WARNING: invalid integer for {name}; using default {default}", flush=True)
            value = default
    value = max(minimum, value)
    return min(value, maximum) if maximum is not None else value


def _env_list(name: str, default: str) -> List[str]:
    """Comma-separated env list, whitespace-trimmed, empties dropped."""
    raw = os.getenv(name) or default
    return [item.strip().rstrip("/") for item in raw.split(",") if item.strip()]


# `APP_ENV=production` flips off debug surfaces (docs, schema, autoreload) and
# tightens the response surface. Anything else is treated as development.
APP_ENV = (os.getenv("APP_ENV") or "development").strip().lower()
IS_PRODUCTION = APP_ENV in {"production", "prod"}

# Only these origins may call the API. Defaults to the local dev server; a
# deployed instance MUST set FRONTEND_ORIGINS explicitly.
FRONTEND_ORIGINS = _env_list("FRONTEND_ORIGINS", "http://localhost:3000")
FRONTEND_ORIGIN = FRONTEND_ORIGINS[0]  # backwards-compatible single-origin view

ALLOWED_METHODS = ["GET", "POST", "OPTIONS"]
ALLOWED_HEADERS = ["Accept", "Content-Type"]

ALLOWED_REPO_SCHEMES = frozenset({"http", "https"})
ALLOWED_REPO_HOSTS = frozenset({"github.com", "www.github.com"})
MAX_REPO_URL_LENGTH = 2048
MAX_ISSUE_DESCRIPTION_LENGTH = 4000

RATE_LIMIT_REQUESTS = _env_int("RATE_LIMIT_REQUESTS", 5, minimum=1, maximum=1000)
RATE_LIMIT_WINDOW_SECONDS = float(
    _env_int("RATE_LIMIT_WINDOW_SECONDS", 60, minimum=1, maximum=3600)
)
MAX_RATE_LIMIT_BUCKETS = _env_int("MAX_RATE_LIMIT_BUCKETS", 1024, minimum=16, maximum=65536)

# Hard cap on a request body, so a malicious client cannot exhaust memory
# before Pydantic validation runs. Generous vs. the real payload ceiling
# (2048 + 4000 chars) but bounded.
MAX_REQUEST_BODY_BYTES = _env_int(
    "MAX_REQUEST_BODY_BYTES", 64 * 1024, minimum=4096, maximum=8 * 1024 * 1024
)

# GZip floor: only compress responses that are actually worth compressing.
GZIP_MINIMUM_SIZE = _env_int("GZIP_MINIMUM_SIZE", 1024, minimum=0, maximum=65536)

# How much of the graph's internal message transcript to echo in the HTTP
# response. Defaults to 0 (no echo): the transcript embeds the caller's own
# issue text and grows on every node, so it is dead weight on the wire and a
# needless copy of untrusted input. The live narration already reaches the UI
# over the agent stream. Raise it only for local debugging.
MAX_ECHOED_MESSAGES = _env_int("MAX_ECHOED_MESSAGES", 0, minimum=0, maximum=200)

# Concurrency guard so one client cannot pin the event loop with overlapping
# workflow runs. The graph itself is unchanged.
MAX_CONCURRENT_WORKFLOWS = _env_int("MAX_CONCURRENT_WORKFLOWS", 4, minimum=1, maximum=64)

logger = logging.getLogger(APP_NAME)


class StartWorkflowRequest(BaseModel):
    """Validated payload for POST /api/start-workflow (both fields required).

    ``repo_url`` is an allowlist: only public ``github.com`` repository URLs
    survive, which inherently rejects localhost, loopback/private/link-local
    addresses and cloud metadata endpoints. ``issue_description`` is sanitised
    here so nothing downstream ever sees raw markup.

    ``extra="forbid"`` is the mass-assignment guard: an attacker cannot smuggle
    ``max_retries`` (or any other graph-state key) in alongside the two fields
    to steer the pipeline.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)

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
        """Sanitise, injection-neutralise, and re-redact untrusted prose.

        Three layers, cheapest first:
          1. ``sanitize_text``      — strips HTML/control/bidi characters (XSS).
          2. ``neutralize_prompt_injection`` — blanks instruction-override,
             persona-hijack, exfiltration, delimiter-spoof and command-injection
             attempts, preserving length so the graph's slicing is unaffected.
          3. ``redact_secrets``     — masks any credential the user pasted in,
             so it can never be echoed in a response or written to a log.
        """
        cleaned = sanitize_text(value, max_length=MAX_ISSUE_DESCRIPTION_LENGTH)
        if not cleaned:
            raise ValueError(
                "issue_description must contain text outside of HTML/control characters"
            )

        if contains_injection(cleaned):
            logger.warning(
                "neutralised a prompt-injection attempt in issue_description"
            )
        cleaned = neutralize_prompt_injection(cleaned).strip()
        if not cleaned:
            raise ValueError(
                "issue_description contained no usable text after sanitisation"
            )

        return redact_secrets(cleaned, max_length=MAX_ISSUE_DESCRIPTION_LENGTH)


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


# Interactive docs + the OpenAPI schema are an information-disclosure surface
# (they publish the exact request schema and every error path), so they are
# only mounted outside production. `redoc_url`/`openapi_url` are the two that
# leak the schema; `docs_url` is the Swagger UI itself.
app = FastAPI(
    title=APP_NAME,
    version=APP_VERSION,
    lifespan=lifespan,
    docs_url=None if IS_PRODUCTION else "/docs",
    redoc_url=None if IS_PRODUCTION else "/redoc",
    openapi_url=None if IS_PRODUCTION else "/openapi.json",
)

_rate_limit_buckets: Dict[str, List[float]] = {}


def _client_ip(request: Request) -> str:
    """Peer address used for rate limiting.

    Only the transport peer is trusted, so a spoofable ``X-Forwarded-For``
    cannot be used to sidestep the limit. Behind a trusted reverse proxy the
    proxy's own address is what we see, which is the correct (conservative)
    behaviour: all clients then share one bucket rather than getting an
    unlimited supply by forging headers.
    """
    if request.client is not None and request.client.host:
        return request.client.host
    return "unknown"


def is_origin_allowed(origin: str | None) -> bool:
    """True when ``origin`` is one of the configured frontend origins.

    A missing/empty Origin is treated as allowed: browsers always send Origin on
    a cross-origin WebSocket handshake, so its absence indicates a non-browser
    client (the integration test harness, curl, a service worker on a same-origin
    page) rather than an attempt to bypass the check.
    """
    if not origin:
        return True
    return origin.strip().rstrip("/") in FRONTEND_ORIGINS


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


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    """Reject over-sized bodies from the declared Content-Length.

    A Content-Length above the cap is refused with 413 *before* the body is read
    into memory. Requests without a Content-Length (chunked) are let through to
    the router, where the field-level ``max_length`` caps still apply — this is
    a cheap first line of defence, not the only one.
    """

    async def dispatch(self, request: Request, call_next: Any) -> Any:
        if request.method in {"POST", "PUT", "PATCH"}:
            raw_length = request.headers.get("content-length")
            if raw_length:
                try:
                    declared = int(raw_length)
                except ValueError:
                    return JSONResponse(
                        status_code=400,
                        content={"status": "error", "message": "invalid Content-Length"},
                    )
                if declared > MAX_REQUEST_BODY_BYTES:
                    return JSONResponse(
                        status_code=413,
                        content={
                            "status": "error",
                            "message": "request body too large",
                        },
                    )
        return await call_next(request)


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
        # The API only ever returns JSON: forbid the browser from sniffing an
        # HTML/JS interpretation, and forbid any framing of the probe.
        response.headers.setdefault("Cache-Control", "no-store")
        if IS_PRODUCTION:
            response.headers["Strict-Transport-Security"] = (
                "max-age=63072000; includeSubDomains"
            )
        return response


# Middleware order note: Starlette executes middleware in reverse registration
# order, so the last one added is the outermost. GZip sits outermost so it can
# compress the responses produced by everything below it.
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(BodySizeLimitMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(
    GZipMiddleware,
    minimum_size=GZIP_MINIMUM_SIZE,
    compresslevel=6,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,  # explicit allowlist, never "*"
    allow_credentials=True,
    allow_methods=ALLOWED_METHODS,
    allow_headers=ALLOWED_HEADERS,
    expose_headers=["Retry-After"],
    max_age=600,
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

# In-flight workflow runs, so a burst cannot monopolise the event loop.
_workflow_slots = asyncio.Semaphore(MAX_CONCURRENT_WORKFLOWS)


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


def _summarise_workflow_state(state: Dict[str, Any]) -> Dict[str, Any]:
    """Compact, non-sensitive view of the graph result for the HTTP response.

    The frontend only reads ``validation_status``; echoing the whole state would
    ship the full node transcript (unbounded — it grows on every node) plus the
    caller's own ``issue_description`` straight back to them. So: a bounded tail
    of redacted messages, no raw user input, and no credential-shaped strings.
    """
    messages = state.get("messages")
    summary: Dict[str, Any] = {
        "current_agent": state.get("current_agent"),
        "status": state.get("status"),
        "validation_status": state.get("validation_status"),
        "attempts": state.get("attempts"),
        "progress_percentage": state.get("progress_percentage"),
        "file_path": redact_secrets(str(state.get("file_path", "")), max_length=256),
    }

    if isinstance(messages, list) and MAX_ECHOED_MESSAGES:
        tail = messages[-MAX_ECHOED_MESSAGES:]
        summary["messages"] = [
            redact_secrets(str(message), max_length=300) for message in tail
        ]
    return summary


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

    if _workflow_slots.locked():
        return JSONResponse(
            status_code=503,
            content={
                "status": "busy",
                "service": APP_NAME,
                "message": "Workflow capacity reached. Please retry shortly.",
            },
            headers={"Retry-After": "5"},
        )

    async with _workflow_slots:
        emit_agent_event(
            "system",
            f"Workflow started for {repo_url}",
            current_node="system",
            status="started",
            progress_percentage=0.0,
            # The issue text is deliberately NOT echoed into the event bus: it
            # would land in every connected client's log buffer.
            extra={"repo_url": repo_url},
        )
        try:
            final_state = await run_workflow(repo_url, issue_description)
        except Exception:
            # Log the repo URL only, and only after redaction: an exception
            # message can embed the offending input.
            logger.exception("workflow run failed for %s", redact_secrets(repo_url))
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
            "workflow": _summarise_workflow_state(final_state),
        }
    )


@app.websocket(AGENT_STREAM_PATH)
async def agent_stream(websocket: WebSocket) -> None:
    """Pipe live LangGraph state transitions and log-bus events to the client.

    The upgrade is origin-checked first: an agent stream carries repo URLs, file
    paths and diffs, so it must not be reachable by an arbitrary third-party
    page. A browser always sends ``Origin`` on a cross-origin WS handshake, so a
    disallowed value is closed with 1008 (policy violation) before ``accept()``.
    """
    if not is_origin_allowed(websocket.headers.get("origin")):
        logger.warning("rejected agent-stream upgrade from disallowed origin")
        # 1008 = Policy Violation. Close before accepting so the socket is never
        # registered in the connection manager.
        with contextlib.suppress(Exception):
            await websocket.close(code=1008)
        return

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
            # Inbound control messages (e.g. run/pause/cancel) get an ack. The
            # payload is length-capped and redacted before it is reflected, so a
            # client cannot use the ack as an unbounded echo channel.
            try:
                await websocket.send_json(
                    {
                        "type": "ack",
                        "level": "debug",
                        "agent": "system",
                        "message": f"received: {redact_secrets(payload, max_length=120)}",
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

    # Never enable the autoreloader in production: it spawns a child process,
    # keeps a file watcher resident, and prints tracebacks on every request.
    # It is also a hard requirement of `reload=True` to be off in prod.
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "127.0.0.1" if IS_PRODUCTION else "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        reload=not IS_PRODUCTION and _env_flag("DEV_RELOAD", True),
        log_level="warning" if IS_PRODUCTION else "info",
        access_log=not IS_PRODUCTION,
        server_header=False,
        date_header=True,
    )
