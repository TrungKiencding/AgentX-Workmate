"""Everything the service reads from its environment, resolved once.

This is a server, not a laptop, so configuration comes from the environment
rather than from a ``config.yaml`` in somebody's AgentX home — that file
describes a person's install and does not exist here. The one exception is the
LiteLLM proxy URL, which is the same public value the app already ships in
``hermes_cli/config_defaults.py``; reading it from there keeps one deployment
from pointing at two different proxies.

Resolution is eager and total: :func:`load_settings` either returns a settings
object every field of which is usable, or raises
:class:`~second_brain.errors.BrainConfigError` naming what is missing. There is
no lazily-resolved credential, because the failure mode of one is a service
that starts green and breaks during somebody's sign-in.

``deploy/second-brain/.env.example`` lists every variable named here.
"""

from __future__ import annotations

import base64
import binascii
import os
from dataclasses import dataclass

from second_brain.errors import BrainConfigError

#: Postgres DSN, e.g. ``postgresql://brain:…@postgres:5432/brain``.
DATABASE_URL_ENV_VAR = "AGENTX_BRAIN_DATABASE_URL"

#: The key-encryption key protecting stored model keys, base64 of 32 bytes.
#: Generate with ``openssl rand -base64 32``.
KEK_ENV_VAR = "AGENTX_BRAIN_KEK"

#: Which KEK the rows written from now on are wrapped with. Stored per row, so
#: rotating the KEK is a re-encrypt job rather than an outage: both keys are
#: present during the roll and each row says which one opens it.
KEK_ID_ENV_VAR = "AGENTX_BRAIN_KEK_ID"

#: The KEK being retired, and its id. Set both during a roll so rows still
#: wearing the old id can be opened; each one is re-wrapped under the current
#: KEK the next time it is read, and once none is left these two come out
#: again. Without them a roll is an outage, not a rotation.
PREVIOUS_KEK_ENV_VAR = "AGENTX_BRAIN_KEK_PREVIOUS"
PREVIOUS_KEK_ID_ENV_VAR = "AGENTX_BRAIN_KEK_PREVIOUS_ID"

#: Overrides the LiteLLM proxy URL from ``accounts.litellm.base_url``.
LITELLM_BASE_URL_ENV_VAR = "AGENTX_BRAIN_LITELLM_BASE_URL"

#: The LiteLLM admin credential. Named identically to the laptop-side variable
#: it is replacing, because it is the same secret moving to the one machine
#: that should have held it all along.
LITELLM_ADMIN_KEY_ENV_VAR = "AGENTX_LITELLM_ADMIN_KEY"

#: Overrides ``accounts.litellm.key_alias_prefix``. The alias is the label a
#: person's key wears in the proxy's own console, so an operator running two
#: fleets against one proxy needs to be able to tell them apart. Everything
#: else about a minted key — the model allow-list, the budget and the rate
#: ceilings — comes from that same shipped policy and has no override here,
#: because those are fleet-wide decisions that belong in one place.
KEY_ALIAS_PREFIX_ENV_VAR = "AGENTX_BRAIN_KEY_ALIAS_PREFIX"

#: Connection-pool bounds. The service is small; the defaults are sized for a
#: few hundred devices polling on a 30-second tick, not for a fleet.
POOL_MIN_ENV_VAR = "AGENTX_BRAIN_POOL_MIN"
POOL_MAX_ENV_VAR = "AGENTX_BRAIN_POOL_MAX"

#: Largest body ``POST /v1/sync/push`` will read. One client must not be able
#: to exhaust the service's memory by announcing a body nobody bounded.
MAX_PUSH_BYTES_ENV_VAR = "AGENTX_BRAIN_MAX_PUSH_BYTES"

#: How long a delete is remembered. A tombstone is what stops a device that
#: was offline during the delete from pushing the row straight back, so the
#: window has to be comfortably longer than any plausible offline stretch —
#: a laptop that has been shut in a drawer for a season, not an afternoon.
TOMBSTONE_RETENTION_DAYS_ENV_VAR = "AGENTX_BRAIN_TOMBSTONE_RETENTION_DAYS"

#: How often the sweeper runs. Configurable mainly so a test can drive a sweep
#: without waiting a day for one.
TOMBSTONE_SWEEP_SECONDS_ENV_VAR = "AGENTX_BRAIN_TOMBSTONE_SWEEP_SECONDS"

#: Bytes of key material a KEK must carry. AES-256-GCM, so 32.
KEK_BYTES = 32

_DEFAULT_KEK_ID = "k1"
_DEFAULT_POOL_MIN = 1
_DEFAULT_POOL_MAX = 10

#: 8 MB. Comfortably above one session and its messages — the largest single
#: document the client produces — and far below anything that would trouble a
#: small instance holding a few of them at once.
_DEFAULT_MAX_PUSH_BYTES = 8 * 1024 * 1024

_DEFAULT_TOMBSTONE_RETENTION_DAYS = 90
_DEFAULT_TOMBSTONE_SWEEP_SECONDS = 24 * 60 * 60

#: Matches ``accounts.litellm.key_alias_prefix`` in ``config_defaults``. Only
#: reached when the config cannot be read at all, which on a server is the
#: normal case rather than an error — a container carries no AgentX home.
_DEFAULT_KEY_ALIAS_PREFIX = "agentx-workmate"

#: How long a call to LiteLLM may take before the caller is told the proxy is
#: unreachable. Matches the laptop-side default in ``litellm_admin`` — the
#: reasoning is the same, since a wedged proxy must not hold up a sign-in.
DEFAULT_LITELLM_TIMEOUT_SECONDS = 20.0


@dataclass(frozen=True)
class BrainSettings:
    """The resolved configuration of one running service."""

    database_url: str
    kek: bytes
    kek_id: str
    previous_kek: bytes = b""
    previous_kek_id: str = ""
    litellm_base_url: str = ""
    litellm_admin_key: str = ""
    litellm_timeout_seconds: float = DEFAULT_LITELLM_TIMEOUT_SECONDS
    pool_min: int = _DEFAULT_POOL_MIN
    pool_max: int = _DEFAULT_POOL_MAX
    #: The change feed's limits. Bodies above ``max_push_bytes`` are refused
    #: with 413 before anything is parsed; tombstones older than
    #: ``tombstone_retention_days`` are swept every
    #: ``tombstone_sweep_seconds``.
    max_push_bytes: int = _DEFAULT_MAX_PUSH_BYTES
    tombstone_retention_days: int = _DEFAULT_TOMBSTONE_RETENTION_DAYS
    tombstone_sweep_seconds: int = _DEFAULT_TOMBSTONE_SWEEP_SECONDS
    #: The key-minting policy, mirroring ``accounts.litellm``. Read from the
    #: same shipped defaults the laptop reads, so a key minted here carries the
    #: ceilings an operator configured once rather than a second set nobody
    #: remembers writing.
    key_alias_prefix: str = _DEFAULT_KEY_ALIAS_PREFIX
    key_models: tuple[str, ...] = ()
    key_max_budget: float = 0.0
    key_budget_duration: str = ""
    key_tpm_limit: int = 0
    key_rpm_limit: int = 0

    @property
    def litellm_configured(self) -> bool:
        """True when this deploy can talk to LiteLLM at all.

        A deploy that only wants device management is allowed to omit both
        values and gets an honest ``unconfigured`` in ``/health`` rather than
        a refusal to start. The key vault requires it, and says so — with 503
        rather than 500, so a laptop keeps the key it holds.
        """
        return bool(self.litellm_base_url and self.litellm_admin_key)

    def alias_for(self, account_slug: str) -> str:
        """The label this person's key wears in LiteLLM.

        Deliberately the same string ``LiteLLMAccountSettings.alias_for``
        builds on the laptop. Nothing depends on the two agreeing — the
        service finds a key by subject, never by alias — but an operator
        reading the proxy's console is entitled to see one naming scheme
        rather than two.
        """
        return f"{self.key_alias_prefix}-{account_slug}"

    def kek_for(self, kek_id: str) -> bytes | None:
        """The KEK that opens a row wearing *kek_id*, or None.

        None is the honest answer for a row wrapped with a KEK this process
        was not given — during a roll that somebody only half-finished, or
        after one was dropped too early. The caller turns it into
        ``key_unreadable``; guessing with the current KEK would only produce
        an authentication-tag failure one frame later.
        """
        if kek_id == self.kek_id:
            return self.kek
        if self.previous_kek and kek_id == self.previous_kek_id:
            return self.previous_kek
        return None


def decode_kek(raw: str) -> bytes:
    """Decode a base64 KEK, or raise :class:`BrainConfigError`.

    Standard and URL-safe alphabets are both accepted, with or without
    padding: an operator pasting from ``openssl rand -base64 32`` and one
    pasting from a secrets manager should not get different answers.
    """
    text = (raw or "").strip()
    if not text:
        raise BrainConfigError(
            f"{KEK_ENV_VAR} is not set. The service encrypts every stored model "
            "key with it, so there is nothing safe to do without one. Generate "
            "one with: openssl rand -base64 32"
        )

    # One decode path for both alphabets: fold the URL-safe characters onto
    # the standard ones and pad. `validate=True` then means what it says,
    # rather than silently discarding whatever it did not recognise.
    padded = text + "=" * (-len(text) % 4)
    normalized = padded.replace("-", "+").replace("_", "/")

    try:
        value = base64.b64decode(normalized, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise BrainConfigError(
            f"{KEK_ENV_VAR} is not valid base64. Generate one with: "
            "openssl rand -base64 32"
        ) from exc

    if len(value) != KEK_BYTES:
        raise BrainConfigError(
            f"{KEK_ENV_VAR} decodes to {len(value)} bytes; AES-256-GCM needs "
            f"exactly {KEK_BYTES}. Generate one with: openssl rand -base64 32"
        )
    return value


def _litellm_policy_from_config():
    """Return the ``accounts.litellm`` policy, or None when unreadable.

    Best-effort by design. The service runs in a container that may carry no
    AgentX home at all, and the environment overrides above are the documented
    way to configure it; this only saves an operator from repeating values the
    repository already ships.

    Reading the laptop's own policy object rather than restating it is what
    keeps one budget ceiling from meaning two different things depending on
    which side minted the key.
    """
    try:
        from hermes_cli.account_provisioning import load_settings as load_litellm_settings

        return load_litellm_settings()
    except Exception:
        return None


def _int_env(source, name: str, fallback: int) -> int:
    try:
        value = int((source.get(name) or "").strip() or fallback)
    except ValueError as exc:
        raise BrainConfigError(f"{name} must be a whole number") from exc
    if value < 1:
        raise BrainConfigError(f"{name} must be at least 1")
    return value


def load_settings(env: dict[str, str] | None = None) -> BrainSettings:
    """Resolve the service's configuration, or raise ``BrainConfigError``.

    *env* is injectable so tests can drive a whole configuration without
    mutating the process environment.
    """
    source = os.environ if env is None else env

    database_url = (source.get(DATABASE_URL_ENV_VAR) or "").strip()
    if not database_url:
        raise BrainConfigError(
            f"{DATABASE_URL_ENV_VAR} is not set, so the service does not know "
            "which Postgres holds its accounts, devices and documents."
        )

    kek = decode_kek(source.get(KEK_ENV_VAR) or "")
    kek_id = (source.get(KEK_ID_ENV_VAR) or "").strip() or _DEFAULT_KEK_ID

    previous_raw = (source.get(PREVIOUS_KEK_ENV_VAR) or "").strip()
    previous_kek = decode_kek(previous_raw) if previous_raw else b""
    previous_kek_id = (source.get(PREVIOUS_KEK_ID_ENV_VAR) or "").strip()
    if previous_kek and not previous_kek_id:
        # A retiring KEK with no id opens nothing: rows name the KEK that
        # wrapped them, and an unnamed key can never be the one they name.
        # Refuse now rather than half-way through somebody's roll.
        raise BrainConfigError(
            f"{PREVIOUS_KEK_ENV_VAR} is set but {PREVIOUS_KEK_ID_ENV_VAR} is not. "
            "Set it to the id the rows being retired carry (the previous "
            f"{KEK_ID_ENV_VAR}), or unset both."
        )
    if previous_kek and previous_kek_id == kek_id:
        raise BrainConfigError(
            f"{PREVIOUS_KEK_ID_ENV_VAR} and {KEK_ID_ENV_VAR} are both "
            f"{kek_id!r}. Bump {KEK_ID_ENV_VAR} when you roll the KEK, or the "
            "rows written from now on cannot be told from the ones being "
            "retired."
        )

    base_url = (source.get(LITELLM_BASE_URL_ENV_VAR) or "").strip()
    policy = _litellm_policy_from_config()
    if not base_url and policy is not None:
        base_url = policy.base_url

    from hermes_cli.litellm_admin import normalize_base_url

    pool_min = _int_env(source, POOL_MIN_ENV_VAR, _DEFAULT_POOL_MIN)
    pool_max = _int_env(source, POOL_MAX_ENV_VAR, _DEFAULT_POOL_MAX)
    if pool_max < pool_min:
        raise BrainConfigError(
            f"{POOL_MAX_ENV_VAR} ({pool_max}) is below {POOL_MIN_ENV_VAR} ({pool_min})"
        )

    alias_prefix = (source.get(KEY_ALIAS_PREFIX_ENV_VAR) or "").strip()
    if not alias_prefix:
        alias_prefix = getattr(policy, "key_alias_prefix", "") or _DEFAULT_KEY_ALIAS_PREFIX

    return BrainSettings(
        database_url=database_url,
        kek=kek,
        kek_id=kek_id,
        previous_kek=previous_kek,
        previous_kek_id=previous_kek_id,
        litellm_base_url=normalize_base_url(base_url),
        litellm_admin_key=(source.get(LITELLM_ADMIN_KEY_ENV_VAR) or "").strip(),
        pool_min=pool_min,
        pool_max=pool_max,
        max_push_bytes=_int_env(source, MAX_PUSH_BYTES_ENV_VAR, _DEFAULT_MAX_PUSH_BYTES),
        tombstone_retention_days=_int_env(
            source, TOMBSTONE_RETENTION_DAYS_ENV_VAR, _DEFAULT_TOMBSTONE_RETENTION_DAYS
        ),
        tombstone_sweep_seconds=_int_env(
            source, TOMBSTONE_SWEEP_SECONDS_ENV_VAR, _DEFAULT_TOMBSTONE_SWEEP_SECONDS
        ),
        key_alias_prefix=alias_prefix,
        key_models=tuple(getattr(policy, "models", ()) or ()),
        key_max_budget=float(getattr(policy, "max_budget", 0.0) or 0.0),
        key_budget_duration=str(getattr(policy, "budget_duration", "") or ""),
        key_tpm_limit=int(getattr(policy, "tpm_limit", 0) or 0),
        key_rpm_limit=int(getattr(policy, "rpm_limit", 0) or 0),
    )
