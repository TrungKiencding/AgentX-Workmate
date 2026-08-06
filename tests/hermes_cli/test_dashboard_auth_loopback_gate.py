"""The loopback auth-gate opt-in.

A loopback dashboard has always been ungated: whoever reaches 127.0.0.1 is the
operator. AgentX Workmate breaks that assumption — it ships to employees'
machines and has to know *which* employee before it does anything, so its users
line up with the ones AgentX already has in Keycloak.

``dashboard.require_auth`` / ``AGENTX_DASHBOARD_REQUIRE_AUTH`` is what turns the
gate on there. The properties worth pinning:

  * unset, it follows whether an identity provider is configured — which is
    why a shipped build (one ships a Keycloak client) is gated and a
    provider-less checkout is not. ``test_deployment_defaults.py`` pins the
    shipped answer; every test here supplies its own config;
  * env beats config.yaml in BOTH directions (an explicit 0 must be able to
    turn off what config turned on);
  * a broken config.yaml degrades to "off" rather than taking the server down;
  * with it on and no provider registered, the server refuses to start —
    fail closed, never open;
  * with it on and a provider registered, an unauthenticated request lands on
    /login.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from hermes_cli import web_server
from hermes_cli.dashboard_auth import clear_providers, register_provider

from .conftest_dashboard_auth import StubAuthProvider


@pytest.fixture(autouse=True)
def clean_opt_in(monkeypatch):
    """Start every test from "no opt-in anywhere"."""
    monkeypatch.delenv("AGENTX_DASHBOARD_REQUIRE_AUTH", raising=False)
    monkeypatch.setattr("hermes_cli.config.load_config", lambda: {})


def _set_config(monkeypatch, value):
    monkeypatch.setattr(
        "hermes_cli.config.load_config",
        lambda: {"dashboard": {"require_auth": value}},
    )


# ---------------------------------------------------------------------------
# The predicate
# ---------------------------------------------------------------------------


class TestShouldRequireAuth:
    def test_loopback_is_ungated_by_default(self):
        assert web_server.should_require_auth("127.0.0.1") is False
        assert web_server.should_require_auth("localhost") is False
        assert web_server.should_require_auth("::1") is False

    @pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on", "On"])
    def test_env_truthy_spellings_engage_the_gate(self, monkeypatch, value):
        monkeypatch.setenv("AGENTX_DASHBOARD_REQUIRE_AUTH", value)
        assert web_server.should_require_auth("127.0.0.1") is True

    @pytest.mark.parametrize("value", ["0", "false", "no", "off", "banana", " "])
    def test_env_falsy_and_garbage_leave_it_off(self, monkeypatch, value):
        monkeypatch.setenv("AGENTX_DASHBOARD_REQUIRE_AUTH", value)
        assert web_server.should_require_auth("127.0.0.1") is False

    def test_config_yaml_engages_the_gate(self, monkeypatch):
        _set_config(monkeypatch, True)
        assert web_server.should_require_auth("127.0.0.1") is True

    def test_env_zero_overrides_config_true(self, monkeypatch):
        """The direction a plain truthiness check gets wrong."""
        _set_config(monkeypatch, True)
        monkeypatch.setenv("AGENTX_DASHBOARD_REQUIRE_AUTH", "0")
        assert web_server.should_require_auth("127.0.0.1") is False

    def test_env_one_overrides_config_false(self, monkeypatch):
        _set_config(monkeypatch, False)
        monkeypatch.setenv("AGENTX_DASHBOARD_REQUIRE_AUTH", "1")
        assert web_server.should_require_auth("127.0.0.1") is True

    def test_broken_config_degrades_to_off(self, monkeypatch):
        def _broken():
            raise RuntimeError("config.yaml is a banana")

        monkeypatch.setattr("hermes_cli.config.load_config", _broken)
        assert web_server.should_require_auth("127.0.0.1") is False

    def test_opt_in_never_ungates_a_public_bind(self, monkeypatch):
        """The opt-in only ever ADDS a gate. Non-loopback stays gated."""
        monkeypatch.setenv("AGENTX_DASHBOARD_REQUIRE_AUTH", "0")
        _set_config(monkeypatch, False)
        assert web_server.should_require_auth("0.0.0.0") is True
        assert web_server.should_require_auth("192.168.1.5", True) is True


# ---------------------------------------------------------------------------
# start_server behaviour
# ---------------------------------------------------------------------------


def _stub_uvicorn(monkeypatch):
    """Make start_server return without binding a socket."""
    captured: dict = {}

    class _FakeConfig:
        def __init__(self, app, **kwargs):
            captured["app"] = app
            captured.update(kwargs)
            self.loaded = True

        def load(self):  # pragma: no cover - not reached with loaded=True
            pass

    class _FakeServer:
        def __init__(self, config):
            self.config = config

        def run(self):
            return None

    import uvicorn

    monkeypatch.setattr(uvicorn, "Config", _FakeConfig)
    monkeypatch.setattr(uvicorn, "Server", _FakeServer)
    monkeypatch.setattr(
        web_server.asyncio, "run", lambda coro: coro.close(), raising=False
    )
    return captured


class TestStartServer:
    @pytest.fixture(autouse=True)
    def isolate_providers(self):
        prev = getattr(web_server.app.state, "auth_required", None)
        clear_providers()
        yield
        clear_providers()
        if prev is None:
            if hasattr(web_server.app.state, "auth_required"):
                del web_server.app.state.auth_required
        else:
            web_server.app.state.auth_required = prev

    def test_refuses_to_start_with_no_provider(self, monkeypatch):
        """Fail closed: an opted-in dashboard with no way to sign in must not serve."""
        monkeypatch.setenv("AGENTX_DASHBOARD_REQUIRE_AUTH", "1")
        _stub_uvicorn(monkeypatch)
        with pytest.raises(SystemExit) as exc:
            web_server.start_server(host="127.0.0.1", port=9119, open_browser=False)
        message = str(exc.value)
        # The message must name the real reason — telling a Workmate operator
        # "the gate engages on non-loopback binds" sends them hunting a bind
        # problem they do not have.
        assert "require_auth" in message
        assert "keycloak" in message.lower()

    def test_starts_with_a_provider_registered(self, monkeypatch):
        monkeypatch.setenv("AGENTX_DASHBOARD_REQUIRE_AUTH", "1")
        _stub_uvicorn(monkeypatch)
        register_provider(StubAuthProvider())
        web_server.start_server(host="127.0.0.1", port=9119, open_browser=False)
        assert web_server.app.state.auth_required is True

    def test_loopback_without_opt_in_needs_no_provider(self, monkeypatch):
        _stub_uvicorn(monkeypatch)
        web_server.start_server(host="127.0.0.1", port=9119, open_browser=False)
        assert web_server.app.state.auth_required is False


# ---------------------------------------------------------------------------
# End to end: a gated loopback bind sends you to /login
# ---------------------------------------------------------------------------


class TestGatedLoopbackRequests:
    @pytest.fixture
    def gated_client(self):
        prev_auth = getattr(web_server.app.state, "auth_required", None)
        prev_host = getattr(web_server.app.state, "bound_host", None)
        clear_providers()
        register_provider(StubAuthProvider())
        web_server.app.state.auth_required = True
        web_server.app.state.bound_host = "127.0.0.1"
        client = TestClient(web_server.app, base_url="http://127.0.0.1:9119")
        yield client
        clear_providers()
        web_server.app.state.bound_host = prev_host
        if prev_auth is None:
            if hasattr(web_server.app.state, "auth_required"):
                del web_server.app.state.auth_required
        else:
            web_server.app.state.auth_required = prev_auth

    def test_unauthenticated_page_request_redirects_to_login(self, gated_client):
        r = gated_client.get("/sessions", follow_redirects=False)
        assert r.status_code in (302, 307)
        assert "/login" in r.headers["location"]

    def test_login_page_is_reachable_without_a_session(self, gated_client):
        r = gated_client.get("/login", follow_redirects=False)
        assert r.status_code == 200
        assert "AgentX" in r.text

    def test_unauthenticated_api_request_is_401(self, gated_client):
        r = gated_client.get("/api/auth/me", follow_redirects=False)
        assert r.status_code == 401
