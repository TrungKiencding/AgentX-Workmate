"""The two HTTP surfaces of per-account LiteLLM provisioning.

Part A is the central broker (``hermes_cli.litellm_broker``). It is the only
piece of this feature that holds the LiteLLM admin key, so it is tested as a
security boundary: who may call it, whose key it mints, and what it answers
when the realm or the proxy is down.

Part B is the on-device pair of routes (``hermes_cli.web_routers.accounts``)
that the desktop app calls right after sign-in.

Everything runs in-process. The realm is a subclass of the suite's
``StubAuthProvider``; LiteLLM is an ``httpx.MockTransport`` standing in for the
proxy's admin API. No network, no server process, no real ``~/.agentx``.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import httpx
import pytest
import yaml
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from hermes_cli import account_provisioning, litellm_broker
from hermes_cli.account_provisioning import (
    ADMIN_KEY_ENV_VAR,
    LiteLLMAccountSettings,
    provider_key_env,
)
from hermes_cli.accounts import (
    AccountIdentity,
    account_slug_for_identity,
    ensure_account_home,
)
from hermes_cli.dashboard_auth.base import ProviderError, Session
from hermes_cli.litellm_admin import LiteLLMAdminClient
from hermes_cli.litellm_broker import BROKER_ROUTE, BrokerConfigError, build_app
from tests.hermes_cli.conftest_dashboard_auth import StubAuthProvider

_PROXY_URL = "https://litellm.internal.test"
_ADMIN_KEY = "sk-admin-lives-on-the-server-only"
_PROXY_MODELS = ("gpt-4o-mini", "claude-sonnet-4")


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeRealm(StubAuthProvider):
    """A realm that recognises exactly the tokens a test hands it.

    Subclasses the suite's stub so the provider protocol stays satisfied, and
    overrides only ``verify_session`` — the one method the broker calls — so a
    test can hold two distinct users and simulate an IdP outage.
    """

    name = "fake-realm"

    def __init__(self) -> None:
        super().__init__()
        self.sessions: dict[str, Session] = {}
        self.outage_tokens: set[str] = set()

    def add(self, token: str, session: Session) -> Session:
        self.sessions[token] = session
        return session

    def verify_session(self, *, access_token: str):
        if access_token in self.outage_tokens:
            raise ProviderError("JWKS endpoint unreachable")
        return self.sessions.get(access_token)


class _FakeLiteLLM:
    """LiteLLM's virtual-key admin API, in memory, behind a MockTransport.

    Models the two behaviours the provisioner depends on: ``/key/list`` never
    returns plaintext (only the hash), and ``/v1/models`` answers 401 for a key
    the proxy does not know.
    """

    def __init__(self) -> None:
        self.records: dict[str, dict] = {}  # token(hash) -> record incl. plaintext
        self.minted: list[str] = []
        self.unreachable = False
        self.fail_next: tuple[int, dict] | None = None
        self._counter = 0

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def records_for(self, alias: str) -> list[dict]:
        return [r for r in self.records.values() if r["key_alias"] == alias]

    def aliases(self) -> set[str]:
        return {r["key_alias"] for r in self.records.values()}

    def key_for(self, alias: str) -> str:
        matches = self.records_for(alias)
        assert len(matches) == 1, f"expected one key for {alias}, got {len(matches)}"
        return matches[0]["key"]

    def _handle(self, request: httpx.Request) -> httpx.Response:
        if self.unreachable:
            raise httpx.ConnectError("connection refused", request=request)
        if self.fail_next is not None:
            status, body = self.fail_next
            self.fail_next = None
            return httpx.Response(status, json=body)

        path = request.url.path
        body = json.loads(request.content or b"{}") if request.content else {}

        if path == "/key/list":
            alias = request.url.params.get("key_alias", "")
            rows = [
                {k: v for k, v in record.items() if k != "key"}
                for record in self.records_for(alias)
            ]
            return httpx.Response(200, json={"keys": rows})

        if path == "/key/generate":
            self._counter += 1
            record = {
                "token": f"hash-{self._counter}",
                "key": f"sk-user-{self._counter}",
                "key_alias": str(body.get("key_alias") or ""),
                "user_id": str(body.get("user_id") or ""),
                "models": list(body.get("models") or []),
                "metadata": dict(body.get("metadata") or {}),
            }
            self.records[record["token"]] = record
            self.minted.append(record["key"])
            return httpx.Response(
                200,
                json={
                    "key": record["key"],
                    "token": record["token"],
                    "key_alias": record["key_alias"],
                    "models": record["models"],
                },
            )

        if path == "/key/delete":
            deleted = [t for t in (body.get("keys") or []) if self.records.pop(t, None)]
            return httpx.Response(200, json={"deleted_keys": deleted})

        if path == "/v1/models":
            auth = request.headers.get("authorization", "")
            presented = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
            known = presented == _ADMIN_KEY or any(
                r["key"] == presented for r in self.records.values()
            )
            if not known:
                return httpx.Response(401, json={"error": {"message": "invalid key"}})
            return httpx.Response(
                200, json={"data": [{"id": m} for m in _PROXY_MODELS]}
            )

        return httpx.Response(404, json={"error": {"message": f"no route {path}"}})


def _session(
    subject: str,
    email: str,
    display_name: str,
    token: str,
    provider: str = "keycloak",
) -> Session:
    return Session(
        user_id=subject,
        email=email,
        display_name=display_name,
        org_id="",
        provider=provider,
        expires_at=int(time.time()) + 900,
        access_token=token,
        refresh_token="",
    )


def _settings(**overrides) -> LiteLLMAccountSettings:
    base = {
        "enabled": True,
        "base_url": _PROXY_URL,
        "mode": "direct",
        "models": _PROXY_MODELS,
        "key_alias_prefix": "agentx-workmate",
        "request_timeout_seconds": 2.0,
    }
    base.update(overrides)
    return LiteLLMAccountSettings(**base)


def _admin_client(proxy: _FakeLiteLLM, base_url: str = _PROXY_URL) -> LiteLLMAdminClient:
    # sleep is stubbed out so the client's single retry on a 5xx/connect error
    # does not add real wall-clock time to the suite.
    return LiteLLMAdminClient(
        base_url,
        _ADMIN_KEY,
        timeout=2.0,
        transport=proxy.transport,
        sleep=lambda _seconds: None,
    )


@pytest.fixture
def proxy() -> _FakeLiteLLM:
    return _FakeLiteLLM()


@pytest.fixture
def realm() -> _FakeRealm:
    return _FakeRealm()


# ===========================================================================
# PART A — the broker
# ===========================================================================


@pytest.fixture
def broker(realm, proxy):
    settings = _settings()
    app = build_app(provider=realm, client=_admin_client(proxy), settings=settings)
    with TestClient(app) as client:
        yield client, realm, proxy, settings


def _post(client: TestClient, token: str | None = None, body: dict | None = None,
          raw_header: str | None = None):
    headers = {}
    if raw_header is not None:
        headers["Authorization"] = raw_header
    elif token is not None:
        headers["Authorization"] = f"Bearer {token}"
    return client.post(BROKER_ROUTE, json=body or {}, headers=headers)


def test_broker_health_needs_no_auth(broker):
    client, _realm, _proxy, settings = broker
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["base_url"] == settings.base_url


@pytest.mark.parametrize(
    "kwargs",
    [
        {},                                        # no Authorization header
        {"raw_header": "Basic dXNlcjpwYXNz"},      # wrong scheme
        {"raw_header": "Bearer   "},               # scheme, no token
        {"raw_header": "not-even-a-scheme"},
    ],
    ids=["absent", "wrong-scheme", "empty-token", "malformed"],
)
def test_broker_rejects_anything_that_is_not_a_bearer_token(broker, kwargs):
    client, _realm, proxy, _settings = broker
    assert _post(client, **kwargs).status_code == 401
    assert proxy.minted == []


def test_broker_rejects_a_token_the_realm_does_not_know(broker):
    client, _realm, proxy, _settings = broker
    response = _post(client, token="forged-token")
    assert response.status_code == 401
    # Nothing may be minted for a caller the realm rejected.
    assert proxy.minted == []


def test_broker_mints_for_the_token_holder(broker):
    client, realm, proxy, settings = broker
    realm.add("tok-ada", _session("kc-ada", "ada@corp.test", "ada", "tok-ada"))

    response = _post(client, token="tok-ada")
    assert response.status_code == 200
    payload = response.json()

    expected_slug = account_slug_for_identity("kc-ada", username="ada", email="ada@corp.test")
    expected_alias = settings.alias_for(expected_slug)

    assert payload["account"] == expected_slug
    assert payload["key_alias"] == expected_alias
    assert payload["key"] == proxy.key_for(expected_alias)
    assert payload["token"] == proxy.records_for(expected_alias)[0]["token"]
    assert payload["base_url"] == settings.base_url
    assert payload["models"] == list(_PROXY_MODELS)
    assert payload["rotated"] is False
    # The key is attributed to the verified subject upstream too, so LiteLLM's
    # own spend reporting names the same person.
    assert proxy.records_for(expected_alias)[0]["user_id"] == "kc-ada"


def test_broker_ignores_the_account_field_in_the_body(broker):
    """Privilege-escalation guard.

    The whole reason the admin key lives on the broker is that laptops cannot
    be trusted with it. That is worth nothing if a laptop can name someone
    else's alias in a JSON field and be handed their key. The slug must come
    from the verified ``sub`` and from nowhere else, so user A presenting a
    valid token while asking for user B's alias gets A's key — and B's alias
    must not exist on the proxy afterwards.
    """
    client, realm, proxy, settings = broker
    realm.add("tok-ada", _session("kc-ada", "ada@corp.test", "ada", "tok-ada"))

    victim_slug = account_slug_for_identity(
        "kc-grace", username="grace", email="grace@corp.test"
    )
    victim_alias = settings.alias_for(victim_slug)
    attacker_slug = account_slug_for_identity(
        "kc-ada", username="ada", email="ada@corp.test"
    )
    attacker_alias = settings.alias_for(attacker_slug)
    assert victim_alias != attacker_alias

    response = _post(
        client,
        token="tok-ada",
        body={"account": victim_alias, "subject": "kc-grace"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["key_alias"] == attacker_alias
    assert payload["account"] == attacker_slug
    assert proxy.aliases() == {attacker_alias}
    assert proxy.records_for(victim_alias) == []
    assert payload["key"] == proxy.key_for(attacker_alias)


def test_broker_rotates_instead_of_accumulating_keys(broker):
    client, realm, proxy, settings = broker
    realm.add("tok-ada", _session("kc-ada", "ada@corp.test", "ada", "tok-ada"))
    alias = settings.alias_for(
        account_slug_for_identity("kc-ada", username="ada", email="ada@corp.test")
    )

    first = _post(client, token="tok-ada").json()
    second = _post(client, token="tok-ada").json()

    assert first["rotated"] is False
    assert second["rotated"] is True
    assert second["key"] != first["key"]
    # One person, one live key: the old one is retired, not orphaned upstream.
    assert len(proxy.records_for(alias)) == 1
    assert proxy.key_for(alias) == second["key"]
    assert len(proxy.minted) == 2


def test_broker_answers_503_when_the_realm_is_unreachable(broker):
    """An IdP outage must not read as "your token is bad".

    ``verify_session`` raising means the broker could neither confirm nor deny
    the caller. Answering 401 there would tell a laptop its sign-in is dead and
    make it discard a perfectly good LiteLLM key over a JWKS blip; 503 tells it
    to keep what it has and retry later.
    """
    client, realm, proxy, _settings = broker
    realm.add("tok-ada", _session("kc-ada", "ada@corp.test", "ada", "tok-ada"))
    realm.outage_tokens.add("tok-ada")

    response = _post(client, token="tok-ada")
    assert response.status_code == 503
    assert response.status_code != 401
    assert proxy.minted == []


def test_broker_answers_503_when_litellm_is_unreachable(broker):
    client, realm, proxy, _settings = broker
    realm.add("tok-ada", _session("kc-ada", "ada@corp.test", "ada", "tok-ada"))
    proxy.unreachable = True

    assert _post(client, token="tok-ada").status_code == 503


def test_broker_answers_502_when_litellm_refuses(broker):
    client, realm, proxy, _settings = broker
    realm.add("tok-ada", _session("kc-ada", "ada@corp.test", "ada", "tok-ada"))
    # "The proxy answered, and the answer was no" is an upstream fault, not an
    # outage — the caller must be able to tell those apart.
    proxy.fail_next = (400, {"error": {"message": "key_alias already in use"}})

    assert _post(client, token="tok-ada").status_code == 502


def test_broker_refuses_to_build_without_an_admin_key(realm, monkeypatch):
    """A misconfigured broker fails the deploy, not somebody's sign-in."""
    monkeypatch.setattr(account_provisioning, "_admin_key", lambda: "")
    with pytest.raises(BrokerConfigError):
        build_app(provider=realm, settings=_settings())


def test_broker_refuses_to_build_without_a_base_url(realm, monkeypatch):
    monkeypatch.setattr(account_provisioning, "_admin_key", lambda: _ADMIN_KEY)
    with pytest.raises(BrokerConfigError):
        build_app(provider=realm, settings=_settings(base_url=""))


def test_broker_route_constant_is_what_the_app_serves(broker):
    client, realm, _proxy, _settings = broker
    realm.add("tok-ada", _session("kc-ada", "ada@corp.test", "ada", "tok-ada"))
    # The desktop's broker_url must name this path exactly; a rename that
    # forgets the constant would 404 every laptop.
    assert client.post(BROKER_ROUTE, json={}).status_code != 404
    assert litellm_broker.BROKER_ROUTE.startswith("/")


# ===========================================================================
# PART B — the on-device routes
# ===========================================================================
#
# These are exercised against a minimal FastAPI app that mounts the real
# router behind a middleware that sets ``request.state.session`` — which is
# the entire contract the dashboard auth gate provides to these handlers.
# Standing up ``hermes_cli.web_server.app`` instead would drag in the whole
# dashboard (and its module-level ``app.state`` that other test files mutate)
# to test two handlers that read exactly one attribute. The 401 path is still
# real: it comes from the router's own ``_require_session``, not from the gate.


def _account_app(session: Session | None) -> FastAPI:
    from hermes_cli.web_routers import accounts as accounts_routes

    app = FastAPI()

    @app.middleware("http")
    async def _attach_session(request: Request, call_next):
        if session is not None:
            request.state.session = session
        return await call_next(request)

    app.include_router(accounts_routes.router)
    return app


def _use_home(monkeypatch, home: Path) -> Path:
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("AGENTX_HOME", str(home))
    return home


def _write_litellm_config(home: Path, section: dict) -> None:
    (home / "config.yaml").write_text(
        yaml.safe_dump({"accounts": {"litellm": section}}), encoding="utf-8"
    )


def _route_admin_client_to(monkeypatch, proxy: _FakeLiteLLM) -> None:
    """Make every admin client the provisioner builds talk to the fake proxy.

    ``ensure_account_key`` constructs its own client in direct mode, so the
    MockTransport is bound in at construction rather than passed down through
    a kwarg the HTTP route does not expose.
    """
    real = LiteLLMAdminClient

    def _factory(base_url, admin_key, **kwargs):
        kwargs.setdefault("transport", proxy.transport)
        kwargs.setdefault("sleep", lambda _seconds: None)
        return real(base_url, admin_key, **kwargs)

    monkeypatch.setattr(account_provisioning, "LiteLLMAdminClient", _factory)


@pytest.fixture
def ada() -> Session:
    return _session("kc-ada", "ada@corp.test", "Ada Lovelace", "tok-ada")


@pytest.mark.parametrize(
    "method,path",
    [("get", "/api/account"), ("post", "/api/account/provision")],
)
def test_account_routes_require_a_session(method, path):
    with TestClient(_account_app(None)) as client:
        response = getattr(client, method)(path)
    assert response.status_code == 401


def test_get_account_on_the_shared_home_reports_not_isolated(tmp_path, monkeypatch, ada):
    home = _use_home(monkeypatch, tmp_path / "install-root")
    # A shipped install has LiteLLM on and pointed at AgentX's proxy, which
    # this test has no business reaching. Turn it off explicitly: the subject
    # here is the identity half of the payload, not provisioning.
    _write_litellm_config(home, {"enabled": False})

    with TestClient(_account_app(ada)) as client:
        payload = client.get("/api/account").json()

    assert payload["isolated"] is False
    assert Path(payload["home"]) == home
    # No slug in the path, so it is derived from the verified claims — and it
    # is the same slug the account home would be created under.
    assert payload["account"] == account_slug_for_identity(
        "kc-ada", username="Ada Lovelace", email="ada@corp.test"
    )
    assert payload["email"] == "ada@corp.test"
    assert payload["display_name"] == "Ada Lovelace"
    assert payload["user_id"] == "kc-ada"
    assert payload["provider"] == "keycloak"
    assert payload["litellm"]["status"] == "disabled"


def test_get_account_inside_an_account_home_reports_isolated(tmp_path, monkeypatch, ada):
    root = tmp_path / "install-root"
    slug = account_slug_for_identity(
        "kc-ada", username="Ada Lovelace", email="ada@corp.test"
    )
    home = _use_home(monkeypatch, root / "accounts" / slug)

    with TestClient(_account_app(ada)) as client:
        payload = client.get("/api/account").json()

    assert payload["isolated"] is True
    assert payload["account"] == slug
    assert Path(payload["home"]) == home


def test_provision_with_litellm_disabled_is_a_200_not_an_error(tmp_path, monkeypatch, ada):
    """A LiteLLM that is off (or down) is not a failed sign-in.

    The desktop treats a non-2xx from this route as "sign-in did not complete",
    so provisioning reports its trouble in the body and keeps the status 200.
    """
    home = _use_home(monkeypatch, tmp_path / "install-root")
    _write_litellm_config(home, {"enabled": False})

    with TestClient(_account_app(ada)) as client:
        response = client.post("/api/account/provision")

    assert response.status_code == 200
    body = response.json()
    assert body["litellm"]["status"] == "disabled"
    assert body["litellm"]["ok"] is False


def _provisioning_home(tmp_path, monkeypatch, proxy, session: Session) -> tuple[Path, str]:
    """Put the process inside a real account home wired for direct mode."""
    from hermes_cli.config import save_env_value

    root = tmp_path / "install-root"
    slug = account_slug_for_identity(
        session.user_id,
        username=session.display_name,
        email=session.email,
    )
    home = root / "accounts" / slug
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("AGENTX_HOME", str(home))

    ensure_account_home(
        slug,
        AccountIdentity(
            subject=session.user_id,
            username=session.display_name,
            email=session.email,
            display_name=session.display_name,
            issuer=session.provider,
        ),
    )
    # Written at the INSTALL ROOT, not in the account home: accounts.litellm is
    # operator policy that every account on the machine inherits. A fresh
    # account home has no config.yaml at all, which is exactly why the
    # provisioner reads this section from the root.
    _write_litellm_config(
        root,
        {
            "enabled": True,
            "mode": "direct",
            "base_url": _PROXY_URL,
            "provider_name": "litellm",
            "key_alias_prefix": "agentx-workmate",
            "discover_models": True,
            "request_timeout_seconds": 2,
        },
    )
    save_env_value(ADMIN_KEY_ENV_VAR, _ADMIN_KEY)
    _route_admin_client_to(monkeypatch, proxy)
    return home, slug


def _env_text(home: Path) -> str:
    return (home / ".env").read_text(encoding="utf-8")


def test_provision_direct_mode_lands_the_key_in_the_account_env(
    tmp_path, monkeypatch, proxy, ada
):
    home, slug = _provisioning_home(tmp_path, monkeypatch, proxy, ada)
    alias = f"agentx-workmate-{slug}"

    with TestClient(_account_app(ada)) as client:
        response = client.post("/api/account/provision")

    assert response.status_code == 200
    body = response.json()
    assert body["account"] == slug
    litellm = body["litellm"]
    assert litellm["status"] == "provisioned"
    assert litellm["ok"] is True
    assert litellm["key_alias"] == alias
    # discover_models filled the picker from the proxy rather than leaving it
    # empty, which is what a freshly provisioned account depends on.
    assert set(litellm["models"]) == set(_PROXY_MODELS)

    minted = proxy.key_for(alias)
    key_env = provider_key_env("litellm")
    env_text = _env_text(home)
    assert f"{key_env}={minted}" in env_text
    # The plaintext key belongs in .env only — never echoed back over HTTP.
    assert minted not in json.dumps(body)
    assert litellm["masked_key"].endswith(minted[-4:])

    # ...and the account's config.yaml now points a provider at that env var.
    cfg = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    entry = cfg["providers"]["litellm"]
    assert entry["key_env"] == key_env
    assert entry["base_url"] == f"{_PROXY_URL}/v1"
    assert "api_key" not in entry


def test_provision_is_idempotent_until_rotation_is_asked_for(
    tmp_path, monkeypatch, proxy, ada
):
    home, slug = _provisioning_home(tmp_path, monkeypatch, proxy, ada)
    alias = f"agentx-workmate-{slug}"

    with TestClient(_account_app(ada)) as client:
        first = client.post("/api/account/provision").json()["litellm"]
        again = client.post("/api/account/provision").json()["litellm"]
        minted_after_reuse = len(proxy.minted)
        rotated = client.post(
            "/api/account/provision", json={"rotate": True}
        ).json()["litellm"]

    assert first["status"] == "provisioned"
    # A launch that finds a working key must not mint a second one.
    assert again["status"] == "reused"
    assert minted_after_reuse == 1

    assert rotated["status"] == "rotated"
    assert len(proxy.minted) == 2
    assert len(proxy.records_for(alias)) == 1

    new_key = proxy.key_for(alias)
    assert new_key == proxy.minted[-1]
    assert f"{provider_key_env('litellm')}={new_key}" in _env_text(home)
    assert proxy.minted[0] not in _env_text(home)


def test_provision_ignores_an_account_named_in_the_body(
    tmp_path, monkeypatch, proxy, ada
):
    """Same rule as the broker: the session decides whose account this is."""
    _home, slug = _provisioning_home(tmp_path, monkeypatch, proxy, ada)
    other_slug = account_slug_for_identity(
        "kc-grace", username="grace", email="grace@corp.test"
    )
    assert other_slug != slug

    with TestClient(_account_app(ada)) as client:
        body = client.post(
            "/api/account/provision",
            json={"account": other_slug, "subject": "kc-grace", "slug": other_slug},
        ).json()

    assert body["account"] == slug
    assert body["litellm"]["key_alias"] == f"agentx-workmate-{slug}"
    assert proxy.aliases() == {f"agentx-workmate-{slug}"}


def test_provision_tolerates_a_body_that_is_not_json(tmp_path, monkeypatch, proxy, ada):
    _home, slug = _provisioning_home(tmp_path, monkeypatch, proxy, ada)

    with TestClient(_account_app(ada)) as client:
        response = client.post(
            "/api/account/provision",
            content=b"not json at all",
            headers={"Content-Type": "application/json"},
        )

    assert response.status_code == 200
    assert response.json()["litellm"]["status"] == "provisioned"


def test_get_account_reports_the_key_after_provisioning(
    tmp_path, monkeypatch, proxy, ada
):
    home, slug = _provisioning_home(tmp_path, monkeypatch, proxy, ada)

    with TestClient(_account_app(ada)) as client:
        before = client.get("/api/account").json()["litellm"]
        client.post("/api/account/provision")
        after = client.get("/api/account").json()["litellm"]

    assert before["status"] == "missing"
    assert after["status"] == "reused"
    assert after["key_alias"] == f"agentx-workmate-{slug}"
    assert after["masked_key"].endswith(proxy.key_for(after["key_alias"])[-4:])
    assert Path(home / "litellm-account.json").is_file()
