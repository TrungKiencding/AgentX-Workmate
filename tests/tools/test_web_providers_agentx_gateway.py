"""Tests for the AgentX AI Gateway web search provider (plugins/web/agentx_gateway/).

Covers:
- is_available() — true only for an account whose provisioning sidecar names a
  web search model and whose key is set; a configured model stands in for a
  missing grant; no network either way
- search() — request shape, search_results rows plus the answer, the citation
  fallbacks, de-duplication, the limit, and the error paths (access denied,
  other HTTP errors, 200 error envelope, failed status, unreachable gateway,
  no account)
- selection — _get_backend() picks it for a signed-in account, a deliberate key
  or config still wins, and web_extract is not offered on its strength
- the picker row asks for a sign-in until the account holds a grant
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest

SEARCH_MODEL = "perplexity/preset/pro-search"
KEY_ENV = "AGENTX_CUSTOM_LITELLM_API_KEY"


def _write_state(home, **overrides) -> None:
    state = {
        "base_url": "https://gateway.test",
        "key_env": KEY_ENV,
        "provider": "litellm",
        "mode": "second_brain",
        "models": ["chat-a"],
        **overrides,
    }
    (home / "litellm-account.json").write_text(json.dumps(state))


@pytest.fixture
def account_home(tmp_path, monkeypatch):
    """An account home whose sidecar grants web search, with its key set."""
    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
    monkeypatch.setenv(KEY_ENV, "sk-account-key")
    _write_state(tmp_path, web_search_model=SEARCH_MODEL)
    return tmp_path


def _mock_resp(json_data, status_code: int = 200):
    m = MagicMock()
    m.status_code = status_code
    m.json.return_value = json_data
    m.text = json.dumps(json_data)
    return m


def _reply(answer: str = "", annotations=None, search_results=None, **extra) -> dict:
    """A Responses-API reply shaped like Perplexity's Agent API."""
    output: list = []
    if search_results is not None:
        output.append({"type": "search_results", "queries": ["q"], "results": search_results})
    output.append(
        {
            "type": "message",
            "role": "assistant",
            "content": [
                {"type": "output_text", "text": answer, "annotations": annotations or []}
            ],
        }
    )
    return {
        "id": "resp_1",
        "object": "response",
        "status": "completed",
        "error": None,
        "output": output,
        **extra,
    }


def _provider():
    from plugins.web.agentx_gateway.provider import AgentXGatewayWebSearchProvider

    return AgentXGatewayWebSearchProvider()


# ---------------------------------------------------------------------------
# Availability
# ---------------------------------------------------------------------------


class TestAvailability:
    def test_identity(self):
        provider = _provider()
        assert provider.name == "agentx-gateway"
        assert provider.supports_search() is True
        assert provider.supports_extract() is False

    def test_available_for_an_account_granted_web_search(self, account_home):
        assert _provider().is_available() is True

    def test_not_available_without_a_grant(self, account_home):
        _write_state(account_home, web_search_model="")
        assert _provider().is_available() is False

    def test_not_available_signed_out(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
        monkeypatch.setenv(KEY_ENV, "sk-account-key")
        assert _provider().is_available() is False

    def test_not_available_when_the_key_is_gone(self, account_home, monkeypatch):
        monkeypatch.delenv(KEY_ENV)
        assert _provider().is_available() is False

    def test_a_configured_model_stands_in_for_a_missing_grant(self, account_home):
        from plugins.web.agentx_gateway import provider as gateway

        _write_state(account_home, web_search_model="")
        with patch.object(
            gateway, "_load_gateway_web_config",
            return_value={"model": "perplexity/preset/fast-search"},
        ):
            assert _provider().is_available() is True

    def test_is_available_never_touches_the_network(self, account_home):
        with patch("httpx.post", side_effect=AssertionError("no network in is_available")):
            assert _provider().is_available() is True


# ---------------------------------------------------------------------------
# search()
# ---------------------------------------------------------------------------


class TestSearchRequest:
    def test_posts_the_query_to_the_responses_endpoint_with_the_account_key(self, account_home):
        captured: dict = {}

        def fake_post(url, **kwargs):
            captured.update(url=url, **kwargs)
            return _mock_resp(_reply("ok"))

        with patch("httpx.post", side_effect=fake_post):
            _provider().search("latest python release", limit=3)

        assert captured["url"] == "https://gateway.test/v1/responses"
        assert captured["headers"]["Authorization"] == "Bearer sk-account-key"
        assert captured["json"] == {"model": SEARCH_MODEL, "input": "latest python release"}

    def test_a_configured_model_wins_over_the_grant(self, account_home):
        from plugins.web.agentx_gateway import provider as gateway

        captured: dict = {}

        def fake_post(url, **kwargs):
            captured.update(kwargs)
            return _mock_resp(_reply("ok"))

        with patch.object(
            gateway, "_load_gateway_web_config",
            return_value={"model": "perplexity/preset/fast-search", "timeout": 30},
        ), patch("httpx.post", side_effect=fake_post):
            _provider().search("q")

        assert captured["json"]["model"] == "perplexity/preset/fast-search"
        assert captured["timeout"] == 30.0


class TestSearchResults:
    def test_search_results_become_rows_and_the_answer_rides_along(self, account_home):
        reply = _reply(
            answer="Python 3.14 is the latest stable release [1].",
            search_results=[
                {
                    "title": "Python Releases",
                    "url": "https://www.python.org/downloads/",
                    "snippet": "Latest: 3.14.0",
                    "date": "2026-08-01",
                },
                {
                    "title": "What's new",
                    "url": "https://docs.python.org/3/whatsnew/",
                    "snippet": "Changes in 3.14",
                },
            ],
            annotations=[
                {"type": "url_citation", "url": "https://www.python.org/downloads/", "title": "1"}
            ],
        )
        with patch("httpx.post", return_value=_mock_resp(reply)):
            result = _provider().search("q", limit=5)

        assert result["success"] is True
        assert result["data"]["web"] == [
            {
                "title": "Python Releases",
                "url": "https://www.python.org/downloads/",
                "description": "(2026-08-01) Latest: 3.14.0",
                "position": 1,
            },
            {
                "title": "What's new",
                "url": "https://docs.python.org/3/whatsnew/",
                "description": "Changes in 3.14",
                "position": 2,
            },
        ]
        assert result["data"]["answer"] == "Python 3.14 is the latest stable release [1]."

    def test_cited_results_lead_and_the_answer_cites_rows_by_position(self, account_home):
        results = [
            {"id": i, "title": f"r{i}", "url": f"https://r{i}.example.com", "snippet": f"s{i}"}
            for i in range(1, 8)
        ]
        reply = _reply(
            "Gold is up [web:2], says the exchange [web:6], and again [web:2].",
            search_results=results,
        )
        with patch("httpx.post", return_value=_mock_resp(reply)):
            data = _provider().search("q", limit=3)["data"]

        # Returned past the limit rather than cited but missing: an answer
        # citing a source the agent never received cannot be checked.
        assert [row["title"] for row in data["web"]] == ["r2", "r6", "r1"]
        assert [row["position"] for row in data["web"]] == [1, 2, 3]
        assert data["answer"] == "Gold is up [1], says the exchange [2], and again [1]."

    def test_a_citation_the_reply_carries_no_result_for_is_left_alone(self, account_home):
        results = [{"id": 1, "title": "r1", "url": "https://r1.example.com", "snippet": ""}]
        with patch("httpx.post", return_value=_mock_resp(_reply("See [web:9].", search_results=results))):
            data = _provider().search("q")["data"]

        assert data["answer"] == "See [web:9]."
        assert [row["url"] for row in data["web"]] == ["https://r1.example.com"]

    def test_snippets_carry_their_freshness_on_one_line(self, account_home):
        results = [
            {
                "id": 1,
                "title": "Prices",
                "url": "https://prices.example.com",
                "snippet": "## SJC\n\nBuy   143.6\nSell 146.6",
                "date": "2019-07-04",
                "last_updated": "2026-09-10",
            }
        ]
        with patch("httpx.post", return_value=_mock_resp(_reply("x", search_results=results))):
            row = _provider().search("q")["data"]["web"][0]

        assert row["description"] == "(2026-09-10) ## SJC Buy 143.6 Sell 146.6"

    def test_citations_fill_in_when_there_are_no_search_results(self, account_home):
        reply = _reply(
            answer="See [the guide](https://docs.example.com/guide).",
            annotations=[
                {"type": "url_citation", "url": "https://a.example.com", "title": "Example A"},
                {"type": "url_citation", "url": "https://b.example.com", "title": "2"},
            ],
            citations=["https://b.example.com", "https://c.example.com"],
        )
        with patch("httpx.post", return_value=_mock_resp(reply)):
            web = _provider().search("q", limit=10)["data"]["web"]

        assert [row["url"] for row in web] == [
            "https://a.example.com",
            "https://b.example.com",
            "https://c.example.com",
            "https://docs.example.com/guide",
        ]
        assert web[0]["title"] == "Example A"
        # A citation's number is not a title.
        assert web[1]["title"] == ""
        assert web[3]["title"] == "the guide"
        assert [row["position"] for row in web] == [1, 2, 3, 4]

    def test_the_limit_caps_the_rows(self, account_home):
        results = [
            {"title": f"r{i}", "url": f"https://r{i}.example.com", "snippet": ""} for i in range(7)
        ]
        with patch("httpx.post", return_value=_mock_resp(_reply("x", search_results=results))):
            web = _provider().search("q", limit=3)["data"]["web"]

        assert [row["title"] for row in web] == ["r0", "r1", "r2"]

    def test_a_long_answer_is_trimmed(self, account_home):
        from plugins.web.agentx_gateway.provider import MAX_ANSWER_CHARS

        with patch("httpx.post", return_value=_mock_resp(_reply("x" * (MAX_ANSWER_CHARS + 500)))):
            answer = _provider().search("q")["data"]["answer"]

        assert len(answer) <= MAX_ANSWER_CHARS + 2
        assert answer.endswith("…")

    def test_an_empty_reply_is_an_empty_success(self, account_home):
        with patch("httpx.post", return_value=_mock_resp(_reply(""))):
            result = _provider().search("q")

        assert result == {"success": True, "data": {"web": []}}


class TestSearchErrors:
    def test_a_key_without_the_grant_is_told_so(self, account_home):
        denied = {
            "error": {
                "message": (
                    "key not allowed to access model. This key can only access "
                    "models=['chat-a']. Tried to access perplexity/preset/pro-search"
                ),
                "type": "key_model_access_denied",
                "param": "model",
                "code": "401",
            }
        }
        with patch("httpx.post", return_value=_mock_resp(denied, status_code=401)):
            result = _provider().search("q")

        assert result["success"] is False
        assert SEARCH_MODEL in result["error"]
        assert "not allowed" in result["error"]

    def test_other_http_errors_carry_the_gateway_message(self, account_home):
        body = {"error": {"message": "upstream timeout"}}
        with patch("httpx.post", return_value=_mock_resp(body, status_code=500)):
            result = _provider().search("q")

        assert result["success"] is False
        assert "HTTP 500" in result["error"]
        assert "upstream timeout" in result["error"]

    def test_a_200_error_envelope_is_a_failure(self, account_home):
        body = {"error": {"message": "preset unavailable"}, "output": []}
        with patch("httpx.post", return_value=_mock_resp(body)):
            result = _provider().search("q")

        assert result["success"] is False
        assert "preset unavailable" in result["error"]

    def test_a_failed_status_is_a_failure(self, account_home):
        body = {"status": "failed", "error": None, "output": []}
        with patch("httpx.post", return_value=_mock_resp(body)):
            assert _provider().search("q")["success"] is False

    def test_an_unreachable_gateway_is_a_failure(self, account_home):
        with patch("httpx.post", side_effect=httpx.ConnectError("connection refused")):
            result = _provider().search("q")

        assert result["success"] is False
        assert "Could not reach" in result["error"]

    def test_signed_out_nothing_is_sent(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
        with patch("httpx.post") as posted:
            result = _provider().search("q")

        assert result["success"] is False
        posted.assert_not_called()


# ---------------------------------------------------------------------------
# Selection and gating in tools/web_tools.py
# ---------------------------------------------------------------------------


class TestSelection:
    @pytest.fixture(autouse=True)
    def _nothing_else_configured(self, monkeypatch):
        from tools import web_tools

        for key in (
            "TAVILY_API_KEY", "EXA_API_KEY", "PARALLEL_API_KEY", "FIRECRAWL_API_KEY",
            "FIRECRAWL_API_URL", "SEARXNG_URL", "BRAVE_SEARCH_API_KEY", "XAI_API_KEY",
        ):
            monkeypatch.delenv(key, raising=False)
        monkeypatch.setattr(web_tools, "_load_web_config", lambda: {})
        monkeypatch.setattr(web_tools, "_is_tool_gateway_ready", lambda: False)
        monkeypatch.setattr(web_tools, "_ddgs_package_importable", lambda: False)
        web_tools._ensure_web_plugins_loaded()

    def test_it_is_the_default_for_a_signed_in_account(self, account_home):
        from tools import web_tools

        assert web_tools._get_search_backend() == "agentx-gateway"
        assert web_tools.check_web_api_key() is True

    def test_it_ranks_above_duckduckgo(self, account_home, monkeypatch):
        from tools import web_tools

        monkeypatch.setattr(web_tools, "_ddgs_package_importable", lambda: True)
        assert web_tools._get_backend() == "agentx-gateway"

    def test_a_key_somebody_set_on_purpose_still_wins(self, account_home, monkeypatch):
        from tools import web_tools

        monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")
        assert web_tools._get_backend() == "tavily"

    def test_a_configured_backend_still_wins(self, account_home, monkeypatch):
        from tools import web_tools

        monkeypatch.setenv("SEARXNG_URL", "https://searx.example.com")
        monkeypatch.setattr(web_tools, "_load_web_config", lambda: {"backend": "searxng"})
        assert web_tools._get_search_backend() == "searxng"

    def test_signed_out_it_is_not_picked(self, tmp_path, monkeypatch):
        from tools import web_tools

        monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
        assert web_tools._get_backend() != "agentx-gateway"

    def test_web_extract_is_not_offered_on_the_strength_of_search_alone(self, account_home):
        from tools import web_tools

        assert web_tools.check_web_api_key() is True
        assert web_tools.check_web_extract_api_key() is False

    def test_web_extract_is_offered_once_something_can_extract(self, account_home, monkeypatch):
        from tools import web_tools

        monkeypatch.setenv("TAVILY_API_KEY", "tvly-test")
        assert web_tools.check_web_extract_api_key() is True


class TestPickerRow:
    def test_the_row_asks_for_a_sign_in_until_the_account_holds_a_grant(
        self, tmp_path, monkeypatch
    ):
        from hermes_cli.tools_config import (
            _plugin_web_search_providers,
            provider_readiness_status,
        )

        monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
        row = next(
            r for r in _plugin_web_search_providers() if r["web_backend"] == "agentx-gateway"
        )
        assert row["env_vars"] == []
        assert provider_readiness_status(row, {}) == "needs_auth"

        monkeypatch.setenv(KEY_ENV, "sk-account-key")
        _write_state(tmp_path, web_search_model=SEARCH_MODEL)
        assert provider_readiness_status(row, {}) == "ready"
