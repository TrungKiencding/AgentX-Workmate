"""The backend's Phase 3 hub routes: tick (bearer delivery + reconcile),
changes (no network), validate/publish/propose (local files → the hub).

Driven through a minimal app whose middleware sets ``request.state.session``
— the whole contract the dashboard auth gate provides — with the engine and
the hub client replaced by fakes, exactly like ``test_sync_routes.py``."""

from __future__ import annotations

import contextlib
import json
import time

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from hermes_cli import hub_sync
from hermes_cli.dashboard_auth.base import Session
from hermes_cli.hub_client import HubError
from hermes_cli.hub_sync import HubMailbox, HubSyncOutcome
from hermes_cli.web_routers import skills as skills_routes

DEVICE_ID = "11111111-2222-3333-4444-555555555555"
HEADERS = {"X-AgentX-Device": DEVICE_ID, "X-AgentX-Device-Name": "Ada's laptop"}


def _session(token: str = "tok-ada", expires_in: int = 3600) -> Session:
    return Session(user_id="kc-ada", email="ada@corp.test", display_name="Ada", org_id="astralx", provider="keycloak",
                   expires_at=int(time.time()) + expires_in, access_token=token, refresh_token="")


def _app(session: Session | None) -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def _attach(request: Request, call_next):
        if session is not None:
            request.state.session = session
        return await call_next(request)

    app.include_router(skills_routes.hub_router)
    return app


class _FakeEngine:
    def __init__(self) -> None:
        self.ticks = 0
        self.reloads = 0
        self.outcome = HubSyncOutcome(status="ok", installed=["demo-core"])

    def tick(self) -> HubSyncOutcome:
        self.ticks += 1
        return self.outcome

    def reload_settings(self) -> None:
        self.reloads += 1

    def changes(self) -> dict:
        return {"enabled": True, "configured": True, "installs": [{"slug": "demo-core", "desired_state": "installed"}], "updates": [], "history": []}


class _FakeHubClient:
    calls: list = []
    fail: HubError | None = None

    def __init__(self, base_url: str, **_kwargs) -> None:
        self.base_url = base_url

    def validate(self, files, **kwargs):
        _FakeHubClient.calls.append(("validate", files, kwargs))
        if _FakeHubClient.fail:
            raise _FakeHubClient.fail
        return {"ok": True, "package": {"name": "dashboard-skill", "kind": "core"}}

    def publish(self, files, **kwargs):
        _FakeHubClient.calls.append(("publish", files, kwargs))
        if _FakeHubClient.fail:
            raise _FakeHubClient.fail
        return {"skill": {"slug": "dashboard-skill", "visibility": kwargs.get("visibility")}, "version": {"version": "1.0.0", "publish_state": "scanning"},
                "scan_id": "scan-9", "created": True, "warnings": []}


@pytest.fixture
def engine(monkeypatch) -> _FakeEngine:
    fake = _FakeEngine()
    monkeypatch.setattr(hub_sync, "engine", lambda: fake)
    return fake


@pytest.fixture
def mailbox(monkeypatch) -> HubMailbox:
    box = HubMailbox()
    monkeypatch.setattr(hub_sync, "mailbox", lambda: box)
    return box


@pytest.fixture
def fake_hub(monkeypatch):
    import hermes_cli.hub_client as hub_client

    _FakeHubClient.calls = []
    _FakeHubClient.fail = None
    monkeypatch.setattr(hub_client, "HubClient", _FakeHubClient)
    monkeypatch.setattr(hub_client, "hub_base_url", lambda: "https://hub.test")
    monkeypatch.setattr(skills_routes, "_profile_scope", lambda profile: contextlib.nullcontext())
    return _FakeHubClient


@pytest.fixture
def local_skill(tmp_path, monkeypatch):
    """A skill under the isolated home, with a binary asset and a sidecar to skip."""
    from hermes_constants import get_hermes_home

    skills = get_hermes_home() / "skills"
    d = skills / "tools" / "dashboard-skill"
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text("---\nname: dashboard-skill\ndescription: a test skill\n---\n\n# Dashboard\n", encoding="utf-8")
    (d / "assets").mkdir()
    (d / "assets" / "logo.bin").write_bytes(b"\x00\x01\xff")
    (d / ".usage.json").write_text("{}", encoding="utf-8")
    return d


class TestTick:
    def test_it_delivers_the_bearer_and_runs_a_tick(self, engine, mailbox):
        client = TestClient(_app(_session("tok-ada")))
        response = client.post("/api/skills/hub/tick", headers=HEADERS, json={})
        assert response.status_code == 200 and response.json()["status"] == "ok" and response.json()["installed"] == ["demo-core"]
        assert engine.ticks == 1
        held = mailbox.current()
        assert held is not None and held.bearer == "tok-ada" and held.device_id == DEVICE_ID and held.device_name == "Ada's laptop"
        assert held.source == "session"

    def test_without_a_session_it_falls_back_to_the_engines_credentials(self, engine, mailbox, monkeypatch):
        monkeypatch.setattr(hub_sync, "resolve_credentials", lambda: None)
        client = TestClient(_app(None))
        response = client.post("/api/skills/hub/tick", json={})
        assert response.status_code == 200 and response.json()["status"] == "signed_out"
        assert engine.ticks == 0

    def test_reload_settings_is_honoured(self, engine, mailbox):
        client = TestClient(_app(_session()))
        client.post("/api/skills/hub/tick", headers=HEADERS, json={"reload_settings": True})
        assert engine.reloads == 1

    def test_an_expired_token_is_not_kept(self, engine, mailbox):
        client = TestClient(_app(_session(expires_in=-10)))
        client.post("/api/skills/hub/tick", headers=HEADERS, json={})
        assert mailbox.current() is None


class TestChanges:
    def test_it_answers_without_a_session(self, engine):
        client = TestClient(_app(None))
        response = client.get("/api/skills/hub/changes")
        assert response.status_code == 200 and response.json()["installs"][0]["slug"] == "demo-core"


class TestPublish:
    def test_it_uploads_the_local_files(self, fake_hub, local_skill, mailbox):
        client = TestClient(_app(_session("tok-ada")))
        response = client.post("/api/skills/hub/publish", headers=HEADERS, json={"name": "dashboard-skill", "visibility": "private"})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["ok"] is True and body["slug"] == "dashboard-skill" and body["version"] == "1.0.0" and body["scan_id"] == "scan-9"
        assert body["url"] == "https://hub.test/skills/dashboard-skill" and body["scan_url"] == "https://hub.test/scans/scan-9"
        kind, files, kwargs = fake_hub.calls[-1]
        assert kind == "publish" and set(files) == {"SKILL.md", "assets/logo.bin"}
        assert files["assets/logo.bin"] == {"base64": "AAH/"} and files["SKILL.md"].startswith("---")
        assert kwargs["bearer"] == "tok-ada" and kwargs["device_id"] == DEVICE_ID and kwargs["visibility"] == "private"

    def test_propose_is_an_org_upload(self, fake_hub, local_skill):
        client = TestClient(_app(_session()))
        response = client.post("/api/skills/hub/propose", headers=HEADERS, json={"name": "dashboard-skill", "visibility": "public"})
        assert response.status_code == 200 and response.json()["visibility"] == "org"
        assert fake_hub.calls[-1][2]["visibility"] == "org"

    def test_unknown_skill_is_404_and_bad_visibility_400(self, fake_hub, local_skill):
        client = TestClient(_app(_session()))
        assert client.post("/api/skills/hub/publish", headers=HEADERS, json={"name": "nope"}).status_code == 404
        assert client.post("/api/skills/hub/publish", headers=HEADERS, json={"name": "dashboard-skill", "visibility": "secret"}).status_code == 400

    def test_signed_out_is_a_sentence_not_an_error(self, fake_hub, local_skill, monkeypatch):
        monkeypatch.setattr(hub_sync, "resolve_credentials", lambda: None)
        client = TestClient(_app(None))
        response = client.post("/api/skills/hub/publish", json={"name": "dashboard-skill"})
        assert response.status_code == 200 and response.json()["status"] == "signed_out"

    def test_hub_refusals_are_rendered_not_raised(self, fake_hub, local_skill):
        fake_hub.fail = HubError("the AgentX Skill Hub returned HTTP 409", status_code=409, code="version_not_newer", detail={"highest": "1.2.0"})
        client = TestClient(_app(_session()))
        body = client.post("/api/skills/hub/publish", headers=HEADERS, json={"name": "dashboard-skill"}).json()
        assert body["ok"] is False and body["status"] == "error" and body["code"] == "version_not_newer" and body["error_detail"] == {"highest": "1.2.0"}
        fake_hub.fail = HubError("could not reach")
        body = client.post("/api/skills/hub/publish", headers=HEADERS, json={"name": "dashboard-skill"}).json()
        assert body["status"] == "offline"

    def test_validate_previews_without_uploading(self, fake_hub, local_skill):
        client = TestClient(_app(_session()))
        body = client.post("/api/skills/hub/validate", headers=HEADERS, json={"name": "dashboard-skill", "kind": "core"}).json()
        assert body["ok"] is True and body["files"] == ["SKILL.md", "assets/logo.bin"] and body["result"]["package"]["name"] == "dashboard-skill"
        assert fake_hub.calls[-1][0] == "validate" and fake_hub.calls[-1][2]["kind"] == "core"
        assert json.dumps(body)  # serialisable


class TestCatalog:
    """``/api/skills/hub/catalog`` — the store front the Hub tab opens on."""

    @pytest.fixture
    def hub_catalog(self, monkeypatch):
        """Record the token each sync ran with; answer with one card."""
        import hermes_cli.web_server as web_server
        from tools.skills_hub import SkillMeta

        calls: list = []

        def _catalog(*, token=None, force=False, **_kwargs):
            calls.append({"token": token, "force": force})
            if token:
                skills = [_meta("agentx-hub/vneb-report", SkillMeta), _meta("agentx-hub/kien/notes", SkillMeta, visibility="private")]
            else:
                skills = [_meta("agentx-hub/vneb-report", SkillMeta)]
            return {"skills": skills, "fetched_at": 1_780_000_000.0, "stale": False, "cached": not force,
                    "authenticated": bool(token), "hub_url": "https://hub.test", "error": ""}

        monkeypatch.setattr("tools.skills_hub.agentx_hub_catalog", _catalog)
        monkeypatch.setattr(web_server, "_config_profile_scope", lambda profile: contextlib.nullcontext())
        monkeypatch.setattr(web_server, "_installed_hub_identifiers", lambda profile=None: {})
        return calls

    def test_it_answers_without_anyone_signing_in(self, hub_catalog, monkeypatch):
        monkeypatch.setattr(hub_sync, "resolve_credentials", lambda: None)
        client = TestClient(_app(None))

        body = client.get("/api/skills/hub/catalog").json()

        assert [s["identifier"] for s in body["skills"]] == ["agentx-hub/vneb-report"]
        assert body["authenticated"] is False and body["stale"] is False and body["fetched_at"] > 0
        # A card carries what it needs to be a card, and nothing was installed.
        assert body["skills"][0]["extra"]["version"] == "1.0.0"
        assert body["installed"] == {}
        assert hub_catalog == [{"token": None, "force": False}]

    def test_a_bearer_widens_the_catalogue_to_personal_skills(self, hub_catalog):
        client = TestClient(_app(_session("tok-ada")))

        body = client.get("/api/skills/hub/catalog").json()

        assert [s["identifier"] for s in body["skills"]] == ["agentx-hub/vneb-report", "agentx-hub/kien/notes"]
        assert body["skills"][1]["extra"]["visibility"] == "private"
        assert body["authenticated"] is True
        assert hub_catalog[0]["token"] == "tok-ada"

    def test_refresh_forces_the_sync_behind_the_button(self, hub_catalog, monkeypatch):
        monkeypatch.setattr(hub_sync, "resolve_credentials", lambda: None)
        client = TestClient(_app(None))

        client.get("/api/skills/hub/catalog?refresh=1")

        assert hub_catalog[-1]["force"] is True

    def test_a_refused_bearer_falls_back_to_the_public_catalogue(self, monkeypatch):
        import hermes_cli.web_server as web_server
        from tools.skills_hub import SkillMeta

        seen: list = []

        def _catalog(*, token=None, force=False, **_kwargs):
            seen.append(token)
            if token:
                return {"skills": [], "fetched_at": 0.0, "stale": True, "cached": False,
                        "authenticated": True, "hub_url": "https://hub.test", "error": "hub refused the bearer"}
            return {"skills": [_meta("agentx-hub/vneb-report", SkillMeta)], "fetched_at": 1_780_000_000.0, "stale": False,
                    "cached": False, "authenticated": False, "hub_url": "https://hub.test", "error": ""}

        monkeypatch.setattr("tools.skills_hub.agentx_hub_catalog", _catalog)
        monkeypatch.setattr(web_server, "_config_profile_scope", lambda profile: contextlib.nullcontext())
        monkeypatch.setattr(web_server, "_installed_hub_identifiers", lambda profile=None: {})
        client = TestClient(_app(_session("tok-stale")))

        body = client.get("/api/skills/hub/catalog").json()

        assert seen == ["tok-stale", ""]
        assert [s["identifier"] for s in body["skills"]] == ["agentx-hub/vneb-report"]


class TestInstallCredentials:
    """A private hub skill installs through a CLI that has no session of its own."""

    @pytest.fixture
    def spawned(self, monkeypatch):
        import hermes_cli.web_server as web_server

        class _Proc:
            pid = 4242

        calls: list = []

        def _spawn(subcommand, name, extra_env=None):
            calls.append({"args": list(subcommand), "env": extra_env})
            return _Proc()

        monkeypatch.setattr(web_server, "_spawn_hermes_action", _spawn)
        monkeypatch.setattr(web_server, "_hub_action_name", lambda kind, ident: f"skills-{kind}")
        monkeypatch.setattr(web_server, "_profile_cli_args", lambda profile: [])
        return calls

    def test_the_callers_bearer_reaches_the_installer(self, spawned):
        client = TestClient(_app(_session("tok-ada")))

        response = client.post("/api/skills/hub/install", headers=HEADERS, json={"identifier": "agentx-hub/kien/notes"})

        assert response.status_code == 200
        assert spawned[0]["args"] == ["skills", "install", "agentx-hub/kien/notes", "--yes"]
        assert spawned[0]["env"] == {"AGENTX_HUB_TOKEN": "tok-ada"}

    def test_other_sources_are_spawned_with_nothing_extra(self, spawned, monkeypatch):
        monkeypatch.setattr(hub_sync, "resolve_credentials", lambda: None)
        client = TestClient(_app(_session("tok-ada")))

        client.post("/api/skills/hub/install", headers=HEADERS, json={"identifier": "official/demo"})

        assert spawned[0]["env"] is None


def _meta(identifier: str, meta_cls, *, visibility: str = "public"):
    """A hub SkillMeta the way ``AgentXHubSource`` builds one."""
    return meta_cls(
        name=identifier.split("/")[-1],
        description="does a thing",
        source="agentx-hub",
        identifier=identifier,
        trust_level="agentx-hub-verified",
        tags=[],
        extra={"kind": "core", "version": "1.0.0", "downloads": 3, "visibility": visibility},
    )


class TestInstalledMap:
    """What the cards read to know a skill is already here."""

    def test_a_hub_install_is_found_by_its_unpinned_identifier(self, tmp_path):
        import hermes_cli.web_server as web_server
        from hermes_constants import get_hermes_home
        from tools.skills_hub import HubLockFile

        lock = HubLockFile(get_hermes_home() / "skills" / ".hub" / "lock.json")
        lock.record_install(
            name="demo-core", source="agentx-hub", identifier="agentx-hub/demo-core@1.2.0",
            trust_level="agentx-hub-verified", scan_verdict="safe", skill_hash="sha256:abc",
            install_path="demo-core", files=["SKILL.md"],
        )
        lock.record_install(
            name="gif-search", source="official", identifier="official/gifs/gif-search",
            trust_level="builtin", scan_verdict="safe", skill_hash="sha256:def",
            install_path="gif-search", files=["SKILL.md"],
        )

        installed = web_server._installed_hub_identifiers()

        # The catalogue card speaks the unpinned identifier; the lock pins one.
        assert installed["agentx-hub/demo-core"]["name"] == "demo-core"
        assert installed["agentx-hub/demo-core@1.2.0"]["name"] == "demo-core"
        # Other sources are untouched.
        assert set(installed) == {"agentx-hub/demo-core", "agentx-hub/demo-core@1.2.0", "official/gifs/gif-search"}
