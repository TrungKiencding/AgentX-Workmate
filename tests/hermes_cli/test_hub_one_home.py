"""AgentX Hub keeps one home per machine: the default profile's (hub
decisions §8 #22, §9.1 #18).

Every backend starts the hub sync, and on the desktop a named profile runs a
backend of its own — with the machine's device id. Two homes answering for one
machine undo each other: a skill one has is, to the other, a copy "removed
here", which it tells the hub, which then removes it from the first. So the
sync runs in the default profile only (of the install, or of the account
signed in), what a named profile has is its own, and no new AgentX Hub skill
or server lands in a named profile to begin with."""

from __future__ import annotations

import io
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from hermes_cli import hub_sync
from hermes_cli.hub_sync import announce_mcp_install, announce_mcp_removal, hub_keeps_profile, syncs_this_home
from hermes_cli.web_server import app
from tests.hermes_cli.test_hub_sync import SAFE_FILES, FakeHub, FakeInstaller, _engine


def _root() -> Path:
    from hermes_constants import get_default_hermes_root

    return get_default_hermes_root()


@pytest.fixture
def named_profile(monkeypatch: pytest.MonkeyPatch) -> Path:
    """This process runs as named profile ``work`` — as the desktop's own backend of that profile does."""
    home = _root() / "profiles" / "work"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("AGENTX_HOME", str(home))
    return home


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(app.state, "auth_required", False, raising=False)
    with TestClient(app) as test_client:
        test_client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
        yield test_client


@pytest.fixture
def spawned(monkeypatch: pytest.MonkeyPatch) -> list:
    import hermes_cli.web_server as web_server

    calls: list = []
    monkeypatch.setattr(web_server, "_spawn_hermes_action", lambda args, name, extra_env=None: calls.append(list(args)) or SimpleNamespace(pid=7))
    monkeypatch.setattr(web_server, "_hub_action_name", lambda kind, ident: f"skills-{kind}")
    monkeypatch.setattr(web_server, "_profile_cli_args", lambda profile: ["--profile", profile] if profile else [])
    return calls


class TestWhichHome:
    def test_the_default_profile_of_the_install_or_of_an_account_is_kept_a_named_one_is_not(self):
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override

        root = _root()
        cases = {root: True, root / "accounts" / "kien": True, root / "profiles" / "work": False,
                 root / "accounts" / "kien" / "profiles" / "work": False}
        for home, kept in cases.items():
            token = set_hermes_home_override(str(home))
            try:
                assert syncs_this_home() is kept, home
                assert hub_keeps_profile(None) is kept and hub_keeps_profile("default") is kept, home
                assert hub_keeps_profile("work") is False, home  # a request naming another profile
            finally:
                reset_hermes_home_override(token)


class TestTheSync:
    def test_a_named_profile_runs_no_sync_of_its_own(self, named_profile):
        hub = FakeHub()
        hub.add_skill("demo-core", SAFE_FILES)
        hub.install_row("demo-core", reported="installed")
        installer = FakeInstaller()
        outcome = _engine(hub, installer).tick()
        assert outcome.status == "other_profile" and "default profile" in outcome.detail
        # Nothing asked of the hub, nothing done here, nothing kept of what the hub says.
        assert hub.requests == [] and installer.calls == [] and not (named_profile / "cache" / "hub_sync_state.json").exists()

    def test_the_default_profile_syncs(self):
        hub = FakeHub()
        hub.add_skill("demo-core", SAFE_FILES)
        hub.install_row("demo-core")
        installer = FakeInstaller()
        assert _engine(hub, installer).tick().installed == ["demo-core"]

    def test_the_loop_does_not_start_in_a_named_profile(self, named_profile):
        import asyncio

        engine = _engine(FakeHub())
        engine.tick = lambda: pytest.fail("a named profile ticks")  # type: ignore[method-assign]
        asyncio.run(asyncio.wait_for(engine.run_forever(), timeout=5))  # returns at once


class TestMcpAnnouncements:
    class _Client:
        def __init__(self) -> None:
            self.calls: list = []

        def create_mcp_install(self, slug, **kwargs):
            self.calls.append(slug)
            return {"id": "mcp-1"}

    def test_a_named_profile_tells_the_hub_nothing(self, named_profile, monkeypatch):
        from tools import mcp_hub

        woken: list = []
        monkeypatch.setattr(hub_sync, "engine", lambda: SimpleNamespace(nudge=lambda: woken.append(1)))
        client = self._Client()
        credentials = hub_sync.HubCredentials(bearer="tok", device_id="dev-1", device_name="Mac")
        assert announce_mcp_install("tracker", client=client, credentials=credentials) is False
        announce_mcp_removal("tracker")
        assert client.calls == [] and woken == [] and mcp_hub.removed_here() == set()

    def test_the_default_profile_tells_the_hub(self, monkeypatch):
        woken: list = []
        monkeypatch.setattr(hub_sync, "engine", lambda: SimpleNamespace(nudge=lambda: woken.append(1)))
        client = self._Client()
        credentials = hub_sync.HubCredentials(bearer="tok", device_id="dev-1", device_name="Mac")
        assert announce_mcp_install("tracker", client=client, credentials=credentials) is True
        assert client.calls == ["tracker"] and woken == [1]


class TestRoutes:
    def test_the_store_installs_no_hub_skill_in_a_named_profile(self, client, spawned):
        refused = client.post("/api/skills/hub/install?profile=work", json={"identifier": "agentx-hub/demo-core"})
        assert refused.status_code == 400 and "default profile" in refused.json()["detail"]
        # Another source is the profile's own business; the default profile takes the hub's.
        assert client.post("/api/skills/hub/install?profile=work", json={"identifier": "skills-sh/acme/notes"}).status_code == 200
        assert client.post("/api/skills/hub/install", json={"identifier": "agentx-hub/demo-core"}).status_code == 200
        assert spawned == [["--profile", "work", "skills", "install", "skills-sh/acme/notes", "--yes"],
                           ["skills", "install", "agentx-hub/demo-core", "--yes"]]

    def test_a_named_profiles_own_backend_is_a_named_profile(self, client, spawned, named_profile):
        # It names no profile on its requests: its home says which it is.
        refused = client.post("/api/skills/hub/install", json={"identifier": "agentx-hub/demo-core"})
        assert refused.status_code == 400 and spawned == []
        assert client.get("/api/mcp/gateway").json()["reason"] == "profile"


class TestTheCli:
    """``agentx -p work skills install agentx-hub/…`` refuses a new one; one the profile has already still updates."""

    def _install(self, *, existing: bool, force: bool) -> tuple[str, bool]:
        from rich.console import Console

        from hermes_cli.skills_hub import do_install

        bundle = SimpleNamespace(source="agentx-hub", name="demo-core", identifier="agentx-hub/demo-core", trust_level="agentx-hub-verified",
                                 metadata={}, files={})
        meta = SimpleNamespace(name="demo-core", path="demo-core", extra={})
        lock = SimpleNamespace(get_installed=lambda name: {"install_path": "/x/demo-core"} if existing else None)
        out = io.StringIO()
        reached: list = []

        def quarantine(_bundle):
            reached.append(True)
            raise ValueError("stop here")

        with patch("tools.skills_hub.ensure_hub_dirs"), patch("tools.skills_hub.GitHubAuth"), \
                patch("tools.skills_hub.create_source_router", return_value=[]), \
                patch("hermes_cli.skills_hub._resolve_source_meta_and_bundle", return_value=(meta, bundle, None)), \
                patch("tools.skills_hub.HubLockFile", return_value=lock), \
                patch("tools.skills_hub.quarantine_bundle", side_effect=quarantine), \
                patch("tools.skills_hub.append_audit_log"):
            do_install("agentx-hub/demo-core", force=force, skip_confirm=True, console=Console(file=out, width=200))
        return out.getvalue(), bool(reached)

    def test_a_new_hub_skill_is_refused_in_a_named_profile(self, named_profile):
        said, reached = self._install(existing=False, force=False)
        assert not reached and "installed in the default profile" in said

    def test_one_the_profile_has_already_still_updates(self, named_profile):
        _said, reached = self._install(existing=True, force=True)
        assert reached

    def test_the_default_profile_installs_it(self):
        _said, reached = self._install(existing=False, force=False)
        assert reached
