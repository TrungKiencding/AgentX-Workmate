"""Tests for the bundled Keycloak dashboard-auth plugin.

This provider is what lets AgentX Workmate accept the accounts AgentX already
has, so the properties that matter most are the ones that decide whether a user
gets back in:

1. Issuer derivation from ``base_url`` + ``realm`` (and the explicit override).
2. ``start_login`` shape — PKCE S256, authorize params, the flat PKCE cookie
   the callback route parses back.
3. ``complete_login`` / ``refresh_session`` httpx-mocked, including error mapping.
4. ``complete_password_login`` — the opt-in direct-grant path, and every way
   Keycloak can say no.
5. ``verify_session`` returning ``None`` rather than raising for a token this
   provider doesn't own — the difference between a clean re-login and a 503 the
   user can never clear.
6. Claim mapping that lines up with AgentX's own ``resolve_principal``.
7. ``register()`` gating, precedence, and the no-network-at-import promise.

All HTTP is mocked: nothing here talks to a real Keycloak.
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

import plugins.dashboard_auth.keycloak as kc_plugin
from hermes_cli.dashboard_auth import (
    InvalidCodeError,
    InvalidCredentialsError,
    LoginStart,
    ProviderError,
    RefreshExpiredError,
    Session,
    assert_protocol_compliance,
)

_BASE_URL = "https://agentx.example.com/auth"
_REALM = "agent-hub"
_ISSUER = f"{_BASE_URL}/realms/{_REALM}"
_CLIENT_ID = "agentx-workmate"
_REDIRECT_URI = "https://workmate.example.com/auth/callback"

_DISCOVERY_DOC = {
    "issuer": _ISSUER,
    "authorization_endpoint": f"{_ISSUER}/protocol/openid-connect/auth",
    "token_endpoint": f"{_ISSUER}/protocol/openid-connect/token",
    "jwks_uri": f"{_ISSUER}/protocol/openid-connect/certs",
    "revocation_endpoint": f"{_ISSUER}/protocol/openid-connect/revoke",
    "end_session_endpoint": f"{_ISSUER}/protocol/openid-connect/logout",
}


# ---------------------------------------------------------------------------
# Keypair fixtures (module-scope — keygen is slow)
# ---------------------------------------------------------------------------


def _keypair() -> Dict[str, Any]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return {
        "private_pem": key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode(),
        "kid": "agent-hub-key-1",
    }


@pytest.fixture(scope="module")
def rsa_keypair() -> Dict[str, Any]:
    return _keypair()


@pytest.fixture(scope="module")
def other_keypair() -> Dict[str, Any]:
    """A second key, standing in for "signed by someone who isn't our realm"."""
    return _keypair()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mint_id_token(
    keypair: Dict[str, Any],
    *,
    iss: str = _ISSUER,
    aud: Any = _CLIENT_ID,
    sub: str = "0b7e1f6e-2c11-4f5a-9d2e-2f0e2a1b3c4d",
    email: str | None = "kienlt1@example.com",
    name: str | None = None,
    preferred_username: str | None = None,
    ttl_seconds: int = 1800,
    algorithm: str = "RS256",
    extra_claims: Dict[str, Any] | None = None,
) -> str:
    now = int(time.time())
    claims: Dict[str, Any] = {
        "iss": iss,
        "aud": aud,
        "sub": sub,
        "iat": now,
        "exp": now + ttl_seconds,
    }
    if email is not None:
        claims["email"] = email
    if name is not None:
        claims["name"] = name
    if preferred_username is not None:
        claims["preferred_username"] = preferred_username
    if extra_claims:
        claims.update(extra_claims)
    return jwt.encode(
        claims,
        keypair["private_pem"],
        algorithm=algorithm,
        headers={"kid": keypair["kid"]},
    )


def _make_provider(rsa_keypair, **kwargs):
    """Construct a provider with discovery + JWKS pre-seeded (no network)."""
    params: Dict[str, Any] = {
        "base_url": _BASE_URL,
        "realm": _REALM,
        "client_id": _CLIENT_ID,
    }
    params.update(kwargs)
    p = kc_plugin.KeycloakOIDCProvider(**params)
    p._discovery = dict(_DISCOVERY_DOC)
    p._discovery_fetched_at = time.time()
    fake_key = MagicMock()
    fake_key.key = serialization.load_pem_private_key(
        rsa_keypair["private_pem"].encode(), password=None
    ).public_key()
    fake_client = MagicMock()
    fake_client.get_signing_key_from_jwt.return_value = fake_key
    p._jwks_client = fake_client
    return p


def _mock_response(status_code: int, body: Any, *, ctype: str = "application/json"):
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    if isinstance(body, dict):
        resp.text = json.dumps(body)
        resp.json = MagicMock(return_value=body)
    else:
        resp.text = str(body)
        resp.json = MagicMock(side_effect=ValueError("not json"))
    resp.headers = {"content-type": ctype}
    return resp


def _authorize_params(url: str) -> Dict[str, str]:
    return dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


class TestConstruction:
    def test_protocol_compliance(self):
        assert_protocol_compliance(kc_plugin.KeycloakOIDCProvider)

    def test_derives_issuer_from_base_url_and_realm(self):
        p = kc_plugin.KeycloakOIDCProvider(
            base_url=_BASE_URL, realm=_REALM, client_id=_CLIENT_ID
        )
        assert p._issuer == _ISSUER
        assert p._discovery_url() == f"{_ISSUER}/.well-known/openid-configuration"

    def test_tolerates_trailing_slash_on_base_url(self):
        p = kc_plugin.KeycloakOIDCProvider(
            base_url=_BASE_URL + "/", realm=_REALM, client_id=_CLIENT_ID
        )
        assert p._issuer == _ISSUER

    def test_explicit_issuer_wins_over_derivation(self):
        override = "https://sso.internal.example/realms/other"
        p = kc_plugin.KeycloakOIDCProvider(
            base_url=_BASE_URL,
            realm=_REALM,
            client_id=_CLIENT_ID,
            issuer=override,
        )
        assert p._issuer == override

    def test_issuer_alone_is_enough(self):
        p = kc_plugin.KeycloakOIDCProvider(issuer=_ISSUER, base_url="", realm="", client_id=_CLIENT_ID)
        assert p._issuer == _ISSUER

    def test_requires_client_id(self):
        with pytest.raises(ValueError, match="client_id"):
            kc_plugin.KeycloakOIDCProvider(
                base_url=_BASE_URL, realm=_REALM, client_id=""
            )

    def test_requires_realm_without_explicit_issuer(self):
        with pytest.raises(ValueError, match="realm"):
            kc_plugin.KeycloakOIDCProvider(
                base_url=_BASE_URL, realm="", client_id=_CLIENT_ID
            )

    def test_rejects_non_https_issuer(self):
        with pytest.raises(ProviderError, match="https"):
            kc_plugin.KeycloakOIDCProvider(
                base_url="http://keycloak.corp.example",
                realm=_REALM,
                client_id=_CLIENT_ID,
            )

    def test_allows_http_on_loopback(self):
        p = kc_plugin.KeycloakOIDCProvider(
            base_url="http://localhost:8080", realm=_REALM, client_id=_CLIENT_ID
        )
        assert p._issuer == f"http://localhost:8080/realms/{_REALM}"

    def test_redirect_is_always_offered(self):
        """Even with the credential form on, the SSO redirect stays available.

        An account with MFA or a pending required action can only finish on
        Keycloak's own page; hiding the redirect would strand it.
        """
        p = kc_plugin.KeycloakOIDCProvider(
            base_url=_BASE_URL,
            realm=_REALM,
            client_id=_CLIENT_ID,
            allow_password_grant=True,
        )
        assert p.supports_password is True
        assert p.supports_redirect is True

    def test_password_grant_is_off_by_default(self):
        p = kc_plugin.KeycloakOIDCProvider(
            base_url=_BASE_URL, realm=_REALM, client_id=_CLIENT_ID
        )
        assert p.supports_password is False


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


class TestDiscovery:
    def _provider(self):
        return kc_plugin.KeycloakOIDCProvider(
            base_url=_BASE_URL, realm=_REALM, client_id=_CLIENT_ID
        )

    def test_fetches_and_caches(self):
        p = self._provider()
        resp = _mock_response(200, dict(_DISCOVERY_DOC))
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.get", return_value=resp
        ) as mock_get:
            first = p._get_discovery()
            second = p._get_discovery()
        assert first["token_endpoint"] == _DISCOVERY_DOC["token_endpoint"]
        assert second is first
        assert mock_get.call_count == 1

    def test_issuer_mismatch_is_rejected(self):
        p = self._provider()
        doc = dict(_DISCOVERY_DOC, issuer="https://evil.example/realms/agent-hub")
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.get",
            return_value=_mock_response(200, doc),
        ):
            with pytest.raises(ProviderError, match="issuer mismatch"):
                p._get_discovery()

    def test_404_names_the_likely_cause(self):
        p = self._provider()
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.get",
            return_value=_mock_response(404, "not found", ctype="text/plain"),
        ):
            with pytest.raises(ProviderError, match="base_url and realm"):
                p._get_discovery()

    def test_network_failure_is_provider_error(self):
        p = self._provider()
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.get",
            side_effect=httpx.ConnectError("no route to host"),
        ):
            with pytest.raises(ProviderError, match="unreachable"):
                p._get_discovery()

    def test_cleartext_endpoint_is_rejected(self):
        p = self._provider()
        doc = dict(_DISCOVERY_DOC, token_endpoint="http://agentx.example.com/token")
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.get",
            return_value=_mock_response(200, doc),
        ):
            with pytest.raises(ProviderError, match="token_endpoint"):
                p._get_discovery()

    def test_follows_redirects(self):
        """A Keycloak behind a TLS-terminating proxy answers discovery with a 3xx."""
        p = self._provider()
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.get",
            return_value=_mock_response(200, dict(_DISCOVERY_DOC)),
        ) as mock_get:
            p._get_discovery()
        assert mock_get.call_args.kwargs["follow_redirects"] is True


# ---------------------------------------------------------------------------
# start_login
# ---------------------------------------------------------------------------


class TestStartLogin:
    def test_authorize_url_carries_pkce_s256(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        result = p.start_login(redirect_uri=_REDIRECT_URI)
        assert isinstance(result, LoginStart)
        params = _authorize_params(result.redirect_url)
        assert params["response_type"] == "code"
        assert params["client_id"] == _CLIENT_ID
        assert params["redirect_uri"] == _REDIRECT_URI
        assert params["scope"] == "openid profile email"
        assert params["code_challenge_method"] == "S256"
        assert params["code_challenge"]
        assert params["state"]
        assert "kc_idp_hint" not in params

    def test_code_challenge_is_sha256_of_the_verifier(self, rsa_keypair):
        import hashlib

        p = _make_provider(rsa_keypair)
        result = p.start_login(redirect_uri=_REDIRECT_URI)
        raw = result.cookie_payload["hermes_session_pkce"]
        verifier = dict(seg.split("=", 1) for seg in raw.split(";"))["verifier"]
        expected = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .rstrip(b"=")
            .decode()
        )
        assert _authorize_params(result.redirect_url)["code_challenge"] == expected

    def test_pkce_cookie_uses_the_shape_the_callback_route_parses(self, rsa_keypair):
        """``routes.auth_callback`` splits on ';' then on the first '='.

        A value containing either character would silently corrupt the parse,
        so assert the round trip rather than the literal string.
        """
        p = _make_provider(rsa_keypair)
        result = p.start_login(redirect_uri=_REDIRECT_URI)
        raw = result.cookie_payload["hermes_session_pkce"]
        parsed = dict(seg.split("=", 1) for seg in raw.split(";"))
        assert set(parsed) == {"state", "verifier"}
        assert ";" not in parsed["verifier"] and "=" not in parsed["verifier"]
        assert ";" not in parsed["state"] and "=" not in parsed["state"]
        # The state stashed in the cookie is the one sent to Keycloak — the
        # callback route compares them to reject a forged callback.
        assert parsed["state"] == _authorize_params(result.redirect_url)["state"]

    def test_state_and_verifier_are_fresh_per_login(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        first = p.start_login(redirect_uri=_REDIRECT_URI).cookie_payload
        second = p.start_login(redirect_uri=_REDIRECT_URI).cookie_payload
        assert first["hermes_session_pkce"] != second["hermes_session_pkce"]

    def test_idp_hint_is_forwarded(self, rsa_keypair):
        p = _make_provider(rsa_keypair, idp_hint="corp-ad")
        params = _authorize_params(
            p.start_login(redirect_uri=_REDIRECT_URI).redirect_url
        )
        assert params["kc_idp_hint"] == "corp-ad"

    def test_rejects_redirect_uri_with_wrong_path(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        with pytest.raises(ProviderError, match="/auth/callback"):
            p.start_login(redirect_uri="https://workmate.example.com/oops")

    def test_rejects_non_http_redirect_uri(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        with pytest.raises(ProviderError, match="http"):
            p.start_login(redirect_uri="workmate://auth/callback")


# ---------------------------------------------------------------------------
# complete_login
# ---------------------------------------------------------------------------


class TestCompleteLogin:
    def test_happy_path(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        id_token = _mint_id_token(rsa_keypair, name="Le Trung Kien")
        body = {
            "access_token": "opaque-at",
            "id_token": id_token,
            "refresh_token": "rt-1",
            "token_type": "Bearer",
            "expires_in": 1800,
        }
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            return_value=_mock_response(200, body),
        ) as mock_post:
            session = p.complete_login(
                code="the-code",
                state="st",
                code_verifier="ver",
                redirect_uri=_REDIRECT_URI,
            )
        assert isinstance(session, Session)
        assert session.provider == "keycloak"
        assert session.display_name == "Le Trung Kien"
        assert session.email == "kienlt1@example.com"
        # The verified ID token is what gets stored, not the opaque access token.
        assert session.access_token == id_token
        assert session.refresh_token == "rt-1"

        sent = mock_post.call_args.kwargs["data"]
        assert sent["grant_type"] == "authorization_code"
        assert sent["code_verifier"] == "ver"
        assert sent["client_id"] == _CLIENT_ID
        # Public client — PKCE alone authenticates the exchange.
        assert "client_secret" not in sent

    def test_400_maps_to_invalid_code(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            return_value=_mock_response(400, {"error": "invalid_grant"}),
        ):
            with pytest.raises(InvalidCodeError):
                p.complete_login(
                    code="c", state="s", code_verifier="v", redirect_uri=_REDIRECT_URI
                )

    def test_network_failure_maps_to_provider_error(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            side_effect=httpx.ConnectError("down"),
        ):
            with pytest.raises(ProviderError, match="unreachable"):
                p.complete_login(
                    code="c", state="s", code_verifier="v", redirect_uri=_REDIRECT_URI
                )

    def test_missing_id_token_is_an_actionable_error(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            return_value=_mock_response(200, {"access_token": "at"}),
        ):
            with pytest.raises(ProviderError, match="openid"):
                p.complete_login(
                    code="c", state="s", code_verifier="v", redirect_uri=_REDIRECT_URI
                )

    def test_unverifiable_id_token_is_a_provider_error_not_a_bad_code(
        self, rsa_keypair, other_keypair
    ):
        """Keycloak handing us a token we can't verify is infrastructure, not user error."""
        p = _make_provider(rsa_keypair)
        foreign = _mint_id_token(other_keypair)
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            return_value=_mock_response(200, {"id_token": foreign}),
        ):
            with pytest.raises(ProviderError, match="cannot verify"):
                p.complete_login(
                    code="c", state="s", code_verifier="v", redirect_uri=_REDIRECT_URI
                )


# ---------------------------------------------------------------------------
# complete_password_login (opt-in direct access grants)
# ---------------------------------------------------------------------------


class TestPasswordLogin:
    def _provider(self, rsa_keypair, **kw):
        return _make_provider(rsa_keypair, allow_password_grant=True, **kw)

    def test_happy_path(self, rsa_keypair):
        p = self._provider(rsa_keypair)
        id_token = _mint_id_token(rsa_keypair, preferred_username="kienlt1")
        body = {"id_token": id_token, "refresh_token": "rt-9", "token_type": "Bearer"}
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            return_value=_mock_response(200, body),
        ) as mock_post:
            session = p.complete_password_login(username="kienlt1", password="pw")
        assert session.display_name == "kienlt1"
        assert session.refresh_token == "rt-9"
        sent = mock_post.call_args.kwargs["data"]
        assert sent["grant_type"] == "password"
        assert sent["username"] == "kienlt1"
        assert sent["password"] == "pw"
        assert sent["scope"] == "openid profile email"

    @pytest.mark.parametrize("status", [400, 401])
    def test_invalid_grant_maps_to_invalid_credentials(self, rsa_keypair, status):
        """Keycloak answers a bad password with 401, not 400.

        Without handling both, a wrong password would surface as a 503
        "provider unreachable" instead of "invalid credentials".
        """
        p = self._provider(rsa_keypair)
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            return_value=_mock_response(status, {"error": "invalid_grant"}),
        ):
            with pytest.raises(InvalidCredentialsError):
                p.complete_password_login(username="u", password="wrong")

    @pytest.mark.parametrize("error", ["unauthorized_client", "invalid_client"])
    def test_direct_grants_disabled_is_an_operator_error(self, rsa_keypair, error):
        """Don't tell a user "wrong password" when the realm simply forbids this grant."""
        p = self._provider(rsa_keypair)
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            return_value=_mock_response(400, {"error": error}),
        ):
            with pytest.raises(ProviderError, match="Direct access grants"):
                p.complete_password_login(username="u", password="pw")

    def test_network_failure_is_provider_error(self, rsa_keypair):
        p = self._provider(rsa_keypair)
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            side_effect=httpx.ConnectError("down"),
        ):
            with pytest.raises(ProviderError):
                p.complete_password_login(username="u", password="pw")

    def test_password_is_not_echoed_in_the_rejection(self, rsa_keypair):
        """A failed sign-in must not put the attempted password in an exception
        that ends up in a log line or an error page."""
        p = self._provider(rsa_keypair)
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            return_value=_mock_response(401, {"error": "invalid_grant"}),
        ):
            with pytest.raises(InvalidCredentialsError) as exc:
                p.complete_password_login(username="kienlt1", password="s3cr3t")
        assert "s3cr3t" not in str(exc.value)


# ---------------------------------------------------------------------------
# verify_session
# ---------------------------------------------------------------------------


class TestVerifySession:
    def test_accepts_our_own_token(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        token = _mint_id_token(rsa_keypair)
        session = p.verify_session(access_token=token)
        assert session is not None
        assert session.provider == "keycloak"
        assert session.access_token == token

    def test_expired_token_returns_none(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        token = _mint_id_token(rsa_keypair, ttl_seconds=-60)
        assert p.verify_session(access_token=token) is None

    def test_foreign_issuer_returns_none_and_does_not_raise(self, rsa_keypair):
        """The regression that matters most.

        A cookie minted by a *different* registered provider must read as
        "not mine" (None → the gate refreshes or re-logins), never as an
        outage (ProviderError → a 503 the user cannot clear).
        """
        p = _make_provider(rsa_keypair)
        token = _mint_id_token(rsa_keypair, iss="https://other.example/realms/x")
        assert p.verify_session(access_token=token) is None

    def test_foreign_audience_returns_none(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        token = _mint_id_token(rsa_keypair, aud="some-other-client")
        assert p.verify_session(access_token=token) is None

    def test_wrong_signature_returns_none(self, rsa_keypair, other_keypair):
        p = _make_provider(rsa_keypair)
        token = _mint_id_token(other_keypair)
        assert p.verify_session(access_token=token) is None

    def test_garbage_returns_none(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        assert p.verify_session(access_token="not-a-jwt") is None
        assert p.verify_session(access_token="") is None

    def test_jwks_outage_raises_provider_error(self, rsa_keypair):
        """The one case that must NOT force a re-login."""
        p = _make_provider(rsa_keypair)
        token = _mint_id_token(rsa_keypair)
        p._jwks_client.get_signing_key_from_jwt.side_effect = jwt.PyJWKClientError(
            "connection refused"
        )
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.get",
            side_effect=httpx.ConnectError("down"),
        ):
            with pytest.raises(ProviderError, match="JWKS unreachable"):
                p.verify_session(access_token=token)

    def test_unknown_kid_while_jwks_is_up_returns_none(self, rsa_keypair):
        """A reachable JWKS that simply lacks the key means a foreign token."""
        p = _make_provider(rsa_keypair)
        token = _mint_id_token(rsa_keypair)
        p._jwks_client.get_signing_key_from_jwt.side_effect = jwt.PyJWKClientError(
            'Unable to find a signing key that matches: "who-dis"'
        )
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.get",
            return_value=_mock_response(200, {"keys": []}),
        ):
            assert p.verify_session(access_token=token) is None

    def test_ps256_is_accepted(self, rsa_keypair):
        """Realms can be switched off RS256; PS is a supported successor."""
        p = _make_provider(rsa_keypair)
        token = _mint_id_token(rsa_keypair, algorithm="PS256")
        assert p.verify_session(access_token=token) is not None


# ---------------------------------------------------------------------------
# Claim mapping
# ---------------------------------------------------------------------------


class TestClaimMapping:
    def _session(self, rsa_keypair, provider=None, **token_kwargs):
        p = provider or _make_provider(rsa_keypair)
        token = _mint_id_token(rsa_keypair, **token_kwargs)
        session = p.verify_session(access_token=token)
        assert session is not None
        return session

    def test_name_beats_preferred_username(self, rsa_keypair):
        s = self._session(
            rsa_keypair, name="Le Trung Kien", preferred_username="kienlt1"
        )
        assert s.display_name == "Le Trung Kien"

    def test_preferred_username_beats_email(self, rsa_keypair):
        s = self._session(rsa_keypair, preferred_username="kienlt1")
        assert s.display_name == "kienlt1"

    def test_falls_back_to_email_then_sub(self, rsa_keypair):
        assert self._session(rsa_keypair).display_name == "kienlt1@example.com"
        s = self._session(rsa_keypair, email=None)
        assert s.display_name == s.user_id

    def test_tenant_slug_feeds_org_id(self, rsa_keypair):
        """AgentX's own custom tenant claim, so both products agree on the tenant."""
        s = self._session(rsa_keypair, extra_claims={"tenant_slug": "acme"})
        assert s.org_id == "acme"

    def test_tenant_slug_accepts_a_list(self, rsa_keypair):
        """A multivalued protocol mapper emits ["acme"]; resolve_principal accepts both."""
        s = self._session(rsa_keypair, extra_claims={"tenant_slug": ["acme"]})
        assert s.org_id == "acme"

    def test_organization_is_the_next_fallback(self, rsa_keypair):
        s = self._session(rsa_keypair, extra_claims={"organization": "astralx"})
        assert s.org_id == "astralx"

    def test_realm_roles_are_the_last_resort(self, rsa_keypair):
        s = self._session(
            rsa_keypair,
            extra_claims={"realm_access": {"roles": ["platform-admin", "user"]}},
        )
        assert s.org_id == "platform-admin,user"

    def test_tenant_slug_outranks_realm_roles(self, rsa_keypair):
        s = self._session(
            rsa_keypair,
            extra_claims={
                "tenant_slug": "acme",
                "realm_access": {"roles": ["user"]},
            },
        )
        assert s.org_id == "acme"

    def test_org_claim_override_walks_a_dotted_path(self, rsa_keypair):
        p = _make_provider(rsa_keypair, org_claim="realm_access.roles")
        s = self._session(
            rsa_keypair,
            provider=p,
            extra_claims={
                "tenant_slug": "ignored",
                "realm_access": {"roles": ["ops"]},
            },
        )
        assert s.org_id == "ops"

    def test_org_id_empty_when_no_claim_matches(self, rsa_keypair):
        assert self._session(rsa_keypair).org_id == ""

    def test_expires_at_is_the_token_exp(self, rsa_keypair):
        before = int(time.time())
        s = self._session(rsa_keypair, ttl_seconds=1800)
        assert before + 1700 <= s.expires_at <= before + 1900


# ---------------------------------------------------------------------------
# refresh / revoke
# ---------------------------------------------------------------------------


class TestRefreshAndRevoke:
    def test_refresh_rotates_both_tokens(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        new_id = _mint_id_token(rsa_keypair)
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            return_value=_mock_response(
                200, {"id_token": new_id, "refresh_token": "rt-new"}
            ),
        ) as mock_post:
            session = p.refresh_session(refresh_token="rt-old")
        assert session.access_token == new_id
        assert session.refresh_token == "rt-new"
        assert mock_post.call_args.kwargs["data"]["grant_type"] == "refresh_token"

    def test_refresh_keeps_the_old_rt_when_the_realm_does_not_rotate(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            return_value=_mock_response(
                200, {"id_token": _mint_id_token(rsa_keypair)}
            ),
        ):
            session = p.refresh_session(refresh_token="rt-old")
        assert session.refresh_token == "rt-old"

    def test_refresh_without_a_token_is_expired(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        with pytest.raises(RefreshExpiredError):
            p.refresh_session(refresh_token="")

    def test_refresh_400_is_expired_not_unreachable(self, rsa_keypair):
        """The gate must be free to try the next provider, not surface a 503."""
        p = _make_provider(rsa_keypair)
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            return_value=_mock_response(400, {"error": "invalid_grant"}),
        ):
            with pytest.raises(RefreshExpiredError):
                p.refresh_session(refresh_token="dead")

    def test_revoke_posts_to_the_revocation_endpoint(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            return_value=_mock_response(200, {}),
        ) as mock_post:
            p.revoke_session(refresh_token="rt")
        assert mock_post.call_args.args[0] == _DISCOVERY_DOC["revocation_endpoint"]
        assert mock_post.call_args.kwargs["data"]["token_type_hint"] == "refresh_token"

    def test_revoke_never_raises(self, rsa_keypair):
        p = _make_provider(rsa_keypair)
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            side_effect=httpx.ConnectError("down"),
        ):
            assert p.revoke_session(refresh_token="rt") is None
        assert p.revoke_session(refresh_token="") is None

    def test_revoke_survives_a_discovery_outage(self):
        p = kc_plugin.KeycloakOIDCProvider(
            base_url=_BASE_URL, realm=_REALM, client_id=_CLIENT_ID
        )
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.get",
            side_effect=httpx.ConnectError("down"),
        ):
            assert p.revoke_session(refresh_token="rt") is None


# ---------------------------------------------------------------------------
# Confidential client
# ---------------------------------------------------------------------------


class TestConfidentialClient:
    def test_basic_auth_header_by_default(self, rsa_keypair):
        p = _make_provider(rsa_keypair, client_secret="sh:h")
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            return_value=_mock_response(
                200, {"id_token": _mint_id_token(rsa_keypair)}
            ),
        ) as mock_post:
            p.complete_login(
                code="c", state="s", code_verifier="v", redirect_uri=_REDIRECT_URI
            )
        header = mock_post.call_args.kwargs["headers"]["Authorization"]
        assert header.startswith("Basic ")
        decoded = base64.b64decode(header.split(" ", 1)[1]).decode()
        # Both halves are form-url-encoded before base64 (RFC 6749 §2.3.1), so
        # a secret containing ':' cannot corrupt the header.
        assert decoded == f"{_CLIENT_ID}:sh%3Ah"
        assert "client_secret" not in mock_post.call_args.kwargs["data"]

    def test_post_body_when_the_realm_only_advertises_it(self, rsa_keypair):
        p = _make_provider(rsa_keypair, client_secret="sec")
        p._discovery = dict(
            _DISCOVERY_DOC,
            token_endpoint_auth_methods_supported=["client_secret_post"],
        )
        with patch(
            "plugins.dashboard_auth.keycloak.httpx.post",
            return_value=_mock_response(
                200, {"id_token": _mint_id_token(rsa_keypair)}
            ),
        ) as mock_post:
            p.complete_login(
                code="c", state="s", code_verifier="v", redirect_uri=_REDIRECT_URI
            )
        assert mock_post.call_args.kwargs["data"]["client_secret"] == "sec"
        assert "Authorization" not in mock_post.call_args.kwargs["headers"]

    def test_blank_secret_stays_public(self, rsa_keypair):
        """A provisioned-but-empty secret must not flip us into a broken mode."""
        p = _make_provider(rsa_keypair, client_secret="   ")
        assert p._client_secret == ""
        assert p.native_oidc_config()["confidential"] is False


# ---------------------------------------------------------------------------
# native_oidc_config
# ---------------------------------------------------------------------------


class TestNativeOidcConfig:
    def test_publishes_only_non_secret_values(self, rsa_keypair):
        p = _make_provider(rsa_keypair, client_secret="top-secret")
        cfg = p.native_oidc_config()
        assert cfg == {
            "issuer": _ISSUER,
            "client_id": _CLIENT_ID,
            "scopes": "openid profile email",
            "confidential": True,
        }
        assert "top-secret" not in json.dumps(cfg)

    def test_base_default_is_none(self):
        """A provider with no native story opts out by not overriding."""
        from plugins.dashboard_auth.basic import BasicAuthProvider

        assert BasicAuthProvider.native_oidc_config(object.__new__(BasicAuthProvider)) is None


# ---------------------------------------------------------------------------
# Secret hygiene
# ---------------------------------------------------------------------------


class TestSecretHygiene:
    def test_secret_absent_from_repr(self, rsa_keypair):
        p = _make_provider(rsa_keypair, client_secret="hunter2")
        assert "hunter2" not in repr(p)
        assert "confidential=True" in repr(p)

    def test_secret_absent_from_registration_logs(self, monkeypatch, caplog):
        monkeypatch.setattr("hermes_cli.config.load_config", lambda: {})
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_BASE_URL", _BASE_URL)
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_REALM", _REALM)
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_CLIENT_ID", _CLIENT_ID)
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_CLIENT_SECRET", "hunter2")
        with caplog.at_level("DEBUG"):
            kc_plugin.register(MagicMock())
        assert "hunter2" not in caplog.text


# ---------------------------------------------------------------------------
# register()
# ---------------------------------------------------------------------------


class TestPluginRegister:
    _ENV_VARS = (
        "AGENTX_DASHBOARD_KEYCLOAK_BASE_URL",
        "AGENTX_DASHBOARD_KEYCLOAK_REALM",
        "AGENTX_DASHBOARD_KEYCLOAK_CLIENT_ID",
        "AGENTX_DASHBOARD_KEYCLOAK_CLIENT_SECRET",
        "AGENTX_DASHBOARD_KEYCLOAK_SCOPES",
        "AGENTX_DASHBOARD_KEYCLOAK_ISSUER",
        "AGENTX_DASHBOARD_KEYCLOAK_ORG_CLAIM",
        "AGENTX_DASHBOARD_KEYCLOAK_IDP_HINT",
        "AGENTX_DASHBOARD_KEYCLOAK_ALLOW_PASSWORD_GRANT",
    )

    @pytest.fixture(autouse=True)
    def clear_env(self, monkeypatch):
        for var in self._ENV_VARS:
            monkeypatch.delenv(var, raising=False)

    @pytest.fixture
    def patch_config(self, monkeypatch):
        def _set(oauth_block):
            cfg = {}
            if oauth_block is not None:
                cfg = {"dashboard": {"oauth": oauth_block}}
            monkeypatch.setattr("hermes_cli.config.load_config", lambda: cfg)

        return _set

    def _registered(self, ctx):
        ctx.register_dashboard_auth_provider.assert_called_once()
        return ctx.register_dashboard_auth_provider.call_args.args[0]

    def test_skips_when_unconfigured(self, patch_config):
        patch_config(None)
        ctx = MagicMock()
        kc_plugin.register(ctx)
        ctx.register_dashboard_auth_provider.assert_not_called()
        assert "AGENTX_DASHBOARD_KEYCLOAK_BASE_URL" in kc_plugin.LAST_SKIP_REASON

    def test_skip_reason_names_what_is_missing(self, patch_config, monkeypatch):
        patch_config(None)
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_BASE_URL", _BASE_URL)
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_REALM", _REALM)
        kc_plugin.register(MagicMock())
        assert "client_id set: False" in kc_plugin.LAST_SKIP_REASON

    def test_registers_from_env(self, patch_config, monkeypatch):
        patch_config(None)
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_BASE_URL", _BASE_URL)
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_REALM", _REALM)
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_CLIENT_ID", _CLIENT_ID)
        ctx = MagicMock()
        kc_plugin.register(ctx)
        p = self._registered(ctx)
        assert isinstance(p, kc_plugin.KeycloakOIDCProvider)
        assert p._issuer == _ISSUER
        assert p._scopes == "openid profile email"
        assert p.supports_password is False
        assert kc_plugin.LAST_SKIP_REASON == ""

    def test_registers_from_config_yaml(self, patch_config):
        patch_config(
            {
                "keycloak": {
                    "base_url": _BASE_URL,
                    "realm": _REALM,
                    "client_id": _CLIENT_ID,
                }
            }
        )
        ctx = MagicMock()
        kc_plugin.register(ctx)
        assert self._registered(ctx)._issuer == _ISSUER

    def test_env_overrides_config(self, patch_config, monkeypatch):
        patch_config(
            {
                "keycloak": {
                    "base_url": "https://stale.example/auth",
                    "realm": "stale",
                    "client_id": "stale-client",
                }
            }
        )
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_BASE_URL", _BASE_URL)
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_REALM", _REALM)
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_CLIENT_ID", _CLIENT_ID)
        ctx = MagicMock()
        kc_plugin.register(ctx)
        p = self._registered(ctx)
        assert p._issuer == _ISSUER
        assert p._client_id == _CLIENT_ID

    def test_empty_env_does_not_shadow_config(self, patch_config, monkeypatch):
        patch_config(
            {
                "keycloak": {
                    "base_url": _BASE_URL,
                    "realm": _REALM,
                    "client_id": _CLIENT_ID,
                    "client_secret": "from-config",
                }
            }
        )
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_CLIENT_SECRET", "")
        ctx = MagicMock()
        kc_plugin.register(ctx)
        assert self._registered(ctx)._client_secret == "from-config"

    def test_password_grant_from_config(self, patch_config):
        patch_config(
            {
                "keycloak": {
                    "base_url": _BASE_URL,
                    "realm": _REALM,
                    "client_id": _CLIENT_ID,
                    "allow_password_grant": True,
                }
            }
        )
        ctx = MagicMock()
        kc_plugin.register(ctx)
        assert self._registered(ctx).supports_password is True

    def test_env_can_turn_password_grant_off(self, patch_config, monkeypatch):
        """An explicit 0 must beat a config.yaml True, not just a missing value."""
        patch_config(
            {
                "keycloak": {
                    "base_url": _BASE_URL,
                    "realm": _REALM,
                    "client_id": _CLIENT_ID,
                    "allow_password_grant": True,
                }
            }
        )
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_ALLOW_PASSWORD_GRANT", "0")
        ctx = MagicMock()
        kc_plugin.register(ctx)
        assert self._registered(ctx).supports_password is False

    @pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on"])
    def test_truthy_env_spellings(self, patch_config, monkeypatch, value):
        patch_config(
            {"keycloak": {"base_url": _BASE_URL, "realm": _REALM, "client_id": _CLIENT_ID}}
        )
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_ALLOW_PASSWORD_GRANT", value)
        ctx = MagicMock()
        kc_plugin.register(ctx)
        assert self._registered(ctx).supports_password is True

    def test_config_load_failure_falls_through_to_env(self, monkeypatch):
        def _broken():
            raise RuntimeError("config.yaml is a banana")

        monkeypatch.setattr("hermes_cli.config.load_config", _broken)
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_BASE_URL", _BASE_URL)
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_REALM", _REALM)
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_CLIENT_ID", _CLIENT_ID)
        ctx = MagicMock()
        kc_plugin.register(ctx)
        assert self._registered(ctx)._issuer == _ISSUER

    def test_construction_failure_is_a_skip_not_a_crash(self, patch_config, monkeypatch):
        patch_config(None)
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_BASE_URL", "http://public.example")
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_REALM", _REALM)
        monkeypatch.setenv("AGENTX_DASHBOARD_KEYCLOAK_CLIENT_ID", _CLIENT_ID)
        ctx = MagicMock()
        kc_plugin.register(ctx)
        ctx.register_dashboard_auth_provider.assert_not_called()
        assert "construction failed" in kc_plugin.LAST_SKIP_REASON

    def test_registration_makes_no_network_call(self, patch_config, monkeypatch):
        """A Keycloak that is down at boot must not stop the dashboard starting."""
        patch_config(
            {"keycloak": {"base_url": _BASE_URL, "realm": _REALM, "client_id": _CLIENT_ID}}
        )
        with patch("plugins.dashboard_auth.keycloak.httpx.get") as mock_get, patch(
            "plugins.dashboard_auth.keycloak.httpx.post"
        ) as mock_post:
            kc_plugin.register(MagicMock())
        mock_get.assert_not_called()
        mock_post.assert_not_called()
