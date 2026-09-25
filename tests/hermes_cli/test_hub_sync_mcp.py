"""MCP servers from the AgentX Hub in the hub sync (Agent Hub P3.9).

Two layers, as for skills. The reconcile logic runs against a fake client
and a fake MCP installer, so every branch is pinned: install, a value this
machine lacks, switch off, remove, an edit made here, the lock refreshed
when the hub approves another tool list, and the report carrying what the
server announced. Then the real ``McpLocalInstaller`` installs from a feed
on disk signed by the hub's vector (``tests/fixtures/mcp/feed-manifest-v1.json``)
into the per-test AGENTX_HOME.
"""

from __future__ import annotations

import base64
import copy
import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from hermes_cli.hub_client import HubError
from hermes_cli.hub_sync import FEED_EVENTS, LOCAL_CHANGES, HubCredentials, HubSyncEngine, HubSyncSettings, InstallResult, McpLocalInstaller
from tools import mcp_hub

HUB = "https://hub.test"
DEVICE = "8f2b1c3d-0000-4000-8000-000000000001"
CREDS = HubCredentials(bearer="tok", device_id=DEVICE, device_name="Ada's laptop", source="session")
SETTINGS = HubSyncSettings(base_url=HUB, realtime=False)
VECTOR = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "mcp" / "feed-manifest-v1.json").read_text(encoding="utf-8"))
HASHES = {"list_issues": "sha256:" + "1" * 64}


class FakeClient:
    """The hub as the engine sees it: a snapshot with an ``mcp`` block, and the reports."""

    def __init__(self) -> None:
        self.base_url = HUB
        self.installs: list[dict] = []
        self.reports: list[tuple[str, str, dict]] = []
        self.removals: list[str] = []
        self.refuse_surface = False

    def changes(self, **_kwargs):
        return {"cursor": 1, "installs": [], "updates": [], "workspaces": [], "mcp": {"installs": list(self.installs), "updates": [], "workspaces": []}}

    def remove_mcp_install(self, install_id, **_kwargs):
        self.removals.append(install_id)
        for row in self.installs:
            if row["id"] == install_id:
                row["desired_state"] = "removed"
        return {"ok": True}

    def report_mcp_install(self, install_id, state, **fields):
        if self.refuse_surface and "surface" in fields:
            raise HubError("too large", status_code=422, code="MCP_INVALID|surface_too_large")
        self.reports.append((install_id, state, {k: v for k, v in fields.items() if k not in ("bearer", "device_id", "device_name")}))
        for row in self.installs:
            if row["id"] == install_id:
                row["reported_state"] = state
                row["error"] = fields.get("error") or ""
                if fields.get("surface_hash"):
                    row["reported_surface_hash"] = fields["surface_hash"]
        return {}


class FakeMcp:
    """What is configured on this machine, and what the feed on disk holds."""

    def __init__(self) -> None:
        self.local: dict[str, dict] = {}
        self.feed: dict[str, dict] = {}
        self.seen: dict[str, dict] = {}
        self.calls: list[tuple] = []
        self.install_error = ""
        self.removed: set[str] = set()

    def local_state(self, slug):
        return dict(self.local.get(slug) or {"installed": False, "name": "", "version": "", "enabled": False, "modified": False, "tool_hashes": {}})

    def feed_entry(self, slug):
        item = self.feed.get(slug)
        return SimpleNamespace(hub=SimpleNamespace(version=item["version"], tool_hashes=item["tool_hashes"])) if item else None

    def install(self, slug, *, version=""):
        self.calls.append(("install", slug, version))
        if self.install_error:
            return InstallResult(ok=False, name=slug, error=self.install_error, blocked=True)
        item = self.feed[slug]
        self.local[slug] = {"installed": True, "name": slug, "version": item["version"], "enabled": True, "modified": False,
                            "tool_hashes": dict(item["tool_hashes"])}
        return InstallResult(ok=True, name=slug, version=item["version"])

    def uninstall(self, name):
        self.calls.append(("uninstall", name))
        self.local.pop(name, None)
        return True, f"removed {name}"

    def disable(self, name):
        self.calls.append(("disable", name))
        self.local[name]["enabled"] = False
        return True

    def enable(self, name):
        self.calls.append(("enable", name))
        self.local[name]["enabled"] = True
        return True

    def observed(self, name):
        return self.seen.get(name)

    def removed_here(self):
        return set(self.removed)

    def forget_removed(self, slug):
        self.removed.discard(slug)


@pytest.fixture(autouse=True)
def _no_feed_fetch(monkeypatch):
    """The feed is the fake installer's here: nothing is fetched."""
    fetched: list[bool] = []
    monkeypatch.setattr(mcp_hub, "refresh", lambda client, *, bearer, force=False: fetched.append(force) or mcp_hub.HubFeed(hub_url=HUB))
    return fetched


def _signed(manifest: dict, **hub_changes) -> tuple[dict, dict]:
    """*manifest* with *hub_changes* to its hub block (and to the version it
    signs, for the fields that version holds), signed again by a key of
    this test's own: ``(manifest, keys)``."""
    key = Ed25519PrivateKey.generate()
    public = base64.b64encode(key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode("ascii")
    manifest = copy.deepcopy(manifest)
    hub = manifest["hub"]
    hub.update(hub_changes)
    hub["signed"].update({k: v for k, v in hub_changes.items() if k in mcp_hub.MCP_MANIFEST_FIELDS})
    hub["kid"] = hub["manifest_kid"] = "test-k"
    subset = {k: hub["signed"].get(k) for k in mcp_hub.MCP_MANIFEST_FIELDS}
    hub["signature"] = base64.b64encode(key.sign(mcp_hub.canonical_bytes(subset))).decode("ascii")
    hub["manifest_sig"] = base64.b64encode(key.sign(mcp_hub.canonical_bytes(mcp_hub.signed_manifest_body(manifest)))).decode("ascii")
    return manifest, {"test-k": public}


def _write_feed(manifest: dict, keys: dict) -> None:
    mcp_hub._write_feed(mcp_hub.HubFeed(hub_url=HUB, servers=[{"slug": manifest["hub"]["slug"], "supported": True, "manifest": manifest}],
                                        fetched_at=time.time(), attempted_at=time.time(), keys=keys))


def _row(**extra) -> dict:
    return {"id": "mcp-1", "slug": "linear", "desired_state": "installed", "reported_state": "pending", "version": None, "error": "",
            "reported_surface_hash": None, "reason": "", **extra}


def _engine(client: FakeClient, mcp: FakeMcp) -> HubSyncEngine:
    return HubSyncEngine(credentials=lambda: CREDS, settings=SETTINGS, client=client, installer=SimpleNamespace(local_state=lambda slug: {}),
                         mcp_installer=mcp)


class TestReconcile:
    def test_a_server_asked_for_is_installed_from_the_feed_and_reported(self, _no_feed_fetch):
        client, mcp = FakeClient(), FakeMcp()
        mcp.feed["linear"] = {"version": "1.4.0", "tool_hashes": HASHES}
        client.installs = [_row()]
        outcome = _engine(client, mcp).tick()
        assert outcome.mcp["installed"] == ["linear"] and outcome.mcp_changed and outcome.to_json()["mcp_changed"] is True
        assert client.reports == [("mcp-1", "installed", {"version": "1.4.0", "error": ""})]
        assert _no_feed_fetch == [False]  # the feed is refreshed (when stale) before installing

    def test_a_value_this_machine_lacks_is_reported_once(self):
        client, mcp = FakeClient(), FakeMcp()
        mcp.feed["linear"] = {"version": "1.4.0", "tool_hashes": HASHES}
        mcp.install_error = "needs_secrets: LINEAR_API_KEY"
        client.installs = [_row()]
        engine = _engine(client, mcp)
        engine.tick()
        engine.tick()
        assert [(state, fields["error"]) for _id, state, fields in client.reports] == [("failed", "needs_secrets: LINEAR_API_KEY")]

    def test_switched_off_keeps_the_server_and_says_so_once(self):
        client, mcp = FakeClient(), FakeMcp()
        mcp.local["linear"] = {"installed": True, "name": "linear", "version": "1.4.0", "enabled": True, "modified": False, "tool_hashes": HASHES}
        client.installs = [_row(desired_state="disabled", reason="taken down: leaks tokens", reported_state="installed")]
        engine = _engine(client, mcp)
        outcome = engine.tick()
        assert outcome.mcp["disabled"] == ["linear"] and mcp.local["linear"]["installed"] and not mcp.local["linear"]["enabled"]
        engine.tick()
        assert [state for _id, state, _f in client.reports] == ["disabled"]

    def test_removed_uninstalls_and_reports(self):
        client, mcp = FakeClient(), FakeMcp()
        mcp.local["linear"] = {"installed": True, "name": "linear", "version": "1.4.0", "enabled": True, "modified": False, "tool_hashes": HASHES}
        client.installs = [_row(desired_state="removed", reported_state="installed")]
        outcome = _engine(client, mcp).tick()
        assert outcome.mcp["removed"] == ["linear"] and ("uninstall", "linear") in mcp.calls and client.reports[-1][1] == "removed"

    def test_a_server_removed_on_this_machine_is_removed_on_the_hub_not_installed_again(self):
        client, mcp = FakeClient(), FakeMcp()
        mcp.feed["linear"] = {"version": "1.4.0", "tool_hashes": HASHES}
        client.installs = [_row(reported_state="installed")]  # it ran here; the person deleted it from the config
        engine = _engine(client, mcp)
        outcome = engine.tick()
        assert client.removals == ["mcp-1"] and not [c for c in mcp.calls if c[0] == "install"]
        assert outcome.mcp["removed"] == ["linear"] and client.reports[-1][1] == "removed"
        engine.tick()
        assert len(client.removals) == 1

    def test_a_server_removed_here_before_it_was_reported_is_removed_too(self):
        client, mcp = FakeClient(), FakeMcp()
        mcp.feed["linear"] = {"version": "1.4.0", "tool_hashes": HASHES}
        mcp.removed = {"linear"}  # the MCP tab's "Gỡ" said so
        client.installs = [_row(reported_state="pending")]
        _engine(client, mcp).tick()
        assert client.removals == ["mcp-1"] and mcp.removed == set()

    def test_an_edit_made_here_is_never_overwritten_and_said_once(self):
        client, mcp = FakeClient(), FakeMcp()
        mcp.feed["linear"] = {"version": "1.4.0", "tool_hashes": HASHES}
        mcp.local["linear"] = {"installed": True, "name": "linear", "version": "1.4.0", "enabled": True, "modified": True, "tool_hashes": {}}
        client.installs = [_row(reported_state="installed")]
        engine = _engine(client, mcp)
        engine.tick()
        engine.tick()
        assert not [c for c in mcp.calls if c[0] == "install"]
        assert [(state, fields["error"]) for _id, state, fields in client.reports] == [("failed", LOCAL_CHANGES)]

    def test_the_lock_follows_a_tool_list_the_hub_approved_for_the_same_version(self):
        client, mcp = FakeClient(), FakeMcp()
        mcp.local["linear"] = {"installed": True, "name": "linear", "version": "1.4.0", "enabled": True, "modified": False, "tool_hashes": HASHES}
        mcp.feed["linear"] = {"version": "1.4.0", "tool_hashes": {**HASHES, "create_issue": "sha256:" + "2" * 64}}
        client.installs = [_row(reported_state="installed")]
        outcome = _engine(client, mcp).tick()
        assert ("install", "linear", "1.4.0") in mcp.calls and outcome.mcp["updated"] == ["linear"]
        assert mcp.local["linear"]["tool_hashes"] == mcp.feed["linear"]["tool_hashes"]

    def test_a_newer_version_is_offered_not_forced(self):
        client, mcp = FakeClient(), FakeMcp()
        mcp.local["linear"] = {"installed": True, "name": "linear", "version": "1.4.0", "enabled": True, "modified": False, "tool_hashes": HASHES}
        mcp.feed["linear"] = {"version": "1.5.0", "tool_hashes": HASHES}
        client.installs = [_row(reported_state="installed")]
        _engine(client, mcp).tick()
        assert not [c for c in mcp.calls if c[0] == "install"] and client.reports == []

    def test_the_report_carries_what_the_server_announced_and_the_tools_kept_off(self):
        client, mcp = FakeClient(), FakeMcp()
        mcp.local["linear"] = {"installed": True, "name": "linear", "version": "1.4.0", "enabled": True, "modified": False, "tool_hashes": HASHES}
        mcp.feed["linear"] = {"version": "1.4.0", "tool_hashes": HASHES}
        surface = {"version": 1, "tools": [{"name": "list_issues", "inputSchema": {"type": "object"}}], "prompts": [], "resource_templates": []}
        mcp.seen["linear"] = {"surface_hash": "sha256:" + "9" * 64, "surface": surface, "blocked_tools": ["create_issue"]}
        client.installs = [_row(reported_state="installed", reported_surface_hash="sha256:" + "1" * 64)]
        engine = _engine(client, mcp)
        engine.tick()
        [(_id, state, fields)] = client.reports
        assert state == "installed" and fields["surface"] == surface and fields["surface_hash"] == "sha256:" + "9" * 64
        assert fields["blocked_tools"] == ["create_issue"]
        engine.tick()  # the hub has it now: nothing to say
        assert len(client.reports) == 1

    def test_a_list_the_hub_will_not_read_still_reports_the_state(self):
        client, mcp = FakeClient(), FakeMcp()
        mcp.feed["linear"] = {"version": "1.4.0", "tool_hashes": HASHES}
        mcp.seen["linear"] = {"surface_hash": "sha256:" + "9" * 64, "surface": {"tools": []}, "blocked_tools": []}
        client.refuse_surface = True
        client.installs = [_row()]
        _engine(client, mcp).tick()
        [(_id, state, fields)] = client.reports
        assert state == "installed" and "surface" not in fields

    def test_the_events_that_change_a_manifest_make_the_next_tick_fetch_the_feed(self, _no_feed_fetch):
        assert set(FEED_EVENTS) == {"mcp.install.desired", "mcp.install.update_available", "mcp.endpoint.changed"}
        client, mcp = FakeClient(), FakeMcp()
        mcp.feed["linear"] = {"version": "1.4.0", "tool_hashes": HASHES}
        client.installs = [_row()]
        engine = _engine(client, mcp)
        engine._feed_stale = True
        engine.tick()
        assert _no_feed_fetch == [True]


class TestMcpLocalInstaller:
    """The real installer, against a feed on disk signed by the hub's vector."""

    @pytest.fixture
    def feed(self, monkeypatch):
        monkeypatch.setenv("AGENTX_SKILLS_HUB_URL", HUB)
        manifest = VECTOR["manifest"]
        _write_feed(manifest, {VECTOR["kid"]: VECTOR["public_b64"]})
        return manifest

    def test_installs_from_the_signed_feed_without_asking_and_switches_and_removes(self, feed):
        from hermes_cli import mcp_catalog
        from hermes_cli.config import save_env_value

        installer = McpLocalInstaller()
        missing = installer.install("linear")
        assert not missing.ok and missing.error == "needs_secrets: LINEAR_API_KEY"
        save_env_value("LINEAR_API_KEY", "lin-test-value")
        done = installer.install("linear")
        assert done.ok and done.version == "1.4.0"
        cfg = mcp_catalog.raw_servers()["linear"]  # as written: the value stays in .env, the config names it
        assert cfg["command"] == "npx" and cfg["args"] == ["-y", "@acme/linear-mcp@1.4.0"] and cfg["env"] == {"LINEAR_API_KEY": "${LINEAR_API_KEY}"}
        assert mcp_catalog.installed_servers()["linear"]["env"] == {"LINEAR_API_KEY": "lin-test-value"}  # what the server gets
        assert cfg["hub"]["slug"] == "linear" and cfg["hub"]["tool_hashes"] == feed["hub"]["tool_hashes"]
        assert cfg["tools"] == {"include": ["list_issues"]}  # the author's default
        state = installer.local_state("linear")
        assert (state["installed"], state["version"], state["enabled"], state["modified"]) == (True, "1.4.0", True, False)
        assert installer.disable("linear") and installer.local_state("linear")["enabled"] is False
        assert installer.enable("linear") and installer.local_state("linear")["enabled"] is True
        assert installer.uninstall("linear")[0] and installer.local_state("linear")["installed"] is False

    def test_an_edit_to_the_launch_is_seen(self, feed):
        from hermes_cli.config import load_config, save_config, save_env_value

        save_env_value("LINEAR_API_KEY", "lin-test-value")
        installer = McpLocalInstaller()
        assert installer.install("linear").ok
        config = load_config()
        config["mcp_servers"]["linear"]["args"] = ["-y", "@acme/linear-mcp@1.4.1"]
        save_config(config)
        assert installer.local_state("linear")["modified"] is True

    def test_a_lock_refresh_keeps_what_the_person_set_here(self, feed):
        """The hub approving another tool list reinstalls the server: its
        launch and its lock follow the hub, while what the person set here
        stays — switched off, untrusted, the tools they turned off, their
        timeouts (plan §2.5: a person's edit is never silently overwritten)."""
        from hermes_cli import mcp_catalog
        from hermes_cli.config import load_config, save_config, save_env_value

        save_env_value("LINEAR_API_KEY", "lin-test-value")
        installer = McpLocalInstaller()
        assert installer.install("linear").ok
        config = load_config()
        config["mcp_servers"]["linear"].update(enabled=False, trust="untrusted", timeout=45, connect_timeout=20,
                                               tools={"exclude": ["create_issue"], "prompts": False})
        save_config(config)
        approved = {**feed["hub"]["tool_hashes"], "list_issues": "sha256:" + "5" * 64}
        _write_feed(*_signed(feed, surface_hash="sha256:" + "e" * 64, tool_hashes=approved))
        client = FakeClient()
        client.installs = [_row(reported_state="installed")]
        outcome = HubSyncEngine(credentials=lambda: CREDS, settings=SETTINGS, client=client, installer=SimpleNamespace(local_state=lambda slug: {}),
                                mcp_installer=installer).tick()
        assert outcome.mcp["updated"] == ["linear"]
        raw = mcp_catalog.raw_servers()["linear"]
        assert raw["hub"]["tool_hashes"] == approved and raw["args"] == ["-y", "@acme/linear-mcp@1.4.0"]  # the hub's part followed the hub
        kept = {key: raw.get(key) for key in ("enabled", "trust", "timeout", "connect_timeout", "tools")}
        assert kept == {"enabled": False, "trust": "untrusted", "timeout": 45, "connect_timeout": 20, "tools": {"exclude": ["create_issue"], "prompts": False}}
        assert installer.local_state("linear")["modified"] is False

    def test_a_pinned_version_the_feed_does_not_serve_is_not_installed(self, feed):
        result = McpLocalInstaller().install("linear", version="1.3.0")
        assert not result.ok and result.error.startswith("pinned:")

    def test_a_server_the_feed_does_not_hold_is_not_installed(self, feed):
        result = McpLocalInstaller().install("nothing")
        assert not result.ok and result.error.startswith("not_in_feed:")
