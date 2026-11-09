"""Real account route → isolated home/.env → loopback LiteLLM read.

No admin credentials, account selection parameters, or mocked import chain.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from hermes_cli.account_provisioning import provider_key_env, write_state
from hermes_cli.account_quota import quota_snapshot
from hermes_cli.web_routers.accounts import router


@pytest.fixture
def quota_api(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
    key_env = provider_key_env("litellm")
    monkeypatch.delenv(key_env, raising=False)
    (tmp_path / ".env").write_text(f"{key_env}=sk-person-only\n")
    calls = []
    upstream = {
        "status": 200,
        "body": {
            "key": "sk-never-return",
            "info": {
                "spend": 12.5,
                "max_budget": 50,
                "budget_duration": "30d",
                "budget_reset_at": "2026-12-01T00:00:00",
                "metadata": {"secret": "private"},
            },
        },
    }

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append((self.path, self.headers.get("Authorization")))
            self.send_response(upstream["status"])
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(upstream["body"]).encode())

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    write_state(
        tmp_path,
        {
            "subject": "person",
            "base_url": f"http://127.0.0.1:{server.server_port}/v1",
            "key_env": key_env,
        },
    )
    app = FastAPI()

    @app.middleware("http")
    async def identity(request: Request, call_next):
        subject = request.headers.get("x-test-subject")
        if subject:
            request.state.session = SimpleNamespace(user_id=subject)
        return await call_next(request)

    app.include_router(router)
    with TestClient(app) as client:
        yield client, upstream, calls
    server.shutdown()
    server.server_close()
    thread.join()


def test_route_reads_only_own_key_and_sanitizes(quota_api):
    client, upstream, calls = quota_api
    response = client.get(
        "/api/account/quota?key=someone-else", headers={"x-test-subject": "person"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["quota"]["remaining"] == body["quota"]["limit"] - body["quota"]["spend"]
    assert body["quota"]["reset_at"] == "2026-12-01T00:00:00+00:00"
    assert calls == [("/key/info", "Bearer sk-person-only")]
    assert not any(
        secret in response.text
        for secret in ("sk-person-only", "sk-never-return", "private")
    )


def test_auth_and_account_ownership_are_required(quota_api):
    client, _, calls = quota_api
    assert client.get("/api/account/quota").status_code == 401
    assert (
        client.get("/api/account/quota", headers={"x-test-subject": "other"}).json()[
            "status"
        ]
        == "unavailable"
    )
    assert calls == []


@pytest.mark.parametrize(
    "status,expected",
    [
        (401, "forbidden"),
        (403, "forbidden"),
        (404, "unsupported"),
        (500, "offline"),
        (302, "offline"),
    ],
)
def test_failures_do_not_expose_upstream_or_break_account(quota_api, status, expected):
    client, upstream, _ = quota_api
    upstream.update(status=status, body={"error": "sk-secret-upstream"})
    response = client.get("/api/account/quota", headers={"x-test-subject": "person"})
    assert response.json() == {"status": expected, "quota": None}


@pytest.mark.parametrize(
    "info",
    [
        {},
        {"spend": True, "max_budget": 50},
        {"spend": -1, "max_budget": 50},
        {"spend": float("nan"), "max_budget": 50},
        {"spend": 1, "max_budget": "50"},
    ],
)
def test_unknown_or_invalid_numbers_are_never_zero_usage(info):
    with pytest.raises((KeyError, ValueError)):
        quota_snapshot(info)


@pytest.mark.parametrize(
    "limit,spend,remaining", [(None, 12, None), (0, 0, 0), (50, 60, 0), (50, 12, 38)]
)
def test_budget_invariants(limit, spend, remaining):
    result = quota_snapshot({
        "max_budget": limit,
        "spend": spend,
        "budget_reset_at": "invalid",
    })
    assert result["remaining"] == remaining
    assert result["reset_at"] is None


def test_missing_account_key_never_uses_a_shell_key(quota_api, tmp_path, monkeypatch):
    client, _, calls = quota_api
    (tmp_path / ".env").unlink()
    monkeypatch.setenv(provider_key_env("litellm"), "sk-another-account-inherited")
    assert client.get(
        "/api/account/quota", headers={"x-test-subject": "person"}
    ).json() == {
        "status": "unavailable",
        "quota": None,
    }
    assert calls == []


def test_malformed_proxy_response_is_recoverable(quota_api):
    client, upstream, _ = quota_api
    upstream["body"] = {"info": {"spend": "not available", "max_budget": 50}}
    assert client.get(
        "/api/account/quota", headers={"x-test-subject": "person"}
    ).json() == {
        "status": "error",
        "quota": None,
    }
