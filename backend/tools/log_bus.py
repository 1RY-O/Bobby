"""In-process publish/subscribe bus for agent log events.

Agents in ``/agents`` call :func:`publish` (or the :func:`emit_agent_event`
helper) with a JSON-serialisable dict and the bus fans it out to every
subscriber queue. The WebSocket endpoint in ``main.py`` consumes
:func:`stream` and forwards each event to the frontend.

Rich structured events look like::

    {
        "type": "agent_event",
        "level": "info",
        "agent": "investigator",
        "current_node": "investigator",
        "action": "Analyzing stack trace...",
        "message": "Analyzing stack trace...",
        "file_path": "src/auth/login.py",
        "diff_snippet": "...",
        "progress_percentage": 45,
        "status": "active",
        "timestamp": "2026-...",
    }
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any, AsyncIterator, Dict, Optional, Set

Event = Dict[str, Any]

DEFAULT_QUEUE_SIZE = 1000

DEFAULT_MAX_TEXT_LENGTH = 4000

SCRIPT_BLOCK_RE = re.compile(
    r"<\s*script\b[^>]*>.*?(?:<\s*/\s*script\s*>|$)",
    re.IGNORECASE | re.DOTALL,
)
HTML_TAG_RE = re.compile(r"<[^>]{0,200}>")
CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
ZERO_WIDTH_RE = re.compile(r"[\u200b-\u200f\u2028\u2029\u2060\ufeff]")
BIDI_OVERRIDE_RE = re.compile(r"[\u202a-\u202e\u2066-\u2069]")
FAIL_TOKEN_RE = re.compile(
    r"\[\s*fail\s*[-‐‑–—]\s*(investigator|remediation)\s*\]",
    re.IGNORECASE,
)

_subscribers: Set["asyncio.Queue[Event]"] = set()


def _canonical_fail_token(match: "re.Match[str]") -> str:
    """Rewrite a self-heal token to its exact demo spelling."""
    agent = match.group(1).lower()
    return "[fail-investigator]" if agent == "investigator" else "[fail-remediation]"


def sanitize_text(
    value: Any,
    *,
    max_length: int = DEFAULT_MAX_TEXT_LENGTH,
    preserve_newlines: bool = False,
) -> str:
    """Make untrusted text safe to log, prompt, or render.

    Removes ``<script>`` blocks and any other HTML tags, drops control /
    zero-width / bidi characters, and normalises whitespace. The demo routing
    tokens ``[fail-investigator]`` and ``[fail-remediation]`` are canonicalised
    to their exact spelling so the self-heal path keeps working. Set
    ``preserve_newlines`` for diffs and code snippets whose indentation matters.
    """
    if not isinstance(value, str):
        value = "" if value is None else str(value)

    text = SCRIPT_BLOCK_RE.sub(" ", value)
    text = HTML_TAG_RE.sub(" ", text)
    text = CONTROL_CHAR_RE.sub(" ", text)
    text = ZERO_WIDTH_RE.sub("", text)
    text = BIDI_OVERRIDE_RE.sub("", text)
    text = FAIL_TOKEN_RE.sub(_canonical_fail_token, text)

    if preserve_newlines:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = re.sub(r"^\n+", "", text).rstrip(" \t\n")
    else:
        text = re.sub(r"\s+", " ", text).strip()

    if max_length > 0 and len(text) > max_length:
        text = text[:max_length]
    return text


def _sanitize_event(event: Event) -> Event:
    """Sanitise every string an agent event can carry, in place."""
    single_line_fields = ("action", "message", "file_path")
    for key in single_line_fields:
        if isinstance(event.get(key), str):
            event[key] = sanitize_text(event[key])
    for key, value in list(event.items()):
        if key in single_line_fields or not isinstance(value, str):
            continue
        event[key] = sanitize_text(value, preserve_newlines=True)
    return event


def subscribe(maxsize: int = DEFAULT_QUEUE_SIZE) -> "asyncio.Queue[Event]":
    """Register a new subscriber queue and return it."""
    queue: "asyncio.Queue[Event]" = asyncio.Queue(maxsize=maxsize)
    _subscribers.add(queue)
    return queue


def unsubscribe(queue: "asyncio.Queue[Event]") -> None:
    """Remove ``queue`` from the fan-out set (safe to call twice)."""
    _subscribers.discard(queue)


def publish(event: Event) -> Event:
    """Fan ``event`` out to all subscribers without blocking the caller.

    Every string in the event is sanitised first, so user-controlled text can
    never reach a log consumer raw. Slow or full queues drop the event instead
    of stalling the agent producing it, because log delivery is best-effort by
    design. A ``timestamp`` is added when missing. Returns the (possibly
    enriched) event.
    """
    _sanitize_event(event)
    event.setdefault("timestamp", time.time())
    event.setdefault("type", "agent_event")
    for queue in list(_subscribers):
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            continue
    return event


def make_agent_event(
    agent: str,
    action: str,
    *,
    current_node: Optional[str] = None,
    status: str = "active",
    level: str = "info",
    message: Optional[str] = None,
    file_path: Optional[str] = None,
    diff_snippet: Optional[str] = None,
    progress_percentage: Optional[float] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Event:
    """Build a structured, frontend-ready agent event (without publishing)."""
    event: Event = {
        "type": "agent_event",
        "level": level,
        "agent": agent,
        "current_node": current_node or agent,
        "action": action,
        "message": message if message is not None else action,
        "status": status,
        "timestamp": time.time(),
    }
    if file_path is not None:
        event["file_path"] = file_path
    if diff_snippet is not None:
        event["diff_snippet"] = diff_snippet
    if progress_percentage is not None:
        event["progress_percentage"] = progress_percentage
    if extra:
        event.update(extra)
    return _sanitize_event(event)


def emit_agent_event(
    agent: str,
    action: str,
    *,
    current_node: Optional[str] = None,
    status: str = "active",
    level: str = "info",
    message: Optional[str] = None,
    file_path: Optional[str] = None,
    diff_snippet: Optional[str] = None,
    progress_percentage: Optional[float] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Event:
    """Build **and** publish a structured agent event. Returns the event."""
    return publish(
        make_agent_event(
            agent,
            action,
            current_node=current_node,
            status=status,
            level=level,
            message=message,
            file_path=file_path,
            diff_snippet=diff_snippet,
            progress_percentage=progress_percentage,
            extra=extra,
        )
    )


def subscriber_count() -> int:
    """Number of queues currently receiving events."""
    return len(_subscribers)


async def stream() -> AsyncIterator[Event]:
    """Yield events published while iterating; unsubscribes on exit."""
    queue = subscribe()
    try:
        while True:
            yield await queue.get()
    finally:
        unsubscribe(queue)
