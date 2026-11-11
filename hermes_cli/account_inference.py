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


class AccountGatewayError(ValueError):
    """An account's inference could not be resolved to its AgentX gateway.

    ``code`` is what a client shows the failure under. Without it the desktop
    read "agent init failed: …" and reported a generic local error — "Workmate
    hit a problem on this machine, restart it" — for what is really "this chat
    is pinned to a model your account cannot use" (pilot feedback 2026-11).
    The codes are ones the clients already have words for.
    """

    code = "operation_failed"


class AccountProviderNotAllowed(AccountGatewayError):
    """A chat, fallback or setting names a provider/endpoint other than the gateway."""

    code = "model_not_allowed"

    def __init__(self) -> None:
        super().__init__("This account can only use models through AgentX AI Gateway.")


class AccountGatewayNotConfigured(AccountGatewayError):
    """The account has no gateway address or key on record yet."""

    code = "auth_failed"

    def __init__(self) -> None:
        super().__init__(
            "AgentX AI Gateway is not configured for this account. "
            "Retry gateway setup or skip it for now."
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

    def accepts_runtime_request(self, provider: str, base_url: str = "") -> bool:
        """Whether a *runtime* request may be resolved for this account.

        Everything :meth:`allows` accepts, plus a bare ``custom`` with no
        endpoint. ``custom`` is how the gateway itself is reported back to
        clients (``resolve_runtime_provider`` returns it as the provider), so
        a client that echoes the session's provider on its next request sends
        exactly that — without the endpoint, which it never had. Rejecting it
        failed chats that were on a gateway model all along with "This account
        can only use models through AgentX AI Gateway".

        This is safe only where the caller then resolves to the account's own
        gateway unconditionally, which is why it is not part of ``allows``:
        config sanitation and catalog filtering use that to decide whether a
        *stored* entry is the gateway's, and a stored ``custom`` with no
        endpoint is not evidence of anything.
        """
        from hermes_cli.litellm_admin import normalize_base_url

        if (provider or "").strip().lower() == "custom" and not normalize_base_url(base_url or ""):
            return True
        return self.allows(provider, base_url)


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
        raise AccountProviderNotAllowed()
