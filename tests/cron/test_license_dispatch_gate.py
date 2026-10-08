"""Cron dispatches nothing while the AgentX license is read-only.

A read-only person may not start an AI turn, and a scheduled job is one. Like
the emergency stop, the tick leaves due jobs where they are — they run on the
first tick after the license covers AI again — rather than firing each one
into a refusal and alerting about it every time.
"""

from __future__ import annotations

from unittest.mock import patch

import cron.scheduler as scheduler_mod
from hermes_cli.account_license import remember_license

_READ_ONLY = {
    "state": "expired",
    "access": "read_only",
    "enforced": True,
    "notice": "read_only",
    "plan": {"slug": "pilot-2026", "name": "Pilot 2026"},
    "starts_at": "2026-10-15T00:00:00+07:00",
    "ends_at": "2027-01-01T00:00:00+07:00",
    "grace_until": "2027-01-08T00:00:00+07:00",
    "last_day": "2026-12-31",
    "contact": "",
    "warn_days": [14, 7, 1],
    "server_time": "2027-01-09T09:00:00+07:00",
}


def _tick_looks_at_due_jobs() -> bool:
    with patch.object(scheduler_mod, "get_due_jobs", return_value=[]) as due:
        assert scheduler_mod.tick(verbose=False) == 0
    return due.called


def test_a_read_only_license_leaves_due_jobs_alone():
    remember_license(_READ_ONLY)

    assert _tick_looks_at_due_jobs() is False


def test_dispatch_resumes_once_the_license_covers_ai_again():
    remember_license(_READ_ONLY)
    assert _tick_looks_at_due_jobs() is False

    # The plan was renewed: the next answer from the keys service is active.
    remember_license(
        {
            **_READ_ONLY,
            "state": "active",
            "access": "full",
            "notice": None,
            "ends_at": "2027-07-01T00:00:00+07:00",
            "grace_until": "2027-07-08T00:00:00+07:00",
            "server_time": "2027-01-10T09:00:00+07:00",
        }
    )

    assert _tick_looks_at_due_jobs() is True


def test_no_license_known_dispatches_as_before():
    assert _tick_looks_at_due_jobs() is True
