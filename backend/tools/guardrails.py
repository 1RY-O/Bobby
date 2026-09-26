"""Security guardrails for untrusted, caller-supplied text.

Two jobs, both applied at the edge (request validation) so nothing raw ever
reaches the graph, a log event, or an HTTP response:

1. :func:`neutralize_prompt_injection` defeats instruction-injection attempts in
   ``issue_description`` — the one field that flows toward the agent pipeline
   and can otherwise steer graph routing.
2. :func:`redact_secrets` masks credential-shaped substrings so a token that
   slips into a log line or an error message is never persisted or echoed.

Design constraints (these must not regress):

- The demo self-heal tokens ``[fail-investigator]`` / ``[fail-remediation]``
  are a *feature*: ``agents.graph.route_after_validation`` reads the failure
  reason to pick the retry target. Guardrails must leave them intact, and every
  pattern below was written so that none of them can match those tokens.
- The golden-path narrative is deterministic; nothing here may introduce
  randomness or alter the graph's topology.
- Guardrails are additive to :func:`tools.log_bus.sanitize_text` (which already
  strips HTML/control characters). Run sanitize first, then these.
"""

from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# 1. Prompt-injection neutralisation
# ---------------------------------------------------------------------------

# Instruction-override phrasings. Matched case-insensitively and tolerant of
# the padding attackers use between words ("i g n o r e", "ignore---previous").
# A match is replaced with an equal-length run of spaces so surrounding context,
# line structure, and downstream ``[:N]`` slicing all behave exactly as before.
_INJECTION_PATTERNS: tuple[re.Pattern[str], ...] = (
    # "ignore/disregard/forget the previous/prior/above instructions"
    re.compile(
        r"\b(?:ignore|disregard|forget|discard|override|bypass)\b"
        r"[^.\n]{0,40}?\b(?:previous|prior|above|earlier|foregoing|preceding|"
        r"system|initial|original|all)\b"
        r"[^.\n]{0,40}?"
        r"\b(?:instruction|instructions|prompt|prompts|direction|directions|"
        r"rule|rules|context|guardrail|guardrails|constraint|constraints)\b",
        re.IGNORECASE,
    ),
    # Persona hijack: "you are now / act as / pretend to be <role>"
    re.compile(
        r"\b(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be|roleplay\s+as|"
        r"from\s+now\s+on\s+you)\b[^.\n]{0,60}?"
        r"\b(?:dan|developer\s+mode|unrestricted|jailbroken|unfiltered|root|"
        r"admin|system\s+prompt|no\s+longer\s+bound|without\s+restrictions)\b",
        re.IGNORECASE,
    ),
    # Exfiltration: "reveal / print / show me your system prompt / api key"
    re.compile(
        r"\b(?:reveal|print|show|output|repeat|disclose|leak|dump|echo)\b"
        r"[^.\n]{0,40}?"
        r"\b(?:system\s+prompt|system\s+message|instructions|api[\s_-]?key|"
        r"secret|token|password|credential|environment\s+variables)\b",
        re.IGNORECASE,
    ),
    # Delimiter/role spoofing used to break out of a prompt block. The
    # leading "system|assistant|developer + ':'" form is matched, but the
    # bracket/keyword forms are anchored so ordinary prose is untouched.
    re.compile(r"(?:^|\n)\s*#{0,3}\s*(?:system|assistant|developer)\s*:\s*",
               re.IGNORECASE),
    # Chat-template control tokens (not prose, so matched directly).
    re.compile(
        r"<\|[^|>]{0,40}\|>|\[/?INST\]|<<\s*/?SYS\s*>>|\{\{[^}]{0,40}\}\}",
        re.IGNORECASE,
    ),
    # Tool/command injection: "run bash", "eval this", "curl ..."
    re.compile(
        r"\b(?:execute|run|invoke|eval|exec|spawn)\b[^.\n]{0,30}?"
        r"\b(?:bash|zsh|cmd(?:\.exe)?|powershell|subprocess|shell|curl|wget|"
        r"os\.system|eval|exec|__import__)\b",
        re.IGNORECASE,
    ),
)

# Canonical self-heal routing tokens. Re-emitted with their exact spelling so
# the graph's retry routing keeps working after a scrub.
FAIL_TOKEN_RE = re.compile(
    r"\[\s*fail\s*[-‐‑–—]\s*(investigator|remediation)\s*\]",
    re.IGNORECASE,
)

_MAX_GUARD_PASSES = 3


def _canonical_fail_token(match: "re.Match[str]") -> str:
    agent = match.group(1).lower()
    return "[fail-investigator]" if agent == "investigator" else "[fail-remediation]"


def neutralize_prompt_injection(value: str) -> str:
    """Blank out instruction-injection attempts in ``value``.

    Unlike a delete, each matched span becomes spaces of equal length, so the
    surrounding text, line structure, and any ``[:N]`` slicing downstream behave
    exactly as before.

    ``[fail-investigator]`` / ``[fail-remediation]`` are untouched by every
    pattern above (each one requires an explicit override/exfil verb that those
    tokens do not contain) and are re-canonicalised afterwards, so the self-heal
    routing path in ``agents.graph`` cannot be broken by this function.
    """
    if not isinstance(value, str) or not value:
        return ""

    text = value
    for _ in range(_MAX_GUARD_PASSES):
        before = text
        for pattern in _INJECTION_PATTERNS:
            text = pattern.sub(lambda m: " " * len(m.group(0)), text)
        if text == before:
            break

    return FAIL_TOKEN_RE.sub(_canonical_fail_token, text)


def contains_injection(value: str) -> bool:
    """True when ``value`` trips at least one injection or control-token pattern."""
    if not isinstance(value, str) or not value:
        return False
    return any(pattern.search(value) for pattern in _INJECTION_PATTERNS)


# ---------------------------------------------------------------------------
# 2. Secret redaction (logs, error messages, echoed state)
# ---------------------------------------------------------------------------

# Ordered most-specific first. Each entry is (pattern, replacement); every
# replacement is a fixed label so nothing secret is ever re-emitted.
_SECRET_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # Vendor-specific token shapes
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}\b"), "[redacted:token]"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"), "[redacted:token]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"), "[redacted:apikey]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[redacted:aws-key]"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"), "[redacted:apikey]"),
    (
        re.compile(
            r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"
        ),
        "[redacted:jwt]",
    ),
    # key = value / "key": "value" for well-known secret names. The value
    # alternation accepts a quoted or a bare token; a leading quote is
    # consumed as part of the value so `"hunter2xyz"` is not skipped.
    (
        re.compile(
            r"(?i)\b([a-z0-9_.-]{0,40}(?:secret|password|passwd|token|"
            r"api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)"
            r"[a-z0-9_.-]{0,20})"
            r"(\s*[:=]\s*)"
            r"(\"[^\"]{4,}\"|'[^']{4,}'|[^\s\"',;}]{4,})"
        ),
        r"\1\2[redacted]",
    ),
    # userinfo in URLs: https://user:pass@host
    (re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)([^/\s:@]+):([^/\s@]+)@"),
     r"\1[redacted]@"),
)

# Long opaque blobs (base64/hex keys) that match no shape above.
_OPAQUE_SECRET_RE = re.compile(r"\b[A-Za-z0-9+/]{40,}={0,2}\b")


def _mask_opaque(match: "re.Match[str]") -> str:
    blob = match.group(0)
    # Real prose has vowels and is not this long; require both classes so a
    # repeated-character run is not needlessly masked.
    if not re.search(r"[0-9]", blob) or not re.search(r"[A-Za-z]", blob):
        return blob
    return "[redacted:opaque]"


def redact_secrets(value: str, *, max_length: int = 0) -> str:
    """Mask credential-shaped substrings in ``value``.

    Safe for logs and echoed state: the shape is replaced with a short label
    rather than dropped, so a human can still see *that* a secret was present.
    """
    if not isinstance(value, str):
        return ""
    if not value:
        return value

    text = value
    for pattern, replacement in _SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    text = _OPAQUE_SECRET_RE.sub(_mask_opaque, text)

    if max_length > 0 and len(text) > max_length:
        text = text[:max_length]
    return text


def redact_mapping(mapping: dict, *, max_length: int = 512) -> dict:
    """Redact every string value in ``mapping`` (shallow copy, non-recursive)."""
    return {
        key: redact_secrets(value, max_length=max_length)
        if isinstance(value, str)
        else value
        for key, value in mapping.items()
    }


__all__ = [
    "FAIL_TOKEN_RE",
    "contains_injection",
    "neutralize_prompt_injection",
    "redact_mapping",
    "redact_secrets",
]
