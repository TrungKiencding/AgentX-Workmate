"""Tests for hermes_cli.litellm_admin and hermes_cli.account_provisioning.

Everything runs against a real account home under ``tmp_path`` and a fake
LiteLLM proxy wired in through ``httpx.MockTransport``. The fake models the
parts of the real proxy that the provisioner's correctness depends on — most
importantly that ``/key/list`` never hands back a key's plaintext, which is
the whole reason rotation is delete-then-mint.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import fields
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
import yaml

from hermes_cli.account_provisioning import (
    ADMIN_KEY_ENV_VAR,
    LiteLLMAccountSettings,
    account_key_status,
    ensure_account_key,
    load_settings,
    provider_key_env,
    read_state,
)
from hermes_cli.accounts import (
    AccountIdentity,
    account_slug_for_identity,
    ensure_account_home,
)
from hermes_cli.config_defaults import DEFAULT_CONFIG
from hermes_cli.litellm_admin import (
    LiteLLMAdminClient,
    LiteLLMError,
    mask_key,
    normalize_base_url,
    openai_base_url,
)

PROXY_URL = "https://litellm.test"
BROKER_URL = "https://broker.test/api/litellm/account-key"
BRAIN_URL = "https://brain.test"

IDENTITY = AccountIdentity(
    subject="8f1c0b2e-keycloak-sub",
    username="kien",
    email="kien@agentx.test",
    display_name="Kien Le",
    issuer="https://kc.test/realms/agentx",
)


# ---------------------------------------------------------------------------
# The fake proxy
# ---------------------------------------------------------------------------


class FakeLiteLLM:
    """An in-memory LiteLLM proxy: virtual keys, aliases, and liveness.

    Faithful on the two points the provisioner is built around: a minted
    key's plaintext is returned exactly once (``/key/generate``) and never
    again (``/key/list`` answers with the hash), and the alias is what makes
    a key findable.
    """

    def __init__(self, catalog=("gpt-4o-mini", "claude-sonnet-4"), modes=None):
        self.admin_key = "sk-admin-master-0000"
        self.catalog = list(catalog)
        # `/model/info` is how a caller tells a chat model from an embedding
        # one; `/v1/models` cannot. Defaulting every catalog entry to "chat"
        # keeps the suites that predate model filtering meaningful — they are
        # about keys, not about modes — while a test that cares passes its own.
        self.modes: dict[str, str] = (
            dict(modes) if modes else {m: "chat" for m in self.catalog}
        )
        self.records: dict[str, dict] = {}
        self.requests: list[tuple[str, str]] = []
        self.fault: str | None = None
        self.transport = httpx.MockTransport(self.handle)

    # -- store ------------------------------------------------------------

    def mint(self, alias: str, models=(), user_id: str = "") -> dict:
        key = f"sk-{uuid4().hex}"
        record = {
            "token": hashlib.sha256(key.encode("utf-8")).hexdigest(),
            "key": key,
            "key_alias": alias,
            "user_id": user_id,
            "models": [str(m) for m in models],
        }
        self.records[record["token"]] = record
        return record

    def records_for_alias(self, alias: str) -> list[dict]:
        return [r for r in self.records.values() if r["key_alias"] == alias]

    def sole_key_for_alias(self, alias: str) -> str:
        found = self.records_for_alias(alias)
        assert len(found) == 1, f"expected one key for {alias}, found {len(found)}"
        return found[0]["key"]

    def holds_token(self, token: str) -> bool:
        return token in self.records

    def key_is_live_for_tests(self, key: str) -> bool:
        """Whether the proxy would still accept this plaintext."""
        return any(record["key"] == key for record in self.records.values())

    def revoke_everything(self) -> None:
        self.records.clear()

    def paths_hit(self, path: str) -> int:
        return sum(1 for _method, hit in self.requests if hit == path)

    # -- transport --------------------------------------------------------

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append((request.method, request.url.path))

        if self.fault == "connect":
            raise httpx.ConnectError("connection refused", request=request)
        if self.fault == "server_error":
            return httpx.Response(500, json={"error": {"message": "internal error"}})

        method, path = request.method, request.url.path
        bearer = (request.headers.get("Authorization") or "").split("Bearer ")[-1].strip()

        if path == "/v1/models":
            known = bearer == self.admin_key or any(
                r["key"] == bearer for r in self.records.values()
            )
            if not known:
                return httpx.Response(
                    401, json={"error": {"message": "Invalid proxy server token passed"}}
                )
            models = self.catalog
            for record in self.records.values():
                if record["key"] == bearer and record["models"]:
                    models = record["models"]
            return httpx.Response(
                200, json={"data": [{"id": m, "object": "model"} for m in models]}
            )

        if bearer != self.admin_key:
            return httpx.Response(
                401, json={"error": {"message": "Authentication Error: admin key required"}}
            )

        if method == "GET" and path == "/model/info":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"model_name": name, "model_info": {"mode": mode}}
                        for name, mode in self.modes.items()
                    ]
                },
            )

        if method == "GET" and path == "/key/list":
            alias = request.url.params.get("key_alias") or ""
            rows = [self._listed(r) for r in self.records_for_alias(alias)]
            return httpx.Response(200, json={"keys": rows, "total_count": len(rows)})

        if method == "POST" and path == "/key/generate":
            body = json.loads(request.content or b"{}")
            record = self.mint(
                str(body.get("key_alias") or ""),
                models=body.get("models") or (),
                user_id=str(body.get("user_id") or ""),
            )
            return httpx.Response(
                200,
                json={
                    "key": record["key"],
                    "token": record["token"],
                    "key_alias": record["key_alias"],
                    "user_id": record["user_id"],
                    "models": record["models"],
                    "expires": None,
                },
            )

        if method == "POST" and path == "/key/delete":
            body = json.loads(request.content or b"{}")
            deleted = [t for t in (body.get("keys") or []) if self.records.pop(t, None)]
            return httpx.Response(200, json={"deleted_keys": deleted})

        return httpx.Response(404, json={"error": {"message": f"no route for {path}"}})

    @staticmethod
    def _listed(record: dict) -> dict:
        # The real proxy cannot return the plaintext, and neither can this.
        row = {k: v for k, v in record.items() if k != "key"}
        row["spend"] = 0.0
        return row


@pytest.fixture()
def fake_proxy() -> FakeLiteLLM:
    return FakeLiteLLM()


def make_client(fake: FakeLiteLLM, *, base_url: str = PROXY_URL, admin_key: str | None = None):
    return LiteLLMAdminClient(
        base_url,
        fake.admin_key if admin_key is None else admin_key,
        transport=fake.transport,
        sleep=lambda _delay: None,
    )


# ---------------------------------------------------------------------------
# Account fixture
# ---------------------------------------------------------------------------


@pytest.fixture()
def account(tmp_path, monkeypatch):
    """A real account home at ``<tmp>/.agentx/accounts/<slug>``, made active."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    root = tmp_path / ".agentx"
    root.mkdir(exist_ok=True)
    monkeypatch.setenv("AGENTX_HOME", str(root))

    slug = account_slug_for_identity(
        IDENTITY.subject, username=IDENTITY.username, email=IDENTITY.email
    )
    home = ensure_account_home(slug, IDENTITY)
    monkeypatch.setenv("AGENTX_HOME", str(home))

    return SimpleNamespace(slug=slug, home=home, root=root, identity=IDENTITY)


def alias_for_account(settings: LiteLLMAccountSettings, account) -> str:
    ident = account.identity
    return settings.alias_for(
        account.slug,
        subject=ident.subject,
        username=ident.username,
        display_name=ident.display_name,
        email=ident.email,
    )


def direct_settings(**overrides) -> LiteLLMAccountSettings:
    base = {
        "enabled": True,
        "mode": "direct",
        "base_url": PROXY_URL,
        # Discovery builds its own un-mocked client; the tests that care about
        # the model list pin it through ``models`` instead.
        "discover_models": False,
    }
    base.update(overrides)
    return LiteLLMAccountSettings(**base)


def broker_settings(**overrides) -> LiteLLMAccountSettings:
    base = {
        "enabled": True,
        "mode": "broker",
        "broker_url": BROKER_URL,
        "base_url": PROXY_URL,
        "discover_models": False,
    }
    base.update(overrides)
    return LiteLLMAccountSettings(**base)


def brain_settings(**overrides) -> LiteLLMAccountSettings:
    base = {
        "enabled": True,
        "mode": "second_brain",
        "second_brain_url": BRAIN_URL,
        "base_url": PROXY_URL,
        "discover_models": False,
    }
    base.update(overrides)
    return LiteLLMAccountSettings(**base)


def env_value(name: str) -> str:
    from hermes_cli.config import load_env

    return load_env().get(name, "")


def raw_config(home: Path) -> dict:
    path = home / "config.yaml"
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text()) or {}


def config_text(home: Path) -> str:
    path = home / "config.yaml"
    return path.read_text() if path.exists() else ""


class ExplodingClient:
    """Stand-in for ``httpx.Client`` that fails the test if anything is sent."""

    def __init__(self, *args, **kwargs):
        raise AssertionError("this code path must not touch the network")


# ===========================================================================
# LiteLLMAdminClient
# ===========================================================================


class TestUrlHelpers:
    @pytest.mark.parametrize(
        "given",
        ["https://litellm.test", "https://litellm.test/", "https://litellm.test/v1",
         "https://litellm.test/v1/"],
    )
    def test_every_form_an_operator_pastes_normalizes_to_the_root(self, given):
        assert normalize_base_url(given) == "https://litellm.test"

    @pytest.mark.parametrize(
        "given",
        ["https://litellm.test", "https://litellm.test/", "https://litellm.test/v1",
         "https://litellm.test/v1/"],
    )
    def test_openai_base_url_appends_exactly_one_v1(self, given):
        result = openai_base_url(given)
        assert result == "https://litellm.test/v1"
        assert result.count("/v1") == 1
        # Feeding the output back in must not stack a second /v1.
        assert openai_base_url(result) == result

    def test_empty_base_url_stays_empty(self):
        assert normalize_base_url("") == ""
        assert openai_base_url("  ") == ""


class TestMaskKey:
    def test_masked_key_leaks_at_most_the_last_four_characters(self):
        secret = "sk-1234567890abcdefWXYZ"
        masked = mask_key(secret)

        assert masked.endswith(secret[-4:])
        assert secret not in masked
        assert secret[:-4] not in masked
        # Everything but the visible tail is gone.
        assert len(masked.replace("sk-…", "")) <= 4

    def test_short_keys_reveal_nothing(self):
        assert "2345" not in mask_key("sk-12345")
        assert mask_key("") == ""


class TestAdminClientConstruction:
    def test_refuses_an_empty_base_url(self, fake_proxy):
        with pytest.raises(LiteLLMError):
            LiteLLMAdminClient("", fake_proxy.admin_key, transport=fake_proxy.transport)

    def test_refuses_an_empty_admin_key(self, fake_proxy):
        with pytest.raises(LiteLLMError):
            LiteLLMAdminClient(PROXY_URL, "   ", transport=fake_proxy.transport)


class TestAdminClientErrors:
    def test_client_error_carries_the_status_and_is_not_unreachable(self, fake_proxy):
        client = make_client(fake_proxy, admin_key="sk-wrong")

        with pytest.raises(LiteLLMError) as excinfo:
            client.keys_for_alias("whoever")

        assert excinfo.value.status_code == 401
        assert excinfo.value.unreachable is False
        # A 4xx is the proxy's answer, not a blip: no retry.
        assert len(fake_proxy.requests) == 1

    def test_connect_error_is_unreachable_with_no_status(self, fake_proxy):
        fake_proxy.fault = "connect"
        client = make_client(fake_proxy)

        with pytest.raises(LiteLLMError) as excinfo:
            client.list_models()

        assert excinfo.value.status_code is None
        assert excinfo.value.unreachable is True

    def test_server_error_is_retried_exactly_once_then_raises(self, fake_proxy):
        fake_proxy.fault = "server_error"
        slept: list[float] = []
        client = LiteLLMAdminClient(
            PROXY_URL,
            fake_proxy.admin_key,
            transport=fake_proxy.transport,
            sleep=slept.append,
        )

        with pytest.raises(LiteLLMError) as excinfo:
            client.list_models()

        assert excinfo.value.status_code == 500
        assert len(fake_proxy.requests) == 2
        assert len(slept) == 1

    def test_a_recovered_proxy_is_not_reported_as_failed(self, fake_proxy):
        fake_proxy.fault = "server_error"

        def recover_after_first(request: httpx.Request) -> httpx.Response:
            fake_proxy.fault = None
            return fake_proxy.handle(request)

        client = LiteLLMAdminClient(
            PROXY_URL,
            fake_proxy.admin_key,
            transport=httpx.MockTransport(recover_after_first),
            sleep=lambda _delay: None,
        )

        assert client.list_models() == list(fake_proxy.catalog)


class TestKeyIsLive:
    def test_a_key_the_proxy_rejects_is_not_live(self, fake_proxy):
        client = make_client(fake_proxy)
        assert client.key_is_live("sk-never-minted") is False

    def test_a_minted_key_is_live(self, fake_proxy):
        record = fake_proxy.mint("some-alias")
        client = make_client(fake_proxy)
        assert client.key_is_live(record["key"]) is True

    def test_an_unreachable_proxy_does_not_read_as_a_revocation(self, fake_proxy):
        record = fake_proxy.mint("some-alias")
        fake_proxy.fault = "connect"
        client = make_client(fake_proxy)

        assert client.key_is_live(record["key"]) is True


class TestKeyLifecycle:
    def test_list_never_returns_the_plaintext_key(self, fake_proxy):
        client = make_client(fake_proxy)
        minted = client.generate_key(key_alias="alias-a", user_id="sub-1")

        listed = client.keys_for_alias("alias-a")

        assert [r.token for r in listed] == [minted.token]
        assert minted.key not in json.dumps([dict(r.raw) for r in listed])

    def test_delete_retires_the_key(self, fake_proxy):
        client = make_client(fake_proxy)
        minted = client.generate_key(key_alias="alias-a")

        assert client.delete_keys([minted.token]) == [minted.token]
        assert client.keys_for_alias("alias-a") == []
        assert client.key_is_live(minted.key) is False

    def test_delete_with_nothing_to_do_makes_no_request(self, fake_proxy):
        client = make_client(fake_proxy)
        assert client.delete_keys([]) == []
        assert fake_proxy.requests == []

    def test_alias_scopes_the_lookup(self, fake_proxy):
        client = make_client(fake_proxy)
        client.generate_key(key_alias="alias-a")
        mine = client.generate_key(key_alias="alias-b")

        assert [r.token for r in client.keys_for_alias("alias-b")] == [mine.token]


# ===========================================================================
# ensure_account_key — direct mode, end to end
# ===========================================================================


class TestDirectProvisioning:
    def test_first_call_writes_the_key_env_config_and_state(self, account, fake_proxy):
        settings = direct_settings(models=("gpt-4o-mini",))
        alias = alias_for_account(settings, account)
        key_env = provider_key_env(settings.provider_name)

        result = ensure_account_key(
            account.identity,
            account.slug,
            settings=settings,
            home=account.home,
            client=make_client(fake_proxy),
        )

        assert result.status == "provisioned"
        assert result.ok is True
        assert result.key_alias == alias

        minted = fake_proxy.sole_key_for_alias(alias)
        assert key_env == "AGENTX_CUSTOM_LITELLM_API_KEY"
        assert env_value(key_env) == minted
        assert minted in (account.home / ".env").read_text()

        entry = raw_config(account.home)["providers"][settings.provider_name]
        assert entry["base_url"] == f"{PROXY_URL}/v1"
        assert entry["key_env"] == key_env
        assert "api_key" not in entry
        assert set(entry.get("models") or {}) == {"gpt-4o-mini"}

        state = read_state(account.home)
        assert state["key_alias"] == alias
        assert state["base_url"] == PROXY_URL
        assert state["key_env"] == key_env
        assert state["account"] == account.slug

    def test_the_plaintext_key_never_lands_in_config_yaml(self, account, fake_proxy):
        settings = direct_settings(default_model="gpt-4o-mini")
        ensure_account_key(
            account.identity,
            account.slug,
            settings=settings,
            home=account.home,
            client=make_client(fake_proxy),
        )

        minted = fake_proxy.sole_key_for_alias(alias_for_account(settings, account))
        assert minted not in config_text(account.home)
        assert minted not in json.dumps(read_state(account.home))

    def test_second_call_reuses_the_same_key(self, account, fake_proxy):
        settings = direct_settings()
        first = ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )
        key_after_first = env_value(provider_key_env(settings.provider_name))

        second = ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )

        assert first.status == "provisioned"
        assert second.status == "reused"
        assert second.ok is True
        assert env_value(provider_key_env(settings.provider_name)) == key_after_first
        assert len(fake_proxy.records_for_alias(alias_for_account(settings, account))) == 1

    def test_force_rotate_mints_a_new_key_and_retires_the_old_one(self, account, fake_proxy):
        settings = direct_settings()
        alias = alias_for_account(settings, account)
        key_env = provider_key_env(settings.provider_name)

        ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )
        old_key = env_value(key_env)
        old_token = read_state(account.home)["token"]

        rotated = ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy), force_rotate=True,
        )

        assert rotated.status == "rotated"
        new_key = env_value(key_env)
        assert new_key != old_key
        assert new_key == fake_proxy.sole_key_for_alias(alias)
        # The old key is gone upstream, not merely forgotten locally.
        assert fake_proxy.holds_token(old_token) is False
        assert read_state(account.home)["token"] != old_token

    def test_a_key_the_proxy_no_longer_accepts_is_re_minted(self, account, fake_proxy):
        settings = direct_settings()
        key_env = provider_key_env(settings.provider_name)

        ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )
        old_key = env_value(key_env)

        # Somebody revoked it in the LiteLLM UI; we still hold the plaintext.
        fake_proxy.revoke_everything()

        result = ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )

        assert result.status == "rotated"
        assert env_value(key_env) != old_key
        assert env_value(key_env) == fake_proxy.sole_key_for_alias(
            alias_for_account(settings, account)
        )

    def test_a_key_this_machine_did_not_mint_is_left_alone(self, account, fake_proxy):
        """The alias is shared by every machine one person signs in on.

        So a key wearing it that this machine has no record of minting is, as
        far as this machine can tell, the key their other laptop is using
        right now. Deleting it is the defect the second brain exists to fix,
        and it used to live on exactly this path: provisioning retired
        everything under the alias before minting, which is why signing in on
        a second machine revoked the first one's key.

        The cost of the fix is an orphan in the proxy that an operator can see
        and remove. The cost of the bug was somebody's other laptop.
        """
        settings = direct_settings()
        alias = alias_for_account(settings, account)
        theirs = fake_proxy.mint(alias, user_id=account.identity.subject)

        result = ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )

        assert result.status == "provisioned"
        assert fake_proxy.holds_token(theirs["token"]) is True
        assert len(fake_proxy.records_for_alias(alias)) == 2

        # And this machine holds the one it just minted, not the other one.
        held = env_value(provider_key_env(settings.provider_name))
        assert held != theirs["key"]
        assert fake_proxy.holds_token(read_state(account.home)["token"])

    def test_the_alias_is_never_looked_up(self, account, fake_proxy):
        # Looking a key up by alias is the first half of delete-by-alias, and
        # nothing on this path has any other use for the answer.
        ensure_account_key(
            account.identity, account.slug, settings=direct_settings(),
            home=account.home, client=make_client(fake_proxy),
        )

        assert fake_proxy.paths_hit("/key/list") == 0

    def test_the_minted_key_is_scoped_to_the_signed_in_subject(self, account, fake_proxy):
        settings = direct_settings()
        ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )

        record = fake_proxy.records_for_alias(alias_for_account(settings, account))[0]
        assert record["user_id"] == account.identity.subject

    def test_two_accounts_on_one_machine_get_two_keys(self, account, fake_proxy, monkeypatch):
        settings = direct_settings()
        ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )
        first_key = env_value(provider_key_env(settings.provider_name))

        other = AccountIdentity(subject="second-sub", username="mai", email="mai@agentx.test")
        other_slug = account_slug_for_identity(
            other.subject, username=other.username, email=other.email
        )
        other_home = ensure_account_home(other_slug, other)
        monkeypatch.setenv("AGENTX_HOME", str(other_home))

        ensure_account_key(
            other, other_slug, settings=settings,
            home=other_home, client=make_client(fake_proxy),
        )
        second_key = env_value(provider_key_env(settings.provider_name))

        assert other_slug != account.slug
        assert second_key != first_key
        assert len(fake_proxy.records_for_alias(alias_for_account(settings, account))) == 1
        assert len(fake_proxy.records_for_alias(
            settings.alias_for(
                other_slug,
                subject=other.subject,
                username=other.username,
                display_name=other.display_name,
                email=other.email,
            )
        )) == 1
        # Each home holds only its own key.
        assert first_key not in (other_home / ".env").read_text()
        assert second_key not in (account.home / ".env").read_text()


# ===========================================================================
# Degradation
# ===========================================================================


class TestDegradation:
    def test_disabled_provisions_nothing(self, account, fake_proxy):
        settings = direct_settings(enabled=False)

        result = ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )

        assert result.status == "disabled"
        assert result.ok is False
        assert fake_proxy.requests == []
        assert env_value(provider_key_env(settings.provider_name)) == ""
        assert "providers" not in raw_config(account.home)
        assert read_state(account.home) == {}

    @pytest.mark.parametrize(
        "settings,names",
        [
            pytest.param(
                brain_settings(second_brain_url=""),
                "accounts.second_brain.base_url",
                id="second-brain-without-a-service-url",
            ),
            pytest.param(
                broker_settings(broker_url=""),
                "accounts.litellm.broker_url",
                id="broker-without-broker-url",
            ),
            pytest.param(
                direct_settings(base_url=""),
                "accounts.litellm.base_url",
                id="direct-without-base-url",
            ),
        ],
    )
    def test_enabled_but_incomplete_config_is_unconfigured(
        self, account, fake_proxy, settings, names
    ):
        result = ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )

        assert result.status == "unconfigured"
        assert result.ok is False
        # Naming the setting is the whole value of this status: a shipped
        # install with no service configured has no model, and the person
        # reading Settings needs to be able to tell an admin what to set.
        assert names in result.detail
        assert fake_proxy.requests == []
        assert env_value(provider_key_env(settings.provider_name)) == ""

    def test_an_unconfigured_second_brain_never_falls_back_to_minting_locally(
        self, account, fake_proxy, monkeypatch
    ):
        # Falling back is how the admin key came to travel inside every
        # installer. An install with no service configured provisions nothing
        # and says so.
        monkeypatch.setenv(ADMIN_KEY_ENV_VAR, fake_proxy.admin_key)

        result = ensure_account_key(
            account.identity, account.slug,
            settings=brain_settings(second_brain_url=""),
            home=account.home, bearer="tok",
        )

        assert result.status == "unconfigured"
        assert fake_proxy.requests == []

    def test_direct_mode_without_an_admin_key_names_the_env_var(self, account, monkeypatch):
        monkeypatch.delenv(ADMIN_KEY_ENV_VAR, raising=False)
        monkeypatch.setattr(httpx, "Client", ExplodingClient)

        result = ensure_account_key(
            account.identity, account.slug, settings=direct_settings(), home=account.home,
        )

        assert result.status == "error"
        assert result.ok is False
        assert ADMIN_KEY_ENV_VAR in result.detail
        assert env_value(provider_key_env("litellm")) == ""

    def test_an_unreachable_proxy_keeps_the_key_this_account_already_has(
        self, account, fake_proxy
    ):
        settings = direct_settings()
        key_env = provider_key_env(settings.provider_name)
        ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )
        existing = env_value(key_env)
        state_before = read_state(account.home)

        fake_proxy.fault = "connect"
        result = ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy), force_rotate=True,
        )

        assert result.status == "offline"
        assert result.ok is False
        assert env_value(key_env) == existing
        assert read_state(account.home) == state_before

    def test_a_proxy_that_answers_an_error_is_reported_as_an_error(self, account, fake_proxy):
        settings = direct_settings()
        result = ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            client=make_client(fake_proxy, admin_key="sk-wrong"),
        )

        assert result.status == "error"
        assert "401" in result.detail
        assert env_value(provider_key_env(settings.provider_name)) == ""


# ===========================================================================
# second_brain mode — the fix for the bug this project exists for
# ===========================================================================


class FakeSecondBrain:
    """A second brain that holds one key per person, like the real one.

    Faithful on the single point every assertion below rests on: the FIRST
    call for a person mints, and every call after it — from any machine —
    returns that same plaintext. That is the behaviour the service's own
    tests pin from the inside; this pins the laptop's half of it.
    """

    def __init__(self, proxy: FakeLiteLLM, base_url: str = PROXY_URL) -> None:
        self.proxy = proxy
        self.base_url = base_url
        self.keys: dict[str, dict] = {}
        self.requests: list[httpx.Request] = []
        self.unreachable = False
        self.revoked_devices: set[str] = set()
        self.status_code = 0
        # What the NEXT issued key is scoped to. The real service answers with
        # the modes an operator allows this person, and that set changes over
        # time — which is the whole reason the laptop has to be able to take a
        # model back out of the picker, not just add to it.
        self.grants: list[str] = []

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def rotate_from_another_device(self, subject: str) -> dict:
        """What one of this person's OTHER machines rotating looks like here.

        Mints a replacement and retires exactly the stored token, which is
        what the service does — so the key this machine holds stops being
        accepted by the proxy, without anything having deleted by alias.
        """
        held = self.keys[subject]
        record = self.proxy.mint(
            LiteLLMAccountSettings().alias_for(subject), user_id=subject
        )
        self.proxy.records.pop(held["token"], None)
        self.keys[subject] = {
            **held,
            "key": record["key"],
            "token": record["token"],
        }
        return self.keys[subject]

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)

        if self.unreachable:
            raise httpx.ConnectError("connection refused", request=request)
        if self.status_code:
            return httpx.Response(
                self.status_code, json={"error": "litellm_unavailable", "detail": "no"}
            )

        device = request.headers.get("X-AgentX-Device") or ""
        if not device:
            return httpx.Response(
                400, json={"error": "device_header_missing", "detail": "no device"}
            )
        if device in self.revoked_devices:
            return httpx.Response(
                403, json={"error": "device_revoked", "detail": "this device is out"}
            )

        bearer = (request.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
        if not bearer:
            return httpx.Response(401, json={"error": "missing_bearer", "detail": "no"})

        # The token decides the person, exactly as the service does it.
        subject = bearer
        body = json.loads(request.content or b"{}")
        held = self.keys.get(subject)

        if held is not None and not body.get("rotate"):
            return httpx.Response(200, json={**held, "status": "reused"})

        alias = LiteLLMAccountSettings().alias_for(subject)
        record = self.proxy.mint(alias, user_id=subject)
        if held is not None:
            # Exactly the previously stored token, and never by alias.
            self.proxy.records.pop(held["token"], None)

        issued = {
            "key": record["key"],
            "token": record["token"],
            "key_alias": alias,
            "base_url": self.base_url,
            "models": list(self.grants),
        }
        self.keys[subject] = issued
        return httpx.Response(
            200, json={**issued, "status": "rotated" if held is not None else "issued"}
        )


@pytest.fixture()
def brain(fake_proxy) -> FakeSecondBrain:
    return FakeSecondBrain(fake_proxy)


class TestSecondBrainMode:
    def test_it_asks_the_service_and_never_the_admin_api(
        self, account, fake_proxy, brain, monkeypatch
    ):
        # An admin key present on the machine must make no difference: this
        # mode never touches the admin API, which is what lets the installer
        # stop shipping one.
        monkeypatch.setenv(ADMIN_KEY_ENV_VAR, fake_proxy.admin_key)
        settings = brain_settings()

        result = ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )

        assert result.status == "provisioned"
        assert result.ok is True
        assert [r.url.path for r in brain.requests] == ["/v1/model-key"]
        assert brain.requests[0].headers["Authorization"] == "Bearer tok"
        assert brain.requests[0].headers["X-AgentX-Device"] == "dev-a"

        # The only proxy traffic is the service's own mint, made through the
        # fake brain — nothing from this machine's admin client.
        assert fake_proxy.paths_hit("/key/list") == 0
        assert fake_proxy.paths_hit("/key/delete") == 0

    def test_the_key_lands_where_everything_downstream_expects_it(
        self, account, brain
    ):
        settings = brain_settings()
        key_env = provider_key_env(settings.provider_name)

        result = ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )

        # Nothing downstream of provisioning changes: same .env credential,
        # same providers: entry, same state sidecar.
        assert env_value(key_env) == brain.keys["tok"]["key"]
        entry = raw_config(account.home)["providers"][settings.provider_name]
        assert entry["key_env"] == key_env
        assert entry["base_url"] == openai_base_url(PROXY_URL)
        assert read_state(account.home)["mode"] == "second_brain"
        assert read_state(account.home)["token"] == brain.keys["tok"]["token"]
        assert result.masked_key == mask_key(env_value(key_env))

    def test_two_machines_signing_in_end_up_with_the_same_key(
        self, tmp_path, monkeypatch, fake_proxy, brain
    ):
        """The acceptance test for the whole project, on the laptop side.

        One person, two installs, in sequence — which is exactly the sequence
        that used to leave the first machine with a revoked key. Both homes
        must hold the same plaintext afterwards, and the proxy must hold
        exactly one key.
        """
        from hermes_cli.config import load_env

        settings = brain_settings()
        key_env = provider_key_env(settings.provider_name)
        held: list[str] = []

        for machine in ("machine-one", "machine-two"):
            root = tmp_path / machine / ".agentx"
            root.mkdir(parents=True)
            monkeypatch.setenv("AGENTX_HOME", str(root))
            slug = account_slug_for_identity(
                IDENTITY.subject, username=IDENTITY.username, email=IDENTITY.email
            )
            home = ensure_account_home(slug, IDENTITY)
            monkeypatch.setenv("AGENTX_HOME", str(home))

            result = ensure_account_key(
                IDENTITY, slug, settings=settings, home=home,
                bearer="tok", device_id=machine, brain_transport=brain.transport,
            )

            assert result.ok is True
            held.append(load_env().get(key_env, ""))

        # The second sign-in neither minted nor revoked anything.
        assert held[0] == held[1]
        assert held[0].startswith("sk-")
        assert len(fake_proxy.records) == 1

    def test_the_second_machine_is_told_it_reused_rather_than_rotated(
        self, account, brain
    ):
        settings = brain_settings()
        ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )

        second = ensure_account_key(
            account.identity, "other-home-same-person", settings=settings,
            home=account.home, bearer="tok", device_id="dev-b",
            brain_transport=brain.transport,
        )

        # Telling somebody their key was replaced when the service simply
        # handed back the one they already had describes the fix as the bug.
        assert second.status == "reused"
        assert second.ok is True

    def test_force_rotate_asks_the_service_to_rotate(self, account, brain, fake_proxy):
        settings = brain_settings()
        first = ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )
        old_token = read_state(account.home)["token"]

        rotated = ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
            force_rotate=True,
        )

        assert rotated.status == "rotated"
        assert rotated.masked_key != first.masked_key
        assert json.loads(brain.requests[-1].content)["rotate"] is True
        assert fake_proxy.holds_token(old_token) is False

    def test_a_key_the_proxy_stopped_accepting_is_collected_not_rotated(
        self, account, brain, fake_proxy
    ):
        """Another machine rotated. This one collects; it does not rotate back.

        Rotating here would take the other machine's brand-new key in turn,
        which is the ping-pong the whole project exists to end. This is the
        self-healing property: the other device is not broken by a rotation,
        it is one call behind it.
        """
        settings = brain_settings()
        key_env = provider_key_env(settings.provider_name)
        ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
            client=make_client(fake_proxy),
        )
        stale = env_value(key_env)

        replacement = brain.rotate_from_another_device("tok")
        assert fake_proxy.key_is_live_for_tests(stale) is False

        result = ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
            client=make_client(fake_proxy),
        )

        assert result.status == "reused"
        assert json.loads(brain.requests[-1].content)["rotate"] is False
        assert env_value(key_env) == replacement["key"]
        assert env_value(key_env) != stale

    def test_an_unreachable_service_keeps_the_key_this_machine_holds(
        self, account, brain
    ):
        settings = brain_settings()
        key_env = provider_key_env(settings.provider_name)
        ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )
        held = env_value(key_env)

        brain.unreachable = True
        result = ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
            force_rotate=True,
        )

        # Unreachable is never a revocation. A person who opens their laptop
        # on a train still has their agent.
        assert result.status == "offline"
        assert result.ok is False
        assert env_value(key_env) == held

    @pytest.mark.parametrize("status_code", [502, 503])
    def test_a_service_that_cannot_reach_litellm_reads_as_offline(
        self, account, brain, status_code
    ):
        brain.status_code = status_code

        result = ensure_account_key(
            account.identity, account.slug, settings=brain_settings(),
            home=account.home, bearer="tok", device_id="dev-a",
            brain_transport=brain.transport,
        )

        # Nothing was minted and nothing was lost. From this machine that is
        # indistinguishable from an outage, and must be treated as one.
        assert result.status == "offline"
        assert env_value(provider_key_env("litellm")) == ""

    def test_a_revoked_device_is_told_to_sign_in_again(self, account, brain):
        settings = brain_settings()
        key_env = provider_key_env(settings.provider_name)
        ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )
        held = env_value(key_env)

        brain.revoked_devices.add("dev-a")
        result = ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
            force_rotate=True,
        )

        # Not "offline" and not "error": the one failure the app must act on
        # by re-authenticating rather than by waiting.
        assert result.status == "revoked"
        assert result.ok is False
        assert "sign in again" in result.detail.lower()
        # The key on disk is not the problem, and is left alone.
        assert env_value(key_env) == held

    def test_an_empty_bearer_never_reads_as_success(self, account, brain):
        result = ensure_account_key(
            account.identity, account.slug, settings=brain_settings(),
            home=account.home, bearer="", device_id="dev-a",
            brain_transport=brain.transport,
        )

        assert result.status == "error"
        assert brain.requests == []
        assert env_value(provider_key_env("litellm")) == ""

    def test_a_service_that_returns_no_key_is_an_error(self, account):
        transport, _seen = broker_transport(
            lambda _r: httpx.Response(200, json={"status": "issued"})
        )

        result = ensure_account_key(
            account.identity, account.slug, settings=brain_settings(),
            home=account.home, bearer="tok", device_id="dev-a",
            brain_transport=transport,
        )

        assert result.status == "error"
        assert env_value(provider_key_env("litellm")) == ""

    def test_a_backend_with_no_device_header_names_itself(
        self, account, brain, tmp_path, monkeypatch
    ):
        """A CLI sign-in has no desktop above it and so no device header.

        The service refuses a request that will not name its machine, so the
        backend keeps an id of its own at the install root — one per install,
        shared by every account on it, exactly like the desktop's.
        """
        from hermes_cli.second_brain_client import DEVICE_FILENAME

        root = tmp_path / ".agentx"
        monkeypatch.setattr(
            "hermes_constants.get_default_hermes_root", lambda: root
        )

        result = ensure_account_key(
            account.identity, account.slug, settings=brain_settings(),
            home=account.home, bearer="tok", brain_transport=brain.transport,
        )

        assert result.ok is True
        sent = brain.requests[0].headers["X-AgentX-Device"]
        assert sent
        assert json.loads((root / DEVICE_FILENAME).read_text())["id"] == sent

        # And it is stable: a second sign-in is the same machine, not a
        # second row in somebody's device list.
        ensure_account_key(
            account.identity, account.slug, settings=brain_settings(),
            home=account.home, bearer="tok", brain_transport=brain.transport,
            force_rotate=True,
        )
        assert brain.requests[-1].headers["X-AgentX-Device"] == sent


# ===========================================================================
# Broker mode
# ===========================================================================


def broker_transport(responder) -> tuple[httpx.MockTransport, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return responder(request)

    return httpx.MockTransport(handler), seen


class TestUpgradingOntoTheSecondBrain:
    """What an install that predates the second brain has to do on next launch.

    This is the shape the bug arrived in. A machine that had provisioned under
    the old ``direct``/``broker`` modes still held a live key, so the reuse
    rung — which only ever compared the alias — matched on every launch and the
    service was never asked. Sign-in worked, nothing looked broken, and the
    person simply never got the key their other machines share, while the model
    picker kept offering whatever the old key had reached.
    """

    def test_a_key_minted_before_the_brain_existed_is_collected_from_it(
        self, account, fake_proxy, brain, monkeypatch
    ):
        monkeypatch.setenv(ADMIN_KEY_ENV_VAR, fake_proxy.admin_key)

        # Provision the way this machine used to: locally, against the admin API.
        old = ensure_account_key(
            account.identity, account.slug,
            settings=direct_settings(), home=account.home,
            client=make_client(fake_proxy),
        )
        assert old.status == "provisioned"
        assert read_state(account.home)["mode"] == "direct"
        key_env = provider_key_env("litellm")
        local_key = env_value(key_env)

        # The install updates and now ships mode: second_brain. The old key is
        # still perfectly live at the proxy, which is exactly why the reuse rung
        # used to keep it forever.
        assert make_client(fake_proxy).key_is_live(local_key)

        result = ensure_account_key(
            account.identity, account.slug,
            settings=brain_settings(), home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )

        assert result.ok is True
        assert [r.url.path for r in brain.requests] == ["/v1/model-key"]
        assert env_value(key_env) == brain.keys["tok"]["key"]
        assert env_value(key_env) != local_key
        assert read_state(account.home)["mode"] == "second_brain"

    def test_the_reason_says_the_key_predates_the_brain(self, account, fake_proxy, brain, monkeypatch):
        monkeypatch.setenv(ADMIN_KEY_ENV_VAR, fake_proxy.admin_key)
        ensure_account_key(
            account.identity, account.slug,
            settings=direct_settings(), home=account.home,
            client=make_client(fake_proxy),
        )

        result = ensure_account_key(
            account.identity, account.slug,
            settings=brain_settings(), home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )

        # Settings renders this. "the proxy no longer accepts the stored key"
        # would have been a lie — the proxy accepts it fine.
        assert "predates the second brain" in result.detail

    def test_a_sidecar_written_before_the_mode_field_existed_is_also_collected(
        self, account, brain
    ):
        from hermes_cli.account_provisioning import write_state

        settings = brain_settings()
        ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )

        # An older AgentX recorded no mode at all. Absent must read as "not
        # ours", not as "close enough" — a machine that upgraded twice would
        # otherwise stay stuck on a local key with no way out.
        state = read_state(account.home)
        state.pop("mode")
        write_state(account.home, state)
        brain.requests.clear()

        result = ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )

        assert result.ok is True
        assert [r.url.path for r in brain.requests] == ["/v1/model-key"]
        assert read_state(account.home)["mode"] == "second_brain"

    def test_a_key_the_brain_issued_is_still_reused_without_asking_again(
        self, account, brain
    ):
        """The common path must stay free. Re-checking the mode on every launch
        is only worth it if it costs nothing when nothing has changed."""
        settings = brain_settings()
        ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )
        brain.requests.clear()

        result = ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )

        assert result.status == "reused"
        assert brain.requests == []

    def test_a_deprecated_mode_never_re_mints_over_a_brain_issued_key(
        self, account, fake_proxy, brain, monkeypatch
    ):
        """Downgrading is not a reason to burn a working key.

        ``direct`` mints by deleting first, so treating a brain-issued key as
        unusable there would retire a key this person's other machines are
        still holding — the exact ping-pong the second brain exists to end.
        """
        monkeypatch.setenv(ADMIN_KEY_ENV_VAR, fake_proxy.admin_key)
        ensure_account_key(
            account.identity, account.slug, settings=brain_settings(),
            home=account.home, bearer="tok", device_id="dev-a",
            brain_transport=brain.transport,
        )
        key_env = provider_key_env("litellm")
        brain_key = env_value(key_env)

        result = ensure_account_key(
            account.identity, account.slug,
            settings=direct_settings(), home=account.home,
            client=make_client(fake_proxy),
        )

        assert result.status == "reused"
        assert env_value(key_env) == brain_key
        assert fake_proxy.paths_hit("/key/delete") == 0


class TestModelListFollowsTheKey:
    """The picker must be able to shrink, not only grow.

    ``providers.<name>.models`` was merged into and never pruned, so a key
    replaced by one scoped to fewer models left every id the OLD key reached
    sitting in the picker. Choosing one of those got the user a refusal from
    the proxy naming a model they were plainly being offered.
    """

    def test_ids_the_new_key_cannot_reach_are_taken_back_out(self, account, brain):
        settings = brain_settings()
        brain.grants = ["chat-a", "chat-b"]
        ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )
        assert set(raw_config(account.home)["providers"]["litellm"]["models"]) == {
            "chat-a", "chat-b",
        }

        brain.grants = ["chat-a", "chat-c"]
        ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", force_rotate=True,
            brain_transport=brain.transport,
        )

        assert set(raw_config(account.home)["providers"]["litellm"]["models"]) == {
            "chat-a", "chat-c",
        }

    def test_a_model_the_user_added_by_hand_is_never_pruned(self, account, brain):
        from hermes_cli.config import load_config, save_config

        settings = brain_settings()
        brain.grants = ["chat-a"]
        ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )

        cfg = load_config()
        cfg["providers"]["litellm"]["models"]["my-own-model"] = {"context_window": 8000}
        save_config(cfg, merge_existing=True)

        brain.grants = ["chat-b"]
        ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", force_rotate=True,
            brain_transport=brain.transport,
        )

        models = raw_config(account.home)["providers"]["litellm"]["models"]
        assert set(models) == {"chat-b", "my-own-model"}
        # And their settings on it survived the round trip.
        assert models["my-own-model"] == {"context_window": 8000}

    def test_a_default_we_pinned_is_re_pinned_when_the_key_loses_it(self, account, brain):
        settings = brain_settings()
        brain.grants = ["chat-x", "chat-y"]
        ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )
        assert raw_config(account.home)["model"]["default"] == "chat-x"

        brain.grants = ["chat-y"]
        ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", force_rotate=True,
            brain_transport=brain.transport,
        )

        # Leaving chat-x pinned would open the app on a model group this key is
        # refused for, on every launch, and the error would name chat-x rather
        # than the stale pin that chose it.
        assert raw_config(account.home)["model"]["default"] == "chat-y"

    def test_a_default_the_user_chose_is_left_alone_even_when_it_goes_away(
        self, account, brain
    ):
        from hermes_cli.config import load_config, save_config

        settings = brain_settings()
        brain.grants = ["chat-a"]
        ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", brain_transport=brain.transport,
        )

        cfg = load_config()
        cfg["model"]["default"] = "something-i-picked"
        save_config(cfg, merge_existing=True)

        brain.grants = ["chat-b"]
        ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", device_id="dev-a", force_rotate=True,
            brain_transport=brain.transport,
        )

        # We only ever take back a pin we made ourselves.
        assert raw_config(account.home)["model"]["default"] == "something-i-picked"


class TestBrokerMode:
    def test_posts_the_bearer_and_writes_the_key_the_broker_returns(
        self, account, fake_proxy
    ):
        settings = broker_settings(base_url="https://stale-local.test")
        alias = alias_for_account(settings, account)
        minted = fake_proxy.mint(alias)

        transport, seen = broker_transport(
            lambda _r: httpx.Response(
                200,
                json={
                    "key": minted["key"],
                    "token": minted["token"],
                    "key_alias": alias,
                    "models": [],
                    "base_url": "https://moved-proxy.test/v1",
                },
            )
        )

        result = ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", broker_transport=transport,
        )

        assert result.status == "provisioned"
        assert [str(r.url) for r in seen] == [BROKER_URL]
        assert seen[0].headers["Authorization"] == "Bearer tok"
        assert json.loads(seen[0].content)["account"] == alias

        # The broker is the authority on where LiteLLM lives.
        assert result.base_url == "https://moved-proxy.test"
        entry = raw_config(account.home)["providers"][settings.provider_name]
        assert entry["base_url"] == "https://moved-proxy.test/v1"
        assert env_value(provider_key_env(settings.provider_name)) == minted["key"]
        assert read_state(account.home)["base_url"] == "https://moved-proxy.test"
        assert read_state(account.home)["mode"] == "broker"

    def test_a_broker_that_omits_a_base_url_leaves_the_local_one_in_place(
        self, account, fake_proxy
    ):
        settings = broker_settings()
        minted = fake_proxy.mint(alias_for_account(settings, account))
        transport, _seen = broker_transport(
            lambda _r: httpx.Response(200, json={"key": minted["key"], "token": minted["token"]})
        )

        result = ensure_account_key(
            account.identity, account.slug, settings=settings, home=account.home,
            bearer="tok", broker_transport=transport,
        )

        assert result.status == "provisioned"
        assert result.base_url == PROXY_URL

    def test_a_rejected_sign_in_is_an_error(self, account):
        transport, seen = broker_transport(
            lambda _r: httpx.Response(401, json={"detail": "token expired"})
        )

        result = ensure_account_key(
            account.identity, account.slug, settings=broker_settings(), home=account.home,
            bearer="stale", broker_transport=transport,
        )

        assert result.status == "error"
        assert result.ok is False
        assert len(seen) == 1
        assert env_value(provider_key_env("litellm")) == ""

    def test_a_broker_that_returns_no_key_is_an_error(self, account):
        transport, _seen = broker_transport(lambda _r: httpx.Response(200, json={"ok": True}))

        result = ensure_account_key(
            account.identity, account.slug, settings=broker_settings(), home=account.home,
            bearer="tok", broker_transport=transport,
        )

        assert result.status == "error"
        assert env_value(provider_key_env("litellm")) == ""

    def test_an_empty_bearer_never_reads_as_success(self, account):
        transport, seen = broker_transport(
            lambda _r: httpx.Response(200, json={"key": "sk-should-never-be-asked-for"})
        )

        result = ensure_account_key(
            account.identity, account.slug, settings=broker_settings(), home=account.home,
            bearer="", broker_transport=transport,
        )

        assert result.status == "error"
        assert result.ok is False
        assert seen == []
        assert env_value(provider_key_env("litellm")) == ""

    def test_an_unreachable_broker_is_an_error_not_a_silent_success(self, account):
        def refuse(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route to host", request=request)

        transport, _seen = broker_transport(refuse)

        result = ensure_account_key(
            account.identity, account.slug, settings=broker_settings(), home=account.home,
            bearer="tok", broker_transport=transport,
        )

        assert result.ok is False
        assert env_value(provider_key_env("litellm")) == ""


# ===========================================================================
# account_key_status
# ===========================================================================


class TestAccountKeyStatus:
    def test_missing_before_provisioning_and_offline_safe(self, account, monkeypatch):
        monkeypatch.setattr(httpx, "Client", ExplodingClient)

        result = account_key_status(
            account.slug, settings=direct_settings(), home=account.home
        )

        assert result.status == "missing"
        assert result.ok is False
        assert result.masked_key == ""

    def test_reports_the_provisioned_key_without_asking_the_proxy(
        self, account, fake_proxy, monkeypatch
    ):
        settings = direct_settings()
        ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )
        minted = env_value(provider_key_env(settings.provider_name))
        requests_before = len(fake_proxy.requests)

        monkeypatch.setattr(httpx, "Client", ExplodingClient)
        result = account_key_status(account.slug, settings=settings, home=account.home)

        assert result.status == "reused"
        assert result.key_alias == alias_for_account(settings, account)
        assert result.base_url == PROXY_URL
        assert result.masked_key == mask_key(minted)
        assert minted not in result.masked_key
        assert len(fake_proxy.requests) == requests_before

    def test_disabled_reports_disabled(self, account, monkeypatch):
        monkeypatch.setattr(httpx, "Client", ExplodingClient)
        result = account_key_status(
            account.slug, settings=direct_settings(enabled=False), home=account.home
        )
        assert result.status == "disabled"

    def test_to_json_is_serializable_and_carries_the_verdict(self, account, monkeypatch):
        monkeypatch.setattr(httpx, "Client", ExplodingClient)
        result = account_key_status(
            account.slug, settings=direct_settings(), home=account.home
        )
        payload = json.loads(json.dumps(result.to_json()))

        assert payload["status"] == result.status
        assert payload["ok"] is result.ok
        assert isinstance(payload["models"], list)


# ===========================================================================
# Config plumbing
# ===========================================================================


class TestLoadSettings:
    def test_every_shipped_default_is_surfaced(self):
        """No key can be added to DEFAULT_CONFIG and silently ignored here."""
        section = DEFAULT_CONFIG["accounts"]["litellm"]
        from_defaults = load_settings({"accounts": {"litellm": dict(section)}})

        known = {f.name for f in fields(LiteLLMAccountSettings)}
        for key, value in section.items():
            assert key in known, f"accounts.litellm.{key} is not surfaced by load_settings"
            expected = tuple(value) if isinstance(value, list) else value
            assert getattr(from_defaults, key) == expected

    def test_an_empty_config_is_off_even_though_the_product_ships_on(self):
        """The dataclass defaults are the conservative ones, deliberately.

        ``DEFAULT_CONFIG`` points a shipped install at AgentX's own proxy, but
        ``load_settings`` is also called with whatever a caller hands it, and a
        caller with nothing to say must not end up minting keys against a
        production proxy. Production always passes the merged config, so the
        two never disagree in practice — see ``test_deployment_defaults.py``.
        """
        assert load_settings({}) == LiteLLMAccountSettings()
        assert LiteLLMAccountSettings().enabled is False
        assert LiteLLMAccountSettings().base_url == ""
        assert DEFAULT_CONFIG["accounts"]["litellm"]["enabled"] is True

    def test_a_non_dict_section_falls_back_to_defaults(self):
        assert load_settings({"accounts": {"litellm": "yes please"}}) == LiteLLMAccountSettings()
        assert load_settings({"accounts": None}) == LiteLLMAccountSettings()
        assert load_settings({"accounts": {"litellm": []}}) == LiteLLMAccountSettings()

    def test_a_bad_mode_falls_back_to_the_safe_one(self):
        settings = load_settings({"accounts": {"litellm": {"mode": "yolo"}}})

        # The safe one is the mode that needs no credential on the machine and
        # cannot delete a key another of this person's devices is using.
        assert settings.mode == "second_brain"

    def test_mode_is_case_insensitive(self):
        assert load_settings({"accounts": {"litellm": {"mode": "Direct"}}}).mode == "direct"
        assert (
            load_settings({"accounts": {"litellm": {"mode": "Second_Brain"}}}).mode
            == "second_brain"
        )

    def test_values_are_coerced_and_the_base_url_normalized(self):
        settings = load_settings(
            {
                "accounts": {
                    "litellm": {
                        "enabled": True,
                        "base_url": "https://litellm.test/v1/",
                        "mode": "direct",
                        "models": ["a", "  ", "b"],
                        "tpm_limit": "500",
                        "max_budget": "12.5",
                        "request_timeout_seconds": 0,
                    }
                }
            }
        )

        assert settings.base_url == "https://litellm.test"
        assert settings.models == ("a", "b")
        assert settings.tpm_limit == 500
        assert settings.max_budget == 12.5
        # A zero timeout would mean "give up instantly"; fall back instead.
        assert settings.request_timeout_seconds > 0
        assert settings.configured is True

    def test_garbage_numbers_do_not_blow_up(self):
        settings = load_settings({"accounts": {"litellm": {"tpm_limit": "lots"}}})
        assert settings.tpm_limit == 0

    def test_configured_tracks_the_field_the_mode_actually_needs(self):
        assert LiteLLMAccountSettings(enabled=True, mode="broker", base_url=PROXY_URL).configured is False
        assert LiteLLMAccountSettings(enabled=True, mode="broker", broker_url=BROKER_URL).configured is True
        assert LiteLLMAccountSettings(enabled=True, mode="direct", broker_url=BROKER_URL).configured is False
        assert LiteLLMAccountSettings(enabled=True, mode="direct", base_url=PROXY_URL).configured is True
        assert LiteLLMAccountSettings(enabled=False, mode="direct", base_url=PROXY_URL).configured is False

    def test_the_alias_is_per_account(self):
        settings = LiteLLMAccountSettings(key_alias_prefix="acme")
        kien = settings.alias_for(
            subject="sub-kien", username="Kien Le", display_name="Kien Le"
        )
        mai = settings.alias_for(
            subject="sub-mai", username="Mai Tran", display_name="Mai Tran"
        )
        assert kien == "acme-kienle"
        assert kien != mai

    def test_settings_come_from_the_machine_config_not_the_accounts_own(self, account):
        """``accounts.litellm`` is operator policy, read at the install root.

        An account home is created at sign-in with no config.yaml of its own,
        so reading the section from there would come back empty and nothing
        would ever be provisioned on a real install. The operator writes it
        once per machine and every account inherits it.
        """
        (account.root / "config.yaml").write_text(
            yaml.safe_dump(
                {
                    "accounts": {
                        "litellm": {
                            "enabled": True,
                            "mode": "direct",
                            "base_url": PROXY_URL,
                            "provider_name": "workmate-proxy",
                        }
                    }
                }
            ),
            encoding="utf-8",
        )
        assert not (account.home / "config.yaml").exists()

        settings = load_settings()

        assert settings.enabled is True
        assert settings.mode == "direct"
        assert settings.base_url == PROXY_URL
        assert settings.provider_name == "workmate-proxy"

    def test_the_admin_key_falls_back_to_the_machine_env(self, account, monkeypatch):
        """Direct mode's admin key lives in the install root's .env.

        It is written before anybody has an account home to write it into, so
        without this fallback direct mode would only ever work in the shared
        home — which is to say, never on a machine that has accounts.
        """
        from hermes_cli.account_provisioning import ADMIN_KEY_ENV_VAR, _admin_key

        # An inherited shell export outranks both files by design, so clear it
        # or this asserts nothing about the file fallback.
        monkeypatch.delenv(ADMIN_KEY_ENV_VAR, raising=False)

        (account.root / ".env").write_text(
            f"{ADMIN_KEY_ENV_VAR}=sk-machine-admin\n", encoding="utf-8"
        )
        assert ADMIN_KEY_ENV_VAR not in (account.home / ".env").read_text(encoding="utf-8")

        assert _admin_key() == "sk-machine-admin"


# ===========================================================================
# Default-model pinning
# ===========================================================================


class TestDefaultModelPinning:
    def test_pinned_when_the_user_has_not_chosen(self, account, fake_proxy):
        settings = direct_settings(default_model="gpt-4o-mini")

        ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )

        model_cfg = raw_config(account.home)["model"]
        assert model_cfg["default"] == "gpt-4o-mini"
        assert model_cfg["provider"] == settings.provider_name
        assert model_cfg["key_env"] == provider_key_env(settings.provider_name)
        assert "api_key" not in model_cfg

    def test_a_model_the_user_already_chose_survives_provisioning(self, account, fake_proxy):
        (account.home / "config.yaml").write_text(
            yaml.safe_dump({"model": {"default": "my-own-model", "provider": "openai"}}),
            encoding="utf-8",
        )
        settings = direct_settings(default_model="gpt-4o-mini")

        ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )

        model_cfg = raw_config(account.home)["model"]
        assert model_cfg["default"] == "my-own-model"
        assert model_cfg["provider"] == "openai"
        # The provider entry is still wired up — only the choice was left alone.
        assert raw_config(account.home)["providers"][settings.provider_name]["key_env"] == (
            provider_key_env(settings.provider_name)
        )

    def test_no_default_model_leaves_model_selection_untouched(self, account, fake_proxy):
        settings = direct_settings()

        ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )

        assert "model" not in raw_config(account.home)

    def test_a_hand_written_provider_block_is_merged_not_rebuilt(self, account, fake_proxy):
        (account.home / "config.yaml").write_text(
            yaml.safe_dump(
                {
                    "providers": {
                        "litellm": {
                            "extra_headers": {"X-Team": "platform"},
                            "enabled": False,
                        }
                    }
                }
            ),
            encoding="utf-8",
        )
        settings = direct_settings()

        ensure_account_key(
            account.identity, account.slug, settings=settings,
            home=account.home, client=make_client(fake_proxy),
        )

        entry = raw_config(account.home)["providers"]["litellm"]
        assert entry["extra_headers"] == {"X-Team": "platform"}
        assert entry["enabled"] is False
        assert entry["base_url"] == f"{PROXY_URL}/v1"
