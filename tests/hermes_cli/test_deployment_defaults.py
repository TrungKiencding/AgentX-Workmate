"""What a machine that has never been configured gets.

AgentX Workmate is installed from a signed artifact onto an employee's laptop.
That machine has no ``~/.agentx``, no ``.env``, and nobody to run a setup
command on it, so everything the first launch needs has to already be in the
build. When it wasn't, the failure was silent in the worst way: the app
installed, launched, and worked — as an *ungated* install with no model. It
looked exactly like a correct one.

These tests are the pin on that. Each of them asks the same question — what
does a clean home resolve to? — of the settings a first launch depends on.

The escape hatches are pinned too, in both directions. A default that cannot
be turned off is a different kind of bug: a developer working against a realm
they cannot reach has to be able to say so.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from hermes_cli import web_server
from hermes_cli.account_provisioning import load_settings
from hermes_cli.config import load_config, load_env
from hermes_cli.config_defaults import (
    DEFAULT_CONFIG,
    DEPLOYMENT_KEYCLOAK_BASE_URL,
    DEPLOYMENT_KEYCLOAK_CLIENT_ID,
    DEPLOYMENT_KEYCLOAK_REALM,
    DEPLOYMENT_LITELLM_BASE_URL,
    DEPLOYMENT_LITELLM_DEFAULT_MODEL,
)

REPO_ROOT = Path(__file__).resolve().parents[2]

#: Every ``AGENTX_DASHBOARD_KEYCLOAK_*`` name the resolver consults. Exported
#: from the env of whoever runs the suite, any one of them would mask the
#: question these tests are asking.
_KEYCLOAK_ENV_VARS = (
    "AGENTX_DASHBOARD_KEYCLOAK_ISSUER",
    "AGENTX_DASHBOARD_KEYCLOAK_BASE_URL",
    "AGENTX_DASHBOARD_KEYCLOAK_REALM",
    "AGENTX_DASHBOARD_KEYCLOAK_CLIENT_ID",
)


@pytest.fixture()
def fresh_machine(tmp_path, monkeypatch) -> Path:
    """A home with nothing in it, and an environment that says nothing.

    This is the state a laptop is in the moment the installer finishes: the
    directory does not exist yet, and the only configuration in play is
    whatever shipped inside the build.
    """
    home = tmp_path / ".agentx"
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("AGENTX_HOME", str(home))
    monkeypatch.delenv("AGENTX_DASHBOARD_REQUIRE_AUTH", raising=False)

    for key in _KEYCLOAK_ENV_VARS:
        monkeypatch.delenv(key, raising=False)

    return home


# ---------------------------------------------------------------------------
# Sign-in
# ---------------------------------------------------------------------------


class TestTheGateIsOnOutOfTheBox:
    def test_a_fresh_install_requires_sign_in_on_loopback(self, fresh_machine):
        """The regression this whole change exists to prevent.

        The desktop app only puts a sign-in screen in front of the user when
        its backend answers that it is gated. Before the deployment defaults
        shipped, a machine that had never run ``agentx dashboard keycloak``
        answered "open", and the app went straight in.
        """
        assert web_server.should_require_auth("127.0.0.1") is True
        assert web_server.should_require_auth("localhost") is True
        assert web_server.should_require_auth("::1") is True

    def test_the_gate_is_on_because_a_provider_is_configured(self, fresh_machine):
        """Not because require_auth is forced — the auto rung is what fires."""
        assert web_server._identity_provider_is_configured() is True
        assert DEFAULT_CONFIG["dashboard"]["require_auth"] is None

    def test_the_shipped_client_satisfies_the_plugin_precondition(self, fresh_machine):
        """base_url + realm + client_id, or the plugin stays a no-op."""
        keycloak = load_config()["dashboard"]["oauth"]["keycloak"]

        assert keycloak["base_url"] == DEPLOYMENT_KEYCLOAK_BASE_URL
        assert keycloak["realm"] == DEPLOYMENT_KEYCLOAK_REALM
        assert keycloak["client_id"] == DEPLOYMENT_KEYCLOAK_CLIENT_ID
        assert all(keycloak[key] for key in ("base_url", "realm", "client_id"))

    def test_the_shipped_client_stays_public(self, fresh_machine):
        """A client_secret would stop the desktop running its own sign-in.

        The desktop's OIDC flow is authorization-code + PKCE against a public
        client, because a binary on someone's laptop cannot hold a secret. A
        secret set here silently moves sign-in to the gateway-brokered path,
        whose redirect URI changes every launch and is registered nowhere.
        """
        assert load_config()["dashboard"]["oauth"]["keycloak"]["client_secret"] == ""


class TestTheInstallerTemplateDoesNotUndoAnyOfIt:
    """``install.sh`` copies ``cli-config.yaml.example`` onto a fresh machine.

    That file is a documentation artefact with a handful of live keys, and it
    lands at ``~/.agentx/config.yaml`` — where it wins over ``DEFAULT_CONFIG``
    on every key it defines. Uncommenting the ``dashboard:`` or ``accounts:``
    block in it, for illustration, would ungate every future install and point
    it at no proxy. Nothing about the running app would say so.
    """

    @pytest.fixture()
    def installed_machine(self, fresh_machine) -> Path:
        fresh_machine.mkdir(parents=True, exist_ok=True)
        (fresh_machine / "config.yaml").write_text(
            (REPO_ROOT / "cli-config.yaml.example").read_text(encoding="utf-8"),
            encoding="utf-8",
        )

        return fresh_machine

    def test_the_gate_survives_the_template(self, installed_machine):
        assert web_server.should_require_auth("127.0.0.1") is True

    def test_the_proxy_survives_the_template(self, installed_machine):
        settings = load_settings(load_config())

        assert settings.enabled is True
        assert settings.base_url == DEPLOYMENT_LITELLM_BASE_URL
        assert settings.default_model == DEPLOYMENT_LITELLM_DEFAULT_MODEL


class TestTheEscapeHatchesStillWork:
    def test_the_env_var_turns_it_off(self, fresh_machine, monkeypatch):
        monkeypatch.setenv("AGENTX_DASHBOARD_REQUIRE_AUTH", "0")

        assert web_server.should_require_auth("127.0.0.1") is False

    def test_config_turns_it_off(self, fresh_machine, monkeypatch):
        monkeypatch.setattr(
            "hermes_cli.config.load_config",
            lambda: {"dashboard": {"require_auth": False}},
        )

        assert web_server.should_require_auth("127.0.0.1") is False

    def test_neither_can_open_a_public_bind(self, fresh_machine, monkeypatch):
        """Turning the loopback gate off must not unlock 0.0.0.0."""
        monkeypatch.setenv("AGENTX_DASHBOARD_REQUIRE_AUTH", "0")

        assert web_server.should_require_auth("0.0.0.0") is True
        assert web_server.should_require_auth("192.168.1.5") is True


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class TestModelsWorkOutOfTheBox:
    def test_a_fresh_install_provisions_against_the_agentx_proxy(self, fresh_machine):
        settings = load_settings(load_config())

        assert settings.enabled is True
        assert settings.base_url == DEPLOYMENT_LITELLM_BASE_URL
        assert settings.default_model == DEPLOYMENT_LITELLM_DEFAULT_MODEL

    def test_it_ships_asking_the_second_brain_for_its_key(self, fresh_machine):
        """The shipped mode is the one that needs no secret on the laptop.

        ``second_brain`` mints once per person and hands the same key to every
        machine they sign in on. The other two mint per machine, which is the
        fault the service was built to end, and ``direct`` additionally needs
        an admin credential on the laptop.
        """
        settings = load_settings(load_config())

        assert settings.mode == "second_brain"
        assert settings.broker_url == ""

    def test_no_credential_is_needed_or_carried_for_the_shipped_mode(self, fresh_machine):
        """Nothing secret reaches a laptop, from here or from the installer.

        This repository is public, and the desktop package no longer carries a
        ``deployment.json`` — the mechanism that used to inject the LiteLLM
        admin key into every build was removed with the key vault. If a value
        has to reach laptops, it goes behind the service.
        """
        source = (REPO_ROOT / "hermes_cli" / "config_defaults.py").read_text(encoding="utf-8")

        assert "AGENTX_LITELLM_ADMIN_KEY" in source, "the env var should still be documented"
        assert not re.search(r"\bsk-[A-Za-z0-9_-]{12,}", source), (
            "something shaped like a LiteLLM key was pasted into config_defaults.py"
        )

        assert load_env().get("AGENTX_LITELLM_ADMIN_KEY") is None

        desktop = REPO_ROOT / "apps" / "desktop"
        assert not (desktop / "scripts" / "write-deployment-config.mjs").exists(), (
            "the admin-key injector is back; nothing secret ships inside the app"
        )
        assert "deployment.json" not in (desktop / "package.json").read_text(
            encoding="utf-8"
        ), "the packaged app is carrying a baked-credentials file again"

    def test_a_fresh_install_with_no_service_configured_says_which_setting_is_missing(
        self, fresh_machine
    ):
        """The consequence of shipping ``second_brain`` by default.

        Until ``DEPLOYMENT_SECOND_BRAIN_URL`` names a deployed service, a fresh
        install has no model key — and has to say so in terms an admin can act
        on rather than silently having no model, which is the exact failure
        this module exists to prevent.
        """
        from hermes_cli.accounts import AccountIdentity
        from hermes_cli.account_provisioning import ensure_account_key

        settings = load_settings(load_config())
        if settings.second_brain_url:
            pytest.skip("this build has a second brain configured")

        result = ensure_account_key(
            AccountIdentity(subject="s", username="u", email="u@test", issuer="kc"),
            "u-1234",
            settings=settings,
            home=fresh_machine,
        )

        assert result.status == "unconfigured"
        assert "accounts.second_brain.base_url" in result.detail
