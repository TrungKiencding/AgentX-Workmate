"""``mcp.catalog`` over the gateway (Agent Hub P3.11): each entry says what
the person must supply (``requires`` — the names of ``auth.env``), how it
signs in and how it connects — before, ``requires`` read an attribute
entries never had (always ``[]``) and ``transport`` printed the dataclass —
and an AgentX Hub server is listed with its id and origin, installed only
when it is the server configured under its name."""

from __future__ import annotations

import json
import time
from pathlib import Path

import tui_gateway.server as server
from tools import mcp_hub

HUB = "https://hub.test"
VECTOR = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "mcp" / "feed-manifest-v1.json").read_text(encoding="utf-8"))


def _catalog() -> dict:
    response = server._methods["mcp.catalog"](1, {})
    assert "error" not in response, response.get("error")
    return {entry["id"]: entry for entry in response["result"]["servers"]}


def test_every_entry_says_what_it_needs_how_it_signs_in_and_connects():
    catalog = _catalog()
    assert catalog, "the shipped catalog is listed"
    for entry in catalog.values():
        assert entry["transport"] in ("stdio", "http") and entry["auth"] in ("api_key", "oauth", "none")
        assert all(isinstance(name, str) and name for name in entry["requires"])
    n8n = catalog.get("n8n")
    if n8n is not None:  # a shipped api_key entry names its variables
        assert "N8N_API_KEY" in n8n["requires"] and n8n["origin"] == "official"


def test_a_hub_server_is_listed_with_its_id_and_is_installed_only_as_itself(monkeypatch):
    from hermes_cli.config import load_config, save_config

    monkeypatch.setenv("AGENTX_SKILLS_HUB_URL", HUB)
    mcp_hub._write_feed(mcp_hub.HubFeed(hub_url=HUB, servers=[{"slug": "linear", "supported": True, "manifest": VECTOR["manifest"]}],
                                        fetched_at=time.time(), attempted_at=time.time(), keys={VECTOR["kid"]: VECTOR["public_b64"]}))
    entry = _catalog()["agentx-hub/linear"]
    assert (entry["origin"], entry["name"], entry["requires"], entry["auth"], entry["transport"], entry["installed"]) == (
        "hub", "linear", ["LINEAR_API_KEY"], "api_key", "stdio", False)
    # a server written by hand under the same name is not the hub's
    config = load_config()
    config["mcp_servers"] = {"linear": {"command": "npx", "args": ["-y", "some-other@1.0.0"]}}
    save_config(config)
    assert _catalog()["agentx-hub/linear"]["installed"] is False
