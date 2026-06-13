from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

from test_server import make_event

INDEX_HTML = "<!doctype html><title>Bir</title><h1>Bir dashboard</h1>"


def write_dashboard(tmp_path: Path) -> Path:
    dashboard_dir = tmp_path / "out"
    dashboard_dir.mkdir()
    (dashboard_dir / "index.html").write_text(INDEX_HTML, encoding="utf-8")
    (dashboard_dir / "bir_mark.png").write_bytes(b"PNG")
    return dashboard_dir


def make_client(tmp_path: Path, dashboard_dir: Path | None) -> TestClient:
    return TestClient(
        create_app(
            event_store_path=tmp_path / "events.jsonl",
            dashboard_dir=dashboard_dir,
        )
    )


def test_serves_dashboard_index_at_root(tmp_path: Path) -> None:
    client = make_client(tmp_path, write_dashboard(tmp_path))

    response = client.get("/")

    assert response.status_code == 200
    assert response.text == INDEX_HTML
    assert response.headers["content-type"].startswith("text/html")


def test_serves_dashboard_static_assets(tmp_path: Path) -> None:
    client = make_client(tmp_path, write_dashboard(tmp_path))

    response = client.get("/bir_mark.png")

    assert response.status_code == 200
    assert response.content == b"PNG"


def test_api_routes_take_precedence_over_dashboard_mount(tmp_path: Path) -> None:
    client = make_client(tmp_path, write_dashboard(tmp_path))

    health = client.get("/health")
    assert health.status_code == 200
    assert health.json() == {"status": "ok"}

    traces = client.get("/v1/traces")
    assert traces.status_code == 200
    assert traces.json() == []


def test_no_dashboard_dir_leaves_root_unmounted(tmp_path: Path) -> None:
    client = make_client(tmp_path, None)

    # Without a dashboard mount there is no "/" route, so behavior is unchanged.
    assert client.get("/").status_code == 404
    assert client.get("/health").status_code == 200
    assert client.get("/v1/traces").status_code == 200


def test_missing_dashboard_dir_is_ignored(tmp_path: Path) -> None:
    client = make_client(tmp_path, tmp_path / "does-not-exist")

    # A configured-but-missing build must not crash or mount a catch-all.
    assert client.get("/").status_code == 404
    assert client.get("/health").status_code == 200


def test_dashboard_dir_from_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    dashboard_dir = write_dashboard(tmp_path)
    monkeypatch.setenv("BIR_DASHBOARD_DIR", str(dashboard_dir))

    client = TestClient(create_app(event_store_path=tmp_path / "events.jsonl"))

    response = client.get("/")
    assert response.status_code == 200
    assert response.text == INDEX_HTML


def test_serves_dashboard_in_read_only_local_mode(tmp_path: Path) -> None:
    data_dir = tmp_path / ".bir"
    data_dir.mkdir()
    client = TestClient(
        create_app(local_data_dir=data_dir, dashboard_dir=write_dashboard(tmp_path))
    )

    # The dashboard serves and reads work, but ingestion stays rejected.
    assert client.get("/").text == INDEX_HTML
    assert client.get("/v1/traces").json() == []
    assert client.post("/v1/events", json=make_event()).status_code == 403
