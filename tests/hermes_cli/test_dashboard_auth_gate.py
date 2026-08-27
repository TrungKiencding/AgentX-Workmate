"""Regression harness for the dashboard auth gate.

Phase 0 — establish a baseline pin on the current (pre-OAuth) behavior so
later phases can prove they didn't break loopback mode.
"""
import asyncio
import logging
import pytest

# Phase 5 / Phase 6: these tests mutate ``web_server.app.state.auth_required``
# at module level. Run them in the same xdist worker so they don't race
# against each other (and against any other file that also touches
# ``app.state``) — the marker name is shared across all dashboard-auth test
# files that gate the app.
from fastapi.testclient import TestClient

from hermes_cli import web_server


@pytest.fixture(autouse=True)
def _no_loopback_gate_opt_in(monkeypatch):
    """Pin the loopback rows of the truth table to an install with no opt-in.

    ``should_require_auth`` consults three things for a loopback bind:
    ``AGENTX_DASHBOARD_REQUIRE_AUTH``, ``dashboard.require_auth``, and — when
    neither is set — whether an identity provider is configured at all.

    All three have to be cleared here, and the third is the surprising one:
    AgentX Workmate SHIPS a Keycloak provider in ``DEFAULT_CONFIG``, so on a
    stock install the auto rung resolves to "gated" and every loopback row
    below would flip. These rows are about the predicate's shape, not about
    what the product happens to ship, so the fixture takes the config out of
    the picture. ``test_dashboard_auth_loopback_gate.py`` covers the auto rung
    itself, and ``test_deployment_defaults.py`` covers the shipped answer.
    """
    monkeypatch.delenv("AGENTX_DASHBOARD_REQUIRE_AUTH", raising=False)

    for key in (
        "AGENTX_DASHBOARD_KEYCLOAK_ISSUER",
        "AGENTX_DASHBOARD_KEYCLOAK_BASE_URL",
        "AGENTX_DASHBOARD_KEYCLOAK_REALM",
        "AGENTX_DASHBOARD_KEYCLOAK_CLIENT_ID",
    ):
        monkeypatch.delenv(key, raising=False)

    monkeypatch.setattr("hermes_cli.config.load_config", lambda: {})


@pytest.fixture
def client_loopback():
    # Pin the bound-host state for host_header_middleware so requests with
    # default Host: testclient pass the DNS-rebinding check.  TestClient
    # sends Host: testserver by default, but our middleware accepts the
    # loopback aliases when bound_host is loopback.
    prev_host = getattr(web_server.app.state, "bound_host", None)
    prev_port = getattr(web_server.app.state, "bound_port", None)
    web_server.app.state.bound_host = "127.0.0.1"
    web_server.app.state.bound_port = 9119
    client = TestClient(web_server.app, base_url="http://127.0.0.1:9119")
    yield client
    web_server.app.state.bound_host = prev_host
    web_server.app.state.bound_port = prev_port






# ---------------------------------------------------------------------------
# should_require_auth predicate (Task 0.2)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("host,allow_public,expected", [
    ("127.0.0.1", False, False),
    ("127.0.0.1", True,  False),
    ("localhost", False, False),
    ("::1",       False, False),
    # --insecure (allow_public=True) NO LONGER bypasses the gate on a public
    # bind (June 2026 hermes-0day hardening). Non-loopback always requires auth.
    ("0.0.0.0",   True,  True),
    ("0.0.0.0",   False, True),
    ("192.168.1.5", False, True),
    ("10.0.0.1",  True,  True),     # allow_public ignored — LAN IP is public
    ("100.64.0.1", False, True),    # Tailscale CGNAT — treated as public
    ("agentx-agent-prod-abc.fly.dev", False, True),
])
def test_should_require_auth_truth_table(host, allow_public, expected):
    from hermes_cli.web_server import should_require_auth
    assert should_require_auth(host, allow_public) is expected


# ---------------------------------------------------------------------------
# start_server stashes auth_required on app.state (Task 0.3)
# ---------------------------------------------------------------------------


def _stub_uvicorn_run(monkeypatch):
    """Replace uvicorn.Config/Server with no-op fakes so start_server
    returns immediately (rather than blocking on the event loop). Returns the dict
    that will capture the keyword args.
    """
    import asyncio
    import contextlib
    import uvicorn
    captured: dict = {"kwargs": {}}

    class _FakeConfig:
        loaded = True
        host = "127.0.0.1"
        port = 8000

        def __init__(self, *args, **kwargs):
            captured["kwargs"] = kwargs

        def load(self):
            pass

        class lifespan_class:
            should_exit = False
            state: dict = {}

            def __init__(self, *a, **kw):
                pass

            async def startup(self):
                pass

            async def shutdown(self):
                pass

    class _FakeServer:
        should_exit = False
        started = True
        servers: list = []
        lifespan = None

        @staticmethod
        def capture_signals():
            return contextlib.nullcontext()

        async def startup(self, sockets=None):
            pass

        async def main_loop(self):
            pass

        async def shutdown(self, sockets=None):
            pass

    monkeypatch.setattr(uvicorn, "Config", _FakeConfig)
    monkeypatch.setattr(uvicorn, "Server", lambda config: _FakeServer())
    return captured


def test_start_server_loopback_sets_auth_required_false(monkeypatch):
    """Loopback bind: app.state.auth_required is False after start_server."""
    _stub_uvicorn_run(monkeypatch)
    # Force a fresh state to detect that start_server actually set it.
    web_server.app.state.auth_required = None
    web_server.start_server(
        host="127.0.0.1", port=9119,
        open_browser=False, allow_public=False,
    )
    assert web_server.app.state.auth_required is False


def test_start_server_insecure_public_no_longer_bypasses_gate(monkeypatch):
    """``--insecure`` (allow_public=True) on a public host: gate now ENGAGES.

    June 2026 hardening: --insecure no longer disables auth. With no providers
    registered, the bind fails closed (SystemExit) and auth_required is True.
    """
    from hermes_cli.dashboard_auth import clear_providers
    clear_providers()
    _stub_uvicorn_run(monkeypatch)
    web_server.app.state.auth_required = None
    with pytest.raises(SystemExit):
        web_server.start_server(
            host="0.0.0.0", port=9119,
            open_browser=False, allow_public=True,
        )
    assert web_server.app.state.auth_required is True


def test_start_server_public_without_insecure_records_auth_required(monkeypatch):
    """Public bind without --insecure: the gate engages and auth_required=True.

    With no providers registered, this fails closed with SystemExit. The
    flag-stashing happens BEFORE the exit so the rest of the system can
    branch on it. (See task 3.5 tests below for the with-provider path.)
    """
    from hermes_cli.dashboard_auth import clear_providers
    clear_providers()
    _stub_uvicorn_run(monkeypatch)
    web_server.app.state.auth_required = None
    with pytest.raises(SystemExit):
        web_server.start_server(
            host="0.0.0.0", port=9119,
            open_browser=False, allow_public=False,
        )
    assert web_server.app.state.auth_required is True


# ---------------------------------------------------------------------------
# Task 3.5: start_server fail-closed + proxy_headers + index-token suppression
# ---------------------------------------------------------------------------


def test_start_server_gate_with_provider_proceeds_and_sets_proxy_headers(monkeypatch):
    """With at least one provider, public bind + no --insecure starts the server.

    The SystemExit-refusing-to-bind guard is REPLACED in gated mode by
    "the gate engages", so as long as a provider is registered the bind
    succeeds.  uvicorn is called with proxy_headers=True so X-Forwarded-Proto
    from Fly's TLS terminator is honoured for cookie Secure-flag decisions.
    """
    from hermes_cli.dashboard_auth import clear_providers, register_provider
    from tests.hermes_cli.conftest_dashboard_auth import StubAuthProvider

    clear_providers()
    register_provider(StubAuthProvider())
    captured = _stub_uvicorn_run(monkeypatch)
    try:
        web_server.app.state.auth_required = None
        web_server.start_server(
            host="0.0.0.0", port=9119,
            open_browser=False, allow_public=False,
        )
        assert web_server.app.state.auth_required is True
        assert captured["kwargs"].get("host") == "0.0.0.0"
        assert captured["kwargs"].get("proxy_headers") is True
    finally:
        clear_providers()


def test_start_server_passes_bounded_trusted_proxy_networks(monkeypatch, caplog):
    """A configured proxy network reaches uvicorn without broadening to all peers."""
    from hermes_cli.dashboard_auth import clear_providers, register_provider
    from tests.hermes_cli.conftest_dashboard_auth import StubAuthProvider

    clear_providers()
    register_provider(StubAuthProvider())
    captured = _stub_uvicorn_run(monkeypatch)
    monkeypatch.setattr(
        web_server,
        "load_config",
        lambda: {"dashboard": {"trusted_proxies": ["172.18.0.23/16"]}},
    )
    try:
        with caplog.at_level(logging.INFO, logger=web_server._log.name):
            web_server.start_server(
                host="0.0.0.0", port=9119,
                open_browser=False, allow_public=False,
            )
        assert captured["kwargs"]["forwarded_allow_ips"] == [
            "127.0.0.1",
            "::1",
            "172.18.0.0/16",
        ]
        assert (
            "Dashboard trusted proxies: 127.0.0.1, ::1, 172.18.0.0/16"
            in caplog.text
        )
    finally:
        clear_providers()


def test_trusted_proxy_allowlist_rejects_unbounded_entries(caplog):
    """Wildcard and whole-address-space trust must fail closed."""
    trusted = web_server._dashboard_forwarded_allow_ips({
        "trusted_proxies": ["*", "0.0.0.0/0", "::/0", "172.18.0.7"],
    })

    assert trusted == ["127.0.0.1", "::1", "172.18.0.7"]
    assert "never '*' or a /0 network" in caplog.text

def test_trusted_container_proxy_controls_https_detection():
    """Only a configured bridge peer may turn X-Forwarded-Proto into HTTPS."""
    from hermes_cli.dashboard_auth.cookies import detect_https
    from starlette.requests import Request
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

    trusted = web_server._dashboard_forwarded_allow_ips({
        "trusted_proxies": ["172.18.0.0/16"],
    })

    async def detected_scheme(peer: str) -> bool:
        observed: dict[str, bool] = {}

        async def downstream(scope, receive, send):
            observed["https"] = detect_https(Request(scope))

        middleware = ProxyHeadersMiddleware(downstream, trusted_hosts=trusted)
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/auth/login",
            "raw_path": b"/auth/login",
            "query_string": b"",
            "root_path": "",
            "headers": [(b"x-forwarded-proto", b"https")],
            "client": (peer, 43120),
            "server": ("hermes", 9119),
        }

        async def receive():
            return {"type": "http.disconnect"}

        async def send(message):
            return None

        await middleware(scope, receive, send)
        return observed["https"]

    assert asyncio.run(detected_scheme("172.18.0.9")) is True
    assert asyncio.run(detected_scheme("::1")) is True
    assert asyncio.run(detected_scheme("198.51.100.9")) is False
