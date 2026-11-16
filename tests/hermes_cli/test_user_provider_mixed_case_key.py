"""A ``providers:`` key that carries uppercase (``Axonhub``, ``OpenAI``) must still resolve.

``resolve_provider_full`` lowercases the request before the user-config lookup, so a
case-sensitive dict read missed the key and ``OpenAI`` fell through to the built-in
``openai`` alias, switching to the wrong host.
"""

import pytest

from hermes_cli.providers import resolve_provider_full, resolve_user_provider


def _providers(key: str) -> dict:
    return {key: {"base_url": "http://127.0.0.1:9/v1", "api_key_env": "MIXED_KEY"}}


@pytest.mark.parametrize("key", ["Axonhub", "OpenAI"])
@pytest.mark.parametrize("requested", ["axonhub", "openai", "Axonhub", "OpenAI"])
def test_lowercased_request_finds_mixed_case_key(key, requested):
    if requested.lower() != key.lower():
        pytest.skip("different provider")
    pdef = resolve_user_provider(requested.lower(), _providers(key))
    assert pdef is not None
    assert pdef.id == key  # the config key, so user_config[pdef.id] still hits
    assert pdef.base_url == "http://127.0.0.1:9/v1"
    assert pdef.api_key_env_vars == ("MIXED_KEY",)


@pytest.mark.parametrize("key", ["Axonhub", "OpenAI"])
def test_full_resolution_routes_to_the_configured_endpoint(key):
    pdef = resolve_provider_full(key, user_providers=_providers(key))
    assert pdef is not None
    assert pdef.base_url == "http://127.0.0.1:9/v1"


def test_exact_key_still_preferred_over_case_fold():
    cfg = {"acme": {"base_url": "http://lower/v1"}, "ACME": {"base_url": "http://upper/v1"}}
    assert resolve_user_provider("acme", cfg).base_url == "http://lower/v1"
