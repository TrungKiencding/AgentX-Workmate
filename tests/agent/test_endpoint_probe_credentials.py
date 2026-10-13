"""Keyless metadata probes reuse the key already used for the same endpoint.

Pricing lookups, insights and the mid-turn overflow guards know only an
endpoint's base URL. Against a keyed gateway (LiteLLM) their ``/models`` and
``/api/show`` probes went out with no Authorization header, drew a 401, and
showed up in the gateway's logs as a failed request every few minutes.

Covers:
- a keyless ``/models`` probe borrowing the key a keyed probe sent to that host
- a keyless 401 not caching ``{}`` over the catalog a keyed caller would get
- a host that refused a keyless probe not being asked keyless again
- ``/api/show`` borrowing the key, and skipping a keyless POST once refused
- the borrowed key never reaching a different host
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

URL = "https://gateway.example/v1"
OTHER_URL = "https://other.example/v1"


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

    clear()
    yield
    clear()


def _response(status_code, payload=None):
    response = MagicMock()
    response.status_code = status_code
    response.json.return_value = payload or {}
    if status_code >= 400:
        response.raise_for_status.side_effect = RuntimeError(str(status_code))
    return response


def _catalog():
    return _response(200, {"data": [{"id": "test/model", "context_length": 65536}]})


def _auth(call):
    return call.kwargs["headers"].get("Authorization")


def _expire(url):
    from agent import model_metadata as mm

    mm._endpoint_model_metadata_cache_time[mm._normalize_base_url(url)] = 0


class TestModelsProbe:
    def test_keyless_probe_borrows_key_of_earlier_keyed_probe(self):
        from agent.model_metadata import fetch_endpoint_model_metadata

        with patch("agent.model_metadata.requests.get", side_effect=[_catalog(), _catalog()]) as get:
            fetch_endpoint_model_metadata(URL, api_key="sk-gateway")
            _expire(URL)
            result = fetch_endpoint_model_metadata(URL)

        assert result["test/model"]["context_length"] == 65536
        assert [_auth(call) for call in get.call_args_list] == [
            "Bearer sk-gateway",
            "Bearer sk-gateway",
        ]

    def test_keyless_refusal_does_not_hide_catalog_from_keyed_caller(self):
        from agent.model_metadata import fetch_endpoint_model_metadata

        with patch(
            "agent.model_metadata.requests.get",
            side_effect=[_response(401), _catalog()],
        ) as get:
            assert fetch_endpoint_model_metadata(URL) == {}
            result = fetch_endpoint_model_metadata(URL, api_key="sk-gateway")

        assert result["test/model"]["context_length"] == 65536
        assert [_auth(call) for call in get.call_args_list] == [None, "Bearer sk-gateway"]

    def test_refused_host_is_not_probed_keyless_again(self):
        from agent.model_metadata import fetch_endpoint_model_metadata

        with patch("agent.model_metadata.requests.get", return_value=_response(401)) as get:
            fetch_endpoint_model_metadata(URL)
            assert fetch_endpoint_model_metadata(URL, force_refresh=True) == {}

        get.assert_called_once()

    def test_key_is_not_lent_to_another_host(self):
        from agent.model_metadata import fetch_endpoint_model_metadata

        with patch("agent.model_metadata.requests.get", side_effect=[_catalog(), _catalog()]) as get:
            fetch_endpoint_model_metadata(URL, api_key="sk-gateway")
            fetch_endpoint_model_metadata(OTHER_URL)

        assert _auth(get.call_args_list[1]) is None


def _client(status_code=404):
    client = MagicMock()
    client.__enter__ = lambda s: client
    client.__exit__ = MagicMock(return_value=False)
    client.post.return_value = _response(status_code)
    return client


class TestApiShowProbe:
    def test_keyless_api_show_borrows_key(self):
        from agent.model_metadata import _endpoint_probe_api_key, _query_ollama_api_show_uncached

        _endpoint_probe_api_key(URL, "sk-gateway")
        with patch("httpx.Client", return_value=_client()) as client_cls:
            assert _query_ollama_api_show_uncached("test/model", URL) is None

        assert client_cls.call_args.kwargs["headers"] == {"Authorization": "Bearer sk-gateway"}

    def test_keyless_api_show_skipped_on_refused_host(self):
        from agent.model_metadata import _query_ollama_api_show_uncached, fetch_endpoint_model_metadata

        with patch("agent.model_metadata.requests.get", return_value=_response(401)):
            fetch_endpoint_model_metadata(URL)
        with patch("httpx.Client") as client_cls:
            assert _query_ollama_api_show_uncached("test/model", URL) is None

        client_cls.assert_not_called()
