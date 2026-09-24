"""The MCP tab's routes for AgentX Hub servers (Agent Hub P3.11): the
catalog lists the hub's verified servers beside the shipped ones, with what
the tab shows of them; installing one asks nothing (its values come with
the request), tells the hub and wakes the sync; removing one here is said
to the hub by the sync. The feed on disk is signed by the hub's vector."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hermes_cli.web_server import app
from tools import mcp_hub

HUB = "https://hub.test"
VECTOR = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "mcp" / "feed-manifest-v1.json").read_text(encoding="utf-8"))


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(app.state, "auth_required", False, raising=False)
    with TestClient(app) as test_client:
        test_client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
        yield test_client


class FakeHubClient:
    def __init__(self) -> None:
        self.created: list[str] = []

    def create_mcp_install(self, slug, **_kwargs):
        self.created.append(slug)
        return {"id": "mcp-1"}


@pytest.fixture
def hub(monkeypatch: pytest.MonkeyPatch):
    """A feed on disk, a signed-in machine, a sync that only counts nudges."""
    from hermes_cli.hub_sync import HubCredentials
    from hermes_cli.web_routers import mcp as routes

    monkeypatch.setenv("AGENTX_SKILLS_HUB_URL", HUB)
    mcp_hub._write_feed(mcp_hub.HubFeed(hub_url=HUB, servers=[{"slug": "linear", "supported": True, "manifest": VECTOR["manifest"]},
                                                              {"slug": "legacy", "supported": False, "manifest": None,
                                                               "notes": [{"code": "workmate_sse_gateway", "params": {}}]}],
                                        fetched_at=time.time(), attempted_at=time.time(), keys={VECTOR["kid"]: VECTOR["public_b64"]}))
    import hermes_cli.hub_sync as hub_sync
    from hermes_cli.hub_client import HubClient

    fake = FakeHubClient()
    credentials = HubCredentials(bearer="tok", device_id="8f2b1c3d-0000-4000-8000-000000000001", device_name="LAPTOP", source="session")
    monkeypatch.setattr(hub_sync, "resolve_credentials", lambda: credentials)
    monkeypatch.setattr(HubClient, "create_mcp_install", lambda self, slug, **_kw: fake.create_mcp_install(slug))
    monkeypatch.setattr(routes, "_refresh_hub_feed", lambda force=False: None)  # the feed on disk is the test's
    nudges: list[int] = []
    monkeypatch.setattr(hub_sync, "engine", lambda: type("E", (), {"nudge": lambda self: nudges.append(1)})())
    fake.nudges = nudges
    return fake


def test_the_catalog_lists_the_hubs_verified_servers_with_what_the_tab_shows(client, hub):
    body = client.get("/api/mcp/catalog").json()
    by_id = {e["id"]: e for e in body["entries"]}
    linear = by_id["agentx-hub/linear"]
    assert (linear["origin"], linear["slug"], linear["version"], linear["verified"], linear["trust"], linear["verdict"]) == (
        "hub", "linear", "1.4.0", True, "reviewed", "safe")
    assert linear["tools"] == ["create_issue", "list_issues"] and linear["installed"] is False
    assert [r["name"] for r in linear["required_env"]] == ["LINEAR_API_KEY"]
    assert "agentx-hub/legacy" not in by_id
    [legacy] = [d for d in body["diagnostics"] if d["name"] == "agentx-hub/legacy"]
    assert legacy["kind"] == "hub_unsupported" and "workmate_sse_gateway" in legacy["message"]
    assert body["hub"]["signed_in"] is True and body["hub"]["servers"] == 2


def test_installing_a_hub_server_asks_nothing_tells_the_hub_and_wakes_the_sync(client, hub):
    missing = client.post("/api/mcp/catalog/install", json={"name": "agentx-hub/linear"})
    assert missing.status_code == 400 and missing.json()["detail"]["code"] == "needs_secrets"
    assert missing.json()["detail"]["missing"] == ["LINEAR_API_KEY"] and hub.created == []
    done = client.post("/api/mcp/catalog/install", json={"name": "agentx-hub/linear", "env": {"LINEAR_API_KEY": "lin-value"}})
    assert done.status_code == 200, done.text
    assert done.json() == {"ok": True, "name": "linear", "id": "agentx-hub/linear", "background": False, "registered": True}
    assert hub.created == ["linear"] and hub.nudges
    entry = {e["id"]: e for e in client.get("/api/mcp/catalog").json()["entries"]}["agentx-hub/linear"]
    assert (entry["installed"], entry["enabled"], entry["installed_version"], entry["update_available"], entry["modified"]) == (True, True, "1.4.0", False, False)


def test_a_hub_server_goes_in_the_default_profile_only(client, hub):
    refused = client.post("/api/mcp/catalog/install", json={"name": "agentx-hub/linear", "env": {"LINEAR_API_KEY": "v"}, "profile": "work"})
    assert refused.status_code == 400 and "default profile" in refused.json()["detail"]


def test_removing_a_hub_server_here_is_said_to_the_hub_by_the_sync(client, hub):
    client.post("/api/mcp/catalog/install", json={"name": "agentx-hub/linear", "env": {"LINEAR_API_KEY": "lin-value"}})
    removed = client.post("/api/mcp/hub/linear/remove")
    assert removed.status_code == 200 and removed.json() == {"ok": True, "name": "linear"}
    assert mcp_hub.removed_here() == {"linear"}
    assert client.post("/api/mcp/hub/linear/remove").status_code == 404
    # installing it again takes the mark away
    client.post("/api/mcp/catalog/install", json={"name": "agentx-hub/linear", "env": {"LINEAR_API_KEY": "lin-value"}})
    assert mcp_hub.removed_here() == set()
