"""Inference for signed-in Workmate accounts always uses their AgentX gateway.

Standalone CLI profiles remain independent. Account homes are identified by
an identity sidecar or provisioning record, so a missing key never enables a
fallback to another vendor.
"""

from __future__ import annotations

from dataclasses import dataclass

from hermes_constants import account_slug_for_home, get_hermes_home


def _is_retired_gateway(endpoint: str) -> bool:
    """True for an https address on a host the AgentX AI Gateway has left."""
    from urllib.parse import urlsplit

    from hermes_cli.config_defaults import RETIRED_GATEWAY_HOSTS

    try:
        parts = urlsplit(endpoint)
        port = parts.port
    except ValueError:
        return False
    return (
        parts.scheme == "https"
        and (parts.hostname or "") in RETIRED_GATEWAY_HOSTS
        and port is None
        and parts.path in ("", "/")
    )


@dataclass(frozen=True)
class AccountInference:
    provider: str
    base_url: str
    key_env: str

    def allows(self, provider: str, base_url: str = "") -> bool:
        from hermes_cli.litellm_admin import normalize_base_url

        slug = (provider or "").strip().lower()
        expected = self.provider.lower()
        endpoint = normalize_base_url(base_url or "").lower()
        own_endpoint = normalize_base_url(self.base_url).lower()
        # Persisted sessions store the resolved provider as "custom" and its
        # endpoint. That pair is accepted only for the managed endpoint.
        # A retired address of the gateway is the gateway: a chat saved before it
        # moved must keep working, and callers send requests to self.base_url.
        own = endpoint == own_endpoint or _is_retired_gateway(endpoint)
        named = slug in {expected, f"custom:{expected}"}
        resolved = slug == "custom" and bool(endpoint) and own
        return (named or resolved) and (not endpoint or own)


def account_inference() -> AccountInference | None:
    from hermes_cli.accounts import ACCOUNT_IDENTITY_FILENAME
    from hermes_cli.account_provisioning import (
        STATE_FILENAME,
        load_settings,
        provider_key_env,
        read_state,
    )
    from hermes_cli.litellm_admin import openai_base_url

    home = get_hermes_home()
    state = read_state(home)
    if (
        not (home / ACCOUNT_IDENTITY_FILENAME).exists()
        and not (home / STATE_FILENAME).exists()
        and not account_slug_for_home(home)
    ):
        return None
    settings = load_settings()
    provider = str(state.get("provider") or settings.provider_name).strip()
    base_url = str(state.get("base_url") or settings.base_url).strip()
    return AccountInference(
        provider=provider,
        base_url=openai_base_url(base_url) if base_url else "",
        key_env=str(state.get("key_env") or provider_key_env(provider)),
    )


def require_account_provider(provider: str, base_url: str = "") -> None:
    policy = account_inference()
    if policy is not None and not policy.allows(provider, base_url):
        raise ValueError("This account can only use models through AgentX AI Gateway.")
