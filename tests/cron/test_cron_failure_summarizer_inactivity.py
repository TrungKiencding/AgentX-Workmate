"""Scheduler failures must retain the right impact without internal mechanics."""

from cron.scheduler import _summarize_cron_failure_for_delivery


def test_inactivity_timeout_is_not_reported_as_provider_timeout():
    msg = _summarize_cron_failure_for_delivery(
        {"name": "Daily Repo Sweep"},
        "TimeoutError: Cron job idle for 1239s (limit 600s) — last activity: terminal command running",
    )
    assert "stalled" in msg
    assert "AI service" not in msg
    assert "terminal" not in msg


def test_terminal_cwd_lock_timeout_is_not_reported_as_provider_timeout():
    msg = _summarize_cron_failure_for_delivery(
        {"name": "Workdir Job"},
        "TimeoutError: Timed out waiting for the TERMINAL_CWD write lock after 600s",
    )
    assert "another task" in msg
    assert "AI service" not in msg
    assert "TERMINAL_CWD" not in msg


def test_provider_timeout_offers_retry():
    msg = _summarize_cron_failure_for_delivery({"name": "Reminder"}, "httpx.ReadTimeout: The read operation timed out")
    assert "too long" in msg
    assert "retry" in msg


def test_rate_limit_retains_retry_guidance():
    msg = _summarize_cron_failure_for_delivery({"name": "Reminder"}, "HTTP 429: weekly usage limit exceeded")
    assert "AI service is busy" in msg
    assert "try again later" in msg
