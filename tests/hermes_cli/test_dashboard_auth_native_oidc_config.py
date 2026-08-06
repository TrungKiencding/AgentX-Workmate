"""``/api/auth/providers`` advertises the native-OIDC capability.

The desktop shell can't always use the browser round trip this protocol
assumes: a locally-spawned backend gets an ephemeral port, so the
``{origin}/auth/callback`` redirect_uri is a different URL every launch and
cannot be pre-registered with Keycloak. The shell instead runs its own PKCE
flow against a fixed loopback listener, and it discovers the issuer and
client_id from this route rather than hard-coding them.

That makes this a public route carrying provider configuration, so the two
properties that matter are: it never leaks a secret, and a provider that
misbehaves degrades to "no native story" instead of 500ing the bootstrap the
login page depends on.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from hermes_cli import web_server
from hermes_cli.dashboard_auth import clear_providers, register_provider

from .conftest_dashboard_auth import StubAuthProvider


class _NativeProvider(StubAuthProvider):
    name = "native-stub"
    display_name = "Native Stub"

    def native_oidc_config(self):
        return {
            "issuer": "https://kc.example.com/realms/agent-hub",
            "client_id": "agentx-workmate",
            "scopes": "openid profile email",
            "confidential": False,
        }


class _BrokenProvider(StubAuthProvider):
    name = "broken-stub"
    display_name = "Broken Stub"

    def native_oidc_config(self):
        raise RuntimeError("this provider is having a day")


@pytest.fixture
def client():
    """A gated loopback dashboard — the AgentX Workmate shape.

    ``auth_required`` must be True for the route to be reachable without a
    session: the gate allowlists ``/api/auth/providers`` as the pre-auth
    bootstrap, whereas the ungated path still wants the injected SPA token.
    """
    prev_host = getattr(web_server.app.state, "bound_host", None)
    prev_required = getattr(web_server.app.state, "auth_required", None)
    clear_providers()
    web_server.app.state.bound_host = "127.0.0.1"
    web_server.app.state.auth_required = True
    yield TestClient(web_server.app, base_url="http://127.0.0.1:9119")
    clear_providers()
    web_server.app.state.bound_host = prev_host
    web_server.app.state.auth_required = prev_required


def _providers(client):
    resp = client.get("/api/auth/providers")
    assert resp.status_code == 200
    return {p["name"]: p for p in resp.json()["providers"]}


def test_plain_provider_reports_no_native_story(client):
    register_provider(StubAuthProvider())
    entry = _providers(client)["stub"]
    assert entry["supports_native_oidc"] is False
    assert entry["native_oidc"] is None


def test_native_provider_publishes_its_config(client):
    register_provider(_NativeProvider())
    entry = _providers(client)["native-stub"]
    assert entry["supports_native_oidc"] is True
    assert entry["native_oidc"]["client_id"] == "agentx-workmate"
    assert entry["native_oidc"]["issuer"].endswith("/realms/agent-hub")


def test_payload_never_carries_a_client_secret(client):
    register_provider(_NativeProvider())
    body = json.dumps(client.get("/api/auth/providers").json())
    assert "client_secret" not in body
    assert "secret" not in body


def test_a_raising_provider_degrades_instead_of_500ing(client):
    """The login page bootstraps off this route — a provider bug must not
    take sign-in down entirely."""
    register_provider(_BrokenProvider())
    entry = _providers(client)["broken-stub"]
    assert entry["supports_native_oidc"] is False
    assert entry["native_oidc"] is None


def test_existing_fields_are_unchanged(client):
    """Older clients read name/display_name/supports_password."""
    register_provider(StubAuthProvider())
    entry = _providers(client)["stub"]
    assert entry["display_name"] == StubAuthProvider.display_name
    assert entry["supports_password"] is False


def test_no_providers_still_fails_closed(client):
    assert client.get("/api/auth/providers").status_code == 503
