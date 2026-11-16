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
    ("Gateway shutdown (drain) killed the job's tool subprocess before the run finished.", "interrupted"),
    ("Interrupted by gateway shutdown before the run finished (tool subprocess was killed mid-flight).", "interrupted"),
    ("Executor dispatch failed: cannot schedule new futures after interpreter shutdown", "interrupted"),
    # A provider's own words are not the app being closed (review 2026-11-13:
    # this 503 was shown as "the app was closed or restarted").
    ("RuntimeError: HTTP 503: upstream reset; stream interrupted", "service_unavailable"),
    ("RuntimeError: HTTP 503: server is shutting down for maintenance", "service_unavailable"),
    # LiteLLM refuses a model with a 401: signing in again does not help.
    ("RuntimeError: HTTP 401: Authentication Error, key not allowed to access model. "
     "This key can only access models=['minimax-m3']", "model_not_found"),
    ("RuntimeError: HTTP 400: The response was filtered due to the prompt triggering "
     "Azure OpenAI's content management policy.", "content_filtered"),
    ("RuntimeError: HTTP 400: This model's maximum context length is 128000 tokens.", "too_long"),
    ("", "unknown"),
    (None, "unknown"),
    ("something nobody anticipated", "unknown"),
])
def test_classification(error, kind):
    assert classify_cron_failure(error) == kind


@pytest.mark.parametrize("reason, text, kind", [
    # The agent knew from the exception (status, type, chained cause) what
    # the one-line summary no longer says.
    ("connection_failed", "Connection error.", "unreachable"),
    ("stream_interrupted", "peer closed connection", "service_unavailable"),
    ("model_not_allowed", "HTTP 401: Authentication Error", "model_not_found"),
    ("context_overflow", "Context overflow and auto-compaction is disabled", "too_long"),
    ("format_error", "HTTP 400: Invalid schema for function 'x'", "request_rejected"),
    ("server_error", "HTTP 500: oops", "service_unavailable"),
    ("billing", "HTTP 402: Insufficient Balance", "usage_limit"),
    # The classified reason wins over words that would read otherwise.
    ("rate_limit", "HTTP 401: nested upstream payload says insufficient credits", "rate_limit"),
    ("unknown", "HTTP 429: rate limit", "unknown"),
    ("session_persistence_failed:disk", "storage could not be written", "unknown"),
])
def test_a_failed_agent_run_keeps_the_reason_the_agent_classified(reason, text, kind):
    from cron.scheduler import _cron_failure_marker

    error = "RuntimeError: " + _cron_failure_marker({"failed": True, "failure_reason": reason}) + text
    assert classify_cron_failure(error) == kind


def test_an_unverified_billing_wall_is_not_reported_as_spent_quota():
    from cron.scheduler import _cron_failure_marker

    marker = _cron_failure_marker({"failure_reason": "billing", "billing_unverified": True})
    assert classify_cron_failure(marker + "out of extra usage") == "service_unavailable"


def test_a_script_jobs_own_output_is_not_read_as_an_ai_failure():
    """A no_agent job uses no model; what its script printed is not a refusal."""
    out = "Script exited with code 12: PRIVATE HTTP 400 litellm.BadRequestError"
    assert classify_cron_failure(out, agent_run=False) == "unknown"
    assert classify_cron_failure("Gateway shutdown (drain) killed it", agent_run=False) == "interrupted"
    summary = _summarize_cron_failure_for_delivery({"name": "Watch", "no_agent": True}, out)
    assert summary == f"⚠️ Watch: {_CRON_FAILURE_REASONS['unknown']}"

    from tools.cronjob_tools import _format_job

    listed = _format_job({"id": "s1", "name": "Watch", "prompt": "", "no_agent": True,
                          "script": "w.py", "last_status": "error", "last_error": out})
    assert listed["last_error_kind"] == "unknown"


def test_a_malformed_reason_adds_no_marker():
    from cron.scheduler import _cron_failure_marker

    assert _cron_failure_marker({}) == ""
    assert _cron_failure_marker({"failure_reason": "Bad] [drift_skip"}) == ""


def test_every_reported_failure_reason_has_a_kind():
    """A reason the agent can report never lands on "unknown" by omission."""
    from agent.error_classifier import REPORTED_FAILURE_REASONS
    from cron.scheduler import _FAILURE_REASON_TO_KIND

    assert REPORTED_FAILURE_REASONS - {"unknown"} - set(_FAILURE_REASON_TO_KIND) == set()
    assert set(_FAILURE_REASON_TO_KIND.values()) <= set(CRON_FAILURE_KINDS)


def test_every_kind_has_words_on_the_assistants_page_in_every_language():
    """The Trợ lý page falls back to a bare "Last run failed" for a kind it
    has no words for — which is what this whole key exists to avoid."""
    import re
    from pathlib import Path

    plugin = Path(__file__).resolve().parents[2] / "apps/desktop/src/plugins/agentx-bots"
    blocks = []
    for name in ("i18n.ts", "i18n-ar.ts", "i18n-ja.ts", "i18n-zh.ts", "i18n-zh-hant.ts"):
        source = (plugin / name).read_text(encoding="utf-8")
        blocks += [(name, m.group(1)) for m in re.finditer(r"\n  failure: \{(.*?)\n  \}", source, re.S)]
    assert len(blocks) == 6  # en + vi share i18n.ts
    for name, block in blocks:
        keys = set(re.findall(r"^\s+([a-z_]+):", block, re.M))
        assert keys == set(CRON_FAILURE_KINDS), name


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
