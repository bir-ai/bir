"""Secret redaction helpers shared by server validation paths."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Mapping

REDACTED = "[redacted]"

_SECRET_KEY_PARTS = (
    "access_key",
    "api_key",
    "apikey",
    "authorization",
    "auth_header",
    "client_secret",
    "password",
    "private_key",
    "secret",
    "token",
)
_SECRET_KEY_NAMES = {
    "auth",
    "credential",
    "credentials",
    "creds",
}


def redact_value(value: Any, *, key: str | None = None) -> Any:
    """Recursively redact secret-like values from JSON-compatible data."""

    if key is not None and _is_secret_key(key):
        return REDACTED
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return redact_secret_text(value)
    if isinstance(value, Path):
        return redact_secret_text(str(value))
    if isinstance(value, Mapping):
        return {str(item_key): redact_value(item_value, key=str(item_key)) for item_key, item_value in value.items()}
    if isinstance(value, list):
        return [redact_value(item) for item in value]
    return value


def redact_secret_text(value: str) -> str:
    """Redact labeled, bearer, OpenAI-style, and high-signal secret strings."""

    redacted = value
    redacted = re.sub(
        r"(?i)\b(authorization\s*[:=]\s*)(bearer\s+)?(?!\[redacted\])[^\s,;\)\]\}]+",
        _redact_labeled_secret_match,
        redacted,
    )
    redacted = re.sub(
        (
            r"(?i)\b(access[_-]?key|api[_-]?key|apikey|auth|client[_-]?secret|credential|credentials|password|"
            r"private[_-]?key|secret|token)(\s*[:=]\s*)(?!\[redacted\])(?!\{[A-Za-z_][A-Za-z0-9_]*\})"
            r"[^\s,;\)\]\}]+"
        ),
        _redact_labeled_secret_match,
        redacted,
    )
    redacted = re.sub(
        r"(?i)\b(bearer\s+)(?!\[redacted\])[^\s,;\)\]\}]+",
        _redact_bearer_secret_match,
        redacted,
    )
    redacted = re.sub(r"\b(sk-[A-Za-z0-9_-]{4,})\b", REDACTED, redacted)
    redacted = re.sub(
        r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])",
        REDACTED,
        redacted,
    )
    redacted = re.sub(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", REDACTED, redacted)
    redacted = re.sub(r"(?<![0-9A-Za-z_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])", REDACTED, redacted)
    redacted = re.sub(r"\bxox[baprs]-[0-9A-Za-z-]+\b", REDACTED, redacted)
    redacted = re.sub(r"\b(?:ghp|gho|ghs|ghu|ghr)_[0-9A-Za-z]{36,}\b", REDACTED, redacted)
    return redacted


def _is_secret_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return normalized in _SECRET_KEY_NAMES or any(secret_part in normalized for secret_part in _SECRET_KEY_PARTS)


def _redact_labeled_secret_match(match: re.Match[str]) -> str:
    return f"{match.group(1)}{match.group(2) or ''}{REDACTED}"


def _redact_bearer_secret_match(match: re.Match[str]) -> str:
    return f"{match.group(1)}{REDACTED}"
