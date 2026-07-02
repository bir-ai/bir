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
    """Redact labeled, bearer, OpenAI-style, high-signal secret, and PAN strings."""

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
    # Stripe secret/restricted keys (``sk_live_``/``sk_test_``/``rk_live_``/``rk_test_``).
    redacted = re.sub(r"\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b", REDACTED, redacted)
    # Azure storage-style account keys: a 512-bit key base64-encoded to 88 chars
    # ending in ``==``. Anchored to that exact length class to avoid over-redaction.
    redacted = re.sub(r"(?<![0-9A-Za-z+/])[0-9A-Za-z+/]{86}==(?![0-9A-Za-z+/=])", REDACTED, redacted)
    # PEM private-key blocks (``-----BEGIN ... PRIVATE KEY-----`` .. ``-----END ...
    # PRIVATE KEY-----``), spanning lines via a non-greedy DOTALL-scoped match.
    redacted = re.sub(
        r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
        REDACTED,
        redacted,
    )
    # Credit-card / PAN numbers: 13-19 digit sequences, optionally split into
    # groups by single spaces or hyphens, that pass the Luhn checksum. A pure
    # regex cannot verify Luhn, so the regex only finds candidate digit groups and
    # the Luhn gate in ``_redact_pan_match`` decides replacement -- a candidate
    # that fails Luhn (an ordinary long id, a phone number) is left untouched. The
    # digit-run boundaries (``\b`` plus the {12,18}+1 length) also leave runs of
    # 20+ digits intact, so this never over-redacts an arbitrary long integer.
    redacted = re.sub(r"\b(?:\d[ -]?){12,18}\d\b", _redact_pan_match, redacted)
    return redacted


def _is_secret_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return normalized in _SECRET_KEY_NAMES or any(secret_part in normalized for secret_part in _SECRET_KEY_PARTS)


def _redact_labeled_secret_match(match: re.Match[str]) -> str:
    return f"{match.group(1)}{match.group(2) or ''}{REDACTED}"


def _redact_bearer_secret_match(match: re.Match[str]) -> str:
    return f"{match.group(1)}{REDACTED}"


def _redact_pan_match(match: re.Match[str]) -> str:
    """Redact a candidate card number only when its digits pass the Luhn check.

    The candidate regex matches a 13-19 digit run (optionally single-space- or
    hyphen-separated); this gate strips the separators and replaces the whole run
    with the marker only when the bare digits satisfy the Luhn checksum, so an
    arbitrary long digit string that happens to match the shape is left intact.
    """

    candidate = match.group(0)
    digits = candidate.replace(" ", "").replace("-", "")
    if 13 <= len(digits) <= 19 and _luhn_checksum_valid(digits):
        return REDACTED
    return candidate


def _luhn_checksum_valid(digits: str) -> bool:
    """Return whether a bare digit string passes the Luhn (mod-10) checksum.

    ``digits`` must contain only ASCII digits (the caller strips separators).
    Doubling starts from the second-rightmost digit, matching the standard
    payment-card Luhn definition.
    """

    total = 0
    for index, char in enumerate(reversed(digits)):
        value = ord(char) - 48
        if index % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0
