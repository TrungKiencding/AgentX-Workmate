"""Image routing reads vision capability from the real models.dev lookup.

``_lookup_supports_vision`` calls ``get_model_capabilities(provider, model,
allow_network=True)``. When ``get_model_capabilities`` did not take that
keyword the TypeError was swallowed and every catalog model looked "unknown",
so a vision-capable main model was routed as text.

The other image-routing tests replace ``get_model_capabilities`` with a mock,
which accepts any keyword. These tests keep the real function and replace
only the registry fetch, so they need no network.
"""

import pytest

from agent import models_dev
from agent.image_routing import _lookup_supports_vision, decide_image_input_mode
from agent.models_dev import get_model_capabilities


REGISTRY = {
    "anthropic": {
        "models": {
            "claude-sonnet-4-6": {
                "tool_call": True,
                "attachment": True,
                "modalities": {"input": ["text", "image"], "output": ["text"]},
                "limit": {"context": 200000, "output": 64000},
            },
        },
    },
    "deepseek": {
        "models": {
            "deepseek-chat": {
                "tool_call": True,
                "attachment": False,
                "modalities": {"input": ["text"], "output": ["text"]},
                "limit": {"context": 128000, "output": 8192},
            },
        },
    },
}


@pytest.fixture
def registry_calls(monkeypatch):
    """Serve REGISTRY from the fetch hook and record how it was called."""
    calls = []

    def _fetch(force_refresh=False, *, allow_network=True):
        calls.append({"force_refresh": force_refresh, "allow_network": allow_network})
        return REGISTRY

    monkeypatch.setattr(models_dev, "fetch_models_dev", _fetch)
    return calls


def test_vision_capable_catalog_model_routes_native(registry_calls):
    assert _lookup_supports_vision("anthropic", "claude-sonnet-4-6", {}) is True
    assert decide_image_input_mode("anthropic", "claude-sonnet-4-6", {}) == "native"


def test_text_only_catalog_model_is_known_text_only(registry_calls):
    # False (known text-only), not None (unknown): the #31179 guard needs it.
    assert _lookup_supports_vision("deepseek", "deepseek-chat", {}) is False
    assert decide_image_input_mode("deepseek", "deepseek-chat", {}) == "text"


def test_image_routing_lookup_may_use_the_network_on_a_cold_cache(registry_calls):
    _lookup_supports_vision("anthropic", "claude-sonnet-4-6", {})

    assert registry_calls, "the capability lookup never reached the registry"
    assert all(call["allow_network"] is True for call in registry_calls)


def test_allow_network_false_never_asks_for_the_network(registry_calls):
    caps = get_model_capabilities("anthropic", "claude-sonnet-4-6", allow_network=False)

    assert caps is not None and caps.supports_vision is True
    assert registry_calls == [{"force_refresh": False, "allow_network": False}]


def test_default_lookup_keeps_the_zero_argument_fetch(monkeypatch):
    # Many tests replace fetch_models_dev with a zero-argument callable; the
    # default path must keep calling it that way.
    monkeypatch.setattr(models_dev, "fetch_models_dev", lambda: REGISTRY)

    caps = get_model_capabilities("anthropic", "claude-sonnet-4-6")
    assert caps is not None and caps.supports_vision is True
    assert get_model_capabilities(
        "anthropic", "claude-sonnet-4-6", allow_network=True
    ).supports_vision is True
