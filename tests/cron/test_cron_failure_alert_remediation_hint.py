"""User recovery hints must use ordinary language and never expose setup commands."""

import pytest

from cron.scheduler import _summarize_cron_failure_for_delivery


@pytest.mark.parametrize("error", [
    "Request timed out.",
    "HTTP 429: rate limit exceeded",
    "RuntimeError: [drift_skip] model old -> new; cronjob action=update job_id=secret model=new; See #44585",
    "RuntimeError: [blocked_config] provider unavailable; config.yaml auxiliary.provider=private",
    'HTTP 400: litellm.BadRequestError: {"error": "Your credit balance is too low"}',
    "UnrecognizedError: private server response with diagnostic details",
])
def test_failure_explains_recovery_without_diagnostic_details(error):
    msg = _summarize_cron_failure_for_delivery({"name": "Daily reminder", "id": "private-id"}, error)
    assert "Daily reminder" in msg
    assert len(msg) < 250
    for detail in ("HTTP", "litellm", "RuntimeError", "UnrecognizedError", "cronjob", "job_id", "#44585", "config.yaml", "private", "agentx fallback"):
        assert detail not in msg
    assert any(hint in msg.lower() for hint in ("try", "ask me", "support"))


def test_billing_failure_does_not_tell_managed_users_to_pay_upstream_provider():
    msg = _summarize_cron_failure_for_delivery({"name": "Reminder"}, "Billing or credits exhausted: Your credit balance is too low")
    assert "usage limit" in msg
    assert "add credits" not in msg.lower()
    assert "support" in msg
