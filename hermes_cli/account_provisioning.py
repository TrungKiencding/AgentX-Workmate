"""Turn a signed-in identity into a provider key that belongs to that person.

An AgentX Workmate install is one machine, many possible people. Signing in
already gives each of them their own state directory (``hermes_cli.accounts``);
this module gives each of them their own *model access*: a LiteLLM virtual key
minted for them, written into their account's ``.env``, and referenced from
their account's ``config.yaml``. Ten people on one laptop end up with ten keys
and ten spend lines instead of one key everybody shares.

Three ways to get the key, chosen by ``accounts.litellm.mode``:

**second_brain** (the shipped default)
    The laptop asks the second-brain service, which mints **once per person**
    and hands the same key back to every machine they sign in on. The LiteLLM
    admin key stays on that service. This is the mode that fixes the fault the
    other two share: a key looked up by an alias derived from somebody's
    ``sub`` is a key every one of their machines competes for, and both older
    paths deleted whatever wore that alias before minting. Signing in on a
    second laptop revoked the first laptop's key.

**broker** (deprecated)
    The laptop POSTs its Keycloak bearer to a central service that mints on
    its behalf. Keeps the admin key off laptops, which was its point, but
    still mints per machine rather than per person — so it does not solve the
    multi-device problem, only the credential-exposure one.

**direct** (deprecated, removed 2027-02-13)
    The laptop calls LiteLLM's admin API itself with
    ``AGENTX_LITELLM_ADMIN_KEY``. Nothing to deploy, and it carries the full
    exposure: the product runs on employees' machines, so an admin key on the
    laptop is one every employee can read out of ``.env`` and use to mint
    themselves unlimited budget or enumerate their colleagues' keys. It is no
    longer shipped in the installer.

All three converge on the same idempotency rule: **one LiteLLM key per person,
reused until it stops working.** Provisioning runs on every sign-in, so
anything that minted unconditionally would leave a trail of orphaned keys —
one per launch, per person.

**No path here deletes a key by alias.** That is the defect this module was
carrying: an alias is shared by all of one person's machines, so deleting by it
is deleting somebody else's working key. Rotation retires the token *this
account recorded when it minted*, and nothing else.
"""

from __future__ import annotations

import json
import logging
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
from hermes_cli.second_brain_client import (
    SecondBrainClient,
    SecondBrainError,
    install_device_identity,
)

logger = logging.getLogger(__name__)

# Credential holding the LiteLLM admin key in direct mode. A secret, so it
# lives in .env rather than config.yaml.
ADMIN_KEY_ENV_VAR = "AGENTX_LITELLM_ADMIN_KEY"

#: Modes ``accounts.litellm.mode`` accepts. Anything else falls back to
#: ``second_brain``, which is the one that needs no credential on the machine
#: and cannot revoke another device's key.
MODES = ("second_brain", "broker", "direct")

#: When ``mode: "direct"`` goes away. Named rather than open-ended: a
#: compatibility flag with no end date is a compatibility flag forever, and
#: this one keeps an admin credential on employees' laptops.
DIRECT_MODE_REMOVAL_DATE = "2027-02-13"

# Sidecar recording what was provisioned, next to the account's state. It
# deliberately holds no plaintext key: the key lives in .env, where the rest
# of the credential machinery (rotation, scrubbing, redaction) already knows
# how to handle it. What is here is only what we need to recognise our own
# work on the next launch.
STATE_FILENAME = "litellm-account.json"

_STATE_VERSION = 1

#: What the account's proxy is CALLED in every picker — Settings → Model, the
#: composer's model menu, ``agentx model``. The slug stays ``litellm`` (it keys
#: the ``providers:`` entry, the ``model.provider`` pin, and the key env var, so
#: renaming it would strand every saved choice); only the label people read
#: changes. Existing configs are relabelled by the v34 config migration, which
#: matches on the old literal below.
PROVIDER_DISPLAY_NAME = "AI Gateway"

#: The label this shipped before ``PROVIDER_DISPLAY_NAME``. Kept so the
#: migration and its test agree on exactly what is being replaced.
LEGACY_PROVIDER_DISPLAY_NAME = "LiteLLM"


class ProvisioningError(RuntimeError):
    """Provisioning could not complete. The message is operator-facing."""


@dataclass(frozen=True)
class LiteLLMAccountSettings:
    """The ``accounts.litellm`` config section, resolved and typed."""

    enabled: bool = False
    base_url: str = ""
    mode: str = "second_brain"
    broker_url: str = ""
    #: Copied from the sibling ``accounts.second_brain.base_url`` rather than
    #: restated under ``accounts.litellm``. One install talks to one service,
    #: and two settings naming it would eventually name two.
    second_brain_url: str = ""
    provider_name: str = "litellm"
    key_alias_prefix: str = "second-brain"
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
        if self.mode == "second_brain":
            return bool(self.second_brain_url)
        if self.mode == "broker":
            return bool(self.broker_url)
        return bool(self.base_url)

    @property
    def missing_setting(self) -> str:
        """The setting an unconfigured install has to fill in, by name."""
        if self.mode == "second_brain":
            return "accounts.second_brain.base_url"
        if self.mode == "broker":
            return "accounts.litellm.broker_url"
        return "accounts.litellm.base_url"

    def alias_for(
        self,
        account_slug: str = "",
        *,
        subject: str = "",
        username: str = "",
        display_name: str = "",
        email: str = "",
    ) -> str:
        """The label this person's key wears in LiteLLM.

        One alias per person, deliberately — the same person on two machines
        gets one name in the proxy's console because they have one key. It is
        a label and nothing more: no code path here looks a key up by it, let
        alone deletes one.

        When identity fields are supplied the alias is ``{prefix}-{username}``
        derived from Keycloak (``Lê Trung Kiên`` → ``second-brain-letrungkien``).
        ``account_slug`` alone is a legacy fallback for callers that have not
        moved to identity-based naming yet.
        """
        from hermes_cli.accounts import litellm_key_alias_for_identity

        if subject or username or display_name or email:
            return litellm_key_alias_for_identity(
                self.key_alias_prefix,
                subject=subject,
                username=username,
                display_name=display_name,
                email=email,
            )
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

    mode = _str("mode", "second_brain").lower()
    if mode not in MODES:
        # The safe one: it needs no credential on this machine and cannot
        # delete a key another of this person's devices is using.
        mode = "second_brain"

    # The service URL lives under its own section, because the device list and
    # (from Phase 3) the change feed use the same one.
    brain_section = cfg_get(cfg, "accounts", "second_brain", default=None)
    if not isinstance(brain_section, dict):
        brain_section = {}
    second_brain_url = str(brain_section.get("base_url") or "").strip().rstrip("/")

    return LiteLLMAccountSettings(
        enabled=bool(section.get("enabled", False)),
        base_url=normalize_base_url(_str("base_url")),
        mode=mode,
        broker_url=_str("broker_url").rstrip("/"),
        second_brain_url=second_brain_url,
        provider_name=_str("provider_name", "litellm") or "litellm",
        key_alias_prefix=_str("key_alias_prefix", "second-brain") or "second-brain",
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

    Only direct mode calls this. The point of the other two modes is that this
    value does not exist on the machine at all, and since the key vault
    shipped it is no longer placed there by the installer either.
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
    previous_token: str = "",
) -> MintedKey:
    """Mint against LiteLLM's admin API from this machine.

    Deprecated, and reached only under an explicit ``mode: "direct"``. Every
    launch through here logs why, because the admin key it needs is one every
    person using this machine can read out of ``.env``.
    """
    logger.warning(
        "accounts.litellm.mode is 'direct', so this machine holds %s and mints "
        "its own keys. That credential can mint and revoke for the whole "
        "estate and anyone with this machine can read it. Direct mode is "
        "removed on %s — move to mode: 'second_brain' and set "
        "accounts.second_brain.base_url.",
        ADMIN_KEY_ENV_VAR,
        DIRECT_MODE_REMOVAL_DATE,
    )

    if client is None:
        admin = _admin_key()
        if not admin:
            raise ProvisioningError(
                f"accounts.litellm.mode is 'direct' but {ADMIN_KEY_ENV_VAR} is not set. "
                "Add it to this machine's .env, or switch to mode 'second_brain' "
                "so the admin key never leaves your server."
            )
        client = LiteLLMAdminClient(
            settings.base_url, admin, timeout=settings.request_timeout_seconds
        )

    # Retire the key THIS ACCOUNT recorded when it last minted, and nothing
    # else. What used to be here was a delete of everything wearing the alias,
    # and that was the defect the second brain exists to fix: one person's
    # machines all share an alias, so deleting by it deletes a colleague
    # machine's working key. A key we cannot name is a key we leave alone —
    # it costs an orphan in the proxy, which an operator can see and remove,
    # where the alternative cost somebody their other laptop.
    if previous_token:
        client.delete_keys([previous_token])

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


def _key_from_second_brain(
    settings: LiteLLMAccountSettings,
    identity: AccountIdentity,
    alias: str,
    bearer: str,
    *,
    device_id: str = "",
    device_name: str = "",
    rotate: bool = False,
    transport: Any | None = None,
) -> tuple[MintedKey, str, str]:
    """Ask the second brain for this person's key.

    Returns the key, the proxy URL, and what the service says it did —
    ``issued``, ``reused`` or ``rotated``. That last one matters: reporting
    "rotated" in Settings when the service simply handed back the key this
    person already had would describe the fix as though it were the bug.

    Usually this mints nothing at all: the service holds one key per person and
    hands the same plaintext to every machine, so the second device to sign in
    gets a copy rather than a replacement. That is the whole fix — the reason
    this path exists is that the other two could not do it, because LiteLLM
    reveals a key's plaintext exactly once and only the machine that minted it
    ever had one.

    The service is the authority on the proxy URL as well as on the key, so a
    ``base_url`` in the response wins over the local setting: an operator who
    moves LiteLLM changes one server rather than every laptop.
    """
    if not bearer:
        raise ProvisioningError(
            "second_brain mode needs the signed-in user's access token, and "
            "none was supplied. This is a bug in the caller, not a "
            "configuration problem."
        )

    if not device_id:
        # Only reached without a desktop above us — a CLI sign-in, or a
        # backend somebody started by hand. The service refuses a request that
        # will not name its machine, so name it.
        device_id, fallback_name = install_device_identity()
        device_name = device_name or fallback_name

    client = SecondBrainClient(
        settings.second_brain_url,
        timeout=settings.request_timeout_seconds,
        transport=transport,
    )
    payload = client.model_key(
        bearer=bearer,
        device_id=device_id,
        device_name=device_name,
        rotate=rotate,
    )
    if not isinstance(payload, dict):
        raise ProvisioningError("the second brain returned an unexpected body")

    key = str(payload.get("key") or "").strip()
    if not key:
        raise ProvisioningError("the second brain returned no key")

    minted = MintedKey(
        key=key,
        token=str(payload.get("token") or ""),
        key_alias=str(payload.get("key_alias") or alias),
        models=tuple(str(m) for m in (payload.get("models") or ())),
    )
    base_url = normalize_base_url(str(payload.get("base_url") or "")) or settings.base_url
    return minted, base_url, str(payload.get("status") or "issued")


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
    default_model: str = "",
    previous_models: tuple[str, ...] = (),
) -> None:
    """Point this account's ``providers:`` entry at the proxy and its key env.

    Merges onto whatever is already there. The block is not ours alone — a
    user may have hand-added ``extra_headers`` or an ``api_mode`` — and
    rebuilding it from scratch on every sign-in would quietly delete their
    work.

    ``previous_models`` is what the last provisioning run recorded, and it is
    what makes the merge able to SHRINK. Without it the model map only ever
    grew: a key replaced by one that reaches fewer models left every id the old
    key could reach sitting in the picker, so people kept being offered models
    their key was refused for. Only ids we wrote ourselves are removed — an id
    the user added by hand is theirs and stays.
    """
    from hermes_cli.config import load_config, save_config

    cfg = load_config()
    providers = cfg.get("providers")
    if not isinstance(providers, dict):
        providers = {}

    existing = providers.get(settings.provider_name)
    entry: dict[str, Any] = dict(existing) if isinstance(existing, dict) else {}
    entry.setdefault("name", PROVIDER_DISPLAY_NAME)
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

    # Ids the LAST run wrote that this key can no longer reach. Scoped to our
    # own previous list on purpose: anything else in the map was put there by
    # the user, and this is not the place to prune it.
    retired_models = tuple(m for m in previous_models if m not in models) if models else ()

    if models:
        existing_models = entry.get("models")
        model_map: dict[str, Any] = (
            dict(existing_models) if isinstance(existing_models, dict) else {}
        )
        for retired in retired_models:
            model_map.pop(retired, None)
        for model_id in models:
            current = model_map.get(model_id)
            model_map[model_id] = dict(current) if isinstance(current, dict) else {}
        entry["models"] = model_map

    providers[settings.provider_name] = entry
    cfg["providers"] = providers

    # Pin the account's default model only when we have one and the user has
    # not already chosen. Overriding a model somebody picked themselves, on
    # every sign-in, would be maddening.
    #
    # ``default_model`` comes from the key, not from a constant: the service
    # sorts what it grants so a chat model leads, and the caller hands us the
    # first entry. A shipped constant is how an installer came to pin
    # ``Qwen3.5-35B`` at a proxy that had moved to 3.6 — the app then opened on
    # a model group that did not exist, and the error named the model rather
    # than the stale default that chose it.
    #
    # The main-slot key is ``model.default`` — ``model.model`` is not a thing,
    # and writing it puts the choice somewhere no resolver looks.
    #
    # The one case that DOES overwrite an existing default is a default we
    # pinned ourselves that this key can no longer reach. Leaving it would sit
    # the account on a dead model group on every launch, and the error the user
    # sees names the model rather than the stale pin that chose it — the same
    # failure as the shipped-constant default, arrived at from the other side.
    # A model the user picked by hand is never in ``previous_models``, so their
    # choice still stands.
    chosen = (default_model or settings.default_model or "").strip()
    if chosen:
        model_cfg = cfg.get("model")
        model_cfg = dict(model_cfg) if isinstance(model_cfg, dict) else {}
        current_default = str(model_cfg.get("default") or "").strip()
        ours_and_unreachable = bool(
            current_default
            and models
            and current_default in previous_models
            and current_default not in models
        )
        if not current_default or ours_and_unreachable:
            model_cfg["provider"] = settings.provider_name
            model_cfg["default"] = chosen
            model_cfg["key_env"] = key_env
            model_cfg.pop("api_key", None)
            cfg["model"] = model_cfg

    save_config(cfg, merge_existing=True)

    # A removal cannot ride along with that write. ``merge_existing`` deep-
    # merges the on-disk section back over ours precisely so a partial caller
    # cannot drop somebody's sibling keys — which means a model id we just took
    # out of the map comes straight back. Deletions go through a full-document
    # write against the raw config instead, the same route the config
    # migrations take (see ``_persist_migration``'s docstring).
    if retired_models:
        _drop_provider_models(settings.provider_name, retired_models)


def _drop_provider_models(provider_name: str, retired: tuple[str, ...]) -> None:
    """Delete ``retired`` model ids from a provider's entry in config.yaml."""
    from hermes_cli.config import read_raw_config, save_config

    raw = read_raw_config()
    providers = raw.get("providers")
    entry = providers.get(provider_name) if isinstance(providers, dict) else None
    models = entry.get("models") if isinstance(entry, dict) else None

    if not isinstance(models, dict):
        return

    removed = [model_id for model_id in retired if model_id in models]

    if not removed:
        return

    for model_id in removed:
        del models[model_id]

    save_config(raw)


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
    device_id: str = "",
    device_name: str = "",
    force_rotate: bool = False,
    settings: LiteLLMAccountSettings | None = None,
    home: Path | None = None,
    client: LiteLLMAdminClient | None = None,
    broker_transport: Any | None = None,
    brain_transport: Any | None = None,
) -> ProvisionResult:
    """Make sure this account holds a working LiteLLM key, and return what happened.

    Called on every sign-in, so the common path has to be cheap and silent:
    a key we already minted, still accepted by the proxy, is reused with one
    ``GET /v1/models``. A key that is missing, or that the proxy no longer
    accepts, is replaced — and in ``second_brain`` mode "replaced" usually
    means "collected from the service", which is why a second machine no
    longer costs somebody their first one.

    Never raises for "the service is unreachable" — a person who opens their
    laptop on a train must still get their agent, with the key they already
    have. Only a genuine misconfiguration (direct mode with no admin key, a
    service that rejects the sign-in) surfaces as an error status, and only a
    revoked device surfaces as ``revoked``.
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
        return ProvisionResult(
            status="unconfigured",
            detail=f"{settings.missing_setting} is not set.",
        )

    alias = settings.alias_for(
        account_slug,
        subject=identity.subject,
        username=identity.username,
        display_name=identity.display_name,
        email=identity.email,
    )
    key_env = provider_key_env(settings.provider_name)
    state = read_state(home)

    from hermes_cli.config import get_env_value_prefer_dotenv

    stored_key = (get_env_value_prefer_dotenv(key_env) or "").strip()
    base_url = normalize_base_url(str(state.get("base_url") or "")) or settings.base_url

    # 1. Reuse. The cheapest and by far the most common outcome.
    if (
        stored_key
        and not force_rotate
        and state.get("key_alias") == alias
        and _key_came_from_the_current_authority(state, settings)
    ):
        if not base_url:
            # A service- or broker-only install that has not learned the proxy
            # URL yet.
            return _rotate(
                settings, identity, account_slug, alias, key_env, home, bearer,
                client=client, broker_transport=broker_transport,
                brain_transport=brain_transport, device_id=device_id,
                device_name=device_name, reason="no base URL on record",
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

    # 2. Fetch, mint, or re-mint.
    #
    # Only an explicit rotation asks the second brain for a NEW key. A stored
    # key the proxy no longer accepts means somebody rotated from another
    # machine, and the right answer to that is to collect what they rotated
    # to — not to rotate again and take their key in turn, which is the
    # ping-pong this whole project exists to end.
    if force_rotate:
        reason = "rotation requested"
    elif not stored_key:
        reason = "no key on this account yet"
    elif not _key_came_from_the_current_authority(state, settings):
        reason = "this account's key predates the second brain"
    else:
        reason = "the proxy no longer accepts the stored key"

    return _rotate(
        settings, identity, account_slug, alias, key_env, home, bearer,
        client=client, broker_transport=broker_transport,
        brain_transport=brain_transport, device_id=device_id,
        device_name=device_name, rotate=force_rotate, reason=reason,
    )


def _key_came_from_the_current_authority(
    state: Mapping[str, Any], settings: LiteLLMAccountSettings
) -> bool:
    """True when the stored key came from the source the current mode names.

    ``second_brain`` is the only mode that promises anything across machines:
    one key per person, held by the service, handed back to every device they
    sign in on. A key this account minted under the older ``direct`` or
    ``broker`` modes — or one whose sidecar predates the ``mode`` field
    altogether — carries no such promise. Reusing it means the person keeps a
    machine-local key forever and the service is never asked, which is exactly
    what an in-place upgrade looked like from the outside: sign-in worked, no
    key was ever collected, and the model list stayed the one the old key came
    with.

    Collecting instead is safe to do unprompted. The service answers with the
    key this person already has rather than minting a replacement, so the
    correction costs one request and takes nobody's key away.

    The deprecated modes keep the lenient behaviour on purpose: they mint by
    deleting first, so treating a brain-issued key as unusable there would
    retire a working key to fix nothing.
    """
    if settings.mode != "second_brain":
        return True

    return state.get("mode") == "second_brain"


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
    brain_transport: Any | None = None,
    device_id: str = "",
    device_name: str = "",
    rotate: bool = False,
) -> ProvisionResult:
    """Get this account a working key and wire it in.

    In ``second_brain`` mode this usually mints nothing: the service already
    holds this person's key and answers with it. ``rotate`` is the only thing
    that asks for a new one.
    """
    state = read_state(home)
    had_key = bool(state.get("key_alias"))
    service_status = ""

    try:
        if settings.mode == "second_brain":
            minted, base_url, service_status = _key_from_second_brain(
                settings, identity, alias, bearer,
                device_id=device_id, device_name=device_name,
                rotate=rotate, transport=brain_transport,
            )
        elif settings.mode == "broker":
            minted, base_url = _mint_via_broker(
                settings, identity, alias, bearer, transport=broker_transport
            )
        else:
            minted = _mint_direct(
                settings,
                identity,
                alias,
                client=client,
                previous_token=str(state.get("token") or ""),
            )
            base_url = settings.base_url
    except SecondBrainError as exc:
        if exc.revoked:
            # The one failure that must reach the user as "sign in again"
            # rather than "try later". The key on this machine is not the
            # problem and is left exactly where it is; what has ended is this
            # machine's permission to ask for it.
            return ProvisionResult(
                status="revoked",
                detail=(
                    "this device has been revoked. Sign in again to use it "
                    f"({exc})."
                ),
                provider=settings.provider_name,
                key_alias=alias,
                base_url=settings.base_url,
            )
        if exc.unreachable:
            return ProvisionResult(
                status="offline",
                detail=(
                    f"could not reach the second brain ({exc}); keeping "
                    "whatever key this account has."
                ),
                provider=settings.provider_name,
                key_alias=alias,
                base_url=settings.base_url,
            )
        if exc.status_code in (502, 503):
            # The service is up but cannot reach LiteLLM, or has no proxy
            # configured. Nothing was minted and nothing was lost — the same
            # answer as an outage, because that is what it is from here.
            return ProvisionResult(
                status="offline",
                detail=(
                    f"the second brain could not issue a key right now ({exc}); "
                    "keeping whatever key this account has."
                ),
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

    # The account's default model is the first one its key can reach. Only the
    # second brain vouches for that order — it sorts by configured mode so a
    # chat model leads — so the deprecated modes keep whatever the operator
    # configured rather than opening on whichever id `/v1/models` returned
    # first, which may well be an embedding model.
    default_model = (
        models[0] if settings.mode == "second_brain" and models else settings.default_model
    )

    _write_provider_config(
        settings,
        base_url,
        key_env,
        models,
        default_model=default_model,
        # What the previous run wrote, so ids this key no longer reaches can be
        # taken back out of the picker instead of accumulating forever.
        previous_models=tuple(str(m) for m in (state.get("models") or ())),
    )

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

    # What the second brain says it did beats what this machine assumed. A
    # laptop that fetched the key its owner's other laptop minted has neither
    # provisioned nor rotated anything, and telling somebody their key was
    # replaced when it was not is how a fix comes to look like the bug.
    if service_status == "reused":
        status, detail = "reused", (
            "collected this account's key from the second brain "
            f"({reason}); no new key was issued."
        )
    elif service_status == "rotated":
        status, detail = "rotated", (
            f"the second brain issued a replacement key for this account ({reason})."
        )
    elif service_status:
        status, detail = ("rotated" if had_key else "provisioned"), (
            f"the second brain issued this account's key ({reason})."
        )
    else:
        status, detail = ("rotated" if had_key else "provisioned"), (
            f"minted a new LiteLLM key for this account ({reason})."
        )

    return ProvisionResult(
        status=status,
        detail=detail,
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
