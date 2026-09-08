"""The AgentX Skill Hub as the sync plane (Skill Hub plan, Phase 3).

Pointing ``sync.base_url`` at the hub must be all it takes: identity comes
from the credentials the hub-sync engine holds and the hub's ``/v1/me``,
the pre-launch Nous gate does not apply, and every wire call
(``push_skills``, ``propose_skill``, ``pull_workspace_skills``) runs unchanged
against a server speaking the contract. The Nous plane keeps behaving
exactly as before when it is the one configured.
"""

from __future__ import annotations

import threading
from http.server import HTTPServer
from pathlib import PurePosixPath

import pytest

import tools.skills_sync_client as ssc
from hermes_cli.hub_client import HubError
from hermes_cli.hub_sync import HubCredentials
from tests.tools.test_skills_sync_client import _MockState, _jwt, _make_handler, _write_skill

DEVICE = "8f2b1c3d-0000-4000-8000-000000000001"
WS = {"id": "ws-1", "slug": "team", "name": "Team"}
ME_ADMIN = {"subject": "kc-ada", "slug": "ada", "email": "ada@corp.test", "org_id": "org-1", "roles": ["user"], "workspaces": [{**WS, "role": "owner"}]}
ME_MEMBER = {"subject": "kc-bob", "slug": "bob", "email": "bob@corp.test", "org_id": "org-1", "roles": ["user"], "workspaces": [{**WS, "role": "member"}]}
ME_SOLO = {"subject": "kc-solo", "slug": "solo", "email": "", "org_id": "", "roles": ["user"], "workspaces": []}


@pytest.fixture
def hub_server():
    """The contract server standing in for the hub's /v1/sync/*."""
    state = _MockState()
    server = HTTPServer(("127.0.0.1", 0), _make_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", state
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def hub_plane(monkeypatch, hub_server):
    """sync.base_url == skills.hub_url, an ID token in the mailbox, /v1/me answered by a fake."""
    base, state = hub_server
    monkeypatch.setenv("AGENTX_SYNC_BASE_URL", base)
    monkeypatch.setenv("AGENTX_SKILLS_HUB_URL", base)
    monkeypatch.setenv("AGENTX_SYNC_ENABLED", "1")
    ssc._HUB_ME_CACHE.clear()
    calls: dict = {"me": 0, "credentials": HubCredentials(bearer="id-token", device_id=DEVICE, device_name="Ada's laptop", source="mailbox"), "answer": dict(ME_ADMIN)}

    monkeypatch.setattr("hermes_cli.hub_sync.resolve_credentials", lambda: calls["credentials"])

    def fake_me(self, *, bearer, device_id="", device_name=""):
        calls["me"] += 1
        calls["last_bearer"] = bearer
        calls["last_device"] = device_id
        if isinstance(calls["answer"], Exception):
            raise calls["answer"]
        return dict(calls["answer"])

    monkeypatch.setattr("hermes_cli.hub_client.HubClient.me", fake_me)
    return base, state, calls


@pytest.fixture
def skills_home(tmp_path, monkeypatch):
    """Two opted-in skills, like test_skills_sync_client.synced_env."""
    import hermes_constants
    import tools.skill_usage as su

    home = tmp_path / "agentx"
    skills = home / "skills"
    skills.mkdir(parents=True)
    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: home)
    monkeypatch.setattr(ssc, "_skills_dir", lambda: skills)
    _write_skill(skills, "alpha", body="alpha v1\n")
    _write_skill(skills, "beta", body="beta v1\n", category="devops")
    monkeypatch.setattr(ssc, "list_synced_skill_names", lambda: ["alpha", "beta"])
    monkeypatch.setattr(ssc, "_skill_rel_path", lambda name: {"alpha": PurePosixPath("alpha"), "beta": PurePosixPath("devops/beta")}.get(name))
    monkeypatch.setattr(su, "_find_skill_dir", lambda name: {"alpha": skills / "alpha", "beta": skills / "devops" / "beta"}.get(name))
    return home, skills


class TestProvider:
    def test_base_url_equal_to_the_hub_selects_the_hub(self, monkeypatch):
        monkeypatch.setenv("AGENTX_SYNC_BASE_URL", "https://skills.astralx.com.vn/")
        monkeypatch.setenv("AGENTX_SKILLS_HUB_URL", "https://skills.astralx.com.vn")
        assert ssc.resolve_sync_provider() == "agentx-hub"
        monkeypatch.setenv("AGENTX_SYNC_BASE_URL", "https://gateway-gateway.nousresearch.com")
        assert ssc.resolve_sync_provider() == "nous"

    def test_explicit_provider_wins(self, monkeypatch):
        monkeypatch.setenv("AGENTX_SYNC_BASE_URL", "https://skills.astralx.com.vn")
        monkeypatch.setenv("AGENTX_SKILLS_HUB_URL", "https://skills.astralx.com.vn")
        monkeypatch.setenv("AGENTX_SYNC_PROVIDER", "nous")
        assert ssc.resolve_sync_provider() == "nous"
        monkeypatch.setenv("AGENTX_SYNC_PROVIDER", "hub")
        monkeypatch.setenv("AGENTX_SYNC_BASE_URL", "https://somewhere.else")
        assert ssc.resolve_sync_provider() == "agentx-hub"

    def test_config_provider(self, monkeypatch):
        monkeypatch.delenv("AGENTX_SYNC_PROVIDER", raising=False)
        monkeypatch.setattr("hermes_cli.config.load_config", lambda: {"sync": {"provider": "agentx-hub", "base_url": "https://x.test"}})
        assert ssc.resolve_sync_provider() == "agentx-hub"

    def test_default_is_nous(self, monkeypatch):
        monkeypatch.delenv("AGENTX_SYNC_PROVIDER", raising=False)
        monkeypatch.setattr("hermes_cli.config.load_config", lambda: {})
        assert ssc.resolve_sync_provider() == "nous"


class TestHubIdentity:
    def test_identity_comes_from_the_hubs_credentials_and_me(self, hub_plane):
        base, _state, calls = hub_plane
        identity = ssc.resolve_identity()
        assert identity["provider"] == "agentx-hub" and identity["sync_allowed"] is True and identity["nous_admin"] is False
        assert identity["api_key"] == "id-token" and identity["owner"] == "kc-ada" and identity["base_url"] == base
        assert identity["credential_source"] == "mailbox" and identity["device_id"] == DEVICE
        assert identity["claims"] == {"sub": "kc-ada", "email": "ada@corp.test", "org_id": "org-1", "roles": ["user"], "slug": "ada",
                                      "workspaces": [{"id": "ws-1", "slug": "team", "name": "Team", "role": "owner"}]}
        assert calls["last_bearer"] == "id-token" and calls["last_device"] == DEVICE
        assert ssc.dev_gate_open() is True
        shared = ssc.resolve_workspace_identity()
        assert shared["workspace"]["id"] == "ws-1" and shared["workspace"]["role"] == "owner"
        assert ssc.workspace_sync_available() is True

    def test_a_member_and_a_person_in_no_workspace(self, hub_plane):
        _base, _state, calls = hub_plane
        calls["answer"] = dict(ME_MEMBER)
        assert ssc.resolve_identity()["claims"]["workspaces"][0]["role"] == "member"
        calls["answer"] = dict(ME_SOLO)
        ssc._HUB_ME_CACHE.clear()
        assert ssc.resolve_identity()["claims"]["workspaces"] == []
        with pytest.raises(ssc.SyncInertError):
            ssc.resolve_workspace_identity()
        assert ssc.workspace_sync_available() is False

    def test_me_is_cached_per_bearer(self, hub_plane):
        _base, _state, calls = hub_plane
        ssc.resolve_identity()
        ssc.resolve_identity()
        assert calls["me"] == 1
        calls["credentials"] = HubCredentials(bearer="fresh-token", device_id=DEVICE, source="session")
        assert ssc.resolve_identity()["api_key"] == "fresh-token"
        assert calls["me"] == 2

    def test_without_credentials_sync_is_inert(self, hub_plane, monkeypatch):
        monkeypatch.setattr("hermes_cli.hub_sync.resolve_credentials", lambda: None)
        with pytest.raises(ssc.SyncInertError) as inert:
            ssc.resolve_identity()
        assert "sign in" in str(inert.value)
        assert ssc.dev_gate_open() is False
        assert ssc.maybe_push_skills() is None and ssc.maybe_pull_skills() is None and ssc.maybe_pull_workspace_skills() is None
        status = ssc.sync_status()
        assert status["provider"] == "agentx-hub" and status["logged_in"] is False and status["sync_allowed"] is False

    def test_a_hub_refusal_is_inert_not_a_crash(self, hub_plane):
        _base, _state, calls = hub_plane
        calls["answer"] = HubError("the AgentX Skill Hub returned HTTP 401", status_code=401, code="invalid_token")
        with pytest.raises(ssc.SyncInertError):
            ssc.resolve_identity()
        assert ssc.maybe_push_skills() is None

    def test_status_names_the_plane(self, hub_plane):
        status = ssc.sync_status()
        assert status["provider"] == "agentx-hub" and status["logged_in"] is True and status["sync_allowed"] is True
        assert status["nous_admin"] is False and status["owner"] == "kc-ada" and status["workspaces_available"] is True
        assert [w["slug"] for w in status["workspaces"]] == ["team"]


class TestNousPlaneUnchanged:
    def test_nous_identity_keeps_its_gate(self, monkeypatch):
        monkeypatch.setenv("AGENTX_SYNC_PROVIDER", "nous")
        monkeypatch.setattr("hermes_cli.auth.resolve_nous_runtime_credentials", lambda: {"api_key": _jwt({"sub": "owner1", "tool_gateway_admin": True}), "base_url": "http://x"})
        identity = ssc.resolve_identity()
        assert identity["provider"] == "nous" and identity["nous_admin"] is True and identity["sync_allowed"] is True
        monkeypatch.setattr("hermes_cli.auth.resolve_nous_runtime_credentials", lambda: {"api_key": _jwt({"sub": "owner1"}), "base_url": "http://x"})
        identity = ssc.resolve_identity()
        assert identity["nous_admin"] is False and identity["sync_allowed"] is False
        assert ssc.dev_gate_open() is False and ssc.maybe_push_skills() is None


class TestHubPlaneEndToEnd:
    def test_push_propose_and_pull_run_unchanged_against_the_hub(self, hub_plane, skills_home, monkeypatch):
        base, state, calls = hub_plane
        _home, skills = skills_home
        # push: the gate is open because the plane is the hub
        pushed = ssc.maybe_push_skills(message="from workmate")
        assert pushed is not None and pushed["ok"] is True and pushed.get("pushed_objects", 0) > 0
        head = state.refs["refs/user/kc-ada/HEAD"]
        assert head == pushed["head"]
        assert state.objects[head][0] == "commit"
        # propose as the workspace owner: merges directly into the workspace HEAD
        proposed = ssc.propose_skill("alpha")
        assert proposed["ok"] is True and proposed.get("merged") is True and proposed["workspace"] == "team"
        assert state.refs["refs/workspace/ws-1/HEAD"] == proposed["head"]
        # a member's proposal is parked as a 202 proposal
        state.workspace_owner = False
        calls["answer"] = dict(ME_MEMBER)
        calls["credentials"] = HubCredentials(bearer="bob-token", device_id=DEVICE, source="token")
        (skills / "devops" / "beta" / "SKILL.md").write_text("---\nname: beta\n---\nbeta v2\n", encoding="utf-8")
        member = ssc.propose_skill("beta", workspace="team")
        assert member["ok"] is True and member.get("proposal_pending") is True and member["proposal_id"] == 1
        assert state.refs["refs/workspace/ws-1/proposals/1"] == member["commit"]
        # pull of the workspace mirror sees the owner's HEAD
        pulled = ssc.pull_workspace_skills()
        assert pulled["ok"] is True and pulled["head"] == proposed["head"] and "alpha" in pulled["updated"]
        assert (skills / "_workspaces" / "ws-1" / "alpha" / "SKILL.md").exists()
        everything = ssc.maybe_pull_workspace_skills()
        assert everything["ok"] is True and list(everything["workspaces"]) == ["ws-1"]
