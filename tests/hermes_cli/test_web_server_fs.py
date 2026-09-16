import base64
from pathlib import Path

import pytest

from hermes_cli import web_server

pytest.importorskip("starlette.testclient")
from starlette.testclient import TestClient


@pytest.fixture
def client(monkeypatch):
    previous_auth_required = getattr(web_server.app.state, "auth_required", None)
    web_server.app.state.auth_required = False
    test_client = TestClient(web_server.app)
    test_client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    try:
        yield test_client
    finally:
        if previous_auth_required is None:
            try:
                delattr(web_server.app.state, "auth_required")
            except AttributeError:
                pass
        else:
            web_server.app.state.auth_required = previous_auth_required


def test_fs_list_sorts_and_hides_noise(client, tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (root / "b.txt").write_text("b")
    (root / "a_dir").mkdir()
    (root / "a.txt").write_text("a")
    (root / "node_modules").mkdir()
    (root / ".git").mkdir()

    response = client.get("/api/fs/list", params={"path": str(root)})

    assert response.status_code == 200
    entries = response.json()["entries"]
    assert [entry["name"] for entry in entries] == ["a_dir", "a.txt", "b.txt"]
    assert entries[0] == {"name": "a_dir", "path": str(root / "a_dir"), "isDirectory": True}
    assert all(entry["name"] not in {".git", "node_modules"} for entry in entries)


def test_fs_read_data_url_rejects_over_cap(client, tmp_path, monkeypatch):
    monkeypatch.setattr(web_server, "_FS_DATA_URL_MAX_BYTES", 3)
    target = tmp_path / "image.png"
    target.write_bytes(b"1234")

    response = client.get("/api/fs/read-data-url", params={"path": str(target)})

    assert response.status_code == 413


def test_fs_endpoints_require_auth(tmp_path):
    client = TestClient(web_server.app)
    target = tmp_path / "secret.txt"
    target.write_text("secret")

    list_response = client.get("/api/fs/list", params={"path": str(tmp_path)})
    read_response = client.get("/api/fs/read-text", params={"path": str(target)})
    default_response = client.get("/api/fs/default-cwd")

    assert list_response.status_code == 401
    assert read_response.status_code == 401
    assert default_response.status_code == 401


def test_fs_stat_describes_a_file_and_reports_missing_ones(client, tmp_path):
    target = tmp_path / "report.docx"
    target.write_bytes(b"PK" * 8)

    present = client.get("/api/fs/stat", params={"path": str(target)})
    missing = client.get("/api/fs/stat", params={"path": str(tmp_path / "nope.pdf")})

    assert present.status_code == 200
    body = present.json()
    assert body["exists"] is True
    assert body["isFile"] is True
    assert body["byteSize"] == 16
    assert body["mimeType"].endswith("wordprocessingml.document")
    assert body["modifiedMs"] == pytest.approx(target.stat().st_mtime * 1000, rel=1e-6)
    assert body["path"] == str(target)

    assert missing.status_code == 200
    assert missing.json() == {
        "byteSize": 0,
        "exists": False,
        "isFile": False,
        "mimeType": "application/pdf",
        "modifiedMs": 0,
        "path": str(tmp_path / "nope.pdf"),
    }


def test_fs_stat_requires_auth(tmp_path):
    response = TestClient(web_server.app).get("/api/fs/stat", params={"path": str(tmp_path)})

    assert response.status_code == 401
