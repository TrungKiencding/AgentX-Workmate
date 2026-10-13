"""Account picker freshness against a real HTTP proxy and temp AGENTX_HOME."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from hermes_cli.account_provisioning import write_state
from hermes_cli.inventory import ConfigContext, build_model_options_payload
from hermes_constants import get_hermes_home


@pytest.fixture
def proxy(monkeypatch):
    state = {"models": ["old"], "offline": False, "reads": 0}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.path == "/v1/models"
            assert self.headers["Authorization"] == "Bearer sk-test-refresh"
            state["reads"] += 1
            self.send_response(503 if state["offline"] else 200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"data": [{"id": m} for m in state["models"]]}).encode())

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/v1"
    write_state(get_hermes_home(), {"provider": "litellm", "base_url": url})
    # Enrichment is independent of discovery and must not call external hosts.
    monkeypatch.setattr("agent.models_dev.fetch_models_dev", lambda *a, **kw: {})
    monkeypatch.setattr("hermes_cli.inventory._apply_pricing", lambda *a, **kw: None)
    monkeypatch.setattr("hermes_cli.inventory._apply_capabilities", lambda *a, **kw: None)
    monkeypatch.setattr("hermes_cli.inventory._apply_featured", lambda *a, **kw: None)
    ctx = ConfigContext(
        current_provider="litellm", current_model="old", current_base_url=url,
        user_providers={"litellm": {"name": "AgentX AI Gateway", "base_url": url,
                                  "api_key": "sk-test-refresh", "models": {"old": {}}}},
        custom_providers=[],
    )
    try:
        yield state, ctx
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_refresh_replaces_a_warm_catalog_without_resurrecting_retired_selection(proxy):
    state, ctx = proxy
    old = build_model_options_payload(ctx, explicit_only=True)
    assert old["providers"][0]["models"] == ["old"]
    state["models"] = ["new", "another"]
    refreshed = build_model_options_payload(ctx, explicit_only=True, refresh=True)
    assert refreshed["providers"][0]["models"] == state["models"]
    assert "old" not in refreshed["providers"][0]["models"]
    assert refreshed["model"] == "old"  # reports actual session; UI repairs it
    assert state["reads"] == 2


def test_offline_refresh_keeps_last_catalog_and_does_not_wipe_cache(proxy):
    state, ctx = proxy
    build_model_options_payload(ctx, explicit_only=True)
    state["models"] = ["new"]
    build_model_options_payload(ctx, explicit_only=True, refresh=True)
    state["offline"] = True
    offline = build_model_options_payload(ctx, explicit_only=True, refresh=True)
    assert offline["providers"][0]["models"] == ["new"]
