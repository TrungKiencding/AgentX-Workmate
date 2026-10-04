"""A skill or MCP server the AgentX Hub keeps off stays off here (hub
decisions §8 #22, §9.1 #18): the hub sync writes what the hub last said of
each (``hub_sync_state.json`` in the cache of the home it syncs), and every
way to switch one back on reads it — the Skills switch and the MCP switch
answer ``409`` with the hub's reason, the mcp.json editor keeps the server
off, ``agentx skills`` keeps the skill off. Only the hub turns it back on."""

from __future__ import annotations

import pytest
import yaml
from fastapi.testclient import TestClient

from hermes_cli.hub_sync import _write_hub_state, hub_hold, install_view, read_hub_state
from hermes_cli.web_server import app

HELD = {"desired_state": "disabled", "withdrawn": True, "reason": "taken down by admin: phishing", "reason_version": "1.0.0", "visible": True,
        "skill_status": "yanked", "server_status": "yanked", "archived_at": None, "successor": None, "serving_until": None}


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(app.state, "auth_required", False, raising=False)
    with TestClient(app) as test_client:
        test_client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
        yield test_client


@pytest.fixture
def held():
    """The hub keeps skill ``demo-core`` and server ``linear`` off; ``notes`` and ``calendar`` are on."""
    _write_hub_state({
        "skills": {"demo-core": install_view(HELD, name="demo-core", status_key="skill_status"),
                   "notes": install_view({"desired_state": "installed", "skill_status": "archived"}, name="notes", status_key="skill_status")},
        "mcp": {"linear": install_view(HELD, name="linear", status_key="server_status"),
                "calendar": install_view({"desired_state": "installed"}, name="calendar", status_key="server_status")},
    })


def _config() -> dict:
    from hermes_constants import get_hermes_home

    path = get_hermes_home() / "config.yaml"
    return (yaml.safe_load(path.read_text()) or {}) if path.exists() else {}


def _servers(**servers) -> None:
    from hermes_cli.config import load_config, save_config

    config = load_config()
    config["mcp_servers"] = servers
    save_config(config)


class TestState:
    def test_the_view_keeps_what_the_switches_and_the_store_need(self, held):
        state = read_hub_state()
        assert state["skills"]["demo-core"] == {"desired_state": "disabled", "withdrawn": True, "reason": "taken down by admin: phishing",
                                                "reason_version": "1.0.0", "visible": True, "archived_at": None, "successor": None,
                                                "serving_until": None, "status": "yanked", "name": "demo-core", "slug": ""}
        assert state["skills"]["notes"]["status"] == "archived" and state["skills"]["notes"]["visible"] is True
        assert hub_hold("skills", "demo-core")["reason"] == "taken down by admin: phishing"
        assert hub_hold("skills", "notes") is None and hub_hold("skills", "nothing") is None
        assert hub_hold("mcp", "linear") is not None and hub_hold("mcp", "demo-core") is None

    def test_no_state_is_no_hold_and_another_home_has_none(self, held, tmp_path):
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override

        token = set_hermes_home_override(str(tmp_path / "worker"))
        try:
            assert read_hub_state() == {"skills": {}, "mcp": {}} and hub_hold("skills", "demo-core") is None
        finally:
            reset_hermes_home_override(token)

    def test_a_state_file_that_cannot_be_read_is_no_hold(self, held):
        from hermes_cli.hub_sync import hub_state_path

        hub_state_path().write_text("{not json", encoding="utf-8")
        assert read_hub_state() == {"skills": {}, "mcp": {}}
        hub_state_path().write_text('{"skills": [], "mcp": {"linear": "x"}}', encoding="utf-8")
        assert read_hub_state() == {"skills": {}, "mcp": {}}


class TestSwitches:
    def test_the_skills_switch_does_not_turn_on_what_the_hub_keeps_off(self, client, held):
        refused = client.put("/api/skills/toggle", json={"name": "demo-core", "enabled": True})
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "hub_disabled" and refused.json()["detail"]["reason"] == "taken down by admin: phishing"
        assert refused.json()["detail"]["version"] == "1.0.0"
        # Switching it off, and any other skill, still works.
        assert client.put("/api/skills/toggle", json={"name": "demo-core", "enabled": False}).status_code == 200
        assert client.put("/api/skills/toggle", json={"name": "notes", "enabled": True}).status_code == 200
        assert "demo-core" in _config()["skills"]["disabled"]

    def test_the_mcp_switch_does_not_turn_on_what_the_hub_keeps_off(self, client, held):
        _servers(linear={"url": "https://mcp.test/linear", "enabled": False}, calendar={"url": "https://mcp.test/cal", "enabled": False})
        refused = client.put("/api/mcp/servers/linear/enabled", json={"enabled": True})
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "hub_disabled"
        assert _config()["mcp_servers"]["linear"]["enabled"] is False
        assert client.put("/api/mcp/servers/calendar/enabled", json={"enabled": True}).status_code == 200
        assert client.put("/api/mcp/servers/linear/enabled", json={"enabled": False}).status_code == 200

    def test_the_mcp_json_editor_keeps_off_what_the_hub_keeps_off(self, client, held):
        _servers(linear={"url": "https://mcp.test/linear", "enabled": False})
        saved = client.put("/api/mcp/servers", json={"servers": {"linear": {"url": "https://mcp.test/linear", "enabled": True},
                                                                 "calendar": {"url": "https://mcp.test/cal"}}})
        assert saved.status_code == 200 and saved.json() == {"ok": True, "kept_off": ["linear"]}
        servers = _config()["mcp_servers"]
        assert servers["linear"]["enabled"] is False and servers["calendar"].get("enabled", True) is True

    def test_agentx_skills_keeps_off_what_the_hub_keeps_off(self, held, monkeypatch, capsys):
        from hermes_cli import curses_ui, skills_config

        skills = [{"name": "demo-core", "category": "", "description": "Demo"}, {"name": "notes", "category": "", "description": "Notes"}]
        monkeypatch.setattr(skills_config, "_list_all_skills", lambda: skills)
        monkeypatch.setattr(skills_config, "_select_platform", lambda: None)
        monkeypatch.setattr("builtins.input", lambda _prompt="": "1")
        monkeypatch.setattr(curses_ui, "curses_checklist", lambda *_a, **_k: {0, 1})  # the person ticks every skill on
        skills_config.save_disabled_skills(skills_config.load_config(), {"demo-core", "notes"})
        skills_config.skills_command()
        assert _config()["skills"]["disabled"] == ["demo-core"]
        assert "demo-core stays off — AgentX Hub keeps it off: taken down by admin: phishing" in capsys.readouterr().out
