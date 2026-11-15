"""Scheduled runs in the AgentX SSO usage metrics.

The desktop reports one ``chat.turn`` event per chat turn shown in its window
(apps/desktop/electron/usage-reporter.ts). A scheduled run has no window: it
fires in whichever process ticks the home (the desktop backend, a detached
messaging gateway, a login service), often while the app is closed, and only
the desktop's main process holds the Keycloak access token the SSO console
takes.

So each fire leaves one small file here, ``<home>/cron/usage-outbox/<event_id>.json``,
and the desktop sends them when it can (apps/desktop/electron/cron-usage-outbox.ts):
one ``cron.run`` event, ``success`` or ``failure`` with a stable code (the shared
words of AgentX-sso docs/dashboard.md, "Mã lỗi"). A file holds no prompt, answer,
error text or job name. ``event_id`` is the run's execution id, so a file sent
twice (a crash between the console's answer and the delete) is counted once.

The console takes events at most 7 days old: older files are pruned here and
dropped by the desktop. At most ``MAX_PENDING`` wait; beyond that the oldest go.
Recording a run never raises and never changes it.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

FEATURE = "cron.run"
#: Under the home; the desktop reads the same path (cron-usage-outbox.ts, OUTBOX_DIR).
OUTBOX_DIR = Path("cron") / "usage-outbox"
#: The console's window (sso_console/api/routes_analytics.py: occurred_at at most 7 days old).
MAX_AGE = timedelta(days=7)
MAX_PENDING = 500
#: Sent when nothing more precise is known (tui_gateway/usage_outcome.py).
FALLBACK_CODE = "operation_failed"
_CODE_SHAPE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$")
_DURATION_MAX_MS = 3_600_000
#: Ids that name no execution as a UUID still get a stable one.
_EVENT_NAMESPACE = uuid.UUID("6f1d4f0e-3c55-4c55-9b7e-8d1c2a7c0b31")


def event_id_for(execution_id: str) -> str:
    """The event's id: the execution's own UUID (``create_execution`` makes a uuid4), or a
    stable one derived from it, so every write for the same run names the same event."""
    try:
        return str(uuid.UUID(str(execution_id)))
    except ValueError:
        return str(uuid.uuid5(_EVENT_NAMESPACE, str(execution_id)))


def outbox_dir(home: Path) -> Path:
    return Path(home) / OUTBOX_DIR


def record_fire(
    home: Path,
    execution_id: str,
    *,
    success: bool,
    duration_ms: float,
    error_code: str | None = None,
    now: datetime | None = None,
) -> Path | None:
    """Queue one finished run for the SSO usage metrics; the file written, or None. Never raises."""
    try:
        moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        event = {
            "event_id": event_id_for(execution_id),
            "occurred_at": moment.isoformat(timespec="milliseconds").replace(
                "+00:00", "Z"
            ),
            "feature": FEATURE,
            "outcome": "success" if success else "failure",
            "duration_ms": max(0, min(_DURATION_MAX_MS, int(round(duration_ms)))),
        }
        if not success:
            code = str(error_code or "")
            event["error_code"] = code if _CODE_SHAPE.match(code) else FALLBACK_CODE
        directory = outbox_dir(home)
        directory.mkdir(parents=True, exist_ok=True)
        _prune(directory, moment)
        target = directory / f"{event['event_id']}.json"
        # Whole or not at all: the desktop may read the directory at any moment, and
        # takes only `<uuid>.json`, never the temporary name.
        fd, temporary = tempfile.mkstemp(dir=directory, prefix=".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(event, handle)
            os.replace(temporary, target)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise
        return target
    except Exception as error:  # metrics never stand in the way of the run
        logger.warning("cron usage event not queued: %s", type(error).__name__)
        return None


def _prune(directory: Path, now: datetime) -> None:
    """Drop what the console would refuse, and make room for one more."""
    oldest_kept = (now - MAX_AGE).timestamp()
    waiting: list[tuple[float, Path]] = []
    for entry in directory.iterdir():
        name = entry.name
        if not (
            name.endswith(".json") or (name.startswith(".") and name.endswith(".tmp"))
        ):
            continue
        try:
            modified = entry.stat().st_mtime
        except FileNotFoundError:  # the desktop just sent it
            continue
        if modified < oldest_kept:
            entry.unlink(missing_ok=True)
        elif name.endswith(".json"):
            waiting.append((modified, entry))
    waiting.sort()
    for _, entry in waiting[: max(0, len(waiting) - (MAX_PENDING - 1))]:
        entry.unlink(missing_ok=True)
