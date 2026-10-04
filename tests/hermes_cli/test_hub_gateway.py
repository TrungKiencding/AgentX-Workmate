"""The AgentX Gateway in Workmate (Agent Hub P5.8): the person's gateway
endpoints listed in the MCP tab, one added in a click — this machine's gateway
token asked for with the signed-in session, kept in the profile's ``.env`` as
``AGENTX_HUB_GATEWAY_TOKEN``, an entry that sends it — and the hub sync renewing
the token when it has under 30 days left, or saying Workmate must be signed
into again when it cannot. Before config v38 the token was kept as
``AGENTX_GATEWAY_TOKEN``, the key the OpenClaw migration fills with OpenClaw's
messaging gateway token: the token moves off it, and OpenClaw's value stays.

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
    LEGACY_GATEWAY_TOKEN_ENV,
    GatewayDevice,
    GatewaySignInNeeded,
    HubCredentials,
    HubSyncEngine,
    HubSyncSettings,
    add_gateway_endpoint,
    gateway_entry,
    gateway_entry_name,
    migrate_gateway_token_env,
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
        #: What the hub announces as its gateway with each token.
        self.gateway_url = f"{HUB}/gw"
        #: The installs this machine told the hub about (a gateway endpoint of a hub server is one, the hub's §9.1 #17).
        self.installs: list[str] = []
        self.every_server: list[bool] = []

    def gateway_endpoints(self, every_server=False, **_kwargs):
        self.every_server.append(every_server)
        return ENDPOINTS

    def create_mcp_install(self, slug, **_kwargs):
        self.installs.append(slug)
        return {"id": f"inst-{slug}", "slug": slug}

    def gateway_device_token(self, *, bearer, device_id, device_name=""):
        if self.refuse is not None:
            raise self.refuse
        n = len(self.issued) + 1
        answer = {"id": f"t{n}", "prefix": f"hub_t{n}", "token": f"hub_secret-{n}", "expires_at": _in(90), "device_id": device_id, "purpose": "gateway-device",
                  "gateway_url": self.gateway_url, "replaced": n - 1}
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
    assert entry == {"url": f"{HUB}/gw/t/ts_abcdefghij", "headers": {"Authorization": "Bearer ${AGENTX_HUB_GATEWAY_TOKEN}"}, "protocol": "auto", "enabled": True,
                     "source": GATEWAY_SOURCE, "gateway": {"kind": "toolset", "ref": "ts_abcdefghij", "label": "Dự án"}}
    assert "hub" not in entry  # the tool-hash lock of a feed server: it would block every tool of the gateway
    assert gateway_entry_name("ts_abcdefghij") == "agentx-ts_abcdefghij" and gateway_entry_name("Tracker.Pro") == "agentx-tracker-pro"


# --- the tick renews it ------------------------------------------------------------------------------------------------------------------


def engine_with(tmp_path: Path, entries: dict, credentials: HubCredentials, hub: FakeHub) -> tuple[HubSyncEngine, GatewayDevice, dict]:
    held, env = device(tmp_path, entries)
    sync = HubSyncEngine(credentials=lambda: credentials, settings=SETTINGS, client=hub, installer=_NoSkills(), mcp_installer=_NoMcp(), gateway=held)
    return sync, held, env


class _NoSkills:
    """No skill from the hub on this machine."""

    def local_state(self, _slug):
        return {"installed": False, "name": "", "version": "", "content_hash": "", "install_path": "", "enabled": False}

    def hub_skills(self):
        return []


class _NoMcp:
    def hub_servers(self):
        return []

    def local_state(self, _slug):
        return {"installed": False}

    def removed_here(self):
        return set()


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
    for name in ("gateway_endpoints", "gateway_device_token", "create_mcp_install"):
        monkeypatch.setattr(HubClient, name, lambda self, *args, _name=name, **kwargs: getattr(hub, _name)(*args, **kwargs))
    current = {"credentials": SESSION}
    monkeypatch.setattr(skills, "_hub_credentials_from", lambda _request: current["credentials"])
    monkeypatch.setattr(hub_sync, "resolve_credentials", lambda: current["credentials"])
    held = GatewayDevice(state_path=tmp_path / "gateway.json")
    nudges: list[int] = []
    waits = hub_sync.GatewayWaits()

    class FakeEngine:
        """The engine as the routes use it: the gateway device, a nudge, the servers waited for."""

        _gateway = held

        def nudge(self):
            nudges.append(1)

        def wait_for(self, slug, label=""):
            return waits.add(slug, label)

        def stop_waiting(self, slug):
            return waits.drop(slug)

        def waiting(self):
            return waits.current()

    monkeypatch.setattr(hub_sync, "engine", lambda: FakeEngine())
    hub.current = current
    hub.nudges = nudges
    hub.waits = waits
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
    assert raw["headers"] == {"Authorization": "Bearer ${AGENTX_HUB_GATEWAY_TOKEN}"} and raw["source"] == GATEWAY_SOURCE and raw["protocol"] == "auto"
    assert load_config()["mcp_servers"]["agentx-ts_abcdefghij"]["url"] == f"{HUB}/gw/t/ts_abcdefghij"
    # A second endpoint reuses the token (it has 90 days): one token for the machine. A server's is an install of it,
    # told to the hub (the hub's decision §9.1 #17); a toolset's is not.
    server = client.post("/api/mcp/gateway/add", json={"kind": "server", "ref": "tracker"})
    assert server.status_code == 200 and server.json() == {"ok": True, "name": "agentx-tracker", "url": f"{HUB}/gw/s/tracker", "registered": True}
    assert len(gateway.issued) == 1 and gateway.installs == ["tracker"]
    after = client.get("/api/mcp/gateway").json()
    assert {e["ref"]: e["added"] for e in after["endpoints"]} == {"tracker": "agentx-tracker", "ts_abcdefghij": "agentx-ts_abcdefghij"}
    assert after["device"]["state"] == "ok" and after["device"]["entries"] == 2 and "hub_secret" not in json.dumps(after)
    # The tab — and adding a server — asks the hub for every server set up there, not only the ones connected; a
    # toolset is always one of mine: list, add the toolset, add the server, list.
    assert gateway.every_server == [True, False, True, True] and after["waiting"] == []


def test_the_tab_says_what_stands_in_the_way(client, gateway):
    def add(ref: str = "tracker", path: str = "/api/mcp/gateway/add") -> dict:
        answer = client.post(path, json={"kind": "server", "ref": ref})
        assert answer.status_code == 200, answer.text  # a refusal is said in the body, as the Hub tab's routes say it
        return answer.json()

    assert add("nope") == {"ok": False, "status": "not_found", "code": "not_found", "detail": "That server is not set up on the hub for you."}
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
    assert client.get("/api/mcp/gateway?profile=work").json() == {"available": False, "reason": "profile", "endpoints": [], "device": None, "waiting": []}
    assert client.post("/api/mcp/gateway/add?profile=work", json={"kind": "server", "ref": "tracker"}).status_code == 400
    from hermes_cli import mcp_catalog

    assert not any(cfg.get("source") == GATEWAY_SOURCE for cfg in mcp_catalog.raw_servers().values())


def test_an_unreachable_hub_lists_nothing_and_says_so(client, gateway, monkeypatch):
    def offline(self, **_kwargs):
        raise HubError("could not reach the AgentX Skill Hub")

    monkeypatch.setattr(HubClient, "gateway_endpoints", offline)
    body = client.get("/api/mcp/gateway").json()
    assert body["available"] is False and body["reason"] == "offline" and body["endpoints"] == []


def test_the_gateway_never_writes_over_a_server_of_the_same_name_set_up_by_hand(client, gateway):
    from hermes_cli import mcp_catalog
    from hermes_cli.mcp_config import _save_mcp_server

    mine = {"url": "https://tracker.example.com/mcp", "headers": {"Authorization": "Bearer ${TRACKER_KEY}"}}
    assert _save_mcp_server("agentx-tracker", mine)
    refused = client.post("/api/mcp/gateway/add", json={"kind": "server", "ref": "tracker"})
    assert refused.status_code == 200, refused.text
    body = refused.json()
    assert (body["ok"], body["status"], body["code"]) == (False, "error", "invalid") and "agentx-tracker" in body["detail"]
    assert mcp_catalog.raw_servers()["agentx-tracker"] == mine and not gateway.issued
    # One the gateway wrote is its own to write again.
    assert client.post("/api/mcp/gateway/add", json={"kind": "toolset", "ref": "ts_abcdefghij"}).json()["ok"] is True
    assert client.post("/api/mcp/gateway/add", json={"kind": "toolset", "ref": "ts_abcdefghij"}).json()["ok"] is True


def test_add_gateway_endpoint_refuses_an_endpoint_without_an_address(tmp_path):
    held, _env = device(tmp_path)
    with pytest.raises(ValueError):
        add_gateway_endpoint({"kind": "server", "ref": "x", "url": "javascript:alert(1)"}, gateway_url=f"{HUB}/gw", client=FakeHub(), credentials=SESSION,
                             device=held)


# --- the token goes to the gateway, nowhere else (Agent Hub P6.1 WM-F3) ----------------------------------------------------------------


def test_the_token_goes_over_https_to_the_origin_of_the_gateway_only():
    from hermes_cli.hub_sync import gateway_endpoint_problem as problem

    gateway = f"{HUB}/gw"
    assert problem(f"{HUB}/gw/s/tracker", gateway) is None and problem("https://HUB.test:443/gw/t/ts_x", gateway) is None
    for url in ("http://hub.test/gw/s/x", "https://gw.evil.example/gw/s/x", "https://hub.test:8443/gw/s/x", "https://hub.test.evil.example/gw/s/x",
                "https://hub.test@evil.example/gw/s/x", "javascript:alert(1)", ""):
        assert problem(url, gateway), url
    for local in ("http://127.0.0.1:8820", "http://localhost:8820", "http://[::1]:8820"):  # a hub run on this machine
        assert problem(f"{local}/gw/s/x", f"{local}/gw") is None
    assert problem(f"{HUB}/gw/s/x", "http://hub.test/gw") and problem(f"{HUB}/gw/s/x", "")  # a gateway over plain http, or none, is no anchor


@pytest.mark.parametrize("url", ["https://gw.evil.example/gw/s/tracker", "http://hub.test/gw/s/tracker", "https://hub.test:8443/gw/s/tracker"],
                         ids=["foreign-host", "plain-http", "other-port"])
def test_a_foreign_or_plain_http_endpoint_is_refused_and_no_token_is_issued(client, gateway, monkeypatch, url):
    """Whatever the endpoint list says, the device token goes over https to
    the gateway the hub announces: an endpoint elsewhere is refused before
    any token is asked for."""
    from hermes_cli import mcp_catalog

    rewritten = {**ENDPOINTS, "endpoints": [{**ENDPOINTS["endpoints"][0], "url": url}]}
    monkeypatch.setattr(HubClient, "gateway_endpoints", lambda self, **_kwargs: rewritten)
    refused = client.post("/api/mcp/gateway/add", json={"kind": "server", "ref": "tracker"})
    assert refused.status_code == 200, refused.text
    body = refused.json()
    assert (body.get("ok"), body.get("status"), body.get("code"), len(gateway.issued)) == (False, "error", "endpoint_refused", 0)
    assert not any(cfg.get("source") == GATEWAY_SOURCE for cfg in mcp_catalog.raw_servers().values())


def _enabled(name: str):
    from hermes_cli import mcp_catalog

    return (mcp_catalog.raw_servers().get(name) or {}).get("enabled")


def _renewing(tmp_path: Path, hub: FakeHub, written: list) -> tuple[HubSyncEngine, GatewayDevice]:
    """A token issued for the tracker entry of the real config, twelve days from expiry."""
    from hermes_cli.mcp_config import _save_mcp_server

    assert _save_mcp_server("agentx-tracker", gateway_entry(ENDPOINTS["endpoints"][0]))
    held = GatewayDevice(state_path=tmp_path / "gateway.json", write_env=lambda _key, value: written.append((value, _enabled("agentx-leak"))))
    held.issue(hub, SESSION)
    _age(tmp_path / "gateway.json", 12)
    return HubSyncEngine(credentials=lambda: SESSION, settings=SETTINGS, client=hub, installer=_NoSkills(), mcp_installer=_NoMcp(), gateway=held), held


def test_a_renewal_switches_off_an_entry_off_the_gateway_before_the_token_is_written(tmp_path):
    """Each renewal checks every entry again: one whose address left the
    gateway (edited here, or written from a list rewritten on the way) is
    switched off before the fresh token reaches .env — it never sends it."""
    from hermes_cli import mcp_catalog
    from hermes_cli.mcp_config import _save_mcp_server

    hub, written = FakeHub(), []
    sync, _held = _renewing(tmp_path, hub, written)
    assert _save_mcp_server("agentx-leak", gateway_entry({"kind": "server", "ref": "leak", "url": "http://gw.evil.example/gw/s/tracker"}))
    outcome = sync.tick()
    assert outcome.gateway["renewed"] is True and len(hub.issued) == 2
    assert written[-1] == ("hub_secret-2", False)  # switched off before the fresh token was written
    assert _enabled("agentx-tracker") is True and [r["name"] for r in outcome.gateway["refused"]] == ["agentx-leak"] and outcome.mcp_changed
    assert mcp_catalog.raw_servers()["agentx-leak"]["headers"] == {"Authorization": "Bearer ${AGENTX_HUB_GATEWAY_TOKEN}"}  # never the token itself
    assert sync.changes()["history"][1]["slug"] == "mcp:agentx-leak"


def test_no_token_is_issued_when_no_entry_may_carry_it(tmp_path):
    from hermes_cli.config import load_config, save_config

    hub, written = FakeHub(), []
    sync, _held = _renewing(tmp_path, hub, written)
    config = load_config()
    config["mcp_servers"]["agentx-tracker"]["url"] = "http://gw.evil.example/gw/s/tracker"
    save_config(config)
    outcome = sync.tick()
    assert len(hub.issued) == 1 and "renewed" not in outcome.gateway and _enabled("agentx-tracker") is False
    assert "renewed" not in sync.tick().gateway and len(hub.issued) == 1  # and none on the ticks after


def test_a_renewal_follows_the_gateway_the_hub_announces_now(tmp_path):
    """The gateway moved (the hub's domain changed): the entries on the old
    address are switched off before the new token is written — that address
    may no longer be the hub's."""
    hub, written = FakeHub(), []
    sync, _held = _renewing(tmp_path, hub, written)
    hub.gateway_url = "https://skills.new.example/gw"
    outcome = sync.tick()
    assert outcome.gateway["renewed"] is True and _enabled("agentx-tracker") is False


# --- the token's own key (config v38) -----------------------------------------------------------------------------------------------------

#: A token as the hub makes one: ``hub_`` and the secret; the hub gives its first 12 characters as its prefix.
HUB_TOKEN = "hub_Q7fK2mZx-the-rest-of-a-test-token"
#: What the OpenClaw migration writes as ``AGENTX_GATEWAY_TOKEN``: OpenClaw's messaging gateway token.
OPENCLAW_TOKEN = "oc-gateway-7d2c1e9a4b3f5a60"
#: The tracker's entry as this build writes it, and as the build before v38 wrote it.
TRACKER = gateway_entry({"kind": "server", "ref": "tracker", "label": "Tracker", "url": f"{HUB}/gw/s/tracker"})
LEGACY_TRACKER = {**TRACKER, "headers": {"Authorization": "Bearer ${AGENTX_GATEWAY_TOKEN}"}}
#: A server of the person's own that reads the old key on purpose: never the gateway's to rewrite.
RELAY = {"url": "https://relay.example.com/mcp", "headers": {"X-Relay-Token": "${AGENTX_GATEWAY_TOKEN}"}}


def _left_before_v38(state_path: Path, legacy_value: str | None = HUB_TOKEN, *, state: dict | None = None) -> GatewayDevice:
    """What a build before v38 left on this machine: the tracker's entry reading
    ``${AGENTX_GATEWAY_TOKEN}``, a server of the person's own, *legacy_value*
    under that key (the hub's token — or OpenClaw's, once its migration ran),
    and the state beside the feed naming the hub's token (none with ``state={}``)."""
    from hermes_cli.config import save_env_value
    from hermes_cli.mcp_config import _save_mcp_server

    assert _save_mcp_server("agentx-tracker", dict(LEGACY_TRACKER)) and _save_mcp_server("relay", dict(RELAY))
    if legacy_value is not None:
        save_env_value(LEGACY_GATEWAY_TOKEN_ENV, legacy_value)
    held = state if state is not None else {"token_id": "0b1d6a4e-token", "prefix": HUB_TOKEN[:12], "expires_at": _in(80), "device_id": DEVICE,
                                            "gateway_url": f"{HUB}/gw", "issued_at": _in(-10)}
    if held:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(held), encoding="utf-8")
    return GatewayDevice(state_path=state_path)


def _env() -> dict:
    """The profile's ``.env`` as written, the two keys of this story."""
    from hermes_cli.config import load_env

    env = load_env()
    return {key: env[key] for key in (LEGACY_GATEWAY_TOKEN_ENV, GATEWAY_TOKEN_ENV) if key in env}


def _servers() -> dict:
    from hermes_cli import mcp_catalog

    return mcp_catalog.raw_servers()


def test_the_token_has_a_key_of_its_own_and_the_openclaw_migration_keeps_its_own(tmp_path, monkeypatch):
    """The two tokens never share a key again, whichever comes first: the
    OpenClaw migration (the real script, overwriting) writes OpenClaw's
    messaging gateway token as ``AGENTX_GATEWAY_TOKEN``; this machine's
    gateway token is ``AGENTX_HUB_GATEWAY_TOKEN``, through a renewal and a
    move after."""
    import importlib.util
    import sys

    from hermes_constants import get_hermes_home

    assert (GATEWAY_TOKEN_ENV, LEGACY_GATEWAY_TOKEN_ENV) == ("AGENTX_HUB_GATEWAY_TOKEN", "AGENTX_GATEWAY_TOKEN")
    script = Path(__file__).resolve().parents[2] / "optional-skills" / "migration" / "openclaw-migration" / "scripts" / "openclaw_to_hermes.py"
    spec = importlib.util.spec_from_file_location("openclaw_to_hermes_gateway_token", script)
    assert spec is not None and spec.loader is not None
    openclaw = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, openclaw)  # its dataclasses look their module up while being made
    spec.loader.exec_module(openclaw)
    source = tmp_path / ".openclaw"
    source.mkdir()
    (source / "openclaw.json").write_text(json.dumps({"gateway": {"auth": {"token": OPENCLAW_TOKEN}}}), encoding="utf-8")

    def migrate_from_openclaw() -> None:
        openclaw.Migrator(source_root=source, target_root=get_hermes_home(), execute=True, workspace_target=None, overwrite=True,
                          migrate_secrets=True, output_dir=tmp_path / "openclaw-report", selected_options={"gateway-config"}).migrate()

    hub = FakeHub()
    held = GatewayDevice(state_path=tmp_path / "gateway.json")
    held.issue(hub, SESSION)
    migrate_from_openclaw()
    assert _env() == {LEGACY_GATEWAY_TOKEN_ENV: OPENCLAW_TOKEN, GATEWAY_TOKEN_ENV: "hub_secret-1"}
    held.issue(hub, SESSION)  # a renewal
    migrate_from_openclaw()
    assert _env() == {LEGACY_GATEWAY_TOKEN_ENV: OPENCLAW_TOKEN, GATEWAY_TOKEN_ENV: "hub_secret-2"}
    assert migrate_gateway_token_env(held) == {"entries": [], "moved": False, "expired": False}
    assert _env() == {LEGACY_GATEWAY_TOKEN_ENV: OPENCLAW_TOKEN, GATEWAY_TOKEN_ENV: "hub_secret-2"}


def test_the_hubs_token_moves_to_its_own_key_when_the_state_proves_it_and_the_entries_follow(tmp_path):
    import os

    held = _left_before_v38(tmp_path / "gateway.json")
    assert held.is_its_token(HUB_TOKEN) and not held.is_its_token(OPENCLAW_TOKEN) and not held.is_its_token(HUB_TOKEN[:11])
    assert migrate_gateway_token_env(held) == {"entries": ["agentx-tracker"], "moved": True, "expired": False}
    assert _env() == {GATEWAY_TOKEN_ENV: HUB_TOKEN}
    assert os.environ.get(GATEWAY_TOKEN_ENV) == HUB_TOKEN and LEGACY_GATEWAY_TOKEN_ENV not in os.environ
    # The entry is the one this build writes; the person's own server reads what it read.
    assert _servers()["agentx-tracker"] == TRACKER and _servers()["relay"] == RELAY
    assert held.status(1)["state"] == "ok" and not held.needs_rotation()  # the same token: nothing to renew
    # Nothing left to move, nothing touched again.
    assert migrate_gateway_token_env(held) == {"entries": [], "moved": False, "expired": False}
    assert _env() == {GATEWAY_TOKEN_ENV: HUB_TOKEN}


def test_a_value_that_is_not_the_hubs_token_stays_where_it_is_and_no_entry_sends_it_again(tmp_path):
    """The OpenClaw migration ran after the hub's token was written: OpenClaw's
    token sits under the old key, and the entries sent it to the hub's gateway
    while the state said the token was fine. It never moves; the entries read
    the token's own key; the token the state names counts as expired."""
    held = _left_before_v38(tmp_path / "gateway.json", OPENCLAW_TOKEN)
    assert held.status(1)["state"] == "ok"  # what the tab said until now
    assert migrate_gateway_token_env(held) == {"entries": ["agentx-tracker"], "moved": False, "expired": True}
    assert _env() == {LEGACY_GATEWAY_TOKEN_ENV: OPENCLAW_TOKEN}
    assert _servers()["agentx-tracker"] == TRACKER and _servers()["relay"] == RELAY
    assert held.status(1)["state"] == "expired" and held.needs_rotation()
    assert migrate_gateway_token_env(held) == {"entries": [], "moved": False, "expired": False}  # said once


@pytest.mark.parametrize("state", [{}, {"token_id": "0b1d6a4e-token", "prefix": HUB_TOKEN[:8], "expires_at": _in(80)},
                                   {"prefix": HUB_TOKEN[:12], "expires_at": _in(80)}], ids=["no-state", "short-prefix", "no-token-id"])
def test_without_the_states_word_no_value_is_taken_for_the_hubs_token(tmp_path, state):
    held = _left_before_v38(tmp_path / "gateway.json", state=state)
    done = migrate_gateway_token_env(held)
    assert (done["entries"], done["moved"]) == (["agentx-tracker"], False)
    assert _env() == {LEGACY_GATEWAY_TOKEN_ENV: HUB_TOKEN}  # left where it is
    assert held.needs_rotation() and held.status(1)["state"] in ("none", "expired")  # a new token on the next tick with a session


@pytest.mark.parametrize("cut", ["after-the-new-key", "after-the-entries"])
def test_a_move_cut_short_is_finished_by_the_next_one(tmp_path, cut):
    from hermes_cli.config import save_env_value
    from hermes_cli.mcp_config import _save_mcp_server

    held = _left_before_v38(tmp_path / "gateway.json")
    save_env_value(GATEWAY_TOKEN_ENV, HUB_TOKEN)
    if cut == "after-the-entries":
        assert _save_mcp_server("agentx-tracker", dict(TRACKER))
    renamed = ["agentx-tracker"] if cut == "after-the-new-key" else []
    assert migrate_gateway_token_env(held) == {"entries": renamed, "moved": True, "expired": False}
    assert _env() == {GATEWAY_TOKEN_ENV: HUB_TOKEN} and _servers()["agentx-tracker"] == TRACKER


@pytest.mark.parametrize("legacy_value", [HUB_TOKEN, OPENCLAW_TOKEN], ids=["hub-token", "openclaw-token"])
def test_the_tick_moves_it_on_a_desktop_that_never_runs_agentx_update(tmp_path, legacy_value):
    hub = FakeHub()
    held = _left_before_v38(tmp_path / "gateway.json", legacy_value)
    sync = HubSyncEngine(credentials=lambda: SESSION, settings=SETTINGS, client=hub, installer=_NoSkills(), mcp_installer=_NoMcp(), gateway=held)
    outcome = sync.tick()
    assert outcome.ok and outcome.gateway["renamed"] == ["agentx-tracker"] and outcome.mcp_changed
    assert _servers()["agentx-tracker"] == TRACKER
    if legacy_value == HUB_TOKEN:
        # The token itself moved: no new one, the entries go on with it.
        assert "renewed" not in outcome.gateway and hub.issued == [] and _env() == {GATEWAY_TOKEN_ENV: HUB_TOKEN}
        assert sync.changes()["history"][0]["detail"] == f"moved from {LEGACY_GATEWAY_TOKEN_ENV}"
    else:
        # OpenClaw's stays; the hub gives this machine a token of its own at once.
        assert outcome.gateway["renewed"] is True and len(hub.issued) == 1
        assert _env() == {LEGACY_GATEWAY_TOKEN_ENV: OPENCLAW_TOKEN, GATEWAY_TOKEN_ENV: "hub_secret-1"}
    assert "renamed" not in sync.tick().gateway  # once


def test_without_a_session_the_desktop_is_asked_to_sign_in_not_told_the_token_is_fine(tmp_path):
    hub = FakeHub()
    held = _left_before_v38(tmp_path / "gateway.json", OPENCLAW_TOKEN)
    sync = HubSyncEngine(credentials=lambda: PERSONAL, settings=SETTINGS, client=hub, installer=_NoSkills(), mcp_installer=_NoMcp(), gateway=held)
    outcome = sync.tick()
    # What the MCP tab reads as "sign in again" (gatewayNeedsSignIn: entries, an expired token, no session).
    assert (outcome.gateway["state"], outcome.gateway["sign_in"], outcome.gateway["renamed"]) == ("expired", True, ["agentx-tracker"])
    assert hub.issued == [] and _env() == {LEGACY_GATEWAY_TOKEN_ENV: OPENCLAW_TOKEN}


def test_adding_an_endpoint_where_the_build_before_v38_left_its_token_moves_it_first(client, gateway, tmp_path):
    _left_before_v38(tmp_path / "gateway.json")  # the state the fixture's device reads
    added = client.post("/api/mcp/gateway/add", json={"kind": "toolset", "ref": "ts_abcdefghij"})
    assert added.status_code == 200 and added.json()["ok"] is True, added.text
    assert gateway.issued == [] and _env() == {GATEWAY_TOKEN_ENV: HUB_TOKEN}  # the token it had, under its own key
    reads = {name: cfg["headers"] for name, cfg in _servers().items() if cfg.get("source") == GATEWAY_SOURCE}
    assert reads == {name: {"Authorization": "Bearer ${AGENTX_HUB_GATEWAY_TOKEN}"} for name in ("agentx-tracker", "agentx-ts_abcdefghij")}


def _run_ladder(current_ver: int) -> dict:
    from hermes_cli.config_migrations import run_migrations

    results: dict = {"env_added": [], "config_added": [], "warnings": []}
    run_migrations(current_ver, results, quiet=True)
    return results


class TestConfigV38:
    """``agentx update`` (and ``doctor --fix``, ``config migrate``) moves it too: config v38."""

    @staticmethod
    def _state_path() -> Path:
        from hermes_constants import get_hermes_home

        return get_hermes_home() / "cache" / "mcp_hub_gateway.json"

    def test_the_hubs_token_moves_and_is_said(self):
        _left_before_v38(self._state_path())
        results = _run_ladder(37)
        assert results["config_added"] == [f".env {GATEWAY_TOKEN_ENV} (was {LEGACY_GATEWAY_TOKEN_ENV})",
                                           "mcp_servers.agentx-tracker.headers reads ${AGENTX_HUB_GATEWAY_TOKEN} (was ${AGENTX_GATEWAY_TOKEN})"]
        assert results["warnings"] == [] and _env() == {GATEWAY_TOKEN_ENV: HUB_TOKEN}

    def test_openclaws_token_stays_and_a_new_one_is_announced(self):
        _left_before_v38(self._state_path(), OPENCLAW_TOKEN)
        results = _run_ladder(37)
        assert results["config_added"] == ["mcp_servers.agentx-tracker.headers reads ${AGENTX_HUB_GATEWAY_TOKEN} (was ${AGENTX_GATEWAY_TOKEN})"]
        assert len(results["warnings"]) == 1 and results["warnings"][0].startswith(f"{LEGACY_GATEWAY_TOKEN_ENV} does not hold")
        assert _env() == {LEGACY_GATEWAY_TOKEN_ENV: OPENCLAW_TOKEN} and GatewayDevice().status(1)["state"] == "expired"

    def test_a_machine_that_never_used_the_gateway_is_left_byte_for_byte(self):
        from hermes_cli.config import save_env_value
        from hermes_cli.mcp_config import _save_mcp_server
        from hermes_constants import get_hermes_home

        assert _save_mcp_server("relay", dict(RELAY))
        save_env_value(LEGACY_GATEWAY_TOKEN_ENV, OPENCLAW_TOKEN)  # the OpenClaw migration ran here, the hub's gateway never did
        files = (get_hermes_home() / "config.yaml", get_hermes_home() / ".env")
        before = [path.read_bytes() for path in files]
        assert _run_ladder(37) == {"env_added": [], "config_added": [], "warnings": []}
        assert [path.read_bytes() for path in files] == before and not self._state_path().exists()

    def test_migrate_config_moves_it_and_stamps_the_version(self):
        from hermes_cli.config import check_config_version, migrate_config, read_raw_config, save_config

        _left_before_v38(self._state_path())
        config = read_raw_config()
        config["_config_version"] = 37
        save_config(config)
        migrate_config(interactive=False, quiet=True)
        current, latest = check_config_version()
        assert current == latest >= 38 and _env() == {GATEWAY_TOKEN_ENV: HUB_TOKEN}
        assert _servers()["agentx-tracker"] == TRACKER and _servers()["relay"] == RELAY

    def test_is_registered_in_the_ladder(self):
        from hermes_cli.config import check_config_version
        from hermes_cli.config_migrations import MIGRATIONS

        targets = [target for target, _ in MIGRATIONS]
        assert 38 in targets and targets == sorted(targets) and check_config_version()[1] >= 38
