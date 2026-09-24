"""``agentx mcp`` with AgentX Hub servers (Agent Hub P3.11): a hub server
is a row of its own (``agentx-hub/<slug>``), installed only as itself, and
``agentx mcp catalog`` says why a hub server cannot be installed here."""

from __future__ import annotations

import json
import time
from pathlib import Path

from tools import mcp_hub

HUB = "https://hub.test"
VECTOR = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "mcp" / "feed-manifest-v1.json").read_text(encoding="utf-8"))


def _feed(monkeypatch, *servers):
    monkeypatch.setenv("AGENTX_SKILLS_HUB_URL", HUB)
    mcp_hub._write_feed(mcp_hub.HubFeed(hub_url=HUB, servers=list(servers), fetched_at=time.time(), attempted_at=time.time(),
                                        keys={VECTOR["kid"]: VECTOR["public_b64"]}))


def test_a_hub_server_is_a_row_of_its_own_and_is_installed_only_as_itself(monkeypatch):
    from hermes_cli import mcp_picker
    from hermes_cli.config import load_config, save_config

    _feed(monkeypatch, {"slug": "linear", "supported": True, "manifest": VECTOR["manifest"]})
    rows = {row.name: row for row in mcp_picker._build_rows()}
    assert rows["agentx-hub/linear"].entry.hub.slug == "linear" and rows["agentx-hub/linear"].status == mcp_picker._STATUS_NOT_INSTALLED
    # the shipped catalog has a "linear" too: a server configured under that
    # name without a hub block is the shipped one — never the hub's
    config = load_config()
    config["mcp_servers"] = {"linear": {"command": "npx", "args": ["-y", "other@1.0.0"]}}
    save_config(config)
    rows = {row.name: row for row in mcp_picker._build_rows()}
    assert rows["agentx-hub/linear"].status == mcp_picker._STATUS_NOT_INSTALLED
    assert rows["linear"].entry.origin == "official" and rows["linear"].status == mcp_picker._STATUS_ENABLED


def test_the_catalog_says_why_a_hub_server_cannot_be_installed(monkeypatch, capsys):
    from hermes_cli import mcp_picker

    tampered = json.loads(json.dumps(VECTOR["manifest"]))
    tampered["transport"]["command"] = "bash"
    _feed(monkeypatch, {"slug": "evil", "supported": True, "manifest": tampered},
          {"slug": "legacy", "supported": False, "manifest": None, "notes": [{"code": "workmate_sse_gateway", "params": {}}]})
    mcp_picker.show_catalog()
    out = capsys.readouterr().out
    assert "agentx-hub/evil: the manifest signature does not hold" in out
    assert "agentx-hub/legacy: Workmate cannot run this server as it is (workmate_sse_gateway)" in out


def test_installing_a_hub_server_by_name_tells_the_hub(monkeypatch):
    from hermes_cli import hub_sync, mcp_picker
    from hermes_cli.config import save_env_value

    _feed(monkeypatch, {"slug": "linear", "supported": True, "manifest": VECTOR["manifest"]})
    told: list[str] = []
    monkeypatch.setattr(hub_sync, "announce_mcp_install", lambda slug: told.append(slug) or True)
    save_env_value("LINEAR_API_KEY", "lin-value")
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    assert mcp_picker.install_by_name("agentx-hub/linear") == 0
    assert told == ["linear"]
