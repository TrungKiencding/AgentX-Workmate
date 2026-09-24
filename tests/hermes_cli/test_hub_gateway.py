"""The AgentX Gateway in Workmate (Agent Hub P5.8): the person's gateway
endpoints listed in the MCP tab, one added in a click — this machine's gateway
token asked for with the signed-in session, kept in the profile's ``.env`` as
``AGENTX_GATEWAY_TOKEN``, an entry that sends it — and the hub sync renewing
the token when it has under 30 days left, or saying Workmate must be signed
into again when it cannot.

The hub is a fake behind ``httpx.MockTransport`` for the client, a fake
object for the engine; AGENTX_HOME is the per-test temp directory, so the
config, ``.env`` and cache written are real files."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from hermes_cli.hub_client import HubClient, HubError
from hermes_cli.hub_sync import (
    GATEWAY_SOURCE,
    GATEWAY_TOKEN_ENV,
    GatewayDevice,
    GatewaySignInNeeded,
    HubCredentials,
    HubSyncEngine,
    HubSyncSettings,
    add_gateway_endpoint,
    gateway_entry,
    gateway_entry_name,
)
from hermes_cli.web_server import app

HUB = "https://hub.test"
DEVICE = "8f2b1c3d-0000-4000-8000-000000000001"
SESSION = HubCredentials(bearer="id-token", device_id=DEVICE, device_name="Ada's laptop", source="mailbox")
PERSONAL = HubCredentials(bearer="hub_personal", device_id=DEVICE, device_name="Ada's laptop", source="token")
SETTINGS = HubSyncSettings(base_url=HUB, realtime=False)
ENDPOINTS = {"gateway": {"enabled": True, "url": f"{HUB}/gw"}, "endpoints": [
    {"kind": "server", "ref": "tracker", "label": "Tracker", "url": f"{HUB}/gw/s/tracker", "status": "ready", "tools": 4},
    {"kind": "toolset", "ref": "ts_abcdefghij", "label": "Dự án", "url": f"{HUB}/gw/t/ts_abcdefghij", "status": "needs_connection", "tools": 2},
]}


def _in(days: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


class FakeHub:
    """What the gateway calls of the hub: the endpoints, a device token (each revoking the one before)."""

    def __init__(self) -> None:
        self.issued: list[dict] = []
        self.refuse: HubError | None = None

    def gateway_endpoints(self, **_kwargs):
        return ENDPOINTS

    def gateway_device_token(self, *, bearer, device_id, device_name=""):
        if self.refuse is not None:
            raise self.refuse
        n = len(self.issued) + 1
        answer = {"id": f"t{n}", "prefix": f"hub_t{n}", "token": f"hub_secret-{n}", "expires_at": _in(90), "device_id": device_id, "purpose": "gateway-device",
                  "gateway_url": f"{HUB}/gw", "replaced": n - 1}
        self.issued.append({"bearer": bearer, "device_id": device_id, "device_name": device_name})
        return answer

    def changes(self, **_kwargs):
        return {"cursor": 1, "installs": [], "updates": [], "workspaces": [], "mcp": {"installs": [], "updates": [], "workspaces": []}}


# --- the client ------------------------------------------------------------------------------------------------------------------------


def test_the_client_lists_endpoints_and_asks_for_a_device_token():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/v1/mcp/me/endpoints":
            return httpx.Response(200, json=ENDPOINTS)
        if request.url.path == "/v1/mcp/gateway/device-token":
            if request.headers["authorization"] == "Bearer hub_personal":
                return httpx.Response(403, json={"code": "forbidden", "message": "A device token is asked for from a signed-in session."})
            return httpx.Response(201, json={"id": "t1", "token": "hub_secret-1", "expires_at": _in(90)})
        return httpx.Response(404, json={"code": "not_found"})

    client = HubClient(HUB, transport=httpx.MockTransport(handler), sleep=lambda _s: None)
    assert client.gateway_endpoints(bearer="id-token", device_id=DEVICE)["endpoints"][1]["ref"] == "ts_abcdefghij"
    token = client.gateway_device_token(bearer="id-token", device_id=DEVICE, device_name="Ada's laptop")
    assert token["token"] == "hub_secret-1"
    asked = seen[-1]
    assert json.loads(asked.content) == {"device_id": DEVICE, "device_name": "Ada's laptop"} and asked.headers["x-agentx-device"] == DEVICE
    with pytest.raises(HubError) as refused:
        client.gateway_device_token(bearer="hub_personal", device_id=DEVICE)
    assert refused.value.status_code == 403 and not refused.value.reauth
    with pytest.raises(HubError):
        client.gateway_device_token(bearer="id-token", device_id="")


# --- the token of this machine ---------------------------------------------------------------------------------------------------------


def device(tmp_path: Path, entries: dict | None = None) -> tuple[GatewayDevice, dict]:
    env: dict = {}
    held = GatewayDevice(state_path=tmp_path / "gateway.json", write_env=lambda key, value: env.__setitem__(key, value),
                         list_entries=lambda: dict(entries or {}))
    return held, env


def test_the_token_is_kept_in_env_its_expiry_beside_it_and_never_the_token_itself(tmp_path):
    held, env = device(tmp_path)
    assert held.status() == {"entries": 0, "token": False, "expires_at": None, "days_left": None, "state": "none"}
    assert held.needs_rotation()
    hub = FakeHub()
    held.issue(hub, SESSION)
    assert env == {GATEWAY_TOKEN_ENV: "hub_secret-1"}
    state = json.loads((tmp_path / "gateway.json").read_text())
    assert state["token_id"] == "t1" and "hub_secret" not in json.dumps(state)
    status = held.status(2)
    assert status["state"] == "ok" and status["days_left"] in (89, 90) and status["entries"] == 2 and "hub_secret" not in json.dumps(status)
    assert not held.needs_rotation()
    with pytest.raises(GatewaySignInNeeded):
        held.issue(hub, PERSONAL)
    assert len(hub.issued) == 1


def test_entries_send_the_token_by_reference_and_are_named_for_their_endpoint():
    entry = gateway_entry(ENDPOINTS["endpoints"][1])
    assert entry == {"url": f"{HUB}/gw/t/ts_abcdefghij", "headers": {"Authorization": "Bearer ${AGENTX_GATEWAY_TOKEN}"}, "protocol": "auto", "enabled": True,
                     "source": GATEWAY_SOURCE, "gateway": {"kind": "toolset", "ref": "ts_abcdefghij", "label": "Dự án"}}
    assert "hub" not in entry  # the tool-hash lock of a feed server: it would block every tool of the gateway
    assert gateway_entry_name("ts_abcdefghij") == "agentx-ts_abcdefghij" and gateway_entry_name("Tracker.Pro") == "agentx-tracker-pro"


# --- the tick renews it ------------------------------------------------------------------------------------------------------------------


def engine_with(tmp_path: Path, entries: dict, credentials: HubCredentials, hub: FakeHub) -> tuple[HubSyncEngine, GatewayDevice, dict]:
    held, env = device(tmp_path, entries)
    sync = HubSyncEngine(credentials=lambda: credentials, settings=SETTINGS, client=hub, installer=object(), mcp_installer=_NoMcp(), gateway=held)
    return sync, held, env


class _NoMcp:
    def local_state(self, _slug):
        return {"installed": False}


def _age(path: Path, days_left: float) -> None:
    state = json.loads(path.read_text())
    state["expires_at"] = _in(days_left)
    path.write_text(json.dumps(state))


ADDED = {"agentx-tracker": {"url": f"{HUB}/gw/s/tracker", "source": GATEWAY_SOURCE}}


def test_a_tick_renews_a_token_with_under_thirty_days_left_and_the_desktop_reloads_mcp(tmp_path):
    hub = FakeHub()
    sync, held, env = engine_with(tmp_path, ADDED, SESSION, hub)
    held.issue(hub, SESSION)
    first = sync.tick()
    assert first.ok and first.gateway["state"] == "ok" and "renewed" not in first.gateway and not first.mcp_changed
    _age(tmp_path / "gateway.json", 12)
    revision = sync.status()["mcp_revision"]
    renewed = sync.tick()
    assert renewed.ok and renewed.gateway["renewed"] is True and renewed.gateway["state"] == "ok"
    assert env[GATEWAY_TOKEN_ENV] == "hub_secret-2" and len(hub.issued) == 2
    assert renewed.mcp_changed and sync.status()["mcp_revision"] == revision + 1
    assert sync.status()["gateway"]["days_left"] in (89, 90)
    assert sync.changes()["history"][0]["action"] == "gateway_token"


def test_no_entry_no_renewal(tmp_path):
    hub = FakeHub()
    sync, held, _env = engine_with(tmp_path, {}, SESSION, hub)
    held.issue(hub, SESSION)
    _age(tmp_path / "gateway.json", 3)
    assert sync.tick().gateway["state"] == "renew" and len(hub.issued) == 1


def test_without_a_session_the_tab_is_told_to_sign_in_again(tmp_path):
    hub = FakeHub()
    sync, held, _env = engine_with(tmp_path, ADDED, PERSONAL, hub)
    held.issue(hub, SESSION)
    _age(tmp_path / "gateway.json", -1)
    outcome = sync.tick()
    assert outcome.ok and outcome.gateway["state"] == "expired" and outcome.gateway["sign_in"] is True
    assert len(hub.issued) == 1 and not outcome.mcp_changed


def test_a_refusal_is_kept_for_the_tab_and_a_lapsed_session_stops_the_sync(tmp_path):
    hub = FakeHub()
    sync, held, _env = engine_with(tmp_path, ADDED, SESSION, hub)
    hub.refuse = HubError("The gateway is not open on this hub.", status_code=409, code="mcp_gateway_disabled")
    outcome = sync.tick()
    assert outcome.ok and outcome.gateway["error_code"] == "mcp_gateway_disabled" and outcome.gateway["state"] == "none"
    hub.refuse = HubError("expired", status_code=401)
    assert sync.tick().status == "reauth"


# --- the routes ------------------------------------------------------------------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(app.state, "auth_required", False, raising=False)
    with TestClient(app) as test_client:
        test_client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
        yield test_client


@pytest.fixture
def gateway(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """A signed-in machine, the fake hub behind every HubClient, an engine whose device writes the real .env."""
    import hermes_cli.hub_sync as hub_sync
    from hermes_cli.web_routers import skills

    monkeypatch.setenv("AGENTX_SKILLS_HUB_URL", HUB)
    hub = FakeHub()
    for name in ("gateway_endpoints", "gateway_device_token"):
        monkeypatch.setattr(HubClient, name, lambda self, *args, _name=name, **kwargs: getattr(hub, _name)(*args, **kwargs))
    current = {"credentials": SESSION}
    monkeypatch.setattr(skills, "_hub_credentials_from", lambda _request: current["credentials"])
    held = GatewayDevice(state_path=tmp_path / "gateway.json")
    nudges: list[int] = []
    fake_engine = type("E", (), {"_gateway": held, "nudge": lambda self: nudges.append(1)})()
    monkeypatch.setattr(hub_sync, "engine", lambda: fake_engine)
    hub.current = current
    hub.nudges = nudges
    return hub


def test_the_tab_lists_my_endpoints_and_adds_one_in_a_click(client, gateway):
    from hermes_cli.config import get_env_value, load_config

    listed = client.get("/api/mcp/gateway")
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["available"] is True and body["session"] is True and body["device"]["state"] == "none"
    assert [(e["ref"], e["added"]) for e in body["endpoints"]] == [("tracker", None), ("ts_abcdefghij", None)]
    added = client.post("/api/mcp/gateway/add", json={"kind": "toolset", "ref": "ts_abcdefghij"})
    assert added.status_code == 200, added.text
    assert added.json() == {"ok": True, "name": "agentx-ts_abcdefghij", "url": f"{HUB}/gw/t/ts_abcdefghij"}
    assert get_env_value(GATEWAY_TOKEN_ENV) == "hub_secret-1" and gateway.nudges
    from hermes_cli import mcp_catalog

    raw = mcp_catalog.raw_servers()["agentx-ts_abcdefghij"]
    assert raw["headers"] == {"Authorization": "Bearer ${AGENTX_GATEWAY_TOKEN}"} and raw["source"] == GATEWAY_SOURCE and raw["protocol"] == "auto"
    assert load_config()["mcp_servers"]["agentx-ts_abcdefghij"]["url"] == f"{HUB}/gw/t/ts_abcdefghij"
    # A second endpoint reuses the token (it has 90 days): one token for the machine.
    assert client.post("/api/mcp/gateway/add", json={"kind": "server", "ref": "tracker"}).status_code == 200
    assert len(gateway.issued) == 1
    after = client.get("/api/mcp/gateway").json()
    assert {e["ref"]: e["added"] for e in after["endpoints"]} == {"tracker": "agentx-tracker", "ts_abcdefghij": "agentx-ts_abcdefghij"}
    assert after["device"]["state"] == "ok" and after["device"]["entries"] == 2 and "hub_secret" not in json.dumps(after)


def test_the_tab_says_what_stands_in_the_way(client, gateway):
    def add(ref: str = "tracker", path: str = "/api/mcp/gateway/add") -> dict:
        answer = client.post(path, json={"kind": "server", "ref": ref})
        assert answer.status_code == 200, answer.text  # a refusal is said in the body, as the Hub tab's routes say it
        return answer.json()

    assert add("nope") == {"ok": False, "status": "not_found", "code": "not_found", "detail": "That endpoint is not one of yours on the hub."}
    gateway.current["credentials"] = PERSONAL
    assert (add()["status"], add()["code"]) == ("sign_in", "sign_in_required")
    gateway.current["credentials"] = None
    assert client.get("/api/mcp/gateway").json()["reason"] == "signed_out"
    assert add()["status"] == "reauth"
    gateway.current["credentials"] = SESSION
    gateway.refuse = HubError("The gateway is not open on this hub.", status_code=409, code="mcp_gateway_disabled")
    assert (add()["status"], add()["code"]) == ("error", "mcp_gateway_disabled")
    gateway.refuse = HubError("A device token is asked for from a signed-in session.", status_code=403, code="forbidden")
    assert add()["status"] == "sign_in"
    assert client.get("/api/mcp/gateway?profile=work").json() == {"available": False, "reason": "profile", "endpoints": [], "device": None}
    assert client.post("/api/mcp/gateway/add?profile=work", json={"kind": "server", "ref": "tracker"}).status_code == 400
    from hermes_cli import mcp_catalog

    assert not any(cfg.get("source") == GATEWAY_SOURCE for cfg in mcp_catalog.raw_servers().values())


def test_an_unreachable_hub_lists_nothing_and_says_so(client, gateway, monkeypatch):
    def offline(self, **_kwargs):
        raise HubError("could not reach the AgentX Skill Hub")

    monkeypatch.setattr(HubClient, "gateway_endpoints", offline)
    body = client.get("/api/mcp/gateway").json()
    assert body["available"] is False and body["reason"] == "offline" and body["endpoints"] == []


def test_add_gateway_endpoint_refuses_an_endpoint_without_an_address(tmp_path):
    held, _env = device(tmp_path)
    with pytest.raises(ValueError):
        add_gateway_endpoint({"kind": "server", "ref": "x", "url": "javascript:alert(1)"}, client=FakeHub(), credentials=SESSION, device=held)
