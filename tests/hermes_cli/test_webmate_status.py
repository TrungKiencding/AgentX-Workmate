"""``GET /api/webmate/status`` and the ``hermes_cli.webmate_paths`` helpers.

Everything the endpoint folds together is a small file another process writes
(the desktop app, the WebMate MCP server), so the tests build those files in
an isolated ``WEBMATE_DIR`` and check the derived code — the one field the
desktop acts on — for every state a fresh machine walks through.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from hermes_cli import webmate_paths as wp
from hermes_cli.web_routers.webmate import derive_code
from hermes_cli.web_server import app


@pytest.fixture
def webmate_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "webmate"
    root.mkdir()
    monkeypatch.setenv("WEBMATE_DIR", str(root))
    return root


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    hh = tmp_path / "agentx-home"
    hh.mkdir()
    monkeypatch.setenv("AGENTX_HOME", str(hh))
    monkeypatch.setattr("hermes_cli.config.get_hermes_home", lambda: hh)
    monkeypatch.setattr("hermes_cli.config.get_config_path", lambda: hh / "config.yaml")
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: hh)
    return hh


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(app.state, "auth_required", False, raising=False)
    with TestClient(app) as test_client:
        test_client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
        yield test_client


def _write_server(home: Path, enabled: bool = True) -> None:
    (home / "config.yaml").write_text(
        yaml.safe_dump(
            {
                "mcp_servers": {
                    "webmate": {
                        "command": "/x/node",
                        "args": ["/x/optional-mcps/webmate/server/agentx-webmate-mcp.mjs"],
                        "enabled": enabled,
                    }
                }
            }
        ),
        encoding="utf-8",
    )


def _install_extension(root: Path, version: str = "1.0.4") -> None:
    ext = root / wp.WEBMATE_INSTALL_DIR_NAME
    ext.mkdir(parents=True, exist_ok=True)
    (ext / "manifest.json").write_text(json.dumps({"name": "AgentX WebMate", "version": version}), encoding="utf-8")


def _write_pairing(root: Path) -> None:
    (root / "pairing.json").write_text(
        json.dumps({"schema": 1, "token": "t" * 44, "port": 17374, "installId": "inst", "createdAt": "2026-09-09T00:00:00Z"}),
        encoding="utf-8",
    )


def _write_state(root: Path, **fields) -> None:
    state = {
        "schema": 1,
        "pid": os.getpid(),
        "port": 17374,
        "serverVersion": "1.1.0",
        "listening": True,
        "connected": False,
        "pairingRequired": True,
        "browser": None,
        "extensionVersion": None,
        "installType": None,
        "signedIn": None,
        "protocolVersion": None,
        "lastHelloAt": None,
        "error": None,
        "lastCommand": None,
        "updatedAt": "2026-09-09T00:00:00Z",
    }
    state.update(fields)
    (root / "state.json").write_text(json.dumps(state), encoding="utf-8")


class TestWebmatePaths:
    def test_dir_resolution_prefers_override_then_install_root(self, monkeypatch, tmp_path):
        monkeypatch.setenv("WEBMATE_DIR", str(tmp_path / "custom"))
        assert wp.get_webmate_dir() == tmp_path / "custom"
        monkeypatch.delenv("WEBMATE_DIR")
        monkeypatch.setattr(wp, "get_default_hermes_root", lambda: tmp_path / "root")
        assert wp.get_webmate_dir() == tmp_path / "root" / "webmate"
        assert wp.get_webmate_install_dir(tmp_path / "w") == tmp_path / "w" / "AgentX WebMate"

    def test_readers_never_raise_on_missing_or_broken_files(self, webmate_dir):
        assert wp.read_installed_extension_version(webmate_dir) is None
        assert wp.read_bridge_state(webmate_dir) is None
        assert wp.read_pairing_summary(webmate_dir)["present"] is False
        assert wp.read_update_check(webmate_dir) is None
        (webmate_dir / "state.json").write_text("{ torn", encoding="utf-8")
        assert wp.read_bridge_state(webmate_dir) is None
        (webmate_dir / "pairing.json").write_text("[]", encoding="utf-8")
        assert wp.read_pairing_summary(webmate_dir)["present"] is False

    def test_pairing_summary_never_leaks_the_token(self, webmate_dir):
        _write_pairing(webmate_dir)
        summary = wp.read_pairing_summary(webmate_dir)
        assert summary["present"] is True
        assert summary["installId"] == "inst"
        assert "token" not in summary and "t" * 44 not in json.dumps(summary)

    def test_state_from_a_dead_pid_is_flagged_stale(self, webmate_dir):
        _write_state(webmate_dir, pid=2_147_000_000, connected=True, browser="Chrome 152")
        state = wp.read_bridge_state(webmate_dir)
        assert state["stale"] is True
        _write_state(webmate_dir, connected=True, browser="Chrome 152")
        assert wp.read_bridge_state(webmate_dir)["stale"] is False


class TestDeriveCode:
    def test_priority_order(self):
        base = dict(extension_present=True, server_enabled=True, connected=True, protocol_version=3, signed_in=True, pairing_required=True)
        assert derive_code(**base) is None
        assert derive_code(**{**base, "extension_present": False, "server_enabled": False}) == "WEBMATE_NOT_INSTALLED"
        assert derive_code(**{**base, "server_enabled": False}) == "WEBMATE_DISABLED"
        assert derive_code(**{**base, "connected": False, "signed_in": False}) == "WEBMATE_NOT_CONNECTED"
        assert derive_code(**{**base, "protocol_version": 2}) == "WEBMATE_OUTDATED"
        assert derive_code(**{**base, "protocol_version": 2, "pairing_required": False}) is None, "dev mode accepts v2"
        assert derive_code(**{**base, "signed_in": False}) == "WEBMATE_NOT_SIGNED_IN"
        assert derive_code(**{**base, "signed_in": None}) is None, "unknown sign-in state is not an error"


class TestStatusEndpoint:
    def test_fresh_machine_reports_not_installed(self, client, home, webmate_dir):
        body = client.get("/api/webmate/status").json()
        assert body["schema"] == 1
        assert body["code"] == "WEBMATE_NOT_INSTALLED"
        assert body["extension"] == {
            "present": False,
            "installedVersion": None,
            "installDir": str(webmate_dir / "AgentX WebMate"),
            "runningVersion": None,
        }
        assert body["server"]["registered"] is False
        assert body["connected"] is False
        assert body["bridge"] is None
        assert body["extensionId"] == "pfadeibckkgklmmjghiikadphihbpape"
        assert body["webmateDir"] == str(webmate_dir)

    def test_installed_but_server_disabled(self, client, home, webmate_dir):
        _install_extension(webmate_dir)
        _write_server(home, enabled=False)
        body = client.get("/api/webmate/status").json()
        assert body["code"] == "WEBMATE_DISABLED"
        assert body["server"] == {
            "registered": True,
            "enabled": False,
            "command": "/x/node",
            "args": ["/x/optional-mcps/webmate/server/agentx-webmate-mcp.mjs"],
            "bundled": True,
        }
        assert body["extension"]["installedVersion"] == "1.0.4"

    def test_installed_enabled_but_browser_closed(self, client, home, webmate_dir):
        _install_extension(webmate_dir)
        _write_server(home)
        _write_pairing(webmate_dir)
        _write_state(webmate_dir)
        body = client.get("/api/webmate/status").json()
        assert body["code"] == "WEBMATE_NOT_CONNECTED"
        assert body["serverRunning"] is True
        assert body["pairing"]["present"] is True
        assert body["browser"] is None

    def test_connected_paired_signed_in_is_ready(self, client, home, webmate_dir):
        _install_extension(webmate_dir)
        _write_server(home)
        _write_pairing(webmate_dir)
        _write_state(
            webmate_dir,
            connected=True,
            browser="Chrome 152",
            extensionVersion="1.0.4",
            installType="workmate",
            signedIn=True,
            protocolVersion=3,
            lastHelloAt="2026-09-09T00:00:01Z",
        )
        body = client.get("/api/webmate/status").json()
        assert body["code"] is None
        assert body["connected"] is True
        assert body["browser"] == "Chrome 152"
        assert body["installType"] == "workmate"
        assert body["signedIn"] is True
        assert body["protocolVersion"] == 3
        assert body["extension"]["runningVersion"] == "1.0.4"
        assert body["bridge"]["stale"] is False

    def test_connected_but_not_signed_in(self, client, home, webmate_dir):
        _install_extension(webmate_dir)
        _write_server(home)
        _write_state(webmate_dir, connected=True, browser="Edge 152", signedIn=False, protocolVersion=3)
        body = client.get("/api/webmate/status").json()
        assert body["code"] == "WEBMATE_NOT_SIGNED_IN"
        assert body["signedIn"] is False

    def test_stale_state_from_a_dead_server_counts_as_not_connected(self, client, home, webmate_dir):
        _install_extension(webmate_dir)
        _write_server(home)
        _write_state(webmate_dir, pid=2_147_000_000, connected=True, browser="Chrome 152", signedIn=True, protocolVersion=3)
        body = client.get("/api/webmate/status").json()
        assert body["code"] == "WEBMATE_NOT_CONNECTED"
        assert body["connected"] is False
        assert body["serverRunning"] is False
        assert body["bridge"]["stale"] is True

    def test_pending_version_comes_from_the_update_check_cache(self, client, home, webmate_dir):
        _install_extension(webmate_dir)
        _write_server(home)
        (webmate_dir / "update-check.json").write_text(
            json.dumps({"checkedAt": "2026-09-09T00:00:00Z", "latest": "1.0.5", "pendingVersion": "1.0.5"}),
            encoding="utf-8",
        )
        body = client.get("/api/webmate/status").json()
        assert body["pendingVersion"] == "1.0.5"
        assert body["updateCheck"]["latest"] == "1.0.5"

    def test_enable_toggle_is_the_existing_mcp_endpoint(self, client, home, webmate_dir):
        _install_extension(webmate_dir)
        _write_server(home, enabled=False)
        assert client.get("/api/webmate/status").json()["code"] == "WEBMATE_DISABLED"
        response = client.put("/api/mcp/servers/webmate/enabled", json={"enabled": True})
        assert response.status_code == 200, response.text
        assert client.get("/api/webmate/status").json()["code"] == "WEBMATE_NOT_CONNECTED"
