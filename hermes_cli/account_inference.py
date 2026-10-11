"""Inference for signed-in Workmate accounts always uses their AgentX gateway.

Standalone CLI profiles remain independent. Account homes are identified by
an identity sidecar or provisioning record, so a missing key never enables a
fallback to another vendor.
"""

from __future__ import annotations

from dataclasses import dataclass

from hermes_constants import account_slug_for_home, get_hermes_home


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
        named = slug in {expected, f"custom:{expected}"}
        resolved = slug == "custom" and bool(endpoint) and endpoint == own_endpoint
        return (named or resolved) and (not endpoint or endpoint == own_endpoint)


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
