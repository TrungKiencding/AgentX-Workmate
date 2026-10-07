"""The MCP card's "test server" route for a server whose command is not on
this machine — a hub server rendered as ``uvx <pkg>`` where no uv can be
found. Nothing is started, and the answer names what is missing so the
desktop card can say "Missing uv" instead of reporting a connection error."""

from __future__ import annotations

import pytest
import yaml
from fastapi.testclient import TestClient

from hermes_cli.web_server import app
from hermes_constants import get_hermes_home


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(app.state, "auth_required", False, raising=False)
    with TestClient(app) as test_client:
        test_client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
        yield test_client


def test_a_uvx_server_without_uv_reports_the_missing_runtime(client, tmp_path, monkeypatch):
    home = tmp_path / "user"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    empty_path = tmp_path / "empty-path"
    empty_path.mkdir()
    monkeypatch.setenv("PATH", str(empty_path))
    (get_hermes_home() / "config.yaml").write_text(
        yaml.safe_dump({"mcp_servers": {"time": {"command": "uvx", "args": ["mcp-server-time"]}}}),
        encoding="utf-8",
    )

    body = client.post("/api/mcp/servers/time/test").json()

    assert body["ok"] is False
    assert body["tools"] == []
    assert body["missing"] == {"command": "uvx", "runtime": "uv"}
    assert body["error"].startswith("missing runtime uv: 'uvx' is not on PATH")
