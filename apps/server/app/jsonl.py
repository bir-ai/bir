"""Shared JSONL line reading tolerant of an in-progress final write."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path


def iter_jsonl_lines_tolerating_torn_tail(path: Path) -> Iterator[tuple[int, str]]:
    """Yield ``(line_number, stripped_line)`` for each complete JSONL line.

    A final line without a trailing newline may be a write still in progress,
    so a tail that does not decode or parse as JSON is skipped instead of
    raising; it surfaces on the next read after the write completes. A
    truncated serialized object can never parse as complete JSON, so a tail
    that parses is a finished write that is only missing its newline and is
    yielded like any other line.
    """

    raw = path.read_bytes()
    complete_part, _, tail = raw.rpartition(b"\n")
    line_number = 0
    if complete_part:
        for line_number, line in enumerate(complete_part.decode("utf-8").split("\n"), start=1):
            stripped = line.strip()
            if stripped:
                yield line_number, stripped

    stripped_tail = tail.strip()
    if not stripped_tail:
        return
    try:
        text = stripped_tail.decode("utf-8")
        json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return
    yield line_number + 1, text
