"""Real config, profile scope, REST and runtime paths for gateway-only accounts."""

from __future__ import annotations

import json

import pytest
import yaml

from hermes_cli.account_inference import account_inference
from hermes_cli.account_provisioning import STATE_FILENAME, write_state
from hermes_cli.accounts import ACCOUNT_IDENTITY_FILENAME, AccountIdentity
from hermes_cli.config import load_config, read_raw_config
from hermes_cli.runtime_provider import resolve_runtime_provider


@pytest.fixture
def account_home(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
    (tmp_path / ACCOUNT_IDENTITY_FILENAME).write_text(
        json.dumps(AccountIdentity(subject="test-account").to_json())
    )
    cfg = {
        "accounts": {
            "litellm": {
                "enabled": True,
                "provider_name": "company-ai",
                "base_url": "https://gateway.test",
            }
        },
        "model": {
            "provider": "anthropic",
            "default": "old-model",
            "api_key": "old-key",
            "base_url": "https://other.test",
        },
        "providers": {
            "company-ai": {
                "name": "AgentX AI Gateway",
                "base_url": "https://gateway.test/v1",
                "key_env": "COMPANY_AI_API_KEY",
                "models": {"gateway-model": {}},
                "discover_models": False,
            },
            "other": {
                "base_url": "https://other.test/v1",
                "models": {"old-model": {}},
                "discover_models": False,
            },
        },
    }
    (tmp_path / "config.yaml").write_text(yaml.safe_dump(cfg))
    write_state(
        tmp_path,
        {
            "provider": "company-ai",
            "base_url": "https://gateway.test",
            "key_env": "COMPANY_AI_API_KEY",
            "models": ["gateway-model"],
        },
    )
    monkeypatch.setenv("COMPANY_AI_API_KEY", "sk-test-account-gateway-key")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-old-provider-key")
    return tmp_path


def test_auto_resolution_uses_managed_key_not_old_config(account_home):
    result = resolve_runtime_provider(explicit_api_key="old-session-key")
    assert result["base_url"] == "https://gateway.test/v1"
    assert result["api_key"] == "sk-test-account-gateway-key"
    assert result["requested_provider"] == "company-ai"


@pytest.mark.parametrize("provider", ["anthropic", "openrouter", "custom:other", "moa"])
def test_explicit_session_aux_and_fallback_provider_cannot_escape(
    account_home, provider
):
    with pytest.raises(ValueError, match="only use models through AgentX AI Gateway"):
        resolve_runtime_provider(requested=provider)


def test_resolved_custom_sessions_must_match_gateway_endpoint(account_home):
    assert (
        resolve_runtime_provider(
            requested="custom", explicit_base_url="https://gateway.test/v1"
        )["source"]
        == "account-gateway"
    )
    with pytest.raises(ValueError, match="only use models"):
        resolve_runtime_provider(
            requested="custom", explicit_base_url="https://other.test/v1"
        )
    with pytest.raises(ValueError, match="only use models"):
        resolve_runtime_provider(
            requested="company-ai", explicit_base_url="https://other.test/v1"
        )


def test_missing_key_never_autodetects_another_provider(account_home, monkeypatch):
    monkeypatch.delenv("COMPANY_AI_API_KEY")
    with pytest.raises(ValueError, match="not configured for this account"):
        resolve_runtime_provider()


def test_identity_keeps_policy_when_provisioning_has_never_succeeded(
    account_home, monkeypatch
):
    (account_home / STATE_FILENAME).unlink()
    monkeypatch.delenv("COMPANY_AI_API_KEY")
    assert account_inference().provider == "company-ai"
    with pytest.raises(ValueError, match="only use models"):
        resolve_runtime_provider(requested="anthropic")


def test_unmanaged_cli_home_remains_independent(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
    assert account_inference() is None


@pytest.mark.parametrize("scope,task", [("main", ""), ("auxiliary", "vision")])
def test_real_assignment_rejects_other_providers_before_writing(
    account_home, scope, task
):
    from fastapi import HTTPException
    from hermes_cli.web_server import _apply_model_assignment_sync

    before = (account_home / "config.yaml").read_bytes()
    with pytest.raises(HTTPException) as refused:
        _apply_model_assignment_sync(scope, "anthropic", "claude", task, "")
    assert refused.value.status_code == 403
    assert (account_home / "config.yaml").read_bytes() == before


def test_gateway_assignment_and_aux_reset_use_real_config(account_home):
    from hermes_cli.web_server import _apply_model_assignment_sync

    result = _apply_model_assignment_sync("main", "company-ai", "gateway-model", "", "")
    assert result["ok"]
    assert load_config()["model"]["provider"] == "company-ai"
    result = _apply_model_assignment_sync(
        "auxiliary", "company-ai", "gateway-model", "vision", ""
    )
    assert result["ok"]
    assert load_config()["auxiliary"]["vision"]["provider"] == "company-ai"
    assert _apply_model_assignment_sync("auxiliary", "", "", "__reset__", "")["reset"]


def test_inventory_returns_only_managed_gateway_with_real_config(account_home):
    from hermes_cli.inventory import build_model_options_payload, load_picker_context

    payload = build_model_options_payload(
        load_picker_context(), include_unconfigured=True
    )
    assert payload["inference_provider"] == "company-ai"
    assert payload["providers"]
    assert all(account_inference().allows(row["slug"]) for row in payload["providers"])
    assert payload["providers"][0]["models"] == ["gateway-model"]


def test_reuse_reconciles_old_provider_and_keeps_a_gateway_model_choice(account_home):
    from hermes_cli.account_provisioning import (
        _tidy_reused_account,
        load_settings,
        read_state,
    )

    state = read_state(account_home)
    _tidy_reused_account(load_settings(), state, account_home)
    cfg = read_raw_config()
    assert cfg["model"]["provider"] == "company-ai"
    assert cfg["model"]["default"] == "gateway-model"
    assert cfg["model"]["base_url"] == "https://gateway.test/v1"
    assert "api_key" not in cfg["model"]
    cfg["model"]["default"] = "my-gateway-pick"
    (account_home / "config.yaml").write_text(yaml.safe_dump(cfg))
    _tidy_reused_account(load_settings(), state, account_home)
    assert read_raw_config()["model"]["default"] == "my-gateway-pick"


def test_aux_auto_uses_gateway_and_rejects_old_native_vendor(account_home):
    from agent.auxiliary_client import resolve_provider_client

    client, model = resolve_provider_client("auto", model="gateway-model")
    try:
        assert str(client.base_url).rstrip("/") == "https://gateway.test/v1"
        assert client.api_key == "sk-test-account-gateway-key"
        assert model == "gateway-model"
    finally:
        client.close()
    with pytest.raises(ValueError, match="only use models"):
        resolve_provider_client("anthropic", model="claude")


def test_vision_cannot_use_a_native_provider_override(account_home):
    from agent.auxiliary_client import resolve_vision_provider_client

    with pytest.raises(ValueError, match="only use models"):
        resolve_vision_provider_client(provider="anthropic", model="claude")


def test_rest_model_set_refuses_other_provider_and_accepts_gateway(account_home):
    from fastapi.testclient import TestClient
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    with TestClient(app) as client:
        client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
        before = (account_home / "config.yaml").read_bytes()
        body = {
            "scope": "main",
            "provider": "anthropic",
            "model": "claude",
            "confirm_expensive_model": True,
        }
        refused = client.post("/api/model/set", json=body)
        assert refused.status_code == 403
        assert (account_home / "config.yaml").read_bytes() == before
        body.update(provider="company-ai", model="gateway-model")
        assert client.post("/api/model/set", json=body).json()["ok"]


def test_corrupt_account_metadata_never_enables_other_providers(account_home):
    (account_home / ACCOUNT_IDENTITY_FILENAME).write_text("invalid json")
    (account_home / STATE_FILENAME).write_text("invalid json")
    (account_home / ACCOUNT_IDENTITY_FILENAME).unlink()
    assert account_inference() is not None
    with pytest.raises(ValueError, match="only use models"):
        resolve_runtime_provider(requested="anthropic")


def test_reuse_migrates_auxiliary_delegation_and_vendor_fallbacks(account_home):
    from hermes_cli.account_provisioning import (
        _tidy_reused_account,
        load_settings,
        read_state,
    )

    cfg = read_raw_config()
    cfg["auxiliary"] = {
        "compression": {
            "provider": "anthropic",
            "model": "claude",
            "api_key": "old",
            "timeout": 123,
        },
        "vision": {"provider": "other", "model": "vendor-vision"},
        "title": {"provider": "company-ai", "model": "my-gateway-title"},
    }
    cfg["delegation"] = {
        "provider": "anthropic",
        "model": "claude",
        "api_key": "old",
        "max_concurrent_children": 3,
    }
    cfg["fallback_providers"] = [
        {"provider": "anthropic", "model": "claude"},
        {"provider": "company-ai", "model": "gateway-model"},
    ]
    cfg["fallback_model"] = {"provider": "other", "model": "vendor"}
    (account_home / "config.yaml").write_text(yaml.safe_dump(cfg))
    _tidy_reused_account(load_settings(), read_state(account_home), account_home)
    after = read_raw_config()
    assert after["auxiliary"]["compression"] == {
        "provider": "auto",
        "model": "",
        "timeout": 123,
    }
    assert after["auxiliary"]["vision"] == {"provider": "auto", "model": ""}
    assert after["auxiliary"]["title"]["model"] == "my-gateway-title"
    assert after["delegation"] == {"max_concurrent_children": 3}
    assert after["fallback_providers"] == [
        {"provider": "company-ai", "model": "gateway-model"}
    ]
    assert "fallback_model" not in after
    before = (account_home / "config.yaml").read_bytes()
    _tidy_reused_account(load_settings(), read_state(account_home), account_home)
    assert (account_home / "config.yaml").read_bytes() == before


def test_default_and_legacy_moa_slots_use_account_gateway(account_home):
    from hermes_cli.moa_config import normalize_moa_config, resolve_moa_preset

    for raw in (
        {},
        {
            "reference_models": [
                {"provider": "anthropic", "model": "claude", "enabled": False}
            ],
            "aggregator": {"provider": "company-ai", "model": "my-gateway-model"},
        },
    ):
        normalized = normalize_moa_config(raw)
        preset = resolve_moa_preset(normalized)
        assert all(
            slot["provider"] == "company-ai"
            for slot in [*preset["reference_models"], preset["aggregator"]]
        )
        assert preset["reference_models"][0]["model"] == "gateway-model"
        if raw:
            assert not preset["reference_models"][0]["enabled"]
            assert preset["aggregator"]["model"] == "my-gateway-model"


def test_real_moa_api_refuses_vendor_slots_without_writing(account_home, monkeypatch):
    from fastapi.testclient import TestClient
    from hermes_cli import web_server

    monkeypatch.setattr(web_server, "_SESSION_TOKEN", "test-policy-token")
    headers = {"Authorization": "Bearer test-policy-token"}
    before = (account_home / "config.yaml").read_bytes()
    with TestClient(web_server.app) as client:
        body = {
            "reference_models": [{"provider": "anthropic", "model": "claude"}],
            "aggregator": {"provider": "company-ai", "model": "gateway-model"},
        }
        assert (
            client.put("/api/model/moa", headers=headers, json=body).status_code == 403
        )
        assert (account_home / "config.yaml").read_bytes() == before
        body["reference_models"][0]["provider"] = "company-ai"
        body["reference_models"][0]["model"] = "gateway-model"
        assert (
            client.put("/api/model/moa", headers=headers, json=body).status_code == 200
        )
        assert (
            read_raw_config()["moa"]["reference_models"][0]["provider"] == "company-ai"
        )


def test_resolved_gateway_model_and_delegation_pins_survive_migration(account_home):
    from hermes_cli.account_provisioning import (
        _tidy_reused_account,
        load_settings,
        read_state,
    )

    cfg = read_raw_config()
    cfg["model"].update(
        provider="custom", base_url="https://gateway.test/v1", default="my-gateway-pick"
    )
    cfg["delegation"] = {
        "provider": "custom",
        "base_url": "https://gateway.test/v1",
        "model": "my-gateway-subagent",
    }
    (account_home / "config.yaml").write_text(yaml.safe_dump(cfg))
    _tidy_reused_account(load_settings(), read_state(account_home), account_home)
    after = read_raw_config()
    assert after["model"]["provider"] == "company-ai"
    assert after["model"]["default"] == "my-gateway-pick"
    assert after["delegation"] == {
        "provider": "company-ai",
        "model": "my-gateway-subagent",
    }


def test_real_auxiliary_request_reaches_only_the_managed_gateway(account_home):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread
    from agent.auxiliary_client import resolve_provider_client

    received = []

    class GatewayHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            received.append((self.path, self.headers.get("Authorization"), payload))
            response = json.dumps({
                "id": "gateway-test",
                "object": "chat.completion",
                "created": 0,
                "model": payload["model"],
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "gateway-ok"},
                    }
                ],
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), GatewayHandler)
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        from hermes_cli.account_provisioning import read_state

        write_state(
            account_home,
            {
                **read_state(account_home),
                "base_url": f"http://127.0.0.1:{server.server_port}",
            },
        )
        client, model = resolve_provider_client("auto", model="gateway-model")
        try:
            answer = client.chat.completions.create(
                model=model, messages=[{"role": "user", "content": "test"}]
            )
        finally:
            client.close()
        assert answer.choices[0].message.content == "gateway-ok"
        assert len(received) == 1
        route, auth, body = received[0]
        assert route == "/v1/chat/completions"
        assert auth == "Bearer sk-test-account-gateway-key"
        assert body["model"] == "gateway-model"
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
