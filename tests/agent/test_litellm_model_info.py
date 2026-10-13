"""LiteLLM context windows come from /model/info, never from Ollama's /api/show.

A LiteLLM proxy lists models on ``/models`` without a window for models its
cost map does not know, and has no Ollama API: the generic ``/api/show``
fallback drew a 404 on every context-length lookup. ``/model/info`` (open to
every virtual key) declares ``model_info.max_input_tokens`` instead, and a
LiteLLM answer there marks the host so ``/api/show`` is skipped.

Covers:
- parsing max_input_tokens (never max_tokens), smallest window per group
- 404 / non-LiteLLM payloads remembered, not re-probed within the TTL
- /api/show skipped for LiteLLM hosts, still used for remote Ollama
- get_model_context_length end to end with mocked HTTP, keyless handling
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

URL = "https://gateway.example/v1"
MODEL = "deepseek/deepseek-v4.1-flash"


@pytest.fixture(autouse=True)
def _clear_caches():
    from agent import model_metadata as mm

    def clear():
        mm._endpoint_model_metadata_cache.clear()
        mm._endpoint_model_metadata_cache_time.clear()
        mm._endpoint_blackhole_cache.clear()
        mm._LOCAL_CTX_PROBE_CACHE.clear()
        mm._endpoint_api_key_cache.clear()
        mm._endpoint_auth_required.clear()
        mm._endpoint_litellm_verdict.clear()
        mm._litellm_model_info_cache.clear()

    clear()
    yield
    clear()


def _response(status_code, payload=None, json_error=False):
    response = MagicMock()
    response.status_code = status_code
    if json_error:
        response.json.side_effect = ValueError("not json")
    else:
        response.json.return_value = payload if payload is not None else {}
    if status_code >= 400:
        response.raise_for_status.side_effect = RuntimeError(str(status_code))
    return response


def _model_info(*rows):
    return {
        "data": [
            {"model_name": name, "litellm_params": {"model": f"openrouter/{name}"}, "model_info": info}
            for name, info in rows
        ]
    }


CATALOG = {"data": [{"id": MODEL, "object": "model"}, {"id": "z-ai/glm-5.3-flash", "object": "model"}]}


def _gateway(models=None, model_info=None):
    """requests.get stand-in routing /models and /model/info; records calls."""
    calls = []

    def fake_get(url, headers=None, **kwargs):
        calls.append((url, (headers or {}).get("Authorization")))
        if url.endswith("/model/info"):
            return model_info or _response(404)
        if url.endswith("/models"):
            return models or _response(404)
        return _response(404)

    return fake_get, calls


def _info_calls(calls):
    return [call for call in calls if call[0].endswith("/model/info")]


class TestFetchWindows:
    def test_reads_max_input_tokens_never_max_tokens(self):
        from agent.model_metadata import _fetch_litellm_context_windows, _endpoint_is_litellm

        payload = _model_info(
            (MODEL, {"max_input_tokens": 131072, "max_tokens": 8192}),
            ("z-ai/glm-5.3-flash", {"max_input_tokens": None, "max_tokens": 4096}),
            ("group", {"max_input_tokens": 200000}),
            ("group", {"max_input_tokens": 128000}),
            ("group", {"max_input_tokens": None}),
        )
        fake_get, calls = _gateway(model_info=_response(200, payload))
        with patch("agent.model_metadata.requests.get", side_effect=fake_get):
            windows = _fetch_litellm_context_windows(URL, api_key="sk-gateway")

        assert windows == {MODEL: 131072, "z-ai/glm-5.3-flash": None, "group": 128000}
        assert calls == [(f"{URL}/model/info", "Bearer sk-gateway")]
        assert _endpoint_is_litellm(URL) is True

    def test_answer_is_cached(self):
        from agent.model_metadata import _fetch_litellm_context_windows

        fake_get, calls = _gateway(model_info=_response(200, _model_info((MODEL, {"max_input_tokens": 1000}))))
        with patch("agent.model_metadata.requests.get", side_effect=fake_get):
            _fetch_litellm_context_windows(URL, api_key="sk-gateway")
            _fetch_litellm_context_windows(URL, api_key="sk-gateway")

        assert len(calls) == 1

    @pytest.mark.parametrize(
        "response",
        [_response(404), _response(405), _response(200, json_error=True), _response(200, {"data": [{"id": MODEL}]})],
        ids=["404", "405", "not-json", "not-litellm-shape"],
    )
    def test_non_litellm_answer_is_remembered(self, response):
        from agent.model_metadata import _endpoint_is_litellm, _fetch_litellm_context_windows

        fake_get, calls = _gateway(model_info=response)
        with patch("agent.model_metadata.requests.get", side_effect=fake_get):
            assert _fetch_litellm_context_windows(URL, api_key="sk-gateway") is None
            assert _fetch_litellm_context_windows(URL, api_key="sk-gateway") is None

        assert len(calls) == 1
        assert _endpoint_is_litellm(URL) is False

    def test_server_error_is_not_a_verdict(self):
        from agent import model_metadata as mm

        fake_get, calls = _gateway(model_info=_response(503))
        with patch("agent.model_metadata.requests.get", side_effect=fake_get):
            assert mm._fetch_litellm_context_windows(URL, api_key="sk-gateway") is None
            assert mm._fetch_litellm_context_windows(URL, api_key="sk-gateway") is None

        assert len(calls) == 2
        assert mm._endpoint_litellm_verdict == {}

    def test_keyless_refusal_marks_host_and_stops_asking(self):
        from agent.model_metadata import _fetch_litellm_context_windows

        fake_get, calls = _gateway(model_info=_response(401))
        with patch("agent.model_metadata.requests.get", side_effect=fake_get):
            assert _fetch_litellm_context_windows(URL) is None
            assert _fetch_litellm_context_windows(URL) is None

        assert calls == [(f"{URL}/model/info", None)]

    def test_prefixed_model_name_matches(self):
        from agent.model_metadata import _query_litellm_context_length

        fake_get, _ = _gateway(model_info=_response(200, _model_info((MODEL, {"max_input_tokens": 131072}))))
        with patch("agent.model_metadata.requests.get", side_effect=fake_get):
            assert _query_litellm_context_length(f"local:{MODEL}", URL, api_key="sk-gateway") == 131072


def _ollama_client(context_length=None):
    client = MagicMock()
    client.__enter__ = lambda s: client
    client.__exit__ = MagicMock(return_value=False)
    if context_length is None:
        client.post.return_value = _response(404)
    else:
        client.post.return_value = _response(200, {"model_info": {"llama.context_length": context_length}})
    return client


class TestApiShowGate:
    def test_litellm_host_never_gets_api_show(self):
        from agent import model_metadata as mm

        mm._endpoint_litellm_verdict[mm._endpoint_host_key(URL)] = (True, mm.time.monotonic())
        with patch("httpx.Client") as client_cls:
            assert mm._query_ollama_api_show_uncached(MODEL, URL, api_key="sk-gateway") is None

        client_cls.assert_not_called()


@pytest.fixture
def _offline_lookups():
    """Keep get_model_context_length off disk caches and public catalogs."""
    with patch("agent.model_metadata.get_cached_context_length", return_value=None), \
         patch("agent.model_metadata.save_context_length"), \
         patch("agent.model_metadata.fetch_model_metadata", return_value={}), \
         patch("agent.models_dev.lookup_models_dev_context", return_value=None):
        yield


@pytest.mark.usefixtures("_offline_lookups")
class TestGetModelContextLength:
    def test_litellm_window_comes_from_model_info_without_api_show(self):
        from agent.model_metadata import get_model_context_length

        fake_get, calls = _gateway(
            models=_response(200, CATALOG),
            model_info=_response(200, _model_info((MODEL, {"max_input_tokens": 131072}))),
        )
        with patch("agent.model_metadata.requests.get", side_effect=fake_get), \
             patch("httpx.Client") as client_cls:
            ctx = get_model_context_length(MODEL, base_url=URL, api_key="sk-gateway")

        assert ctx == 131072
        assert len(_info_calls(calls)) == 1
        client_cls.assert_not_called()

    def test_undeclared_window_still_skips_api_show(self):
        from agent.model_metadata import get_model_context_length

        fake_get, calls = _gateway(
            models=_response(200, CATALOG),
            model_info=_response(200, _model_info((MODEL, {"max_input_tokens": None, "max_tokens": 8192}))),
        )
        with patch("agent.model_metadata.requests.get", side_effect=fake_get), \
             patch("httpx.Client") as client_cls:
            ctx = get_model_context_length(MODEL, base_url=URL, api_key="sk-gateway")
            get_model_context_length(MODEL, base_url=URL, api_key="sk-gateway")

        assert ctx != 8192
        assert len(_info_calls(calls)) == 1
        client_cls.assert_not_called()

    def test_remote_ollama_still_uses_api_show_and_model_info_once(self):
        from agent.model_metadata import get_model_context_length

        fake_get, calls = _gateway(models=_response(200, CATALOG), model_info=_response(404))
        with patch("agent.model_metadata.requests.get", side_effect=fake_get), \
             patch("httpx.Client", return_value=_ollama_client(65536)) as client_cls:
            first = get_model_context_length(MODEL, base_url=URL, api_key="sk-gateway")
            second = get_model_context_length(MODEL, base_url=URL, api_key="sk-gateway")

        assert first == second == 65536
        assert len(_info_calls(calls)) == 1
        client_cls.assert_called()

    def test_no_catalog_no_model_info_probe(self):
        from agent.model_metadata import get_model_context_length

        fake_get, calls = _gateway(models=_response(404), model_info=_response(200, _model_info()))
        with patch("agent.model_metadata.requests.get", side_effect=fake_get), \
             patch("httpx.Client", return_value=_ollama_client()):
            get_model_context_length(MODEL, base_url=URL, api_key="sk-gateway")

        assert _info_calls(calls) == []

    def test_keyless_lookup_borrows_key_for_model_info(self):
        from agent.model_metadata import get_model_context_length

        fake_get, calls = _gateway(
            models=_response(200, CATALOG),
            model_info=_response(200, _model_info((MODEL, {"max_input_tokens": 131072}))),
        )
        with patch("agent.model_metadata.requests.get", side_effect=fake_get), \
             patch("httpx.Client") as client_cls:
            get_model_context_length(MODEL, base_url=URL, api_key="sk-gateway")
            from agent import model_metadata as mm

            mm._endpoint_model_metadata_cache_time.clear()
            mm._litellm_model_info_cache.clear()
            ctx = get_model_context_length(MODEL, base_url=URL)

        assert ctx == 131072
        assert all(auth == "Bearer sk-gateway" for _, auth in calls)
        client_cls.assert_not_called()
