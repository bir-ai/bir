from __future__ import annotations

import gc
import json
import tracemalloc
from pathlib import Path

from app.jsonl import iter_jsonl_lines_tolerating_torn_tail
from app.storage import LocalJsonlEventReader
from test_server import make_event


def test_jsonl_iterator_peak_memory_does_not_scale_with_file_size(tmp_path: Path) -> None:
    path = tmp_path / "many-lines.jsonl"
    line_count = 300_000
    with path.open("wb") as jsonl_file:
        for _ in range(line_count):
            jsonl_file.write(b'{"ok":true}\n')
    store_size = path.stat().st_size

    gc.collect()
    tracemalloc.start()
    observed_count = sum(1 for _ in iter_jsonl_lines_tolerating_torn_tail(path))
    _, peak_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    assert observed_count == line_count
    assert store_size > 3_000_000
    # Path.read_bytes() alone would retain at least store_size bytes. Leave
    # generous headroom for interpreter/file-buffer variance while ensuring
    # the iterator keeps line-sized, rather than file-sized, storage.
    assert peak_bytes < store_size // 4


def test_large_local_store_browse_and_detail_have_bounded_peak_memory(tmp_path: Path) -> None:
    path = tmp_path / "traces.jsonl"
    trace_count = 2_500
    large_input = "x" * 4_096
    with path.open("w", encoding="utf-8") as trace_file:
        for index in range(trace_count):
            trace_id = f"trace-{index:05d}"
            event = make_event(id=trace_id, trace_id=trace_id, input={"payload": large_input})
            trace_file.write(json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n")
    store_size = path.stat().st_size
    reader = LocalJsonlEventReader(path)

    gc.collect()
    tracemalloc.start()
    traces = reader.load_traces(limit=5)
    _, browse_peak_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    assert [trace.id for trace in traces] == [f"trace-{index:05d}" for index in range(trace_count - 5, trace_count)]
    assert store_size > 10_000_000
    assert browse_peak_bytes < store_size // 4

    del traces
    gc.collect()
    tracemalloc.start()
    detail = reader.load_trace("trace-01234")
    _, detail_peak_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    assert detail is not None
    assert detail.id == "trace-01234"
    assert [event.id for event in detail.events] == ["trace-01234"]
    assert detail_peak_bytes < store_size // 4
