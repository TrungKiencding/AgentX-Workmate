"""A URL typed without a scheme ("acme.dev/docs") is completed with https://
before the URL tools check it.

browser_navigate and web_extract run their checks (SSRF, the cloud-metadata
floor, credential query params, website policy) on what
``normalize_url_for_request`` returns. It kept a bare host bare, so on a cloud
browser ``is_safe_url`` refused it for its empty scheme with "Blocked: URL
targets a private or internal address", public host or not. agent-browser
itself opens such a URL as https ("If no protocol is provided, https:// is
automatically prepended").

These tests run the real ``is_safe_url`` / ``is_always_blocked_url`` /
``sensitive_query_param_name`` against a fake resolver.
"""

import json
import socket

import pytest

from agent import web_search_registry
from agent.web_search_provider import WebSearchProvider
from tools import browser_tool, url_safety, web_tools
from tools.url_safety import normalize_url_for_request

_FAKE_DNS = {
    "acme.dev": "93.184.216.34",
    "docs.example": "93.184.216.35",
    "localhost": "127.0.0.1",
    "intranet.corp": "10.1.2.3",
}


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


class TestNormalizeCompletesABareHost:
    @pytest.mark.parametrize("raw, expected", [
        ("acme.dev/docs", "https://acme.dev/docs"),
        ("acme.dev", "https://acme.dev"),
        ("localhost:3000/app", "https://localhost:3000/app"),
        ("10.0.0.1/admin", "https://10.0.0.1/admin"),
        ("web_app:3000", "https://web_app:3000"),
        ("acme.dev?q=1", "https://acme.dev?q=1"),
        ("acme.dev#top", "https://acme.dev#top"),
        ("  acme.dev/docs  ", "https://acme.dev/docs"),
        # completed, then encoded like any https URL
        ("münich.example/Köln", "https://xn--mnich-kva.example/K%C3%B6ln"),
        ("acme.dev/a b", "https://acme.dev/a%20b"),
    ])
    def test_completes_with_https(self, raw, expected):
        assert normalize_url_for_request(raw) == expected

    @pytest.mark.parametrize("raw", [
        "a@b.c",                # user-info reads like an email
        "user@acme.dev/docs",
        "/docs",                # a path
        "./index.html",
        "acme.dev./docs",       # a trailing dot
        "acme..dev",
        "[::1]:8080/",          # no IPv6 literal
        "acme.dev:99999/x",     # no such port
        "acme.dev docs",        # prose
        "about:blank",          # another scheme
        "file:///etc/hosts",
        "data:text/html,hi",
        "javascript:alert(1)",
        "mailto:a@b.c",
        "",
    ])
    def test_leaves_what_is_not_a_bare_host(self, raw):
        assert normalize_url_for_request(raw) == raw

    def test_is_safe_url_still_refuses_the_bare_form_itself(self):
        # The completion is the URL tools' job; is_safe_url stays strict.
        assert url_safety.is_safe_url("acme.dev/docs") is False
        assert url_safety.is_safe_url(normalize_url_for_request("acme.dev/docs")) is True


def _browser(monkeypatch, *, local=False, auto_local=False, camofox=False):
    """Stub the session layer; return the (session key, args) of each open."""
    opened = []

    def _run(session_key, command, args, timeout=None):
        if command == "open":
            opened.append((session_key, list(args)))
            return {"success": True, "data": {"title": "OK", "url": args[0]}}
        return {"success": False, "error": "no snapshot in tests"}

    monkeypatch.setattr(browser_tool, "_get_cdp_override_raw", lambda: "")
    monkeypatch.setattr(browser_tool, "_is_camofox_mode", lambda: camofox)
    monkeypatch.setattr(browser_tool, "_is_local_backend", lambda: local)
    monkeypatch.setattr(browser_tool, "_get_cloud_provider", lambda: None if local else object())
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


class TestBrowserNavigateCloud:
    """Cloud provider, no hybrid routing, no allow_private_urls."""

    @pytest.mark.parametrize("raw, expected", [
        ("acme.dev/docs", "https://acme.dev/docs"),
        ("acme.dev", "https://acme.dev"),
        ("docs.example:8443/x?y=1#z", "https://docs.example:8443/x?y=1#z"),
    ])
    def test_opens_a_bare_public_host_as_https(self, monkeypatch, raw, expected):
        opened = _browser(monkeypatch)

        result = _navigate(raw)

        assert result["success"] is True, result
        assert result["url"] == expected
        assert opened == [("default", [expected])]

    @pytest.mark.parametrize("raw, checked", [
        ("10.0.0.1/admin", "https://10.0.0.1/admin"),
        ("localhost:3000", "https://localhost:3000"),
        ("localhost:3000/app", "https://localhost:3000/app"),
        ("intranet.corp/wiki", "https://intranet.corp/wiki"),
    ])
    def test_still_refuses_a_bare_private_host_for_its_address(self, monkeypatch, raw, checked):
        opened = _browser(monkeypatch)
        seen = []
        real_is_safe_url = browser_tool._is_safe_url
        monkeypatch.setattr(
            browser_tool, "_is_safe_url", lambda url: seen.append(url) or real_is_safe_url(url),
        )

        result = _navigate(raw)

        assert result == {
            "success": False,
            "error": "Blocked: URL targets a private or internal address",
        }
        # Refused because the https URL's host resolves to a private address,
        # not for an empty scheme: the same check opens acme.dev/docs above.
        assert seen == [checked]
        assert opened == []

    @pytest.mark.parametrize("raw", [
        "a@b.c/x",
        "/docs",
        "acme.dev./x",
        "[::1]:8080/",
        "about:blank",
        "file:///etc/hosts",
    ])
    def test_refuses_what_is_still_not_http_without_blaming_an_address(self, monkeypatch, raw):
        opened = _browser(monkeypatch)

        result = _navigate(raw)

        assert result == {
            "success": False,
            "error": "Blocked: URL must start with http:// or https://",
        }
        assert opened == []

    def test_reads_a_credential_query_param_on_a_bare_host(self, monkeypatch):
        opened = _browser(monkeypatch)

        result = _navigate("acme.dev/login?token=abc123")

        assert result["success"] is False
        assert "credential-like query parameter (token)" in result["error"]
        assert opened == []

    def test_every_check_sees_the_completed_url(self, monkeypatch):
        opened = _browser(monkeypatch)
        seen = {}

        def _record(name, verdict):
            return lambda url: seen.setdefault(name, []).append(url) or verdict

        monkeypatch.setattr(browser_tool, "_sensitive_query_param_name", _record("query", None))
        monkeypatch.setattr(browser_tool, "_is_always_blocked_url", _record("floor", False))
        monkeypatch.setattr(browser_tool, "_is_safe_url", _record("ssrf", True))
        monkeypatch.setattr(browser_tool, "check_website_access", _record("policy", None))

        assert _navigate("acme.dev/docs")["success"] is True

        url = "https://acme.dev/docs"
        assert seen == {"query": [url], "floor": [url], "ssrf": [url], "policy": [url]}
        assert opened == [("default", [url])]


class TestBrowserNavigateHybrid:
    """Cloud provider + browser.auto_local_for_private_urls (the default)."""

    def test_routes_a_bare_loopback_host_like_its_https_form(self, monkeypatch):
        opened = _browser(monkeypatch, auto_local=True)

        bare = _navigate("localhost:3000/app")
        full = _navigate("https://localhost:3000/app")

        assert bare["success"] is True, bare
        assert bare == full
        assert opened == [
            ("default::local", ["https://localhost:3000/app"]),
            ("default::local", ["https://localhost:3000/app"]),
        ]

    def test_public_bare_host_stays_on_the_cloud_session(self, monkeypatch):
        opened = _browser(monkeypatch, auto_local=True)

        assert _navigate("acme.dev/docs")["success"] is True
        assert opened == [("default", ["https://acme.dev/docs"])]


class TestBrowserNavigateLocal:
    @pytest.mark.parametrize("raw", [
        "169.254.169.254/latest/meta-data/",
        "169.254.170.2/v2/credentials",
        "metadata.google.internal/computeMetadata/v1/",
    ])
    def test_metadata_floor_refuses_a_bare_metadata_host(self, monkeypatch, raw):
        # The floor read no host from the bare form and let it through.
        opened = _browser(monkeypatch, local=True)

        result = _navigate(raw)

        assert result == {
            "success": False,
            "error": "Blocked: URL targets a cloud metadata endpoint",
        }
        assert opened == []

    def test_opens_a_bare_host_as_agent_browser_would(self, monkeypatch):
        opened = _browser(monkeypatch, local=True)

        assert _navigate("localhost:3000/app")["success"] is True
        assert opened == [("default", ["https://localhost:3000/app"])]

    def test_camofox_gets_the_completed_url(self, monkeypatch):
        # Camofox's Docker loopback rewrite only reads http(s) URLs.
        _browser(monkeypatch, local=True, camofox=True)
        sent = []
        import tools.browser_camofox as camofox

        monkeypatch.setattr(
            camofox,
            "camofox_navigate",
            lambda url, task_id=None: sent.append(url) or json.dumps({"success": True, "url": url}),
        )

        assert _navigate("localhost:3000/app")["success"] is True
        assert sent == ["https://localhost:3000/app"]


class TestEvaluateUrlSafety:
    @pytest.fixture(autouse=True)
    def _cloud(self, monkeypatch):
        _browser(monkeypatch)

    def test_bare_public_host_is_safe(self):
        assert browser_tool.evaluate_url_safety("acme.dev/docs") is None

    def test_bare_private_host_is_refused_for_its_address(self, monkeypatch):
        seen = []
        real_is_safe_url = browser_tool._is_safe_url
        monkeypatch.setattr(
            browser_tool, "_is_safe_url", lambda url: seen.append(url) or real_is_safe_url(url),
        )

        assert browser_tool.evaluate_url_safety("10.0.0.1/admin") == {
            "success": False,
            "error": "Blocked: URL targets a private or internal address",
        }
        assert seen == ["https://10.0.0.1/admin"]

    def test_what_is_not_http_is_refused_for_that(self):
        assert browser_tool.evaluate_url_safety("a@b.c/x") == {
            "success": False,
            "error": "Blocked: URL must start with http:// or https://",
        }


class _FakeExtractProvider(WebSearchProvider):
    def __init__(self) -> None:
        self.received_urls: list[str] = []

    @property
    def name(self) -> str:
        return "schemeless-url-test"

    @property
    def display_name(self) -> str:
        return "Schemeless URL Test"

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


class TestWebExtract:
    @pytest.mark.asyncio
    async def test_extracts_a_bare_public_host_as_https(self, extract_provider):
        result = json.loads(await web_tools.web_extract_tool(["acme.dev/docs"]))

        assert extract_provider.received_urls == ["https://acme.dev/docs"]
        assert result["results"][0]["url"] == "https://acme.dev/docs"
        assert result["results"][0]["error"] is None

    @pytest.mark.asyncio
    async def test_still_refuses_a_bare_private_host_for_its_address(self, extract_provider):
        result = json.loads(await web_tools.web_extract_tool(["10.0.0.1/admin"]))

        assert extract_provider.received_urls == []
        assert result["results"] == [{
            "url": "https://10.0.0.1/admin",
            "title": "",
            "content": "",
            "error": "Blocked: URL targets a private or internal network address",
        }]

    @pytest.mark.asyncio
    async def test_refuses_what_is_still_not_http_without_blaming_an_address(self, extract_provider):
        result = json.loads(await web_tools.web_extract_tool(["a@b.c/x", "acme.dev/ok"]))

        assert extract_provider.received_urls == ["https://acme.dev/ok"]
        assert [entry["error"] for entry in result["results"]] == [
            "Blocked: URL must start with http:// or https://",
            None,
        ]
