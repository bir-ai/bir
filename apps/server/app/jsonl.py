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

    with path.open("rb") as jsonl_file:
        for line_number, raw_line in enumerate(jsonl_file, start=1):
            terminated = raw_line.endswith(b"\n")
            stripped = raw_line.strip()
            if not stripped:
                continue

            if terminated:
                yield line_number, stripped.decode("utf-8")
                continue

            # Binary iteration yields an unterminated final line as its last
            # item. It is only complete when both UTF-8 and JSON decoding
            # succeed; otherwise another process may still be writing it.
            try:
                text = stripped.decode("utf-8")
                json.loads(text)
            except (UnicodeDecodeError, json.JSONDecodeError):
                return
            yield line_number, text
