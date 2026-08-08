from __future__ import annotations

import itertools
import json
import re
import time
from pathlib import Path
from typing import Any

import pytest
from app.redaction import _redact_private_key_blocks, redact_secret_text, redact_value

ROOT = Path(__file__).resolve().parents[3]
REDACTION_CASES_PATH = ROOT / "tests" / "fixtures" / "redaction-cases.json"


def load_redaction_cases() -> list[dict[str, Any]]:
    cases = json.loads(REDACTION_CASES_PATH.read_text(encoding="utf-8"))
    if not isinstance(cases, list) or not cases:
        raise ValueError("redaction fixture must be a non-empty list of cases")
    return cases


# The server keeps its own copy of the redaction logic, separate from the SDK's
# (the SDK ships zero dependencies and cannot import server code). This fixture
# is the shared contract that keeps the two copies from drifting apart.
_CASES = load_redaction_cases()


@pytest.mark.parametrize("case", _CASES, ids=[case["name"] for case in _CASES])
def test_fixture_cases_match_expected(case: dict[str, Any]) -> None:
    value = case["input"]
    expected = case["expected"]
    if isinstance(value, str):
        assert redact_secret_text(value) == expected
    else:
        assert redact_value(value) == expected


_PEM_BEGIN_LABEL = "-----BEGIN RSA PRIVATE KEY-----"
_PEM_END_LABEL = "-----END RSA PRIVATE KEY-----"


@pytest.mark.parametrize("length", [1, 2, 3])
def test_private_key_pairing_matches_the_regex_it_replaced(length: int) -> None:
    """The rewrite has to keep producing what the single spanning regex produced.

    That regex was quadratic -- its trailing ``.*?`` rescanned the rest of the
    value for every header that never got a footer -- and it runs over uploaded
    payloads, so the value comes from outside. It is written out here, in the
    test, so the rewrite's equivalence is checked rather than argued; it is not
    what the server runs, because running it is the defect.
    """

    reference = re.compile(r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----")
    tokens = (
        _PEM_BEGIN_LABEL,
        _PEM_END_LABEL,
        "-----BEGIN PRIVATE KEY-----",
        "-----END PRIVATE KEY-----",
        "-----BEGIN ",
        "-----END ",
        "PRIVATE KEY-----",
        "-----",
        "body",
        "\n",
    )
    for combination in itertools.product(tokens, repeat=length):
        text = "".join(combination)
        assert _redact_private_key_blocks(text) == reference.sub("[redacted]", text), text


def test_private_key_cost_stays_linear_in_the_size_of_the_value() -> None:
    # Timed against prose of the same length rather than a fixed budget, so the
    # bound calibrates itself to whatever machine runs it. At this length the
    # spelling this replaced took 842 ms against roughly one scan now.
    length = 64_000
    headers = ((_PEM_BEGIN_LABEL + " ") * (length // (len(_PEM_BEGIN_LABEL) + 1)))[:length]
    prose = ("lorem ipsum dolor sit amet consectetur " * (length // 39))[:length]

    def time_once(text: str) -> float:
        started = time.perf_counter()
        redact_secret_text(text)
        return time.perf_counter() - started

    baseline = min(time_once(prose) for _ in range(5))
    unmatched = min(time_once(headers) for _ in range(5))
    assert unmatched < baseline * 10, (
        f"redacting {length} characters of unmatched private-key headers took {unmatched:.3f}s "
        f"against {baseline:.3f}s for the same length of prose; the rule is not linear in value size"
    )


def test_a_real_key_is_still_redacted_at_that_size() -> None:
    # Linearity must not have been bought by giving up on long keys.
    block = f"{_PEM_BEGIN_LABEL}\n{'QUJDREVG' * 8_000}\n{_PEM_END_LABEL}"
    assert redact_secret_text(f"before {block} after") == "before [redacted] after"
