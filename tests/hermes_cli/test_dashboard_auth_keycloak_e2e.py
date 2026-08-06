"""End-to-end walk of the Keycloak sign-in, against a simulated realm.

The unit tests cover the provider and the gate separately. This file joins them
up and drives the exact sequence a browser performs, so a regression in any one
seam — the login page's button href, the PKCE cookie round trip, the callback's
state check, the session cookies, the gate's verify — shows up as a failed
sign-in rather than as a green suite.

Everything Keycloak does is simulated in-process (``_FakeKeycloak``): discovery,
the authorize redirect, the token endpoint, and an RSA-signed ID token. No
network.
"""

from __future__ import annotations

import base64
import json
import time
import urllib.parse
from typing import Any, Dict
from unittest.mock import MagicMock, patch

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

import plugins.dashboard_auth.keycloak as kc_plugin
from hermes_cli import web_server
from hermes_cli.dashboard_auth import clear_providers, register_provider

_BASE_URL = "https://sso.example.com/auth"
_REALM = "agent-hub"
_ISSUER = f"{_BASE_URL}/realms/{_REALM}"
_CLIENT_ID = "agentx-workmate"


class _FakeKeycloak:
    """A realm that answers discovery and the token endpoint, in-process."""

    def __init__(self) -> None:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.private_pem = key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode()
        self.public_key = key.public_key()
        self.kid = "agent-hub-1"
        # code → the claims that code will redeem for.
        self.codes: Dict[str, Dict[str, Any]] = {}
        self.token_requests: list[Dict[str, str]] = []

    # -- what the realm publishes ------------------------------------------

    @property
    def discovery(self) -> Dict[str, Any]:
        return {
            "issuer": _ISSUER,
            "authorization_endpoint": f"{_ISSUER}/protocol/openid-connect/auth",
            "token_endpoint": f"{_ISSUER}/protocol/openid-connect/token",
            "jwks_uri": self.jwks_uri,
            "end_session_endpoint": f"{_ISSUER}/protocol/openid-connect/logout",
        }

    @property
    def jwks_uri(self) -> str:
        return f"{_ISSUER}/protocol/openid-connect/certs"

    @property
    def jwks(self) -> Dict[str, Any]:
        numbers = self.public_key.public_numbers()

        def _b64u_int(value: int) -> str:
            raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
            return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

        return {
            "keys": [
                {
                    "kty": "RSA",
                    "use": "sig",
                    "alg": "RS256",
                    "kid": self.kid,
                    "n": _b64u_int(numbers.n),
                    "e": _b64u_int(numbers.e),
                }
            ]
        }

    def mint_id_token(self, claims: Dict[str, Any]) -> str:
        now = int(time.time())
        payload = {
            "iss": _ISSUER,
            "aud": _CLIENT_ID,
            "iat": now,
            "exp": now + 1800,
            **claims,
        }
        return jwt.encode(
            payload, self.private_pem, algorithm="RS256", headers={"kid": self.kid}
        )

    # -- the seams the provider calls --------------------------------------

    def http_get(self, url: str, **_kwargs: Any) -> Any:
        if url.endswith("/.well-known/openid-configuration"):
            return _json_response(200, self.discovery)
        if url == self.jwks_uri:
            return _json_response(200, self.jwks)
        return _json_response(404, {"error": "not_found"})

    def http_post(self, url: str, data: Dict[str, str] | None = None, **_kwargs: Any) -> Any:
        form = dict(data or {})
        self.token_requests.append(form)

        grant = form.get("grant_type")

        if grant == "authorization_code":
            entry = self.codes.pop(form.get("code", ""), None)
            if entry is None:
                return _json_response(400, {"error": "invalid_grant"})
            # Keycloak enforces PKCE server-side; assert the verifier arrived so
            # a client that stopped sending it can't pass this test.
            if not form.get("code_verifier"):
                return _json_response(400, {"error": "invalid_grant"})
            return _json_response(
                200,
                {
                    "access_token": "opaque-access-token",
                    "id_token": self.mint_id_token(entry),
                    "refresh_token": "rt-e2e",
                    "token_type": "Bearer",
                    "expires_in": 1800,
                },
            )

        if grant == "password":
            if form.get("username") != "kienlt1" or form.get("password") != "correct-horse":
                return _json_response(401, {"error": "invalid_grant"})
            return _json_response(
                200,
                {
                    "id_token": self.mint_id_token(
                        {"sub": "kc-sub-1", "email": "kienlt1@example.com", "preferred_username": "kienlt1"}
                    ),
                    "refresh_token": "rt-pw",
                    "token_type": "Bearer",
                },
            )

        return _json_response(400, {"error": "unsupported_grant_type"})

    def issue_code(self, claims: Dict[str, Any]) -> str:
        code = f"code-{len(self.codes) + 1}"
        self.codes[code] = claims
        return code


def _json_response(status: int, body: Any):
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    resp.text = json.dumps(body)
    resp.json = MagicMock(return_value=body)
    resp.headers = {"content-type": "application/json"}
    return resp


@pytest.fixture
def keycloak():
    return _FakeKeycloak()


@pytest.fixture
def provider(request):
    """The real provider, unmodified. Only its HTTP seams are faked."""
    allow_password = getattr(request, "param", False)
    return kc_plugin.KeycloakOIDCProvider(
        base_url=_BASE_URL,
        realm=_REALM,
        client_id=_CLIENT_ID,
        allow_password_grant=allow_password,
    )


@pytest.fixture
def client(keycloak, provider):
    """A gated loopback dashboard with the Keycloak provider registered."""
    prev_auth = getattr(web_server.app.state, "auth_required", None)
    prev_host = getattr(web_server.app.state, "bound_host", None)

    clear_providers()
    register_provider(provider)
    web_server.app.state.auth_required = True
    web_server.app.state.bound_host = "127.0.0.1"

    # PyJWKClient fetches with urllib, not httpx, so it needs its own stand-in.
    # It is rebuilt whenever discovery refreshes (the provider drops it so a
    # rotated jwks_uri is picked up), which is why patching the class rather
    # than the instance is what actually holds for the whole flow.
    def _fake_jwk_client(*_args: Any, **_kwargs: Any):
        signing_key = MagicMock()
        signing_key.key = keycloak.public_key
        stub = MagicMock()
        stub.get_signing_key_from_jwt.return_value = signing_key
        return stub

    with patch(
        "plugins.dashboard_auth.keycloak.httpx.get", side_effect=keycloak.http_get
    ), patch(
        "plugins.dashboard_auth.keycloak.httpx.post", side_effect=keycloak.http_post
    ), patch("jwt.PyJWKClient", _fake_jwk_client):
        yield TestClient(web_server.app, base_url="http://127.0.0.1:9119")

    clear_providers()
    web_server.app.state.bound_host = prev_host
    if prev_auth is None:
        if hasattr(web_server.app.state, "auth_required"):
            del web_server.app.state.auth_required
    else:
        web_server.app.state.auth_required = prev_auth


def _button_href(html: str) -> str:
    """Pull the sign-in anchor's href out of the rendered login page."""
    marker = 'class="provider-btn'
    i = html.find(marker)
    assert i != -1, "no sign-in button on the login page"
    href_at = html.find('href="', i)
    assert href_at != -1, "sign-in button has no href"
    start = href_at + len('href="')
    return html[start : html.find('"', start)]


def _walk_redirect_login(client, keycloak, *, claims: Dict[str, Any], next_path: str = ""):
    """Drive /login → /auth/login → (Keycloak) → /auth/callback."""
    login_path = f"/login?next={urllib.parse.quote(next_path, safe='')}" if next_path else "/login"
    page = client.get(login_path)
    assert page.status_code == 200

    # Follow the button exactly as a browser would.
    start = client.get(_button_href(page.text), follow_redirects=False)
    assert start.status_code == 302

    authorize = urllib.parse.urlparse(start.headers["location"])
    params = dict(urllib.parse.parse_qsl(authorize.query))

    # Keycloak would now authenticate the human and redirect back with a code.
    code = keycloak.issue_code(claims)

    return client.get(
        f"/auth/callback?code={code}&state={urllib.parse.quote(params['state'])}",
        follow_redirects=False,
    ), params


# ---------------------------------------------------------------------------
# The redirect flow
# ---------------------------------------------------------------------------


class TestRedirectSignIn:
    def test_unauthenticated_visitor_is_sent_to_login(self, client):
        r = client.get("/sessions", follow_redirects=False)
        assert r.status_code in (302, 307)
        assert "/login" in r.headers["location"]

    def test_login_page_offers_the_agentx_button(self, client):
        page = client.get("/login")
        assert page.status_code == 200
        assert "Sign in with AgentX" in page.text
        assert _button_href(page.text).startswith("/auth/login?provider=keycloak")

    def test_full_round_trip_signs_the_user_in(self, client, keycloak):
        callback, params = _walk_redirect_login(
            client,
            keycloak,
            claims={
                "sub": "kc-sub-1",
                "email": "kienlt1@example.com",
                "name": "Le Trung Kien",
                "tenant_slug": "astralx",
            },
        )

        assert callback.status_code == 302

        # PKCE actually happened: S256 challenge out, verifier back.
        assert params["code_challenge_method"] == "S256"
        exchange = keycloak.token_requests[-1]
        assert exchange["grant_type"] == "authorization_code"
        assert exchange["code_verifier"]
        assert "client_secret" not in exchange

        me = client.get("/api/auth/me")
        assert me.status_code == 200
        assert me.json() == {
            "user_id": "kc-sub-1",
            "email": "kienlt1@example.com",
            "display_name": "Le Trung Kien",
            "org_id": "astralx",
            "provider": "keycloak",
            "expires_at": me.json()["expires_at"],
        }

    def test_signed_in_visitor_reaches_the_app(self, client, keycloak):
        _walk_redirect_login(client, keycloak, claims={"sub": "s", "email": "a@b.c"})

        r = client.get("/sessions", follow_redirects=False)
        assert r.status_code not in (302, 307), "should no longer be bounced to /login"

    def test_next_survives_the_round_trip(self, client, keycloak):
        callback, _ = _walk_redirect_login(
            client, keycloak, claims={"sub": "s", "email": "a@b.c"}, next_path="/models"
        )
        assert callback.headers["location"].endswith("/models")

    def test_forged_callback_state_is_rejected(self, client, keycloak):
        page = client.get("/login")
        client.get(_button_href(page.text), follow_redirects=False)

        code = keycloak.issue_code({"sub": "s", "email": "a@b.c"})
        r = client.get(f"/auth/callback?code={code}&state=attacker-chosen", follow_redirects=False)

        assert r.status_code == 400
        assert client.get("/api/auth/me").status_code == 401

    def test_logout_ends_the_session(self, client, keycloak):
        _walk_redirect_login(client, keycloak, claims={"sub": "s", "email": "a@b.c"})
        assert client.get("/api/auth/me").status_code == 200

        out = client.post("/auth/logout", follow_redirects=False)
        assert out.status_code == 302
        assert "/login" in out.headers["location"]
        assert client.get("/api/auth/me").status_code == 401


# ---------------------------------------------------------------------------
# The in-app credential form (opt-in)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("provider", [True], indirect=True)
class TestPasswordSignIn:
    def test_login_page_offers_both_doors(self, client):
        """A realm with direct grants on gets the form AND the SSO redirect.

        Dropping the redirect would strand anyone whose account needs
        Keycloak's own page — MFA, a required password change, a brokered IdP.
        """
        page = client.get("/login")

        assert 'class="provider-form"' in page.text
        assert 'name="username"' in page.text
        assert 'name="password"' in page.text
        assert "Use AgentX single sign-on" in page.text

    def test_sso_button_still_starts_a_redirect(self, client):
        """Regression guard: /auth/login used to bounce EVERY password provider
        back to /login, which would make this button do nothing."""
        page = client.get("/login")
        start = client.get(_button_href(page.text), follow_redirects=False)

        assert start.status_code == 302
        assert start.headers["location"].startswith(f"{_ISSUER}/protocol/openid-connect/auth")

    def test_correct_credentials_sign_in(self, client, keycloak):
        r = client.post(
            "/auth/password-login",
            json={"provider": "keycloak", "username": "kienlt1", "password": "correct-horse"},
        )

        assert r.status_code == 200
        assert r.json()["ok"] is True
        assert keycloak.token_requests[-1]["grant_type"] == "password"

        me = client.get("/api/auth/me")
        assert me.status_code == 200
        assert me.json()["display_name"] == "kienlt1"

    def test_wrong_password_is_a_generic_401(self, client):
        r = client.post(
            "/auth/password-login",
            json={"provider": "keycloak", "username": "kienlt1", "password": "nope"},
        )

        assert r.status_code == 401
        # Never distinguishable from an unknown user — no username oracle.
        assert "nope" not in r.text
        assert client.get("/api/auth/me").status_code == 401

    def test_unknown_user_is_indistinguishable_from_a_wrong_password(self, client):
        unknown = client.post(
            "/auth/password-login",
            json={"provider": "keycloak", "username": "ghost", "password": "whatever"},
        )
        wrong = client.post(
            "/auth/password-login",
            json={"provider": "keycloak", "username": "kienlt1", "password": "nope"},
        )

        assert unknown.status_code == wrong.status_code == 401
        assert unknown.json() == wrong.json()


# ---------------------------------------------------------------------------
# Redirect-only default
# ---------------------------------------------------------------------------


def test_password_form_absent_by_default(client):
    """Direct access grants are opt-in; without them there is no form to phish."""
    page = client.get("/login")

    assert 'class="provider-form"' not in page.text
    assert 'name="password"' not in page.text


def test_password_route_refuses_when_the_grant_is_off(client):
    r = client.post(
        "/auth/password-login",
        json={"provider": "keycloak", "username": "kienlt1", "password": "correct-horse"},
    )

    # 404, not 401 — the endpoint must not confirm that this provider exists.
    assert r.status_code == 404
