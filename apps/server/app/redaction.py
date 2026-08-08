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

# The two halves of a PEM private-key block, matched separately so the block can
# be located without a quantifier that spans them. See
# :func:`_redact_private_key_blocks`. Neither label class can contain ``-``, so a
# footer can never fall inside a header's variable part.
_PEM_BEGIN = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")
_PEM_END = re.compile(r"-----END [A-Z0-9 ]*PRIVATE KEY-----")

# How far a secret runs once something has labeled it. It ends at whitespace or
# at punctuation that closes the value rather than belonging to it, so a header
# quoted inside a sentence does not swallow the sentence.
_SECRET_VALUE = r"[^\s,;\)\]\}]+"

# RFC 7235 writes an Authorization header as a scheme followed by the credential.
# Only the credential is secret; the scheme says which authentication a call
# used, which is worth keeping. These schemes carry a single ``token68``
# credential.
_AUTH_SCHEME_TOKEN = r"bearer|basic|token|api-?key|ntlm|negotiate|ssws"
# These carry a comma-separated auth-param list instead. The part worth hiding is
# not the first pair -- a Digest ``response`` and a SigV4 ``Signature`` come last
# -- so the whole list goes rather than its head.
_AUTH_SCHEME_PARAMS = r"digest|hawk|signature|aws4-hmac-sha256"
_AUTH_ANY_SCHEME = f"{_AUTH_SCHEME_TOKEN}|{_AUTH_SCHEME_PARAMS}"

# One pattern rather than two, so a long value is scanned for the header once.
# The scheme group in the second branch stays optional so a bare
# ``Authorization: <token>`` is still covered, and the trailing lookahead is what
# keeps that optionality honest: without it the engine backtracks to an empty
# scheme and matches the scheme word itself, which destroyed the scheme and left
# the credential behind it untouched. That is also what makes the rule idempotent
# -- re-redacting an already-redacted header used to consume its scheme.
_AUTH_HEADER_RULE = re.compile(
    rf"(?i)\b(?P<label>authorization\s*[:=]\s*)(?:"
    rf"(?P<param_scheme>(?:{_AUTH_SCHEME_PARAMS})\s+)"
    rf"(?!\[redacted\]){_SECRET_VALUE}(?:\s*,\s*{_SECRET_VALUE})*"
    rf"|"
    rf"(?P<token_scheme>(?:{_AUTH_SCHEME_TOKEN})\s+)?"
    rf"(?!\[redacted\])(?!(?:{_AUTH_ANY_SCHEME})\s){_SECRET_VALUE}"
    rf")"
)

# Cookie attributes describe a cookie rather than authenticate anything, so they
# are not credentials and keeping them makes the record readable. Every other
# name in the header is a cookie whose value is the secret. Deciding by name
# rather than by position also means one rule covers both headers: ``Set-Cookie``
# carries one cookie followed by attributes, ``Cookie`` carries only cookies.
_COOKIE_ATTRIBUTES = frozenset(
    {
        "domain",
        "expires",
        "httponly",
        "max-age",
        "partitioned",
        "path",
        "priority",
        "samesite",
        "secure",
        "version",
    }
)

# The label is a literal, so finding it is cheap, and the run of pairs after it is
# bounded by cookie syntax rather than by the end of the line -- a header quoted
# inside a sentence does not take the sentence with it. The pair group repeats,
# but each repetition must begin with a ``;`` and a name, so there is no greedy
# prefix for the engine to backtrack across.
_COOKIE_PAIR = r"[^\s;=,]+(?:=[^\s;,]*)?"
_COOKIE_HEADER_RULE = re.compile(rf"(?i)\b(set-cookie|cookie)(\s*[:=]\s*)({_COOKIE_PAIR}(?:\s*;\s*{_COOKIE_PAIR})*)")

# A credential carried in a URI's userinfo, the spelling a connection string
# uses. The password is the secret; the scheme, user, and host are what make the
# record worth reading, so they stay. Requiring the ``:`` and the ``@`` is what
# keeps an ordinary ``host:port`` and a passwordless ``https://user@host`` out of
# it -- neither carries a password to hide.
#
# It starts at ``://`` rather than at the scheme, and that is a cost decision
# rather than a stylistic one. Written as ``[A-Za-z][A-Za-z0-9+.-]*://`` the rule
# is quadratic: every letter in the value starts an attempt, and each one runs
# the greedy class to the end of its run and backtracks over it looking for the
# ``://``. Measured on one 64,000-character alphanumeric run -- the shape a
# base64 body has -- that spelling took 4,745 ms against 0.03 ms here. The scheme
# is left out of the match entirely; it sits in front of it and is never
# replaced, so the result is identical.
_URI_CREDENTIAL_RULE = re.compile(r"(://[^\s/:@]*:)[^\s/@]*(@)")


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
    redacted = _AUTH_HEADER_RULE.sub(_redact_auth_header_match, redacted)
    redacted = _COOKIE_HEADER_RULE.sub(_redact_cookie_header_match, redacted)
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
    # Before the token shapes below, so a token used as the *user* half of a URI
    # (the ``<token>:x-oauth-basic@`` convention) is still matched by its own rule
    # once the password beside it has gone.
    redacted = _URI_CREDENTIAL_RULE.sub(_redact_uri_credential_match, redacted)
    redacted = re.sub(r"\b(sk-[A-Za-z0-9_-]{4,})\b", REDACTED, redacted)
    redacted = re.sub(
        r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])",
        REDACTED,
        redacted,
    )
    redacted = re.sub(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", REDACTED, redacted)
    redacted = re.sub(r"(?<![0-9A-Za-z_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])", REDACTED, redacted)
    redacted = re.sub(r"\bxox[baprs]-[0-9A-Za-z-]+\b", REDACTED, redacted)
    # Both GitHub token families in one pass: the classic ``ghp_``-style prefixes
    # and the fine-grained ``github_pat_`` tokens that replaced them. The
    # fine-grained form joins its two halves with an underscore, so it needs a
    # character class the classic branch must not have.
    redacted = re.sub(
        r"\b(?:(?:ghp|gho|ghs|ghu|ghr)_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z_]{50,})\b",
        REDACTED,
        redacted,
    )
    # Stripe secret/restricted keys (``sk_live_``/``sk_test_``/``rk_live_``/``rk_test_``).
    redacted = re.sub(r"\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b", REDACTED, redacted)
    # Azure storage-style account keys: a 512-bit key base64-encoded to 88 chars
    # ending in ``==``. Anchored to that exact length class to avoid over-redaction.
    redacted = re.sub(r"(?<![0-9A-Za-z+/])[0-9A-Za-z+/]{86}==(?![0-9A-Za-z+/=])", REDACTED, redacted)
    # PEM private-key blocks (``-----BEGIN ... PRIVATE KEY-----`` .. ``-----END ...
    # PRIVATE KEY-----``), paired rather than spanned. See the function.
    redacted = _redact_private_key_blocks(redacted)
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


def _redact_private_key_blocks(text: str) -> str:
    """Replace every ``-----BEGIN … PRIVATE KEY-----`` block with the marker.

    One regex spanning both markers is the obvious spelling and it is quadratic:
    a trailing ``.*?`` rescans the rest of the value for every BEGIN that never
    gets an END, so the cost is the product of the value's length and the number
    of unterminated headers. This runs over uploaded payloads, so the value comes
    from outside: 64,000 characters of bare headers took 842 ms on the spelling
    this replaces, against roughly one scan now.

    The two markers are located once each instead, and the blocks are paired by
    walking the two position lists together. That reproduces what the regex
    matched -- leftmost BEGIN, nearest END at or after it, resume after the
    block -- at a cost linear in the length of the value.
    """

    # Scanning for the footer is skipped entirely when there is no header, so
    # text without a private key costs the one scan it always cost.
    begins = [(match.start(), match.end()) for match in _PEM_BEGIN.finditer(text)]
    if not begins:
        return text
    ends = [(match.start(), match.end()) for match in _PEM_END.finditer(text)]
    if not ends:
        return text

    parts: list[str] = []
    copied = 0  # everything before this index has been written to ``parts``
    next_end = 0  # index of the first END not yet consumed by a block
    for begin_start, begin_end in begins:
        if begin_start < copied:
            # This header sits inside a block already replaced, exactly as the
            # regex skipped it by resuming past its own match.
            continue
        # A block's END may start no earlier than the header's own end, which is
        # where the regex's ``.*?`` began matching.
        while next_end < len(ends) and ends[next_end][0] < begin_end:
            next_end += 1
        if next_end == len(ends):
            # No END is left, so no later header can have one either. This is
            # the case the regex used to pay for once per remaining header.
            break
        parts.append(text[copied:begin_start])
        parts.append(REDACTED)
        copied = ends[next_end][1]
        next_end += 1

    if not parts:
        return text
    parts.append(text[copied:])
    return "".join(parts)


def _redact_auth_header_match(match: re.Match[str]) -> str:
    """Keep the header label and the auth scheme; replace the credential."""

    scheme = match.group("param_scheme") or match.group("token_scheme") or ""
    return f"{match.group('label')}{scheme}{REDACTED}"


def _redact_cookie_header_match(match: re.Match[str]) -> str:
    """Replace every cookie's value, keeping the names and the attributes.

    Splitting the matched run rather than repeating a capture group is what makes
    each pair reachable: a regex hands back only the last repetition. The parts
    keep their own spacing, so rejoining on ``;`` restores the header as written.
    A pair with no ``=`` is a flag such as ``HttpOnly`` and carries nothing.
    """

    pairs = []
    for pair in match.group(3).split(";"):
        name, separator, _value = pair.partition("=")
        if not separator or name.strip().lower() in _COOKIE_ATTRIBUTES:
            pairs.append(pair)
        else:
            pairs.append(f"{name}={REDACTED}")
    return f"{match.group(1)}{match.group(2)}{';'.join(pairs)}"


def _redact_uri_credential_match(match: re.Match[str]) -> str:
    """Keep a URI's scheme, user, and host; replace the password between them."""

    return f"{match.group(1)}{REDACTED}{match.group(2)}"


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
