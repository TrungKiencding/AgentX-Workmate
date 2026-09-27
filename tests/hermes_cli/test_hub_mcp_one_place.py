"""Every MCP server of the AgentX Hub is set up in one place (the hub's decision §9.1 #17).

The hub's feed says where each server is set up (``route``). One set up on
the hub — its key or its sign-in kept by the hub — is never installed here
from its manifest and nothing of it is asked here: the MCP store adds its
gateway endpoint when the hub serves it to the person, and otherwise sends
them to the hub's connect page and adds it once they are connected (the
hub's ``mcp.connection.connected``, or the next check). Such an endpoint is
an install of the server like any other: the hub is told, can ask for it on
every machine ("Thêm vào Workmate" on the web), switch it off, hear it go.
One set up on the machine is installed from its manifest, as before.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import hermes_cli.hub_sync as hub_sync
from hermes_cli.hub_client import HubClient, HubError
from hermes_cli.hub_sync import (
    GATEWAY_SOURCE,
    GATEWAY_WAIT_SECONDS,
    GatewayDevice,
    GatewayWaits,
    HubCredentials,
    HubSyncEngine,
    HubSyncSettings,
    McpLocalInstaller,
    add_hub_server,
    gateway_entry,
)
from hermes_cli.web_server import app
from tools import mcp_hub

HUB = "https://hub.test"
DEVICE = "8f2b1c3d-0000-4000-8000-000000000001"
SESSION = HubCredentials(bearer="id-token", device_id=DEVICE, device_name="Ada's laptop", source="session")
PERSONAL = HubCredentials(bearer="hub_personal", device_id=DEVICE, device_name="Ada's laptop", source="token")
SETTINGS = HubSyncSettings(base_url=HUB, realtime=False)
VECTOR = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "mcp" / "feed-manifest-v1.json").read_text(encoding="utf-8"))
ON_HUB = {"via": "gateway", "reason": None}


def _write_feed(*servers: dict) -> None:
    mcp_hub._write_feed(mcp_hub.HubFeed(hub_url=HUB, servers=list(servers), fetched_at=time.time(), attempted_at=time.time(),
                                        keys={VECTOR["kid"]: VECTOR["public_b64"]}))


#: GitHub's shape: set up on the hub, no manifest Workmate could run (the hub's feed says why).
OCTO = {"slug": "octo", "label": "GitHub", "version": "1.12.2", "supported": False, "manifest": None, "route": ON_HUB, "auth": "api_key",
        "trust": "curated", "verdict": "safe", "tools": ["search_repositories", "get_issue"], "page": f"{HUB}/mcp/servers/octo",
        "notes": [{"code": "workmate_header_template", "params": {}}], "description": "Repositories, issues and pull requests."}
#: A server the hub sets up on the machine, from its signed manifest (the hub's vector).
LINEAR = {"slug": "linear", "label": "Linear của nhóm", "supported": True, "manifest": VECTOR["manifest"],
          "route": {"via": "local", "reason": "runs_local"}}


def _endpoints(**statuses: str) -> dict:
    """The hub's ``/v1/mcp/me/endpoints?servers=all``: one row per server named, in the status given."""
    rows = []
    for slug, status in statuses.items():
        via = "local" if status == "local" else "gateway"
        rows.append({"kind": "server", "ref": slug, "label": slug.title(), "url": f"{HUB}/gw/s/{slug}", "status": "ready" if via == "local" else status,
                     "reason": "not_published" if status == "unavailable" else None, "credential": None, "tools": 3,
                     "route": {"via": via, "reason": "sign_in_local" if via == "local" else None}})
    return {"gateway": {"enabled": True, "url": f"{HUB}/gw"}, "endpoints": rows}


class FakeHub:
    """The hub as this machine asks it: where the person stands with each server, a device token, installs."""

    def __init__(self, **statuses: str) -> None:
        self.statuses = dict(statuses)
        self.gateway_on = True
        self.issued: list[str] = []
        self.installs: list[str] = []
        self.rows: list[dict] = []
        self.reports: list[tuple[str, str, dict]] = []
        self.removals: list[str] = []
        self.asked: list[bool] = []

    def gateway_endpoints(self, every_server=False, **_kwargs):
        self.asked.append(every_server)
        body = _endpoints(**self.statuses)
        if not self.gateway_on:
            body["gateway"] = {"enabled": False, "url": None}
        return body

    def gateway_device_token(self, *, bearer, device_id, device_name=""):
        self.issued.append(bearer)
        return {"id": f"t{len(self.issued)}", "prefix": "hub_t", "token": f"hub_secret-{len(self.issued)}", "expires_at": "2099-01-01T00:00:00+00:00",
                "device_id": device_id, "gateway_url": f"{HUB}/gw"}

    def create_mcp_install(self, slug, **_kwargs):
        self.installs.append(slug)
        return {"id": f"inst-{slug}", "slug": slug}

    def changes(self, **_kwargs):
        return {"cursor": 1, "installs": [], "updates": [], "workspaces": [], "mcp": {"installs": [dict(row) for row in self.rows], "updates": [], "workspaces": []}}

    def report_mcp_install(self, install_id, state, **fields):
        self.reports.append((install_id, state, {k: v for k, v in fields.items() if k in ("version", "error") and v}))
        for row in self.rows:
            if row["id"] == install_id:
                row.update(reported_state=state, error=fields.get("error") or "", reported_version=fields.get("version"))
        return {}

    def remove_mcp_install(self, install_id, **_kwargs):
        self.removals.append(install_id)
        return {"ok": True}


@pytest.fixture
def nudges(monkeypatch: pytest.MonkeyPatch) -> list:
    """The global engine as :func:`hub_sync.add_gateway_endpoint` wakes it: counted."""
    woken: list[int] = []
    monkeypatch.setattr(hub_sync, "engine", lambda: SimpleNamespace(nudge=lambda: woken.append(1)))
    monkeypatch.setenv("AGENTX_SKILLS_HUB_URL", HUB)
    return woken


def _device(tmp_path: Path) -> GatewayDevice:
    return GatewayDevice(state_path=tmp_path / "gateway.json", write_env=lambda key, value: None)


def _config_servers() -> dict:
    from hermes_cli import mcp_catalog

    return mcp_catalog.raw_servers()


# --- the hub's word on where a server is set up --------------------------------------------------------------------------------------


def test_the_hubs_word_on_where_a_server_is_set_up_is_read_as_it_is_and_nothing_more():
    assert mcp_hub.hub_route({"route": {"via": "gateway", "reason": None}}) == ON_HUB
    assert mcp_hub.hub_route({"route": {"via": "local", "reason": "sign_in_local"}}) == {"via": "local", "reason": "sign_in_local"}
    # A hub from before the rule says nothing: everything is set up here, as it was.
    assert mcp_hub.hub_route({}) == {"via": "local", "reason": None}
    # A way or a reason this machine does not know is never read as more than it can.
    assert mcp_hub.hub_route({"route": {"via": "teleport"}}) == {"via": "local", "reason": None}
    assert mcp_hub.hub_route({"route": {"via": "local", "reason": "../../etc"}}) == {"via": "local", "reason": None}
    assert mcp_hub.hub_route({"route": "gateway"}) == {"via": "local", "reason": None}


def test_a_server_set_up_on_the_hub_is_never_installed_here_from_a_manifest(monkeypatch, capsys):
    from hermes_cli import mcp_catalog
    from hermes_cli.mcp_picker import install_by_name

    monkeypatch.setenv("AGENTX_SKILLS_HUB_URL", HUB)
    # Its manifest missing (GitHub's), or present and signed (linear as the hub now sets it up): nothing installs it here.
    signed_on_hub = {**LINEAR, "slug": "linear-hub", "route": ON_HUB}
    _write_feed(OCTO, LINEAR, signed_on_hub)
    checked = {entry["slug"]: entry for entry in mcp_hub.checked_servers(HUB)}
    assert (checked["octo"]["route"], checked["octo"]["problem"]) == (ON_HUB, None)
    assert checked["linear"]["route"] == {"via": "local", "reason": "runs_local"} and checked["linear"]["problem"] is None
    diagnostics: list[tuple] = []
    entries = mcp_catalog.hub_entries(diagnostics)
    assert [entry.hub.slug for entry in entries] == ["linear"]
    assert {(name, kind) for name, kind, _ in diagnostics} == {("agentx-hub/octo", "hub_gateway"), ("agentx-hub/linear-hub", "hub_gateway")}
    assert mcp_catalog.get_entry("agentx-hub/octo") is None and mcp_catalog.get_entry("agentx-hub/linear-hub") is None
    assert mcp_catalog.set_up_on_hub("octo") and not mcp_catalog.set_up_on_hub("linear") and not mcp_catalog.set_up_on_hub("nope")
    # The command line says where it is added, instead of "not in the catalog".
    assert install_by_name("agentx-hub/octo") == 1
    said = capsys.readouterr().out
    assert "set up on AgentX Hub" in said and "Utilities → Store → MCP" in said
    assert install_by_name("agentx-hub/nope") == 1 and "is not in the catalog" in capsys.readouterr().out


# --- adding one --------------------------------------------------------------------------------------------------------------------


def test_adding_a_server_set_up_on_the_hub_follows_what_the_hub_says_of_it(tmp_path, nudges):
    hub = FakeHub(octo="needs_connection", tracker="ready", stale="needs_reauth", gone="unavailable", designs="local")
    device = _device(tmp_path)
    added = add_hub_server("tracker", client=hub, credentials=SESSION, device=device)
    assert added == {"status": "added", "name": "agentx-tracker", "url": f"{HUB}/gw/s/tracker", "label": "Tracker"}
    assert _config_servers()["agentx-tracker"] == gateway_entry({"kind": "server", "ref": "tracker", "label": "Tracker", "url": f"{HUB}/gw/s/tracker"})
    assert hub.issued == ["id-token"] and nudges and hub.asked == [True]
    # Not connected yet: nothing is asked here — the hub's own page, opened for Workmate.
    assert add_hub_server("octo", client=hub, credentials=SESSION, device=device) == {
        "status": "needs_connection", "label": "Octo", "connect_url": f"{HUB}/mcp/connect/octo?from=workmate"}
    assert add_hub_server("stale", client=hub, credentials=SESSION, device=device)["status"] == "needs_reauth"
    assert add_hub_server("gone", client=hub, credentials=SESSION, device=device) == {"status": "unavailable", "label": "Gone", "reason": "not_published"}
    assert add_hub_server("designs", client=hub, credentials=SESSION, device=device) == {"status": "local", "label": "Designs"}
    assert add_hub_server("nope", client=hub, credentials=SESSION, device=device) == {"status": "not_found"}
    hub.gateway_on = False
    assert add_hub_server("tracker", client=hub, credentials=SESSION, device=device) == {"status": "gateway_off"}
    assert set(_config_servers()) == {"agentx-tracker"}  # only the one that serves was written


def test_the_connect_page_is_the_hubs_own_whatever_the_slug_holds(nudges):
    assert hub_sync.hub_connect_url("octo") == f"{HUB}/mcp/connect/octo?from=workmate"
    assert hub_sync.hub_connect_url("a/../b?x=1") == f"{HUB}/mcp/connect/a%2F..%2Fb%3Fx%3D1?from=workmate"


# --- waiting for a connection made on the hub ----------------------------------------------------------------------------------------


def test_a_wait_lasts_half_an_hour_and_is_forgotten_after(monkeypatch):
    now = {"t": 1000.0}
    waits = GatewayWaits(clock=lambda: now["t"])
    waits.add("octo", "GitHub")
    assert "octo" in waits and [w["label"] for w in waits.current()] == ["GitHub"]
    now["t"] += GATEWAY_WAIT_SECONDS - 1
    assert "octo" in waits
    now["t"] += 2
    assert "octo" not in waits and waits.current() == []
    assert waits.drop("octo") is False


def test_a_server_waited_for_is_added_once_the_hub_serves_it_and_the_hub_is_told(tmp_path, nudges):
    hub = FakeHub(octo="needs_connection", gone="unavailable", designs="local")
    sync = HubSyncEngine(credentials=lambda: SESSION, settings=SETTINGS, client=hub, installer=SimpleNamespace(local_state=lambda slug: {}),
                         mcp_installer=McpLocalInstaller(), gateway=_device(tmp_path))
    for slug in ("octo", "gone", "designs", "nope"):
        sync.wait_for(slug, slug.title())
    revision = sync.status()["gateway_revision"]
    # Still to connect: kept. No longer served, set up on the machine now, or not listed: waited for no more.
    assert sync.complete_waits(hub, SESSION) == [] and [w["slug"] for w in sync.waiting()] == ["octo"]
    assert hub.installs == [] and "agentx-octo" not in _config_servers()
    hub.statuses["octo"] = "ready"  # the person connected on the hub
    assert sync.complete_waits(hub, SESSION) == [{"slug": "octo", "name": "agentx-octo", "label": "Octo"}]
    assert sync.waiting() == [] and hub.installs == ["octo"] and _config_servers()["agentx-octo"]["source"] == GATEWAY_SOURCE
    assert sync.status()["gateway_revision"] > revision and sync.status()["mcp_revision"] == 1
    assert sync.complete_waits(hub, SESSION) == []  # nothing left to wait for, nothing asked


def test_a_wait_taken_back_while_the_hub_is_asked_is_not_added(tmp_path, nudges):
    class CancelledMeanwhile(FakeHub):
        def gateway_endpoints(self, every_server=False, **kwargs):
            sync.stop_waiting("octo")  # "Huỷ" on its card while the hub answers
            return super().gateway_endpoints(every_server=every_server, **kwargs)

    hub = CancelledMeanwhile(octo="ready", tracker="ready")
    sync = HubSyncEngine(credentials=lambda: SESSION, settings=SETTINGS, client=hub, installer=SimpleNamespace(local_state=lambda slug: {}),
                         mcp_installer=McpLocalInstaller(), gateway=_device(tmp_path))
    sync.wait_for("octo", "GitHub")
    sync.wait_for("tracker", "Tracker")
    assert [added["slug"] for added in sync.complete_waits(hub, SESSION)] == ["tracker"]
    assert "agentx-octo" not in _config_servers() and hub.installs == ["tracker"] and sync.waiting() == []


def test_the_hubs_word_that_a_connection_was_made_adds_the_server_waited_for_at_once(tmp_path, nudges):
    class StreamingHub(FakeHub):
        async def aiter_events(self, **_kwargs):
            for event in ({"id": 7, "type": "mcp.connection.needs_reauth", "payload": {"slug": "billing"}},
                          {"id": 8, "type": "mcp.connection.connected", "payload": {"slug": "elsewhere"}},
                          {"id": 9, "type": "mcp.connection.connected", "payload": {"slug": "octo"}}):
                yield event

    hub = StreamingHub(octo="ready")
    sync = HubSyncEngine(credentials=lambda: SESSION, settings=SETTINGS, client=hub, installer=SimpleNamespace(local_state=lambda slug: {}),
                         mcp_installer=McpLocalInstaller(), gateway=_device(tmp_path))
    woken: list[int] = []
    sync.nudge = lambda: woken.append(1)  # the loop's wake-up: the tick then completes the wait
    sync.wait_for("octo", "GitHub")
    before = sync.status()["gateway_revision"]
    asyncio.run(sync._stream_once(SESSION))
    # Every change to the person's connections has the store ask again; the one waited for wakes the tick, once.
    assert sync.status()["gateway_revision"] == before + 3 and woken == [1] and sync.status()["cursor"] == 9


# --- an install of the hub's, through the gateway ------------------------------------------------------------------------------------


def _row(**extra) -> dict:
    return {"id": "mcp-1", "slug": "octo", "desired_state": "installed", "reported_state": "pending", "version": None, "reported_version": None,
            "error": "", "reported_surface_hash": None, "reason": "", **extra}


def _engine(tmp_path: Path, hub: FakeHub, credentials: HubCredentials = SESSION) -> HubSyncEngine:
    return HubSyncEngine(credentials=lambda: credentials, settings=SETTINGS, client=hub, installer=SimpleNamespace(local_state=lambda slug: {}),
                         mcp_installer=McpLocalInstaller(), gateway=_device(tmp_path))


def test_the_hub_asking_for_a_server_set_up_there_adds_its_endpoint_and_hears_the_version_it_serves(tmp_path, nudges, monkeypatch):
    monkeypatch.setattr(mcp_hub, "refresh", lambda client, *, bearer, force=False: mcp_hub.HubFeed(hub_url=HUB))
    _write_feed(OCTO)
    hub = FakeHub(octo="ready")
    hub.rows = [_row()]  # the web's "Thêm vào Workmate": an install for every machine
    sync = _engine(tmp_path, hub)
    outcome = sync.tick()
    assert outcome.status == "ok" and outcome.mcp["installed"] == ["octo"] and outcome.mcp_changed
    assert _config_servers()["agentx-octo"]["url"] == f"{HUB}/gw/s/octo" and "hub" not in _config_servers()["agentx-octo"]
    assert hub.reports == [("mcp-1", "installed", {"version": "1.12.2"})]
    # Nothing more to do: said once. A newer version is what the gateway serves: said, nothing installed.
    sync.tick()
    assert len(hub.reports) == 1
    _write_feed({**OCTO, "version": "1.13.0"})
    sync.tick()
    assert hub.reports[-1] == ("mcp-1", "installed", {"version": "1.13.0"}) and len(hub.reports) == 2
    # Switched off by the hub (a version withdrawn), then asked for again.
    hub.rows[0].update(desired_state="disabled")
    sync.tick()
    assert _config_servers()["agentx-octo"]["enabled"] is False and hub.reports[-1][1] == "disabled"
    hub.rows[0].update(desired_state="installed")
    sync.tick()
    assert _config_servers()["agentx-octo"]["enabled"] is True and hub.reports[-1][1] == "installed"
    # Removed on the web: gone from this machine, said to the hub.
    hub.rows[0].update(desired_state="removed")
    sync.tick()
    assert "agentx-octo" not in _config_servers() and hub.reports[-1][1] == "removed"


def test_what_stands_in_the_way_of_adding_it_is_said_to_the_hub_by_its_code(tmp_path, nudges, monkeypatch):
    monkeypatch.setattr(mcp_hub, "refresh", lambda client, *, bearer, force=False: mcp_hub.HubFeed(hub_url=HUB))
    _write_feed(OCTO)
    hub = FakeHub(octo="needs_connection")
    hub.rows = [_row()]
    sync = _engine(tmp_path, hub)
    sync.tick()
    assert hub.reports == [("mcp-1", "failed", {"error": "gateway_not_ready: needs_connection"})]
    sync.tick()
    assert len(hub.reports) == 1  # said once while it stands
    # A pin the gateway cannot serve.
    hub.rows = [_row(id="mcp-2", version="1.0.0")]
    sync.tick()
    assert hub.reports[-1] == ("mcp-2", "failed", {"error": "pinned: the gateway serves 1.12.2, not 1.0.0"})
    # A machine whose only credential is a personal token cannot get a gateway token.
    hub = FakeHub(octo="ready")
    hub.rows = [_row(id="mcp-3")]
    _engine(tmp_path, hub, PERSONAL).tick()
    assert hub.reports[-1][1] == "failed" and hub.reports[-1][2]["error"].startswith("gateway_sign_in:")
    assert "agentx-octo" not in _config_servers()


def test_an_endpoint_the_person_removed_here_is_said_gone_not_added_again(tmp_path, nudges, monkeypatch):
    monkeypatch.setattr(mcp_hub, "refresh", lambda client, *, bearer, force=False: mcp_hub.HubFeed(hub_url=HUB))
    _write_feed(OCTO)
    hub = FakeHub(octo="ready")
    hub.rows = [_row(reported_state="installed", reported_version="1.12.2")]
    sync = _engine(tmp_path, hub)
    sync.tick()  # it ran here (reported installed) and is not here any more: the person removed it
    assert hub.removals == ["mcp-1"] and hub.reports[-1][1] == "removed" and "agentx-octo" not in _config_servers()


def test_an_endpoint_added_before_it_was_an_install_is_told_to_the_hub_once(tmp_path, nudges, monkeypatch):
    from hermes_cli.mcp_config import _save_mcp_server

    monkeypatch.setattr(mcp_hub, "refresh", lambda client, *, bearer, force=False: mcp_hub.HubFeed(hub_url=HUB))
    _write_feed(OCTO)
    assert _save_mcp_server("agentx-octo", gateway_entry({"kind": "server", "ref": "octo", "label": "GitHub", "url": f"{HUB}/gw/s/octo"}))
    assert _save_mcp_server("agentx-ts_abcdefghij", gateway_entry({"kind": "toolset", "ref": "ts_abcdefghij", "label": "Dự án",
                                                                   "url": f"{HUB}/gw/t/ts_abcdefghij"}))
    hub = FakeHub(octo="ready")
    hub.rows = [_row(slug="linear", id="mcp-9", desired_state="removed", reported_state="removed")]  # the snapshot has an mcp block
    sync = _engine(tmp_path, hub)
    sync.tick()
    sync.tick()
    assert hub.installs == ["octo"]  # the server's, once; a toolset is no install
    assert McpLocalInstaller().local_state("octo") | {"enabled": None} == {
        "installed": True, "name": "agentx-octo", "route": "gateway", "version": "", "enabled": None, "modified": False,
        "tool_hashes": {}, "prompt_hashes": {}, "template_hashes": {}}


# --- the MCP store's routes ----------------------------------------------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(app.state, "auth_required", False, raising=False)
    with TestClient(app) as test_client:
        test_client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
        yield test_client


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """The feed on disk, a signed-in machine, the fake hub behind every HubClient, an engine of this test's."""
    from hermes_cli.web_routers import mcp as routes
    from hermes_cli.web_routers import skills

    monkeypatch.setenv("AGENTX_SKILLS_HUB_URL", HUB)
    _write_feed(OCTO, LINEAR)
    hub = FakeHub(octo="needs_connection")
    for name in ("gateway_endpoints", "gateway_device_token", "create_mcp_install"):
        monkeypatch.setattr(HubClient, name, lambda self, *args, _name=name, **kwargs: getattr(hub, _name)(*args, **kwargs))
    monkeypatch.setattr(skills, "_hub_credentials_from", lambda _request: SESSION)
    monkeypatch.setattr(hub_sync, "resolve_credentials", lambda: SESSION)
    monkeypatch.setattr(routes, "_refresh_hub_feed", lambda force=False: None)
    sync = HubSyncEngine(credentials=lambda: SESSION, settings=SETTINGS, client=hub, installer=SimpleNamespace(local_state=lambda slug: {}),
                         mcp_installer=McpLocalInstaller(), gateway=_device(tmp_path))
    sync.nudge = lambda: None
    monkeypatch.setattr(hub_sync, "engine", lambda: sync)
    hub.sync = sync
    return hub


def test_the_store_lists_every_hub_server_in_one_shelf_with_where_it_is_set_up(client, store):
    from hermes_cli.mcp_config import _save_mcp_server

    by_id = {entry["id"]: entry for entry in client.get("/api/mcp/catalog").json()["entries"]}
    octo, linear = by_id["agentx-hub/octo"], by_id["agentx-hub/linear"]
    assert octo["route"] == ON_HUB and linear["route"] == {"via": "local", "reason": "runs_local"}
    assert (octo["name"], octo["installed"], octo["required_env"], octo["title"], octo["version"], octo["tools"]) == (
        "agentx-octo", False, [], "GitHub", "1.12.2", ["get_issue", "search_repositories"])
    assert (octo["origin"], octo["slug"], octo["trust"], octo["verdict"], octo["page"]) == ("hub", "octo", "curated", "safe", f"{HUB}/mcp/servers/octo")
    assert [env["name"] for env in linear["required_env"]] == ["LINEAR_API_KEY"]  # asked on this machine: set up here
    # On this machine as its endpoint: said, under the name it has.
    assert _save_mcp_server("agentx-octo", gateway_entry({"kind": "server", "ref": "octo", "label": "GitHub", "url": f"{HUB}/gw/s/octo"}))
    octo = {e["id"]: e for e in client.get("/api/mcp/catalog").json()["entries"]}["agentx-hub/octo"]
    assert (octo["name"], octo["installed"], octo["enabled"]) == ("agentx-octo", True, True)
    # Its catalog diagnostics say it is added from the store — not that it cannot be.
    diagnostics = client.get("/api/mcp/catalog").json()["diagnostics"]
    assert [(d["name"], d["kind"]) for d in diagnostics if d["name"] == "agentx-hub/octo"] == [("agentx-hub/octo", "hub_gateway")]


def test_a_server_installed_from_its_manifest_before_the_hub_set_it_up_on_the_hub_is_said_here_as_it_is(client, store, monkeypatch):
    from hermes_cli.mcp_config import _save_mcp_server

    # It keeps running with its own values (nothing moves it); its card says it is here, and the tools kept off.
    assert _save_mcp_server("octo-old", {"command": "npx", "args": ["-y", "octo-mcp@1.0.0"], "hub": {"slug": "octo", "version": "1.0.0"}})
    monkeypatch.setattr(mcp_hub, "observed", lambda name: {"slug": "octo", "blocked_tools": ["delete_repo"]} if name == "octo-old" else None)
    octo = {e["id"]: e for e in client.get("/api/mcp/catalog").json()["entries"]}["agentx-hub/octo"]
    assert (octo["name"], octo["installed"], octo["enabled"], octo["blocked_tools"], octo["route"]) == ("octo-old", True, True, ["delete_repo"], ON_HUB)
    assert "name_taken" not in octo


def test_connecting_from_the_store_opens_the_hub_then_adds_the_server_once_connected(client, store):
    asked = client.post("/api/mcp/gateway/add", json={"kind": "server", "ref": "octo"}).json()
    assert asked == {"ok": False, "status": "connect", "code": "needs_connection", "connect_url": f"{HUB}/mcp/connect/octo?from=workmate",
                     "detail": "Connect Octo on AgentX Hub: Workmate adds it once you are connected."}
    listed = client.get("/api/mcp/gateway").json()
    assert [(w["slug"], w["connect_url"]) for w in listed["waiting"]] == [("octo", f"{HUB}/mcp/connect/octo?from=workmate")]
    assert [(e["ref"], e["status"]) for e in listed["endpoints"]] == [("octo", "needs_connection")]
    assert client.post("/api/mcp/gateway/waiting/check").json()["added"] == []  # not connected yet
    store.statuses["octo"] = "ready"  # the person connected on the hub
    checked = client.post("/api/mcp/gateway/waiting/check").json()
    assert checked == {"added": [{"slug": "octo", "name": "agentx-octo", "label": "Octo"}], "waiting": []}
    assert store.installs == ["octo"] and "agentx-octo" in _config_servers()
    # Removed from the store: through the hub's own removal, like a server installed from its manifest.
    removed = client.post("/api/mcp/hub/octo/remove")
    assert removed.status_code == 200 and removed.json() == {"ok": True, "name": "agentx-octo"} and "agentx-octo" not in _config_servers()
    assert "octo" in mcp_hub.removed_here()


def test_a_wait_is_taken_back_and_a_ready_server_is_added_at_once(client, store):
    client.post("/api/mcp/gateway/add", json={"kind": "server", "ref": "octo"})
    assert client.delete("/api/mcp/gateway/waiting/octo").json() == {"ok": True}
    assert client.get("/api/mcp/gateway").json()["waiting"] == []
    store.statuses["octo"] = "ready"
    added = client.post("/api/mcp/gateway/add", json={"kind": "server", "ref": "octo"}).json()
    assert added == {"ok": True, "name": "agentx-octo", "url": f"{HUB}/gw/s/octo", "registered": True} and store.installs == ["octo"]
    store.statuses["paused"] = "unavailable"
    refused = client.post("/api/mcp/gateway/add", json={"kind": "server", "ref": "paused"}).json()
    assert (refused["ok"], refused["code"]) == (False, "unavailable:not_published")
    store.statuses["designs"] = "local"
    assert client.post("/api/mcp/gateway/add", json={"kind": "server", "ref": "designs"}).json()["code"] == "set_up_here"


def test_a_hub_that_cannot_be_reached_leaves_the_waits_as_they_are(client, store, monkeypatch):
    client.post("/api/mcp/gateway/add", json={"kind": "server", "ref": "octo"})

    def offline(self, **_kwargs):
        raise HubError("could not reach the AgentX Skill Hub")

    monkeypatch.setattr(HubClient, "gateway_endpoints", offline)
    checked = client.post("/api/mcp/gateway/waiting/check").json()
    assert checked["added"] == [] and [w["slug"] for w in checked["waiting"]] == ["octo"]
