from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.redaction import redact_secret_text, redact_value

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
