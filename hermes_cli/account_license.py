"""This person's AgentX license, as this machine last heard it.

The company SSO licenses AgentX the way Microsoft 365 does: an administrator
assigns a plan, the plan runs out, a grace period of normal use with warnings
follows, and then the person is read-only — they can still sign in, open the
app and browse, search and export their history, but nothing may reach an AI.
Revoking the license makes them read-only at once. A global switch
(``enforced``) decides whether any of this applies; with it off the service
still reports the plan, and nobody is blocked.

The keys service is the authority and the real lock: it stops handing out the
person's model key and the gateway blocks the key they hold. This module is
the laptop's half, and it has three jobs:

1. **Remember** the last license the service sent, per person, in
   ``license.json`` at the account home (:func:`hermes_constants.get_user_root`
   — shared by every profile of that person), together with when it arrived
   and how far this machine's clock was from the service's.
2. **Re-evaluate** that license at the current moment, so the boundaries it
   names take effect on time even while the service cannot be asked: a plan
   starting, ending, its grace period running out.
3. **Answer** the question every new AI turn asks — may this account use AI
   right now? Workmate blocks *all* AI in read-only mode, including providers
   somebody configured with their own key, so the answer has to come from here
   rather than from whether the AgentX gateway happens to refuse a request.

Two rules shape everything below.

* **An outage is never a lock.** A service that cannot be reached leaves the
  last license known in place; with none known the answer is full access.
* **Unknown is not ``none``.** An SSO that predates licensing sends no
  ``license`` with the key and answers ``GET /v1/license`` with ``404``. That
  means "nobody here knows about licenses", and it must leave Workmate exactly
  as it behaved before — full access, no license UI — whereas ``none`` means
  "this person has no plan", which locks.
"""

from __future__ import annotations

import logging
import math
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

logger = logging.getLogger(__name__)

LICENSE_FILENAME = "license.json"

_FILE_VERSION = 1

#: The error code a refused turn carries on every surface — the desktop's chat
#: stream, the messaging gateway, cron — so a client can recognise it without
#: matching on prose.
READ_ONLY_CODE = "license_read_only"

FULL_ACCESS = "full"
READ_ONLY = "read_only"

STATES = frozenset({"none", "scheduled", "active", "grace", "expired", "revoked"})

#: The states in which the person may use AI; every other one is read-only
#: while the license is enforced.
_FULL_STATES = frozenset({"active", "grace"})

_DEFAULT_WARN_DAYS = (14, 7, 1)

_SECONDS_PER_DAY = 86400.0


# ---------------------------------------------------------------------------
# Reading the service's answer
# ---------------------------------------------------------------------------


def normalize_license(raw: Any) -> dict[str, Any] | None:
    """*raw* as a license this module can reason about, or ``None``.

    Only the fields every decision rests on are checked. Anything that is not
    recognisably a license — a body from a service that predates licensing, a
    half-written cache — is unknown, and unknown means full access rather
    than a guess.
    """
    if not isinstance(raw, Mapping):
        return None
    if str(raw.get("state") or "") not in STATES:
        return None
    if str(raw.get("access") or "") not in (FULL_ACCESS, READ_ONLY):
        return None
    return dict(raw)


def _instant(value: Any) -> datetime | None:
    """An ISO-8601 instant as an aware datetime, or ``None``."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        # The contract sends offsets; a bare timestamp is read as UTC rather
        # than as this machine's local time, which would move every boundary
        # by however far the laptop is from the server.
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _utc(now: datetime | None) -> datetime:
    if now is None:
        return datetime.now(timezone.utc)
    return now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)


def _warn_days(raw: Any) -> tuple[int, ...]:
    if not isinstance(raw, (list, tuple)):
        return _DEFAULT_WARN_DAYS
    days = []
    for value in raw:
        try:
            day = int(value)
        except (TypeError, ValueError):
            continue
        if day > 0:
            days.append(day)
    return tuple(sorted(set(days)))


def _days_until(boundary: datetime, at: datetime) -> int:
    """Whole days left before *boundary*, rounded up — the contract's ``days_left``."""
    return max(0, math.ceil((boundary - at).total_seconds() / _SECONDS_PER_DAY))


def evaluate(license: Mapping[str, Any], at: datetime) -> dict[str, Any]:
    """*license* as it stands at *at*, a moment on the service's clock.

    Starts from the state the service reported and only ever moves it forward,
    along the one road a plan travels — scheduled → active → grace → expired —
    so the result agrees with the service at the moment it answered, and a
    boundary it named still takes effect when nobody can ask it again.
    ``none`` and ``revoked`` never change here: only the service can lift
    them.

    ``access`` is re-derived only when the state moved, and is always ``full``
    while the license is not enforced. The time-dependent fields —
    ``days_left``, ``reminder``, ``notice`` — are recomputed for *at* by the
    contract's own rules.
    """
    result = dict(license)
    reported = str(license.get("state") or "")
    state = reported
    enforced = bool(license.get("enforced"))

    starts_at = _instant(license.get("starts_at"))
    ends_at = _instant(license.get("ends_at"))
    # A plan with no grace period ends straight into read-only.
    grace_until = _instant(license.get("grace_until")) or ends_at

    if state == "scheduled" and starts_at is not None and at >= starts_at:
        state = "active"
    if state == "active" and ends_at is not None and at >= ends_at:
        state = "grace"
    if state == "grace" and grace_until is not None and at >= grace_until:
        state = "expired"

    result["state"] = state
    if not enforced:
        result["access"] = FULL_ACCESS
    elif state != reported:
        result["access"] = FULL_ACCESS if state in _FULL_STATES else READ_ONLY

    days_left: int | None = None
    if state == "active" and ends_at is not None:
        days_left = _days_until(ends_at, at)
    elif state == "grace" and grace_until is not None:
        days_left = _days_until(grace_until, at)
    result["days_left"] = days_left

    warn_days = _warn_days(license.get("warn_days"))
    reminder: int | None = None
    if state == "active" and days_left is not None and warn_days and days_left <= max(warn_days):
        reminder = min(day for day in warn_days if day >= days_left)
    result["reminder"] = reminder

    notice: str | None = None
    if enforced:
        if result["access"] == READ_ONLY:
            notice = "read_only"
        elif state == "grace":
            notice = "grace"
        elif reminder is not None:
            notice = "expiring"
    result["notice"] = notice
    return result


# ---------------------------------------------------------------------------
# What this machine remembers
# ---------------------------------------------------------------------------


def license_path(home: Path | None = None) -> Path:
    """Where *home*'s license record lives — the account home by default."""
    if home is None:
        from hermes_constants import get_user_root

        home = get_user_root()
    return Path(home) / LICENSE_FILENAME


@dataclass(frozen=True)
class KnownLicense:
    """The last license the service sent, and the clock it was sent by."""

    license: dict[str, Any]
    #: When it arrived, on this machine's clock.
    fetched_at: datetime
    #: How far the service's clock was ahead of this machine's when it
    #: arrived, in seconds (negative when behind). Every later evaluation runs
    #: on the service's clock: a laptop whose clock is a week fast must not
    #: see a plan expire a week early.
    clock_offset: float = 0.0

    def service_now(self, now: datetime | None = None) -> datetime:
        """The current moment on the service's clock, as well as it can be told.

        Never earlier than the moment the service evaluated the license:
        winding this machine's clock back must not walk an expired plan back
        to active.
        """
        estimate = _utc(now) + timedelta(seconds=self.clock_offset)
        evaluated = _instant(self.license.get("server_time"))
        if evaluated is not None and estimate < evaluated:
            return evaluated
        return estimate

    def at(self, now: datetime | None = None) -> dict[str, Any]:
        """The license re-evaluated for *now* (see :func:`evaluate`)."""
        return evaluate(self.license, self.service_now(now))


def read_known_license(home: Path | None = None) -> KnownLicense | None:
    """The recorded license, or ``None`` when there is no usable record.

    Total: a missing, truncated or hand-edited file reads as unknown, which is
    full access. This runs at the start of every turn, and an exception here
    would cost somebody their agent over a file that only ever adds a lock.
    """
    import json

    try:
        data = json.loads(license_path(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    license = normalize_license(data.get("license"))
    fetched_at = _instant(data.get("fetched_at"))
    if license is None or fetched_at is None:
        return None
    try:
        offset = float(data.get("clock_offset_seconds") or 0.0)
    except (TypeError, ValueError):
        offset = 0.0
    if not math.isfinite(offset):
        offset = 0.0
    return KnownLicense(license=license, fetched_at=fetched_at, clock_offset=offset)


def remember_license(
    raw: Any, *, home: Path | None = None, now: datetime | None = None
) -> KnownLicense | None:
    """Record a license the service has just sent; return what was recorded.

    Returns ``None`` — and writes nothing — when *raw* is not a license, so a
    reply from a service that predates licensing can never overwrite what an
    earlier one said. Best-effort: a record that cannot be written costs one
    stale answer, never a turn.
    """
    license = normalize_license(raw)
    if license is None:
        return None

    received = _utc(now)
    server_time = _instant(license.get("server_time"))
    offset = (server_time - received).total_seconds() if server_time is not None else 0.0
    known = KnownLicense(license=license, fetched_at=received, clock_offset=offset)

    from utils import atomic_json_write

    try:
        atomic_json_write(
            license_path(home),
            {
                "version": _FILE_VERSION,
                "license": license,
                "fetched_at": received.isoformat(),
                "clock_offset_seconds": offset,
            },
        )
    except OSError as exc:
        logger.warning("could not record the AgentX license: %s", exc)
    return known


def forget_license(home: Path | None = None) -> bool:
    """Drop the record. Returns whether there was one.

    For a service that says it knows nothing about licenses: what an earlier
    one said no longer describes this person, and keeping it would lock them
    out under an SSO that has no way to unlock them.
    """
    try:
        license_path(home).unlink()
    except FileNotFoundError:
        return False
    except OSError as exc:
        logger.warning("could not forget the AgentX license: %s", exc)
        return False
    return True


def current_license(
    *, home: Path | None = None, now: datetime | None = None
) -> dict[str, Any] | None:
    """The recorded license as it stands now, or ``None`` when none is known."""
    known = read_known_license(home)
    return known.at(now) if known is not None else None


def read_only_license(*, home: Path | None = None, now: datetime | None = None) -> dict[str, Any] | None:
    """The license that makes this account read-only now, or ``None`` when it may use AI.

    The one check made before anything starts a new AI turn — the agent loop
    itself (``AIAgent.run_conversation``), cron's tick, the messaging
    gateway — whatever provider the turn would use, the person's own keys
    included. No license known means ``None``: an install that never signed
    in, a CLI user with no account, an SSO that predates licensing.
    """
    license = current_license(home=home, now=now)
    if license is not None and license.get("access") == READ_ONLY:
        return license
    return None


def effective_access(now: datetime | None = None, *, home: Path | None = None) -> str:
    """``"full"`` or ``"read_only"`` — whether this account may use AI now."""
    return READ_ONLY if read_only_license(home=home, now=now) is not None else FULL_ACCESS


# ---------------------------------------------------------------------------
# Refusing a turn
# ---------------------------------------------------------------------------


def turn_refusal(
    license: Mapping[str, Any], messages: Any = None, *, api_calls: int = 0
) -> dict[str, Any]:
    """The terminal result of an agent turn refused because the account is read-only.

    The shape every surface already handles for a failed turn — the one a
    billing wall returns (``agent.conversation_loop._billing_failure_result``)
    — so the desktop, the messaging gateway, cron and the CLI each report it
    their usual way, and a client that knows ``failure_reason`` can say it in
    its own words from ``license``. ``messages`` is the conversation as it
    stands: a surface that adopts it as the new history must not lose a turn.
    """
    message = read_only_message(license)
    return {
        "final_response": message,
        "messages": list(messages or []),
        "api_calls": api_calls,
        "completed": False,
        "failed": True,
        "error": message,
        "failure_reason": READ_ONLY_CODE,
        "failure_retryable": False,
        "license": dict(license),
    }


_dispatch_lock = threading.Lock()
_dispatch_held: set[str] = set()


def dispatch_blocked(component: str, log: logging.Logger) -> bool:
    """True while the account is read-only, so *component* starts no new work.

    For loops that would otherwise start agent turns on their own — cron's
    tick. Logged once when the block begins and once when it lifts, per
    component, rather than on every tick.
    """
    license = read_only_license()
    with _dispatch_lock:
        held = component in _dispatch_held
        if license is None:
            _dispatch_held.discard(component)
        else:
            _dispatch_held.add(component)
    if license is None:
        if held:
            log.info("%s: the AgentX license covers AI again — dispatching resumes", component)
        return False
    if not held:
        log.info(
            "%s: not dispatching — the AgentX license is read-only (state %s) until "
            "it is renewed or assigned",
            component,
            license.get("state"),
        )
    return True


#: How long a turn waits for the keys service after the gateway refused it.
#: Short: the person is waiting on an answer, and an unreachable service
#: leaves the license this machine already holds to decide.
_MID_TURN_TIMEOUT_SECONDS = 5.0


def _is_account_gateway(base_url: str) -> bool:
    """Whether *base_url* is the AgentX AI Gateway this account's key was issued for."""
    from hermes_cli.account_provisioning import read_state
    from hermes_cli.litellm_admin import normalize_base_url
    from hermes_constants import get_hermes_home

    recorded = normalize_base_url(str(read_state(get_hermes_home()).get("base_url") or ""))
    candidate = normalize_base_url(base_url or "")
    return bool(recorded) and recorded.lower() == candidate.lower()


def license_behind_gateway_refusal(base_url: str) -> dict[str, Any] | None:
    """The read-only license behind a 401/403 from *base_url*, or ``None``.

    The SSO blocks a person's gateway key the moment it makes them read-only,
    so a model request this account's AgentX AI Gateway refuses mid-turn may
    be exactly that. The keys service is asked again — with the bearer the
    desktop last handed this process (``sync_engine.mailbox``), when it holds
    one — and the license standing afterwards decides. With no bearer to ask
    with (the messaging gateway's own process), the license this machine
    already holds decides alone. A refusal from any other provider is not
    the license's business.
    """
    if not _is_account_gateway(base_url):
        return None
    try:
        from hermes_cli.sync_engine import mailbox

        credentials = mailbox().current()
    except Exception:  # noqa: BLE001 — the record alone still decides
        credentials = None
    if credentials is not None:
        refresh_license(
            bearer=credentials.bearer,
            device_id=credentials.device_id,
            device_name=credentials.device_name,
            timeout=_MID_TURN_TIMEOUT_SECONDS,
        )
    return read_only_license()


_EN_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def format_day(day: Any, lang: str) -> str:
    """A ``YYYY-MM-DD`` calendar day the way *lang* writes one; ``""`` when unusable.

    The service sends days, not instants, for everything a person reads (the
    last covered day, the first read-only one), already in the company's time
    zone — so they are formatted as written, never converted through this
    machine's.
    """
    from datetime import date

    try:
        parsed = date.fromisoformat(str(day or "").strip())
    except ValueError:
        return ""
    if lang == "vi":
        return f"{parsed.day:02d}/{parsed.month:02d}/{parsed.year}"
    if lang == "en":
        return f"{_EN_MONTHS[parsed.month - 1]} {parsed.day}, {parsed.year}"
    return parsed.isoformat()


def read_only_message(license: Mapping[str, Any], *, lang: str | None = None) -> str:
    """Why this account is read-only, and whom to ask — in the display language."""
    from agent.i18n import get_language, t

    lang = lang or get_language()
    plan = license.get("plan")
    if not isinstance(plan, Mapping):
        plan = {}
    plan_name = str(plan.get("name") or plan.get("slug") or "").strip()
    state = license.get("state")

    reason = ""
    if state == "none":
        reason = t("license.read_only_none", lang=lang)
    elif state == "revoked":
        reason = t("license.read_only_revoked", lang=lang)
    elif state == "scheduled":
        starts_on = format_day(license.get("starts_on"), lang)
        if plan_name and starts_on:
            reason = t("license.read_only_scheduled", lang=lang, plan=plan_name, date=starts_on)
    elif state == "expired":
        last_day = format_day(license.get("last_day"), lang)
        if plan_name and last_day:
            reason = t("license.read_only_expired", lang=lang, plan=plan_name, date=last_day)
    if not reason:
        reason = t("license.read_only", lang=lang)

    contact = str(license.get("contact") or "").strip()
    if contact:
        reason = f"{reason} {t('license.contact', lang=lang, contact=contact)}"
    return reason


# ---------------------------------------------------------------------------
# Asking the service
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LicenseRefresh:
    """What asking the service did, and the license that stands afterwards.

    ``status`` is what a caller branches on:

    ``ok``            the service answered with a license, now recorded
    ``unsupported``   the service predates licensing; any record was dropped
    ``offline``       it could not be reached; the last license known stands
    ``unauthorized``  the bearer was refused (expired); the last one stands
    ``revoked``       this device has been revoked; the last one stands
    ``unconfigured``  no keys service is configured for this install
    ``error``         it answered, and refused or said something unreadable
    """

    status: str
    detail: str = ""
    license: dict[str, Any] | None = None

    @property
    def ok(self) -> bool:
        return self.status == "ok"


def refresh_license(
    *,
    bearer: str,
    device_id: str = "",
    device_name: str = "",
    base_url: str | None = None,
    timeout: float | None = None,
    home: Path | None = None,
    now: datetime | None = None,
    transport: Any | None = None,
    sleep: Any | None = None,
) -> LicenseRefresh:
    """Ask the keys service for this person's license and record the answer.

    Never raises for a service problem. Whatever happens, ``license`` on the
    result is the license that stands afterwards, evaluated for *now* — the
    fresh answer, or the last one known when the service could not give one.
    """
    from hermes_cli.second_brain_client import (
        SecondBrainClient,
        SecondBrainError,
        install_device_identity,
    )

    def _standing(status: str, detail: str) -> LicenseRefresh:
        return LicenseRefresh(status=status, detail=detail, license=current_license(home=home, now=now))

    if base_url is None or timeout is None:
        from hermes_cli.account_provisioning import second_brain_service

        configured_url, configured_timeout = second_brain_service()
        base_url = configured_url if base_url is None else base_url
        timeout = configured_timeout if timeout is None else timeout

    if not base_url:
        return _standing("unconfigured", "no keys service is configured (accounts.second_brain.base_url)")
    if not bearer:
        return _standing("unauthorized", "no sign-in token to ask the keys service with")

    if not device_id:
        # A backend with no desktop above it still names its machine; the
        # service refuses a request that will not.
        device_id, fallback_name = install_device_identity()
        device_name = device_name or fallback_name

    kwargs: dict[str, Any] = {"timeout": timeout}
    if transport is not None:
        kwargs["transport"] = transport
    if sleep is not None:
        kwargs["sleep"] = sleep

    try:
        body = SecondBrainClient(base_url, **kwargs).license(
            bearer=bearer, device_id=device_id, device_name=device_name
        )
    except SecondBrainError as exc:
        if exc.status_code == 404:
            # A service that predates licensing. Unknown, which is full
            # access — and a record an earlier service left no longer applies.
            if forget_license(home):
                logger.info("the keys service no longer reports licenses; forgot the recorded one")
            return LicenseRefresh(status="unsupported", detail=str(exc), license=None)
        if exc.unreachable or (exc.status_code or 0) >= 500:
            return _standing("offline", str(exc))
        if exc.status_code == 401:
            return _standing("unauthorized", str(exc))
        if exc.revoked:
            return _standing("revoked", str(exc))
        return _standing("error", str(exc))

    raw = body.get("license") if isinstance(body, dict) else None
    known = remember_license(raw, home=home, now=now)
    if known is None:
        return _standing("error", "the keys service answered without a readable license")
    return LicenseRefresh(status="ok", license=known.at(now))
