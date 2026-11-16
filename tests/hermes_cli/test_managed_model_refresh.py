"""Account picker freshness: the service-issued grant, refreshed on picker open.

On a signed-in home the picker lists the grant provisioning wrote
(``account_models``), never the proxy's own ``/v1/models``. A refreshed read
asks provisioning again; a transient outage (``status="offline"``) keeps the
last grant, exactly as provisioning keeps the last key, while a definitive
refusal still surfaces.
"""

import pytest

from hermes_cli.account_credentials import AccountCredentials, mailbox
from hermes_cli.account_inference import AccountGatewayError
from hermes_cli.account_provisioning import ProvisionResult, read_state, write_state
from hermes_cli.inventory import ConfigContext, build_model_options_payload
from hermes_constants import get_hermes_home

URL = "http://127.0.0.1:9/v1"


@pytest.fixture
def grant(monkeypatch):
    home = get_hermes_home()
    write_state(home, {"provider": "litellm", "base_url": URL, "models": ["old"]})
    service = {"models": ["old"], "status": "reused", "calls": 0}

    def ensure_account_key(identity, slug, **kwargs):
        service["calls"] += 1
        if service["status"] == "reused":
            write_state(kwargs["home"], {**read_state(kwargs["home"]), "models": list(service["models"])})
        return ProvisionResult(status=service["status"], detail=f"service said {service['status']}")

    monkeypatch.setattr("hermes_cli.account_provisioning.ensure_account_key", ensure_account_key)
    monkeypatch.setattr("hermes_cli.accounts.read_account_identity", lambda _home: object())
    monkeypatch.setattr(mailbox(), "_held", AccountCredentials("bearer", "device-1"))
    # Enrichment is independent of the grant and must not call external hosts.
    monkeypatch.setattr("agent.models_dev.fetch_models_dev", lambda *a, **kw: {})
    monkeypatch.setattr("hermes_cli.inventory._apply_pricing", lambda *a, **kw: None)
    monkeypatch.setattr("hermes_cli.inventory._apply_capabilities", lambda *a, **kw: None)
    monkeypatch.setattr("hermes_cli.inventory._apply_featured", lambda *a, **kw: None)
    ctx = ConfigContext(
        current_provider="litellm", current_model="old", current_base_url=URL,
        user_providers={"litellm": {"name": "AgentX AI Gateway", "base_url": URL,
                                  "api_key": "sk-test-refresh", "models": {"old": {}}}},
        custom_providers=[],
    )
    return service, ctx


def test_refresh_replaces_the_grant_without_resurrecting_retired_selection(grant):
    service, ctx = grant
    old = build_model_options_payload(ctx, explicit_only=True)
    assert old["providers"][0]["models"] == ["old"]
    assert service["calls"] == 0  # a plain read never asks the service

    service["models"] = ["new", "another"]
    refreshed = build_model_options_payload(ctx, explicit_only=True, refresh=True)
    assert refreshed["providers"][0]["models"] == ["new", "another"]
    assert "old" not in refreshed["providers"][0]["models"]
    assert refreshed["model"] == "old"  # reports actual session; UI repairs it
    assert service["calls"] == 1


def test_offline_refresh_keeps_the_last_grant(grant):
    service, ctx = grant
    service["models"] = ["new"]
    build_model_options_payload(ctx, explicit_only=True, refresh=True)

    service["status"] = "offline"
    offline = build_model_options_payload(ctx, explicit_only=True, refresh=True)
    assert offline["providers"][0]["models"] == ["new"]
    assert service["calls"] == 2


def test_a_definitive_refusal_is_not_hidden_behind_the_last_grant(grant):
    service, ctx = grant
    service["status"] = "revoked"
    with pytest.raises(AccountGatewayError, match="revoked"):
        build_model_options_payload(ctx, explicit_only=True, refresh=True)
