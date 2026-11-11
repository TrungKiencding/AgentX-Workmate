"""Why a run failed, as a stable key a UI can translate.

The Trợ lý page showed only "Lần chạy trước bị lỗi" (pilot feedback
2026-11-10) — the reason existed in jobs.json but no surface could say it
without copying raw diagnostic text. ``classify_cron_failure`` is the key;
the chat-delivery summary is the same classification in English.
"""

from __future__ import annotations

import pytest

from cron.scheduler import (
    CRON_FAILURE_KINDS,
    CRON_SESSION_TITLE_STAMP,
    DRIFT_SKIP_MARKER,
    _CRON_FAILURE_REASONS,
    _summarize_cron_failure_for_delivery,
    classify_cron_failure,
)


@pytest.mark.parametrize("error, kind", [
    (f"{DRIFT_SKIP_MARKER} Skipped to prevent unintended spend", "drift_skip"),
    ("[blocked_config] provider is not configured", "blocked_config"),
    ("Job interrupted by gateway shutdown", "interrupted"),
    ("agent idle for 612s (limit 600s)", "stalled"),
    ("TERMINAL_CWD lock timed out", "busy"),
    ("HTTP 429: rate limit exceeded", "rate_limit"),
    ("HTTP 401: invalid api key", "auth"),
    ("", "unknown"),
    (None, "unknown"),
    ("something nobody anticipated", "unknown"),
])
def test_classification(error, kind):
    assert classify_cron_failure(error) == kind


def test_every_kind_has_a_delivery_sentence_and_nothing_else_does():
    assert set(_CRON_FAILURE_REASONS) == set(CRON_FAILURE_KINDS)


def test_delivery_summary_is_the_classified_sentence_without_the_raw_error():
    raw = "HTTP 429: rate limit exceeded for key sk-secret-123"
    summary = _summarize_cron_failure_for_delivery({"name": "Bản tin"}, raw)

    assert summary == f"⚠️ Bản tin: {_CRON_FAILURE_REASONS['rate_limit']}"
    assert "sk-secret" not in summary


def test_listed_job_carries_the_kind_only_when_the_last_run_failed():
    from tools.cronjob_tools import _format_job

    base = {"id": "j1", "name": "Bản tin", "prompt": "x", "schedule_display": "0 21 * * *"}

    failed = _format_job({**base, "last_status": "error", "last_error": "HTTP 429: rate limit exceeded"})
    assert failed["last_error_kind"] == "rate_limit"
    # The raw text is never listed: this dict is also what the model reads.
    assert "last_error" not in failed

    assert "last_error_kind" not in _format_job({**base, "last_status": "ok"})
    assert "last_error_kind" not in _format_job(base)


def test_cron_session_title_stamp_has_no_month_name():
    """The title is stored data shown in every UI language ("Nov 10 21:00" was
    English in a Vietnamese app)."""
    from datetime import datetime

    stamp = datetime(2026, 11, 10, 21, 0).strftime(CRON_SESSION_TITLE_STAMP)

    assert stamp == "2026-11-10 21:00"
