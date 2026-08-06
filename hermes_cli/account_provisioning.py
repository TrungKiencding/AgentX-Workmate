"""Turn a signed-in identity into a provider key that belongs to that person.

An AgentX Workmate install is one machine, many possible people. Signing in
already gives each of them their own state directory (``hermes_cli.accounts``);
this module gives each of them their own *model access*: a LiteLLM virtual key
minted for them, written into their account's ``.env``, and referenced from
their account's ``config.yaml``. Ten people on one laptop end up with ten keys
and ten spend lines instead of one key everybody shares.

Two ways to get the key, chosen by ``accounts.litellm.mode``:

**broker** (the default, and the one to deploy)
    The laptop POSTs its Keycloak bearer to a central service, which verifies
    the token and mints on the user's behalf. The LiteLLM admin key stays on
    that service. This matters because the product runs on employees'
    machines: an admin key shipped to the laptop is an admin key every
    employee can read out of ``.env`` and use to mint themselves unlimited
    budget or enumerate their colleagues' keys.

**direct**
    The laptop calls LiteLLM's admin API itself with
    ``AGENTX_LITELLM_ADMIN_KEY``. Nothing to deploy, works today, and carries
    exactly the exposure described above. Good for a pilot on trusted
    machines; say so out loud before rolling it out.

Both paths converge on the same idempotency rule: **one LiteLLM key per
account, found by alias, reused until it stops working.** Provisioning runs on
every sign-in, so anything that minted unconditionally would leave a trail of
orphaned keys — one per launch, per person.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from hermes_cli.accounts import AccountIdentity
from hermes_cli.litellm_admin import (
    DEFAULT_TIMEOUT_SECONDS,
    LiteLLMAdminClient,
    LiteLLMError,
    MintedKey,
    mask_key,
    normalize_base_url,
    openai_base_url,
)

# Credential holding the LiteLLM admin key in direct mode. A secret, so it
# lives in .env rather than config.yaml.
ADMIN_KEY_ENV_VAR = "AGENTX_LITELLM_ADMIN_KEY"

# Sidecar recording what was provisioned, next to the account's state. It
# deliberately holds no plaintext key: the key lives in .env, where the rest
# of the credential machinery (rotation, scrubbing, redaction) already knows
# how to handle it. What is here is only what we need to recognise our own
# work on the next launch.
STATE_FILENAME = "litellm-account.json"

_STATE_VERSION = 1


class ProvisioningError(RuntimeError):
    """Provisioning could not complete. The message is operator-facing."""


@dataclass(frozen=True)
class LiteLLMAccountSettings:
    """The ``accounts.litellm`` config section, resolved and typed."""

    enabled: bool = False
    base_url: str = ""
    mode: str = "broker"
    broker_url: str = ""
    provider_name: str = "litellm"
    key_alias_prefix: str = "agentx-workmate"
    models: tuple[str, ...] = ()
    max_budget: float = 0.0
    budget_duration: str = ""
    tpm_limit: int = 0
    rpm_limit: int = 0
    default_model: str = ""
    discover_models: bool = True
    request_timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS

    @property
    def configured(self) -> bool:
        """True when this install actually wants per-account provisioning."""
        if not self.enabled:
            return False
        if self.mode == "broker":
            return bool(self.broker_url)
        return bool(self.base_url)

    def alias_for(self, account_slug: str) -> str:
        return f"{self.key_alias_prefix}-{account_slug}"


@dataclass(frozen=True)
class ProvisionResult:
    """What provisioning did, in terms a UI or a CLI can render."""

    status: str
    detail: str = ""
    provider: str = ""
    key_alias: str = ""
    masked_key: str = ""
    base_url: str = ""
    models: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return self.status in {"provisioned", "rotated", "reused"}

    def to_json(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "detail": self.detail,
            "provider": self.provider,
            "key_alias": self.key_alias,
            "masked_key": self.masked_key,
            "base_url": self.base_url,
            "models": list(self.models),
            "ok": self.ok,
        }


def load_machine_config() -> Mapping[str, Any]:
    """Load the config at the INSTALL root, whichever account we are running as.

    ``accounts.litellm`` is operator policy, not a personal preference: which
    proxy to mint against, whether to go through a broker, what budget each
    key carries. It is written once per machine — by an installer, an MDM
    push, or an admin running ``agentx config set`` — and every account has to
    inherit it.

    Reading it from the *account's* own config instead would break the feature
    outright: an account home is created at sign-in with no config.yaml, so
    the section would come back empty and nothing would ever be provisioned.
    """
    from hermes_cli.config import load_config
    from hermes_constants import (
        get_default_hermes_root,
        get_hermes_home,
        reset_hermes_home_override,
        set_hermes_home_override,
    )

    root = get_default_hermes_root()
    if root == get_hermes_home():
        return load_config()

    token = set_hermes_home_override(root)
    try:
        return load_config()
    finally:
        reset_hermes_home_override(token)


def load_settings(cfg: Mapping[str, Any] | None = None) -> LiteLLMAccountSettings:
    """Read ``accounts.litellm`` out of config, with the defaults applied."""
    from hermes_cli.config import cfg_get

    if cfg is None:
        cfg = load_machine_config()
    section = cfg_get(cfg, "accounts", "litellm", default=None)
    if not isinstance(section, dict):
        section = {}

    def _str(key: str, fallback: str = "") -> str:
        return str(section.get(key, fallback) or fallback).strip()

    def _int(key: str) -> int:
        try:
            return int(section.get(key) or 0)
        except (TypeError, ValueError):
            return 0

    def _float(key: str, fallback: float = 0.0) -> float:
        try:
            return float(section.get(key) or fallback)
        except (TypeError, ValueError):
            return fallback

    models = section.get("models")
    model_tuple = tuple(
        str(m).strip() for m in models if str(m).strip()
    ) if isinstance(models, (list, tuple)) else ()

    mode = _str("mode", "broker").lower()
    if mode not in {"broker", "direct"}:
        mode = "broker"

    return LiteLLMAccountSettings(
        enabled=bool(section.get("enabled", False)),
        base_url=normalize_base_url(_str("base_url")),
        mode=mode,
        broker_url=_str("broker_url").rstrip("/"),
        provider_name=_str("provider_name", "litellm") or "litellm",
        key_alias_prefix=_str("key_alias_prefix", "agentx-workmate") or "agentx-workmate",
        models=model_tuple,
        max_budget=_float("max_budget"),
        budget_duration=_str("budget_duration"),
        tpm_limit=_int("tpm_limit"),
        rpm_limit=_int("rpm_limit"),
        default_model=_str("default_model"),
        discover_models=bool(section.get("discover_models", True)),
        request_timeout_seconds=_float("request_timeout_seconds", DEFAULT_TIMEOUT_SECONDS)
        or DEFAULT_TIMEOUT_SECONDS,
    )


# ---------------------------------------------------------------------------
# State sidecar
# ---------------------------------------------------------------------------


def _state_path(home: Path) -> Path:
    return home / STATE_FILENAME


def read_state(home: Path) -> dict[str, Any]:
    """Return the provisioning sidecar, or ``{}`` when there isn't a usable one."""
    try:
        data = json.loads(_state_path(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_state(home: Path, state: Mapping[str, Any]) -> None:
    """Record what we provisioned. Best-effort: losing it costs one rotation."""
    path = _state_path(home)
    tmp = path.with_suffix(".json.tmp")
    try:
        tmp.write_text(
            json.dumps({**state, "version": _STATE_VERSION}, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        try:
            os.chmod(str(tmp), 0o600)
        except OSError:
            pass
        tmp.replace(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Minting
# ---------------------------------------------------------------------------


def _admin_key() -> str:
    """Return the LiteLLM admin key for direct mode, or ``""``.

    Checks this account's ``.env`` first, then the install root's. The root is
    where an operator actually puts it — one machine, one admin key, written
    before anybody has an account home to write it into — and without the
    fallback direct mode would only ever work in the shared home.

    Broker mode never calls this: the whole point of the broker is that this
    value does not exist on the machine at all.
    """
    from hermes_cli.config import get_env_value_prefer_dotenv
    from hermes_constants import (
        get_default_hermes_root,
        get_hermes_home,
        reset_hermes_home_override,
        set_hermes_home_override,
    )

    value = (get_env_value_prefer_dotenv(ADMIN_KEY_ENV_VAR) or "").strip()
    if value:
        return value

    root = get_default_hermes_root()
    if root == get_hermes_home():
        return ""

    token = set_hermes_home_override(root)
    try:
        return (get_env_value_prefer_dotenv(ADMIN_KEY_ENV_VAR) or "").strip()
    finally:
        reset_hermes_home_override(token)


def _mint_direct(
    settings: LiteLLMAccountSettings,
    identity: AccountIdentity,
    alias: str,
    *,
    client: LiteLLMAdminClient | None = None,
) -> MintedKey:
    """Mint against LiteLLM's admin API from this machine."""
    if client is None:
        admin = _admin_key()
        if not admin:
            raise ProvisioningError(
                f"accounts.litellm.mode is 'direct' but {ADMIN_KEY_ENV_VAR} is not set. "
                "Add it to this machine's .env, or switch to broker mode so the "
                "admin key never leaves your server."
            )
        client = LiteLLMAdminClient(
            settings.base_url, admin, timeout=settings.request_timeout_seconds
        )

    # Retire anything already wearing this alias. LiteLLM cannot hand back an
    # existing key's plaintext, so reaching here means we have no usable copy
    # of it — leaving it alive would just accumulate keys nobody holds.
    existing = client.keys_for_alias(alias)
    if existing:
        client.delete_keys([record.token for record in existing])

    return client.generate_key(
        key_alias=alias,
        user_id=identity.subject,
        models=settings.models,
        max_budget=settings.max_budget or None,
        budget_duration=settings.budget_duration,
        tpm_limit=settings.tpm_limit or None,
        rpm_limit=settings.rpm_limit or None,
        metadata={
            "source": "agentx-workmate",
            "email": identity.email,
            "username": identity.username,
            "issuer": identity.issuer,
        },
    )


def _mint_via_broker(
    settings: LiteLLMAccountSettings,
    identity: AccountIdentity,
    alias: str,
    bearer: str,
    *,
    transport: Any | None = None,
) -> tuple[MintedKey, str]:
    """Ask the central broker to mint. Returns the key and the base URL it names.

    The broker is the authority on the proxy URL as well as the key: an
    operator who moves LiteLLM should not have to push new config to every
    laptop, so a ``base_url`` in the response wins over the local setting.
    """
    import httpx

    if not bearer:
        raise ProvisioningError(
            "broker mode needs the signed-in user's access token, and none was "
            "supplied. This is a bug in the caller, not a configuration problem."
        )

    try:
        with httpx.Client(
            timeout=settings.request_timeout_seconds,
            transport=transport,
            follow_redirects=True,
        ) as client:
            response = client.post(
                settings.broker_url,
                json={"account": alias, "subject": identity.subject},
                headers={
                    "Authorization": f"Bearer {bearer}",
                    "Accept": "application/json",
                },
            )
    except httpx.RequestError as exc:
        raise ProvisioningError(
            f"could not reach the provisioning broker at {settings.broker_url}: {exc}"
        ) from exc

    if response.status_code == 401:
        raise ProvisioningError(
            "the provisioning broker rejected this sign-in. Sign out and in again; "
            "if it keeps happening the broker and this app disagree about the realm."
        )
    if response.status_code >= 400:
        detail = ""
        try:
            body = response.json()
            if isinstance(body, dict):
                detail = str(body.get("detail") or body.get("error") or "")
        except ValueError:
            detail = (response.text or "")[:300]
        raise ProvisioningError(
            f"the provisioning broker returned HTTP {response.status_code}"
            f"{f': {detail}' if detail else ''}"
        )

    try:
        payload = response.json()
    except ValueError as exc:
        raise ProvisioningError("the provisioning broker returned a non-JSON body") from exc
    if not isinstance(payload, dict):
        raise ProvisioningError("the provisioning broker returned an unexpected body")

    key = str(payload.get("key") or "").strip()
    if not key:
        raise ProvisioningError("the provisioning broker returned no key")

    minted = MintedKey(
        key=key,
        token=str(payload.get("token") or ""),
        key_alias=str(payload.get("key_alias") or alias),
        models=tuple(str(m) for m in (payload.get("models") or ())),
    )
    base_url = normalize_base_url(str(payload.get("base_url") or "")) or settings.base_url
    return minted, base_url


# ---------------------------------------------------------------------------
# Writing the key where the agent will actually find it
# ---------------------------------------------------------------------------


def _write_provider_config(
    settings: LiteLLMAccountSettings,
    base_url: str,
    key_env: str,
    models: tuple[str, ...],
) -> None:
    """Point this account's ``providers:`` entry at the proxy and its key env.

    Merges onto whatever is already there. The block is not ours alone — a
    user may have hand-added ``extra_headers`` or an ``api_mode`` — and
    rebuilding it from scratch on every sign-in would quietly delete their
    work.
    """
    from hermes_cli.config import load_config, save_config

    cfg = load_config()
    providers = cfg.get("providers")
    if not isinstance(providers, dict):
        providers = {}

    existing = providers.get(settings.provider_name)
    entry: dict[str, Any] = dict(existing) if isinstance(existing, dict) else {}
    entry.setdefault("name", "LiteLLM")
    entry["base_url"] = openai_base_url(base_url)
    entry["key_env"] = key_env
    entry["discover_models"] = settings.discover_models
    # Deliberately not writing ``enabled``: it defaults to true, and forcing
    # it on every sign-in would silently undo a user who turned this provider
    # off on purpose.
    #
    # A key written to .env and referenced by key_env must not also sit in
    # config.yaml in plaintext (#69449); drop any legacy inline copy.
    entry.pop("api_key", None)

    if models:
        existing_models = entry.get("models")
        model_map: dict[str, Any] = (
            dict(existing_models) if isinstance(existing_models, dict) else {}
        )
        for model_id in models:
            current = model_map.get(model_id)
            model_map[model_id] = dict(current) if isinstance(current, dict) else {}
        entry["models"] = model_map

    providers[settings.provider_name] = entry
    cfg["providers"] = providers

    # Pin the account's default model only when the operator asked for one and
    # the user has not already chosen. Overriding a model somebody picked
    # themselves, on every sign-in, would be maddening.
    #
    # The main-slot key is ``model.default`` — ``model.model`` is not a thing,
    # and writing it puts the choice somewhere no resolver looks.
    if settings.default_model:
        model_cfg = cfg.get("model")
        model_cfg = dict(model_cfg) if isinstance(model_cfg, dict) else {}
        if not str(model_cfg.get("default") or "").strip():
            model_cfg["provider"] = settings.provider_name
            model_cfg["default"] = settings.default_model
            model_cfg["key_env"] = key_env
            model_cfg.pop("api_key", None)
            cfg["model"] = model_cfg

    save_config(cfg, merge_existing=True)


def provider_key_env(provider_name: str) -> str:
    """Return the env var holding this provider's per-account key."""
    from hermes_cli.config import custom_endpoint_key_env

    return custom_endpoint_key_env(provider_name)


# ---------------------------------------------------------------------------
# The entry point
# ---------------------------------------------------------------------------


def ensure_account_key(
    identity: AccountIdentity,
    account_slug: str,
    *,
    bearer: str = "",
    force_rotate: bool = False,
    settings: LiteLLMAccountSettings | None = None,
    home: Path | None = None,
    client: LiteLLMAdminClient | None = None,
    broker_transport: Any | None = None,
) -> ProvisionResult:
    """Make sure this account holds a working LiteLLM key, and return what happened.

    Called on every sign-in, so the common path has to be cheap and silent:
    a key we already minted, still accepted by the proxy, is reused with one
    ``GET /v1/models``. A key that is missing, or that the proxy no longer
    accepts, is replaced.

    Never raises for "the proxy is unreachable" — a person who opens their
    laptop on a train must still get their agent, with the key they already
    have. Only a genuine misconfiguration (direct mode with no admin key, a
    broker that rejects the sign-in) surfaces as an error status.
    """
    from hermes_constants import get_hermes_home

    settings = settings or load_settings()
    home = home or get_hermes_home()

    if not settings.enabled:
        return ProvisionResult(
            status="disabled",
            detail="accounts.litellm.enabled is false; nothing to provision.",
        )
    if not settings.configured:
        missing = "broker_url" if settings.mode == "broker" else "base_url"
        return ProvisionResult(
            status="unconfigured",
            detail=f"accounts.litellm.{missing} is not set.",
        )

    alias = settings.alias_for(account_slug)
    key_env = provider_key_env(settings.provider_name)
    state = read_state(home)

    from hermes_cli.config import get_env_value_prefer_dotenv

    stored_key = (get_env_value_prefer_dotenv(key_env) or "").strip()
    base_url = normalize_base_url(str(state.get("base_url") or "")) or settings.base_url

    # 1. Reuse. The cheapest and by far the most common outcome.
    if stored_key and not force_rotate and state.get("key_alias") == alias:
        if not base_url:
            # Broker-only install that has not learned the proxy URL yet.
            return _rotate(
                settings, identity, account_slug, alias, key_env, home, bearer,
                client=client, broker_transport=broker_transport, reason="no base URL on record",
            )
        probe = _probe_client(settings, base_url, client)
        if probe is None or probe.key_is_live(stored_key):
            return ProvisionResult(
                status="reused",
                detail="the key already on this account is still valid.",
                provider=settings.provider_name,
                key_alias=alias,
                masked_key=mask_key(stored_key),
                base_url=base_url,
                models=tuple(state.get("models") or ()),
            )

    # 2. Mint (or re-mint).
    reason = "rotation requested" if force_rotate else (
        "no key on this account yet" if not stored_key else "the proxy no longer accepts the stored key"
    )
    return _rotate(
        settings, identity, account_slug, alias, key_env, home, bearer,
        client=client, broker_transport=broker_transport, reason=reason,
    )


def _probe_client(
    settings: LiteLLMAccountSettings,
    base_url: str,
    client: LiteLLMAdminClient | None,
) -> LiteLLMAdminClient | None:
    """Return a client able to check a key's liveness, or None when we can't.

    Liveness is a ``/v1/models`` call made with the *user's* key, so it needs
    no admin credential — but ``LiteLLMAdminClient`` insists on one at
    construction. In broker mode there is none on this machine, so pass a
    placeholder: it is never sent, because every call here overrides the
    Authorization header with the key under test.
    """
    if client is not None:
        return client
    try:
        return LiteLLMAdminClient(
            base_url,
            _admin_key() or "unused-liveness-probe",
            timeout=settings.request_timeout_seconds,
        )
    except LiteLLMError:
        return None


def _rotate(
    settings: LiteLLMAccountSettings,
    identity: AccountIdentity,
    account_slug: str,
    alias: str,
    key_env: str,
    home: Path,
    bearer: str,
    *,
    client: LiteLLMAdminClient | None,
    broker_transport: Any | None,
    reason: str,
) -> ProvisionResult:
    """Mint a fresh key and wire it into this account."""
    had_key = bool(read_state(home).get("key_alias"))

    try:
        if settings.mode == "broker":
            minted, base_url = _mint_via_broker(
                settings, identity, alias, bearer, transport=broker_transport
            )
        else:
            minted = _mint_direct(settings, identity, alias, client=client)
            base_url = settings.base_url
    except LiteLLMError as exc:
        if exc.unreachable:
            return ProvisionResult(
                status="offline",
                detail=f"could not reach LiteLLM ({exc}); keeping whatever key this account has.",
                provider=settings.provider_name,
                key_alias=alias,
                base_url=settings.base_url,
            )
        return ProvisionResult(
            status="error",
            detail=str(exc),
            provider=settings.provider_name,
            key_alias=alias,
            base_url=settings.base_url,
        )
    except ProvisioningError as exc:
        return ProvisionResult(
            status="error",
            detail=str(exc),
            provider=settings.provider_name,
            key_alias=alias,
            base_url=settings.base_url,
        )

    from hermes_cli.credential_lifecycle import save_provider_env_credential

    save_provider_env_credential(key_env, minted.key)

    models = minted.models
    if settings.discover_models and not models:
        models = tuple(_discover_models(settings, base_url, minted.key))

    _write_provider_config(settings, base_url, key_env, models)

    write_state(
        home,
        {
            "key_alias": alias,
            "token": minted.token,
            "base_url": base_url,
            "key_env": key_env,
            "provider": settings.provider_name,
            "subject": identity.subject,
            "account": account_slug,
            "mode": settings.mode,
            "models": list(models),
        },
    )

    return ProvisionResult(
        status="rotated" if had_key else "provisioned",
        detail=f"minted a new LiteLLM key for this account ({reason}).",
        provider=settings.provider_name,
        key_alias=alias,
        masked_key=minted.masked,
        base_url=base_url,
        models=models,
    )


def _discover_models(
    settings: LiteLLMAccountSettings, base_url: str, api_key: str
) -> list[str]:
    """List what the new key can reach, so the model picker isn't empty.

    Best-effort by design: a key that works for chat but whose ``/v1/models``
    times out is still a working key, and failing provisioning over a
    cosmetic list would be absurd.
    """
    try:
        client = LiteLLMAdminClient(
            base_url, api_key, timeout=settings.request_timeout_seconds
        )
        return client.list_models(api_key=api_key)
    except LiteLLMError:
        return []


def account_key_status(
    account_slug: str,
    *,
    settings: LiteLLMAccountSettings | None = None,
    home: Path | None = None,
) -> ProvisionResult:
    """Report what this account currently holds, without touching the network."""
    from hermes_constants import get_hermes_home

    settings = settings or load_settings()
    home = home or get_hermes_home()

    if not settings.enabled:
        return ProvisionResult(status="disabled", detail="accounts.litellm.enabled is false.")

    state = read_state(home)
    key_env = str(state.get("key_env") or provider_key_env(settings.provider_name))

    from hermes_cli.config import get_env_value_prefer_dotenv

    stored = (get_env_value_prefer_dotenv(key_env) or "").strip()
    if not stored:
        return ProvisionResult(
            status="missing",
            detail="this account has no LiteLLM key yet.",
            provider=settings.provider_name,
            key_alias=settings.alias_for(account_slug),
        )

    return ProvisionResult(
        status="reused",
        detail="a LiteLLM key is configured for this account.",
        provider=str(state.get("provider") or settings.provider_name),
        key_alias=str(state.get("key_alias") or settings.alias_for(account_slug)),
        masked_key=mask_key(stored),
        base_url=str(state.get("base_url") or settings.base_url),
        models=tuple(state.get("models") or ()),
    )
