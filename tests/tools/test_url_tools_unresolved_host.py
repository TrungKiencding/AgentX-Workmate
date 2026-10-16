"""A URL refused because its host doesn't resolve says so.

``is_safe_url`` refuses a host it can't resolve (unless a proxy is configured,
which resolves it instead). browser_navigate on a cloud backend then said
"Blocked: URL targets a private or internal address", and web_extract "...
private or internal network address", even for a typo'd public host.
``unsafe_url_reason`` is the same check and says why it refused, so both tools
now say "Blocked: could not resolve <host>" for that case.

These tests run the real url_safety checks against a fake resolver.
"""

import json
import socket

import pytest

from agent import web_search_registry
from agent.web_search_provider import WebSearchProvider
from tools import browser_tool, url_safety, web_tools

_FAKE_DNS = {
    "acme.dev": "93.184.216.34",
    "intranet.corp": "10.1.2.3",
    "localhost": "127.0.0.1",
}

UNRESOLVED = "Blocked: could not resolve acme.dve"
NOT_HTTP = "Blocked: URL must start with http:// or https://"
BROWSER_PRIVATE = "Blocked: URL targets a private or internal address"
EXTRACT_PRIVATE = "Blocked: URL targets a private or internal network address"


def _fake_getaddrinfo(host, port, *args, **kwargs):
    ip = host if host.replace(".", "").isdigit() else _FAKE_DNS.get(host)
    if ip is None:
        raise socket.gaierror(socket.EAI_NONAME, "not in the fake resolver")
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port or 0))]


@pytest.fixture(autouse=True)
def _hermetic_url_checks(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo)
    monkeypatch.setenv("AGENTX_ALLOW_PRIVATE_URLS", "false")
    for name in url_safety._PROXY_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    url_safety._reset_allow_private_cache()
    yield
    url_safety._reset_allow_private_cache()


class TestUnsafeUrlReason:
    @pytest.mark.parametrize("url, reason", [
        ("https://acme.dev/docs", None),
        ("https://acme.dve/docs", "unresolved"),
        ("https://intranet.corp/wiki", "address"),
        ("http://localhost:3000/", "address"),
        ("http://10.0.0.1/admin", "address"),
        ("http://169.254.169.254/latest/meta-data/", "address"),
        # refused by name before any lookup, so never "unresolved"
        ("http://metadata.google.internal/computeMetadata/v1/", "address"),
        ("http:///docs", "address"),
        ("ftp://acme.dev/file", "scheme"),
        ("about:blank", "scheme"),
        # is_safe_url doesn't complete a bare host; the URL tools do first
        ("acme.dev/docs", "scheme"),
    ])
    def test_is_the_check_is_safe_url_makes(self, url, reason):
        assert url_safety.unsafe_url_reason(url) == reason
        assert url_safety.is_safe_url(url) is (reason is None)

    def test_a_proxy_resolves_what_dns_cannot(self, monkeypatch):
        monkeypatch.setenv("HTTPS_PROXY", "http://proxy.test:3128")

        assert url_safety.unsafe_url_reason("https://acme.dve/docs") is None
        assert url_safety.is_safe_url("https://acme.dve/docs") is True

    def test_allowing_private_urls_still_refuses_what_does_not_resolve(self, monkeypatch):
        monkeypatch.setenv("AGENTX_ALLOW_PRIVATE_URLS", "true")
        url_safety._reset_allow_private_cache()

        assert url_safety.unsafe_url_reason("https://intranet.corp/wiki") is None
        assert url_safety.unsafe_url_reason("https://acme.dve/docs") == "unresolved"

    def test_a_literal_ip_the_resolver_rejects_names_no_host(self, monkeypatch):
        # No DNS was asked for, so nothing went unresolved: refused as an address.
        def _reject(host, *args, **kwargs):
            raise socket.gaierror(socket.EAI_NONAME, "rejected")

        monkeypatch.setattr(socket, "getaddrinfo", _reject)
        monkeypatch.setenv("HTTPS_PROXY", "http://proxy.test:3128")

        assert url_safety.unsafe_url_reason("http://93.184.216.34/") == "address"

    def test_an_unreadable_answer_is_an_address(self, monkeypatch):
        monkeypatch.setattr(
            socket,
            "getaddrinfo",
            lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("not-an-ip%x", 0))],
        )

        assert url_safety.unsafe_url_reason("https://acme.dev/") == "address"

    def test_a_check_that_fails_is_an_address(self, monkeypatch):
        def _boom(url):
            raise ValueError("bad url")

        monkeypatch.setattr(url_safety, "urlparse", _boom)

        assert url_safety.unsafe_url_reason("https://acme.dev/") == "address"
        assert url_safety.is_safe_url("https://acme.dev/") is False


def _cloud_browser(monkeypatch, *, auto_local=False):
    """A cloud backend with the session layer stubbed; returns each open."""
    opened = []

    def _run(session_key, command, args, timeout=None):
        if command == "open":
            opened.append((session_key, args[0]))
            return {"success": True, "data": {"title": "OK", "url": args[0]}}
        return {"success": False, "error": "no snapshot in tests"}

    monkeypatch.setattr(browser_tool, "_get_cdp_override_raw", lambda: "")
    monkeypatch.setattr(browser_tool, "_is_camofox_mode", lambda: False)
    monkeypatch.setattr(browser_tool, "_is_local_backend", lambda: False)
    monkeypatch.setattr(browser_tool, "_get_cloud_provider", lambda: object())
    monkeypatch.setattr(browser_tool, "_auto_local_for_private_urls", lambda: auto_local)
    monkeypatch.setattr(browser_tool, "_allow_private_urls", lambda: False)
    monkeypatch.setattr(browser_tool, "check_website_access", lambda url: None)
    monkeypatch.setattr(browser_tool, "_last_active_session_key", {})
    monkeypatch.setattr(
        browser_tool,
        "_get_session_info",
        lambda key: {"session_name": f"s_{key}", "features": {}, "_first_nav": False},
    )
    monkeypatch.setattr(browser_tool, "_run_browser_command", _run)
    return opened


def _navigate(url):
    return json.loads(browser_tool.browser_navigate(url))


class TestBrowserNavigate:
    @pytest.mark.parametrize("raw", ["https://acme.dve/docs", "acme.dve/docs"])
    def test_says_a_host_does_not_resolve(self, monkeypatch, raw):
        opened = _cloud_browser(monkeypatch)

        assert _navigate(raw) == {"success": False, "error": UNRESOLVED}
        assert opened == []

    @pytest.mark.parametrize("url", ["https://intranet.corp/wiki", "http://10.0.0.1/admin"])
    def test_still_calls_a_private_host_private(self, monkeypatch, url):
        opened = _cloud_browser(monkeypatch)

        assert _navigate(url) == {"success": False, "error": BROWSER_PRIVATE}
        assert opened == []

    def test_opens_a_public_host(self, monkeypatch):
        opened = _cloud_browser(monkeypatch)

        result = _navigate("https://acme.dev/docs")

        assert result["success"] is True, result
        assert opened == [("default", "https://acme.dev/docs")]

    def test_still_says_what_is_not_http(self, monkeypatch):
        opened = _cloud_browser(monkeypatch)

        assert _navigate("about:blank") == {"success": False, "error": NOT_HTTP}
        assert opened == []

    def test_opens_an_unresolved_host_through_a_proxy(self, monkeypatch):
        opened = _cloud_browser(monkeypatch)
        monkeypatch.setenv("HTTPS_PROXY", "http://proxy.test:3128")

        assert _navigate("https://acme.dve/docs")["success"] is True
        assert opened == [("default", "https://acme.dve/docs")]

    def test_hybrid_routing_keeps_an_unresolved_host_on_the_cloud_check(self, monkeypatch):
        # Not private for routing (it doesn't resolve), so no local sidecar.
        opened = _cloud_browser(monkeypatch, auto_local=True)

        assert _navigate("https://acme.dve/docs") == {"success": False, "error": UNRESOLVED}
        assert opened == []

    def test_asks_why_only_after_a_refusal(self, monkeypatch):
        _cloud_browser(monkeypatch)
        asked = []
        real_reason = browser_tool._unsafe_url_reason
        monkeypatch.setattr(
            browser_tool, "_unsafe_url_reason", lambda url: asked.append(url) or real_reason(url),
        )

        assert _navigate("https://acme.dev/docs")["success"] is True
        assert asked == []
        assert _navigate("https://acme.dve/docs")["error"] == UNRESOLVED
        assert asked == ["https://acme.dve/docs"]

    def test_the_reason_never_lets_a_refused_url_through(self, monkeypatch):
        # The second look finds nothing to blame (say DNS changed in between):
        # still refused, in the old words.
        opened = _cloud_browser(monkeypatch)
        monkeypatch.setattr(browser_tool, "_is_safe_url", lambda url: False)

        assert _navigate("https://acme.dev/docs") == {"success": False, "error": BROWSER_PRIVATE}
        assert opened == []


class TestEvaluateUrlSafety:
    @pytest.fixture(autouse=True)
    def _cloud(self, monkeypatch):
        _cloud_browser(monkeypatch)

    def test_says_a_host_does_not_resolve(self):
        assert browser_tool.evaluate_url_safety("https://acme.dve/docs") == {
            "success": False,
            "error": UNRESOLVED,
        }

    def test_still_calls_a_private_host_private(self):
        assert browser_tool.evaluate_url_safety("https://intranet.corp/wiki") == {
            "success": False,
            "error": BROWSER_PRIVATE,
        }

    def test_passes_a_public_host(self):
        assert browser_tool.evaluate_url_safety("https://acme.dev/docs") is None


class _FakeExtractProvider(WebSearchProvider):
    def __init__(self) -> None:
        self.received_urls: list[str] = []

    @property
    def name(self) -> str:
        return "unresolved-host-test"

    @property
    def display_name(self) -> str:
        return "Unresolved Host Test"

    def is_available(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return True

    async def extract(self, urls, **kwargs):
        self.received_urls.extend(urls)
        return [{"url": url, "title": "", "content": "ok"} for url in urls]


@pytest.fixture
def extract_provider(monkeypatch):
    with web_search_registry._lock:
        previous = dict(web_search_registry._providers)
        web_search_registry._providers.clear()

    provider = _FakeExtractProvider()
    web_search_registry.register_provider(provider)
    monkeypatch.setattr(web_tools, "_ensure_web_plugins_loaded", lambda: None)
    monkeypatch.setattr(web_tools, "_load_web_config", lambda: {"extract_backend": provider.name})
    yield provider

    with web_search_registry._lock:
        web_search_registry._providers.clear()
        web_search_registry._providers.update(previous)


async def _extract(urls):
    return json.loads(await web_tools.web_extract_tool(urls))


def _blocked(url, error):
    return {"url": url, "title": "", "content": "", "error": error}


class TestWebExtract:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("raw", ["https://acme.dve/docs", "acme.dve/docs"])
    async def test_says_a_host_does_not_resolve(self, extract_provider, raw):
        result = await _extract([raw])

        assert extract_provider.received_urls == []
        assert result["results"] == [_blocked("https://acme.dve/docs", UNRESOLVED)]

    @pytest.mark.asyncio
    async def test_still_calls_a_private_host_private(self, extract_provider):
        result = await _extract(["https://intranet.corp/wiki"])

        assert extract_provider.received_urls == []
        assert result["results"] == [_blocked("https://intranet.corp/wiki", EXTRACT_PRIVATE)]

    @pytest.mark.asyncio
    async def test_extracts_a_public_host(self, extract_provider):
        result = await _extract(["https://acme.dev/docs"])

        assert extract_provider.received_urls == ["https://acme.dev/docs"]
        assert result["results"][0]["error"] is None

    @pytest.mark.asyncio
    async def test_gives_each_url_its_own_reason(self, extract_provider):
        result = await _extract([
            "https://acme.dve/a",
            "https://intranet.corp/b",
            "https://acme.dev/c",
            "file:///etc/hosts",
        ])

        assert extract_provider.received_urls == ["https://acme.dev/c"]
        assert [entry["error"] for entry in result["results"]] == [
            UNRESOLVED,
            EXTRACT_PRIVATE,
            None,
            NOT_HTTP,
        ]

    @pytest.mark.asyncio
    async def test_extracts_an_unresolved_host_through_a_proxy(self, extract_provider, monkeypatch):
        monkeypatch.setenv("HTTPS_PROXY", "http://proxy.test:3128")

        result = await _extract(["https://acme.dve/docs"])

        assert extract_provider.received_urls == ["https://acme.dve/docs"]
        assert result["results"][0]["error"] is None

    @pytest.mark.asyncio
    async def test_the_reason_never_lets_a_refused_url_through(self, extract_provider, monkeypatch):
        async def _refuse(url):
            return False

        monkeypatch.setattr(web_tools, "async_is_safe_url", _refuse)

        result = await _extract(["https://acme.dev/docs"])

        assert extract_provider.received_urls == []
        assert result["results"] == [_blocked("https://acme.dev/docs", EXTRACT_PRIVATE)]
