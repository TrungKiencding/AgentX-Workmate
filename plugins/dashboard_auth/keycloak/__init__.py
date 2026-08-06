"""KeycloakOIDCProvider — sign AgentX Workmate in against AgentX's Keycloak.

AgentX (the enterprise chatbot) authenticates every user through a Keycloak
realm. Workmate is the decentralised sibling that runs on the employee's own
machine, and it must accept those same accounts — no second user directory, no
second password. This provider is what makes that true: it is an OpenID Connect
Relying Party pointed at the AgentX realm, plugged into the ``agentx dashboard``
auth gate through the standard :class:`DashboardAuthProvider` protocol.

Two ways in
-----------

**Authorization code + PKCE (S256) — the default.** The browser bounces to
Keycloak's own login page and back to ``/auth/callback``. This is the flow that
keeps the things an enterprise realm actually relies on working: MFA/OTP,
``UPDATE_PASSWORD`` and other required actions, terms-of-use prompts, brokered
IdPs, and LDAP/AD federation. The password never enters Workmate's process.
Requires a **public** Keycloak client (no secret shipped to desktops).

**Direct access grants — opt-in.** Setting
``dashboard.oauth.keycloak.allow_password_grant`` flips ``supports_password``
on, and the login page grows a username/password form served by Workmate
itself, posting to ``/auth/password-login`` → :meth:`complete_password_login` →
Keycloak's token endpoint with ``grant_type=password``. It is off by default
because a realm with MFA or required actions cannot satisfy it: Keycloak
answers ``invalid_grant`` and the user is stuck with no way to complete the
challenge. Turn it on only for a realm whose client has
``directAccessGrantsEnabled`` and whose users have no interactive requirements.

Whichever door is used, everything downstream is identical — the same verified
:class:`Session`, the same cookies, the same refresh and WS-ticket handling.

Why the ID token
----------------

The verified **ID token** is what lands in ``Session.access_token``. OIDC
guarantees the ID token is a signed JWT carrying identity claims; Keycloak's
access token is also a JWT but its ``aud`` is the resource (``account``), not
this client, so pinning ``aud`` to our ``client_id`` — the check that stops a
token minted for a different client from being replayed here — only works on
the ID token.

Claim mapping mirrors AgentX's own ``packages/policy/keycloak.py`` so both
products describe the same person the same way: ``sub`` → user id, ``email``,
``name``/``preferred_username`` → display name, and ``tenant_slug`` (AgentX's
custom tenant claim) → ``org_id``, falling back through ``organization`` /
``org_id`` / ``realm_access.roles`` / ``groups``.

Configuration (env wins over config.yaml when set non-empty, so a
provisioned-but-blank secret can't shadow a valid config.yaml entry — the same
precedence convention the other bundled providers use)::

    # config.yaml — canonical surface
    dashboard:
      require_auth: true          # engage the gate on a loopback bind too
      oauth:
        keycloak:
          base_url: https://agentx.example.com/auth   # required
          realm: agent-hub                            # required
          client_id: agentx-workmate                  # required (PUBLIC client)
          # scopes: "openid profile email"
          # issuer: ""            # override for split-horizon DNS
          # org_claim: ""         # dotted claim path feeding org_id
          # idp_hint: ""          # kc_idp_hint, to skip the IdP chooser
          # allow_password_grant: false

    # Environment overrides
    AGENTX_DASHBOARD_KEYCLOAK_BASE_URL
    AGENTX_DASHBOARD_KEYCLOAK_REALM
    AGENTX_DASHBOARD_KEYCLOAK_CLIENT_ID
    AGENTX_DASHBOARD_KEYCLOAK_SCOPES
    AGENTX_DASHBOARD_KEYCLOAK_ISSUER
    AGENTX_DASHBOARD_KEYCLOAK_ORG_CLAIM
    AGENTX_DASHBOARD_KEYCLOAK_IDP_HINT
    AGENTX_DASHBOARD_KEYCLOAK_ALLOW_PASSWORD_GRANT
    AGENTX_DASHBOARD_KEYCLOAK_CLIENT_SECRET   # confidential clients only

When the plugin loads but declines to register, the reason is written to the
module-level :data:`LAST_SKIP_REASON` so the gate's fail-closed branch can tell
the operator *what* is missing instead of a bare "no providers registered".
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import secrets
import threading
import time
import urllib.parse
from typing import Any, Dict, Optional

import httpx

from hermes_cli.dashboard_auth import (
    DashboardAuthProvider,
    InvalidCodeError,
    InvalidCredentialsError,
    LoginStart,
    ProviderError,
    RefreshExpiredError,
    Session,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Defaults / constants
# ---------------------------------------------------------------------------

# ``openid`` is mandatory (without it Keycloak issues no ID token);
# ``profile``/``email`` populate display_name/email.
_DEFAULT_SCOPES = "openid profile email"

# Signing algorithms accepted on the ID token. Keycloak realms default to RS256
# but can be switched to the PS or ES families per-realm or per-client, so all
# three are allowed. HS256 is deliberately excluded — it implies a shared secret
# a public client doesn't have, and is the classic JWT algorithm-confusion
# footgun.
_ALLOWED_ID_TOKEN_ALGS = (
    "RS256", "RS384", "RS512",
    "PS256", "PS384", "PS512",
    "ES256", "ES384", "ES512",
)

_DISCOVERY_TIMEOUT_SEC = 10.0
_TOKEN_ENDPOINT_TIMEOUT_SEC = 10.0

# Discovery is low-frequency and effectively static; cache with a soft TTL so a
# long-running dashboard still picks up an endpoint migration within the hour.
_DISCOVERY_CACHE_TTL_SEC = 3600

# JWKS lifespan — short enough that a realm key rotation is picked up promptly.
_JWKS_CACHE_SECONDS = 300

_TRUTHY = frozenset({"1", "true", "yes", "on"})


# ---------------------------------------------------------------------------
# Skip-reason channel (mirrors the other bundled providers)
# ---------------------------------------------------------------------------

LAST_SKIP_REASON: str = ""


# ---------------------------------------------------------------------------
# Internal exceptions
# ---------------------------------------------------------------------------


class _TokenRejected(Exception):
    """This ID token is not a usable session token for this provider.

    Covers every token-level failure — expired, malformed, bad signature,
    foreign ``iss``/``aud`` — and deliberately NOT an IDP outage.

    The distinction is the whole point. ``verify_session`` turns this into
    ``None``, which the gate reads as "refresh or send them back to /login".
    A :class:`ProviderError` instead means "I can neither confirm nor deny",
    which the gate turns into a 503. Conflating the two is how a user with a
    stale cookie, or a cookie minted by a *different* registered provider,
    ends up staring at a 503 they can never clear.
    """


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _b64url_no_pad(raw: bytes) -> str:
    """Base64url-encode without ``=`` padding (RFC 7636 §4)."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _require_https_or_loopback(url: str, *, field: str) -> str:
    """Reject an endpoint URL that isn't HTTPS (loopback http is allowed).

    Authorization codes and refresh tokens travel over these URLs, so a
    misconfigured issuer must not be able to ship them in cleartext. Returns
    the URL unchanged on success.
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme == "https":
        return url
    if parsed.scheme == "http" and (parsed.hostname or "") in (
        "localhost",
        "127.0.0.1",
        "::1",
    ):
        return url
    raise ProviderError(
        f"Keycloak {field} must be https:// (or http on localhost), got {url!r}"
    )


def _dig(claims: Dict[str, Any], path: str) -> Any:
    """Walk a dotted claim path (``realm_access.roles``). None if absent."""
    node: Any = claims
    for part in path.split("."):
        if not isinstance(node, dict):
            return None
        node = node.get(part)
        if node is None:
            return None
    return node


def _claim_to_str(value: Any) -> str:
    """Flatten a claim into the free-form string ``Session.org_id`` expects.

    Keycloak emits the same logical claim as a scalar or a list depending on
    whether the protocol mapper is set to multivalued — ``tenant_slug`` is
    single-valued in AgentX's realm but a mapper edit would silently turn it
    into ``["acme"]``. AgentX's own ``resolve_principal`` accepts both; so do we.
    """
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return ",".join(str(v) for v in value if v not in (None, ""))
    if isinstance(value, bool):
        return ""
    return str(value)


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class KeycloakOIDCProvider(DashboardAuthProvider):
    """Keycloak OpenID Connect provider (authorization-code + PKCE, or password)."""

    name = "keycloak"
    display_name = "AgentX"

    # Always offer the redirect, even when the credential form is switched on.
    # An account with MFA or a pending required action can only complete on
    # Keycloak's own page, and the form has no way to tell the user that.
    supports_redirect = True

    def __init__(
        self,
        *,
        base_url: str,
        realm: str,
        client_id: str,
        scopes: str = _DEFAULT_SCOPES,
        client_secret: str = "",
        issuer: str = "",
        org_claim: str = "",
        idp_hint: str = "",
        allow_password_grant: bool = False,
    ) -> None:
        if not base_url and not issuer:
            raise ValueError("base_url is required (or an explicit issuer)")
        if not realm and not issuer:
            raise ValueError("realm is required (or an explicit issuer)")
        if not client_id:
            raise ValueError("client_id is required")

        self._base_url = (base_url or "").rstrip("/")
        self._realm = (realm or "").strip()
        # The OIDC issuer identifier. Keycloak's is always
        # ``{base}/realms/{realm}``; an explicit override exists for
        # split-horizon deploys where the browser and the server reach
        # Keycloak by different names.
        self._issuer = (
            issuer.strip() or f"{self._base_url}/realms/{self._realm}"
        ).rstrip("/")
        _require_https_or_loopback(self._issuer, field="issuer")

        self._client_id = client_id
        self._scopes = (scopes or "").strip() or _DEFAULT_SCOPES
        # Empty/whitespace secret means "public client" — strip so a
        # provisioned-but-blank value can't flip us into a broken confidential
        # mode that sends an empty client_secret.
        self._client_secret = (client_secret or "").strip()
        self._org_claim = (org_claim or "").strip()
        self._idp_hint = (idp_hint or "").strip()

        # Instance-level override of the class flag. The login page and the
        # /auth/password-login route both read it via getattr, so per-instance
        # is enough and keeps the capability tied to configuration rather than
        # to the class.
        self.supports_password = bool(allow_password_grant)

        # Discovery + JWKS resolve lazily on first use: registration must never
        # make a network call, or a Keycloak that is down at boot stops the
        # dashboard from starting at all.
        self._discovery: Dict[str, Any] | None = None
        self._discovery_fetched_at: float = 0.0
        self._discovery_lock = threading.Lock()
        self._jwks_client: Any = None

    def __repr__(self) -> str:
        # Never render the secret — this lands in logs and test failure output.
        return (
            f"<KeycloakOIDCProvider issuer={self._issuer!r} "
            f"client_id={self._client_id!r} confidential={bool(self._client_secret)} "
            f"password_grant={self.supports_password}>"
        )

    # ---- public API (DashboardAuthProvider) -------------------------------

    def start_login(self, *, redirect_uri: str) -> LoginStart:
        self._validate_redirect_uri(redirect_uri)
        disco = self._get_discovery()

        code_verifier = _b64url_no_pad(secrets.token_bytes(64))  # ~86 chars
        code_challenge = _b64url_no_pad(
            hashlib.sha256(code_verifier.encode("ascii")).digest()
        )
        state = _b64url_no_pad(secrets.token_bytes(32))

        params = {
            "response_type": "code",
            "client_id": self._client_id,
            "redirect_uri": redirect_uri,
            "scope": self._scopes,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        if self._idp_hint:
            # Skips Keycloak's IdP chooser and lands the user straight on the
            # configured broker (corporate AD/SAML), which is what an employee
            # expects to see.
            params["kc_idp_hint"] = self._idp_hint
        redirect_url = (
            f"{disco['authorization_endpoint']}?{urllib.parse.urlencode(params)}"
        )
        # Flat ``state=…;verifier=…`` shape — routes.auth_callback parses it
        # back with ``seg.split("=", 1)`` over ``raw.split(";")``, so neither
        # value may contain ';'. base64url output never does.
        cookie_payload = {
            "hermes_session_pkce": f"state={state};verifier={code_verifier}",
        }
        return LoginStart(redirect_url=redirect_url, cookie_payload=cookie_payload)

    def complete_login(
        self,
        *,
        code: str,
        state: str,
        code_verifier: str,
        redirect_uri: str,
    ) -> Session:
        # ``state`` is verified by the auth-route layer before this call.
        _ = state
        disco = self._get_discovery()

        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": self._client_id,
            "code_verifier": code_verifier,
        }
        extra_data, extra_headers = self._token_endpoint_auth(disco)
        data.update(extra_data)
        return self._exchange(
            disco["token_endpoint"],
            data,
            bad_request_exc=InvalidCodeError,
            extra_headers=extra_headers,
        )

    def complete_password_login(self, *, username: str, password: str) -> Session:
        """Exchange a username/password for a Session via direct access grants.

        Only reachable when ``allow_password_grant`` is configured — the
        ``/auth/password-login`` route guards on ``supports_password``.

        Keycloak answers ``invalid_grant`` for a wrong password, an unknown
        user, a disabled account, AND for a user who has a pending required
        action (password reset, OTP setup) that this flow structurally cannot
        satisfy. All of them surface as :class:`InvalidCredentialsError`, which
        the route renders as a generic 401 — deliberately, so the endpoint is
        not a username oracle. A realm that leans on required actions or MFA
        should leave this flow off and use the redirect flow instead.
        """
        disco = self._get_discovery()

        data = {
            "grant_type": "password",
            "client_id": self._client_id,
            "username": username,
            "password": password,
            "scope": self._scopes,
        }
        extra_data, extra_headers = self._token_endpoint_auth(disco)
        data.update(extra_data)
        return self._exchange(
            disco["token_endpoint"],
            data,
            bad_request_exc=InvalidCredentialsError,
            extra_headers=extra_headers,
            credentials_grant=True,
        )

    def refresh_session(self, *, refresh_token: str) -> Session:
        if not refresh_token:
            raise RefreshExpiredError("no refresh token present in session")
        disco = self._get_discovery()

        data = {
            "grant_type": "refresh_token",
            "client_id": self._client_id,
            "refresh_token": refresh_token,
            # Re-request the same scopes so the rotated ID token keeps its
            # identity claims (some IDPs narrow scope on refresh otherwise).
            "scope": self._scopes,
        }
        extra_data, extra_headers = self._token_endpoint_auth(disco)
        data.update(extra_data)
        return self._exchange(
            disco["token_endpoint"],
            data,
            bad_request_exc=RefreshExpiredError,
            previous_refresh_token=refresh_token,
            extra_headers=extra_headers,
        )

    def verify_session(self, *, access_token: str) -> Optional[Session]:
        """Re-verify the ID token held in the session cookie.

        Returns ``None`` for anything this provider cannot vouch for —
        expired, malformed, forged, or minted for a different issuer/client.
        The gate reads ``None`` as "refresh, then re-login", which is the
        recoverable outcome. Only a genuine Keycloak/JWKS outage raises
        :class:`ProviderError` (→ 503), because that is the one case where
        forcing a re-login would be wrong.
        """
        try:
            claims = self._verify_id_token(access_token)
        except _TokenRejected:
            return None
        # No refresh token on this path; the gate reads the refresh cookie
        # separately when it calls refresh_session.
        return self._session_from_tokens(
            id_token=access_token, refresh_token="", claims=claims
        )

    def revoke_session(self, *, refresh_token: str) -> None:
        """Best-effort RFC 7009 revocation. Must never raise.

        Deliberately does not call ``end_session_endpoint``: RP-initiated
        logout wants an ``id_token_hint``, which this method is never handed.
        The desktop shell, which does hold the ID token, opens the end-session
        URL itself on an explicit sign-out.
        """
        if not refresh_token:
            return None
        try:
            disco = self._get_discovery()
        except ProviderError:
            return None
        endpoint = str(disco.get("revocation_endpoint") or "").strip()
        if not endpoint:
            return None
        data = {
            "token": refresh_token,
            "token_type_hint": "refresh_token",
            "client_id": self._client_id,
        }
        headers = {"Accept": "application/json"}
        extra_data, extra_headers = self._token_endpoint_auth(disco)
        data.update(extra_data)
        headers.update(extra_headers)
        try:
            httpx.post(
                endpoint,
                data=data,
                headers=headers,
                timeout=_TOKEN_ENDPOINT_TIMEOUT_SEC,
            )
        except Exception as exc:  # noqa: BLE001 — best-effort
            logger.debug("keycloak: revoke failed (ignored): %s", exc)
        return None

    def native_oidc_config(self) -> Optional[dict]:
        """Public OIDC parameters the desktop shell needs to run its own flow.

        Served from the public ``/api/auth/providers`` route, so every value
        here must be non-secret. ``issuer`` and a public ``client_id`` are
        published by design — they are what the browser would carry in an
        authorize URL anyway.
        """
        return {
            "issuer": self._issuer,
            "client_id": self._client_id,
            "scopes": self._scopes,
            "confidential": bool(self._client_secret),
        }

    # ---- internals: token exchange ----------------------------------------

    def _token_endpoint_auth(
        self, disco: Dict[str, Any]
    ) -> tuple[Dict[str, str], Dict[str, str]]:
        """Return ``(extra_data, extra_headers)`` for token-endpoint client auth.

        Public client (the supported configuration): ``({}, {})`` — PKCE alone
        authenticates the exchange.

        Confidential client: authenticate per RFC 6749 §2.3.1, picking the
        method from the realm's advertised
        ``token_endpoint_auth_methods_supported`` (post if it is offered and
        basic is not; otherwise basic, the OIDC default). PKCE is still sent by
        the callers — the secret layers on top, it never replaces it.
        """
        if not self._client_secret:
            return {}, {}

        methods = disco.get("token_endpoint_auth_methods_supported") or []
        prefer_post = (
            "client_secret_post" in methods
            and "client_secret_basic" not in methods
        )
        if prefer_post:
            return {"client_secret": self._client_secret}, {}

        # HTTP Basic: both halves are form-url-encoded before base64 per RFC
        # 6749 §2.3.1, or a secret containing ':' corrupts the header.
        userpass = (
            f"{urllib.parse.quote(self._client_id, safe='')}:"
            f"{urllib.parse.quote(self._client_secret, safe='')}"
        )
        encoded = base64.b64encode(userpass.encode("utf-8")).decode("ascii")
        return {}, {"Authorization": f"Basic {encoded}"}

    def _exchange(
        self,
        token_endpoint: str,
        data: Dict[str, str],
        *,
        bad_request_exc: type[Exception],
        previous_refresh_token: str = "",
        extra_headers: Optional[Dict[str, str]] = None,
        credentials_grant: bool = False,
    ) -> Session:
        """POST the token endpoint and turn the response into a Session.

        ``bad_request_exc`` is what a rejection maps to, which differs per
        grant: ``InvalidCodeError`` (auth code → 400), ``RefreshExpiredError``
        (refresh → the gate tries other providers), ``InvalidCredentialsError``
        (password → generic 401).

        ``credentials_grant`` widens the rejection check to HTTP 401: Keycloak
        answers a bad direct-grant password with 401, not 400, so without this
        a wrong password would surface as a 503 "provider unreachable" instead
        of "invalid credentials". It also carves out the client-side
        misconfiguration errors (``unauthorized_client`` when the realm has
        direct access grants switched off, ``invalid_client``) and raises them
        as :class:`ProviderError` — those are an operator's problem to fix, not
        the user's, and telling them "wrong password" would send them chasing
        the wrong thing.
        """
        headers = {"Accept": "application/json"}
        if extra_headers:
            headers.update(extra_headers)
        try:
            response = httpx.post(
                token_endpoint,
                data=data,
                headers=headers,
                timeout=_TOKEN_ENDPOINT_TIMEOUT_SEC,
            )
        except httpx.RequestError as exc:
            raise ProviderError(f"Keycloak token endpoint unreachable: {exc}") from exc

        rejected = response.status_code == 400 or (
            credentials_grant and response.status_code == 401
        )
        if rejected:
            body = self._parse_json_body(response)
            error_code = str(body.get("error", "invalid_request"))
            if credentials_grant and error_code in (
                "unauthorized_client",
                "invalid_client",
            ):
                raise ProviderError(
                    "Keycloak rejected the password grant with "
                    f"{error_code!r} — enable 'Direct access grants' on client "
                    f"{self._client_id!r} in realm {self._realm!r}, or turn "
                    "dashboard.oauth.keycloak.allow_password_grant off and use "
                    "the sign-in redirect."
                )
            raise bad_request_exc(f"Keycloak rejected token request: {error_code}")
        if response.status_code != 200:
            raise ProviderError(
                f"Keycloak token endpoint returned {response.status_code}: "
                f"{response.text[:200]!r}"
            )

        payload = self._parse_json_body(response)

        id_token = payload.get("id_token")
        if not id_token or not isinstance(id_token, str):
            raise ProviderError(
                "Keycloak token response carried no id_token — check that the "
                "'openid' scope is requested and the client may receive an ID "
                "token."
            )

        token_type = str(payload.get("token_type", "")).lower()
        if token_type and token_type != "bearer":
            raise ProviderError(f"unexpected token_type={token_type!r}")

        try:
            claims = self._verify_id_token(id_token)
        except _TokenRejected as exc:
            # Keycloak just handed us a token we cannot verify. That is an
            # infrastructure/configuration fault (clock skew, wrong client_id,
            # issuer mismatch behind a proxy), not a user error — surface it as
            # such rather than as "bad code" or "wrong password".
            raise ProviderError(
                f"Keycloak returned an ID token we cannot verify: {exc}"
            ) from exc

        # Prefer a freshly-issued refresh token; keep the previous one when the
        # realm doesn't rotate. Empty means the session runs until the ID token
        # expires and then requires a fresh login.
        refresh_token = payload.get("refresh_token")
        if not isinstance(refresh_token, str) or not refresh_token:
            refresh_token = previous_refresh_token or ""

        return self._session_from_tokens(
            id_token=id_token, refresh_token=refresh_token, claims=claims
        )

    # ---- internals: discovery ---------------------------------------------

    def _get_discovery(self) -> Dict[str, Any]:
        """Return the cached OIDC discovery document, fetching if stale."""
        now = time.time()
        if (
            self._discovery is not None
            and (now - self._discovery_fetched_at) < _DISCOVERY_CACHE_TTL_SEC
        ):
            return self._discovery
        with self._discovery_lock:
            now = time.time()
            if (
                self._discovery is not None
                and (now - self._discovery_fetched_at) < _DISCOVERY_CACHE_TTL_SEC
            ):
                return self._discovery
            disco = self._fetch_discovery()
            self._discovery = disco
            self._discovery_fetched_at = now
            # New issuer/keys → drop the JWKS client so it re-binds.
            self._jwks_client = None
            return disco

    def _discovery_url(self) -> str:
        return f"{self._issuer}/.well-known/openid-configuration"

    def _fetch_discovery(self) -> Dict[str, Any]:
        url = self._discovery_url()
        try:
            # follow_redirects: a Keycloak behind a reverse proxy doing an
            # http→https upgrade answers discovery with a 3xx, and httpx does
            # not follow by default. Safe, because the issuer pin and the
            # https-or-loopback check below validate the *resolved* document.
            response = httpx.get(
                url,
                headers={"Accept": "application/json"},
                timeout=_DISCOVERY_TIMEOUT_SEC,
                follow_redirects=True,
            )
        except httpx.RequestError as exc:
            raise ProviderError(f"Keycloak discovery unreachable: {exc}") from exc
        if response.status_code != 200:
            raise ProviderError(
                f"Keycloak discovery returned {response.status_code} for {url!r} "
                f"— check base_url and realm."
            )
        payload = self._parse_json_body(response)
        if not payload:
            raise ProviderError("Keycloak discovery returned a non-JSON body")

        authorization_endpoint = str(
            payload.get("authorization_endpoint", "") or ""
        ).strip()
        token_endpoint = str(payload.get("token_endpoint", "") or "").strip()
        jwks_uri = str(payload.get("jwks_uri", "") or "").strip()
        if not authorization_endpoint or not token_endpoint or not jwks_uri:
            raise ProviderError(
                "Keycloak discovery missing one of authorization_endpoint / "
                "token_endpoint / jwks_uri"
            )

        # Pin the advertised issuer: a mismatch means the document was served
        # from somewhere other than the realm we configured (proxy, MITM, a
        # typo in base_url). Tolerate only a trailing-slash difference.
        advertised_issuer = str(payload.get("issuer", "") or "").strip()
        if advertised_issuer and advertised_issuer.rstrip("/") != self._issuer:
            raise ProviderError(
                f"Keycloak discovery issuer mismatch: realm advertises "
                f"{advertised_issuer!r} but configured issuer is {self._issuer!r}"
            )

        _require_https_or_loopback(
            authorization_endpoint, field="authorization_endpoint"
        )
        _require_https_or_loopback(token_endpoint, field="token_endpoint")
        _require_https_or_loopback(jwks_uri, field="jwks_uri")

        auth_methods_raw = payload.get("token_endpoint_auth_methods_supported")
        token_endpoint_auth_methods = (
            [str(m) for m in auth_methods_raw]
            if isinstance(auth_methods_raw, list)
            else []
        )

        return {
            "issuer": advertised_issuer or self._issuer,
            "authorization_endpoint": authorization_endpoint,
            "token_endpoint": token_endpoint,
            "jwks_uri": jwks_uri,
            "revocation_endpoint": str(
                payload.get("revocation_endpoint", "") or ""
            ).strip(),
            "end_session_endpoint": str(
                payload.get("end_session_endpoint", "") or ""
            ).strip(),
            "token_endpoint_auth_methods_supported": token_endpoint_auth_methods,
        }

    # ---- internals: JWT verification --------------------------------------

    def _get_jwks_client(self) -> Any:
        if self._jwks_client is None:
            from jwt import PyJWKClient  # lazy import

            disco = self._get_discovery()
            self._jwks_client = PyJWKClient(
                disco["jwks_uri"],
                cache_keys=True,
                lifespan=_JWKS_CACHE_SECONDS,
                headers={
                    "Accept": "application/json",
                    "User-Agent": "AgentX-Workmate/1.0",
                },
            )
        return self._jwks_client

    def _verify_id_token(self, id_token: str) -> Dict[str, Any]:
        """Verify an ID token against the realm JWKS. Pins ``iss`` and ``aud``.

        Raises :class:`_TokenRejected` for every token-level failure and
        :class:`ProviderError` only when the realm's JWKS cannot be reached —
        see :class:`_TokenRejected` for why that line matters.
        """
        import jwt  # lazy import — keeps startup fast for the ungated path

        disco = self._get_discovery()

        try:
            signing_key = self._get_jwks_client().get_signing_key_from_jwt(id_token)
        except jwt.PyJWKClientError as exc:
            # PyJWKClient raises this both for a network failure and for a
            # `kid` that simply isn't in the realm's key set. The first is an
            # outage, the second is a foreign token. Distinguish by asking
            # whether the JWKS itself is reachable right now.
            if self._jwks_reachable():
                raise _TokenRejected(f"signing key not in realm JWKS: {exc}") from exc
            raise ProviderError(f"Keycloak JWKS unreachable: {exc}") from exc
        except jwt.InvalidTokenError as exc:
            # Malformed JWS — never ours.
            raise _TokenRejected(f"malformed ID token: {exc}") from exc
        except Exception as exc:  # pragma: no cover - defensive
            raise ProviderError(f"JWKS lookup failed: {exc!r}") from exc

        try:
            return jwt.decode(
                id_token,
                signing_key.key,
                algorithms=list(_ALLOWED_ID_TOKEN_ALGS),
                audience=self._client_id,
                issuer=disco["issuer"],
                options={"require": ["exp", "iat", "aud", "iss", "sub"]},
            )
        except jwt.InvalidTokenError as exc:
            # Expired, wrong issuer, wrong audience, bad signature — all
            # unusable, all recoverable by signing in again. Surface the actual
            # iss/aud so config drift is debuggable; decoding without
            # verification is safe here because we already failed verification
            # and never trust these values.
            details = ""
            try:
                unverified = jwt.decode(
                    id_token,
                    options={"verify_signature": False, "verify_exp": False},
                )
                details = (
                    f" [token iss={unverified.get('iss')!r} "
                    f"aud={unverified.get('aud')!r}; "
                    f"expected iss={disco['issuer']!r} aud={self._client_id!r}]"
                )
            except Exception:
                pass
            raise _TokenRejected(f"ID token rejected: {exc}{details}") from exc

    def _jwks_reachable(self) -> bool:
        """True if the realm's JWKS endpoint answers right now.

        Used only to classify a ``PyJWKClientError`` as "unknown key" versus
        "Keycloak is down". Never raises.
        """
        try:
            jwks_uri = self._get_discovery()["jwks_uri"]
        except Exception:
            return False
        try:
            resp = httpx.get(
                jwks_uri,
                headers={"Accept": "application/json"},
                timeout=_DISCOVERY_TIMEOUT_SEC,
            )
        except Exception:
            return False
        return resp.status_code == 200

    # ---- internals: mapping + misc ----------------------------------------

    def _session_from_tokens(
        self,
        *,
        id_token: str,
        refresh_token: str,
        claims: Dict[str, Any],
    ) -> Session:
        """Map verified Keycloak claims onto a Session.

        The verified ID token goes into ``Session.access_token`` so the
        per-request ``verify_session`` re-verifies a real JWT. Keycloak's
        opaque-to-us OAuth access token is intentionally not stored — Workmate
        calls no resource API with it; the dashboard only needs identity.
        """
        user_id = str(claims.get("sub") or "")
        if not user_id:
            raise ProviderError("Keycloak ID token missing 'sub' claim")

        email = str(claims.get("email") or "")
        display_name = str(
            claims.get("name")
            or claims.get("preferred_username")
            or email
            or user_id
        )

        # org_id is free-form. An explicit org_claim wins; otherwise walk the
        # same preference order AgentX's resolve_principal uses, so a user's
        # tenant reads identically in both products.
        org_id = ""
        if self._org_claim:
            org_id = _claim_to_str(_dig(claims, self._org_claim))
        if not org_id:
            for key in ("tenant_slug", "organization", "org_id"):
                org_id = _claim_to_str(claims.get(key))
                if org_id:
                    break
        if not org_id:
            org_id = _claim_to_str(_dig(claims, "realm_access.roles"))
        if not org_id:
            org_id = _claim_to_str(claims.get("groups"))

        return Session(
            user_id=user_id,
            email=email,
            display_name=display_name,
            org_id=org_id,
            provider=self.name,
            expires_at=int(claims["exp"]),
            access_token=id_token,
            refresh_token=refresh_token,
        )

    def _validate_redirect_uri(self, redirect_uri: str) -> None:
        """Fast-fail an obviously-broken redirect_uri before bouncing to Keycloak.

        The realm's own Valid Redirect URIs list is authoritative; this only
        catches the common operator error with a message that says what is
        wrong. Any http(s) host is allowed — a self-hosted dashboard reached
        over plain HTTP on a LAN address is legitimate, and Keycloak makes the
        final call.
        """
        parsed = urllib.parse.urlparse(redirect_uri)
        if parsed.scheme not in ("https", "http"):
            raise ProviderError(f"redirect_uri must be http(s), got {redirect_uri!r}")
        if not parsed.path or not parsed.path.endswith("/auth/callback"):
            raise ProviderError(
                f"redirect_uri path must end with '/auth/callback', got {redirect_uri!r}"
            )

    def _parse_json_body(self, response: httpx.Response) -> Dict[str, Any]:
        ctype = response.headers.get("content-type", "")
        if not ctype.startswith("application/json"):
            return {}
        try:
            body = response.json()
        except ValueError:
            return {}
        return body if isinstance(body, dict) else {}


# ---------------------------------------------------------------------------
# Plugin entry point
# ---------------------------------------------------------------------------


def _load_config_oauth_section() -> dict:
    """Return the ``dashboard.oauth`` block from config.yaml, or ``{}``.

    Robust to load_config() raising and to either key being absent or not a
    dict — each falls through to ``{}`` so callers can rely on ``.get(...)``.
    """
    try:
        from hermes_cli.config import cfg_get, load_config

        cfg = load_config()
    except Exception as exc:  # noqa: BLE001 — broad catch is intentional
        logger.debug(
            "dashboard-auth-keycloak: load_config() raised %s; "
            "falling back to env-only configuration",
            exc,
        )
        return {}
    section = cfg_get(cfg, "dashboard", "oauth", default=None)
    return section if isinstance(section, dict) else {}


def _keycloak_subsection(oauth_section: dict) -> dict:
    """Return the ``dashboard.oauth.keycloak`` sub-block, or ``{}``."""
    sub = oauth_section.get("keycloak")
    return sub if isinstance(sub, dict) else {}


def _resolve_setting(env_var: str, cfg_value: Any) -> str:
    """env-wins-config with empty-is-unset precedence.

    A provisioned-but-empty env var must not shadow a valid config.yaml entry,
    so only a non-empty env value wins.
    """
    env = os.environ.get(env_var, "").strip()
    if env:
        return env
    return str(cfg_value or "").strip()


def _resolve_flag(env_var: str, cfg_value: Any) -> bool:
    """Boolean form of :func:`_resolve_setting`.

    An explicitly-set env var wins in BOTH directions — ``=0`` must be able to
    turn off something config.yaml turned on, which a plain truthiness check
    would get wrong.
    """
    env = os.environ.get(env_var, "").strip().lower()
    if env:
        return env in _TRUTHY
    if isinstance(cfg_value, bool):
        return cfg_value
    if isinstance(cfg_value, str):
        return cfg_value.strip().lower() in _TRUTHY
    return bool(cfg_value)


def register(ctx) -> None:
    """Plugin entry — called by the plugin loader at startup.

    Registers :class:`KeycloakOIDCProvider` only once a base_url (or explicit
    issuer), realm and client_id are configured. An unconfigured install is a
    silent no-op, so loopback operators who never wanted SSO are unaffected.

    Never makes a network call: a Keycloak that is unreachable at boot must not
    stop the dashboard from starting.
    """
    global LAST_SKIP_REASON
    LAST_SKIP_REASON = ""

    oauth_section = _load_config_oauth_section()
    kc_cfg = _keycloak_subsection(oauth_section)

    base_url = _resolve_setting(
        "AGENTX_DASHBOARD_KEYCLOAK_BASE_URL", kc_cfg.get("base_url")
    )
    realm = _resolve_setting(
        "AGENTX_DASHBOARD_KEYCLOAK_REALM", kc_cfg.get("realm")
    )
    client_id = _resolve_setting(
        "AGENTX_DASHBOARD_KEYCLOAK_CLIENT_ID", kc_cfg.get("client_id")
    )
    issuer = _resolve_setting(
        "AGENTX_DASHBOARD_KEYCLOAK_ISSUER", kc_cfg.get("issuer")
    )
    scopes = (
        _resolve_setting("AGENTX_DASHBOARD_KEYCLOAK_SCOPES", kc_cfg.get("scopes"))
        or _DEFAULT_SCOPES
    )
    # A credential, so the env var / ~/.agentx/.env is its canonical home;
    # config.yaml is accepted for precedence symmetry. Empty ⇒ public client.
    client_secret = _resolve_setting(
        "AGENTX_DASHBOARD_KEYCLOAK_CLIENT_SECRET", kc_cfg.get("client_secret")
    )
    org_claim = _resolve_setting(
        "AGENTX_DASHBOARD_KEYCLOAK_ORG_CLAIM", kc_cfg.get("org_claim")
    )
    idp_hint = _resolve_setting(
        "AGENTX_DASHBOARD_KEYCLOAK_IDP_HINT", kc_cfg.get("idp_hint")
    )
    allow_password_grant = _resolve_flag(
        "AGENTX_DASHBOARD_KEYCLOAK_ALLOW_PASSWORD_GRANT",
        kc_cfg.get("allow_password_grant"),
    )

    have_issuer = bool(issuer) or (bool(base_url) and bool(realm))
    if not have_issuer or not client_id:
        LAST_SKIP_REASON = (
            "Keycloak dashboard auth is not configured. Set base_url + realm "
            "(or an explicit issuer) and client_id — either as env vars "
            "(AGENTX_DASHBOARD_KEYCLOAK_BASE_URL + _REALM + _CLIENT_ID) or "
            "under dashboard.oauth.keycloak.* in config.yaml. Run "
            "`agentx dashboard keycloak --help` for a guided setup. "
            "(base_url set: %s; realm set: %s; issuer set: %s; client_id set: %s)"
            % (bool(base_url), bool(realm), bool(issuer), bool(client_id))
        )
        logger.debug("dashboard-auth-keycloak: %s", LAST_SKIP_REASON)
        return

    try:
        provider = KeycloakOIDCProvider(
            base_url=base_url,
            realm=realm,
            client_id=client_id,
            scopes=scopes,
            client_secret=client_secret,
            issuer=issuer,
            org_claim=org_claim,
            idp_hint=idp_hint,
            allow_password_grant=allow_password_grant,
        )
    except (ValueError, ProviderError) as exc:
        LAST_SKIP_REASON = f"KeycloakOIDCProvider construction failed: {exc}"
        logger.warning("dashboard-auth-keycloak: %s", LAST_SKIP_REASON)
        return

    if client_secret:
        logger.warning(
            "dashboard-auth-keycloak: a client_secret is configured, so client "
            "%r is treated as CONFIDENTIAL. The browser dashboard works, but "
            "the desktop app cannot run its own sign-in against a confidential "
            "client and will fall back to the gateway-brokered flow. Register "
            "%r as a PUBLIC client in Keycloak and clear the secret unless you "
            "know you need it.",
            client_id,
            client_id,
        )

    ctx.register_dashboard_auth_provider(provider)
    logger.info(
        "dashboard-auth-keycloak: registered provider "
        "(issuer=%s, client_id=%s, scopes=%r, confidential=%s, password_grant=%s)",
        provider._issuer,
        client_id,
        scopes,
        # Log only whether a secret is present, never the secret itself.
        bool(client_secret),
        allow_password_grant,
    )
