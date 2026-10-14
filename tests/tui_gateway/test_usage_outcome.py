"""What a finished turn counts as in the AgentX SSO usage metrics.

The terminal ``message.complete`` frame carries ``failure_code`` when the
person did not get their answer — an error ended the turn, or it ended without
one but without the answer — and nothing when they did, or when they stopped
it. The desktop sends that code to the SSO dashboard (apps/desktop/electron/
usage-reporter.ts); it is derived from the turn's result, never its text.
"""

from __future__ import annotations

import threading
import types

import pytest

from hermes_cli.account_license import READ_ONLY_CODE, LicenseReadOnly
from tui_gateway import server
from tui_gateway.usage_outcome import exception_failure_code, turn_failure_code


def _failed(reason: str | None = None, **extra) -> dict:
    """A result an error ended, with the reason it was classified under."""
    return {"failed": True, "error": "x", **({"failure_reason": reason} if reason else {}), **extra}


def _unanswered(exit_reason: str, answer: str | None = None) -> dict:
    """A result with no error, that still did not give the person their answer."""
    return {"final_response": answer, "completed": False, "turn_exit_reason": exit_reason}


@pytest.mark.parametrize(
    ("result", "status", "code"),
    [
        # The person got their answer, or stopped the turn: nothing to report as a failure.
        ({"final_response": "done", "completed": True, "turn_exit_reason": "text_response"}, "complete", None),
        ({"final_response": "", "interrupted": True, "completed": False}, "interrupted", None),
        ("a plain string result", "complete", None),
        # An error ended it: its classified reason, in the shared words.
        (_failed("rate_limit"), "error", "rate_limited"),
        (_failed("upstream_rate_limit"), "error", "rate_limited"),
        (_failed("billing"), "error", "quota_exceeded"),
        (_failed("auth_permanent"), "error", "auth_failed"),
        (_failed("server_error"), "error", "upstream_error"),
        (_failed("overloaded"), "error", "upstream_error"),
        (_failed("timeout"), "error", "timeout"),
        (_failed("context_overflow"), "error", "context_too_long"),
        (_failed("model_not_found"), "error", "model_unavailable"),
        (_failed("content_policy_blocked"), "error", "content_filtered"),
        (_failed("format_error"), "error", "bad_request"),
        (_failed("unknown"), "error", "operation_failed"),
        (_failed("something new"), "error", "operation_failed"),
        (_failed("session_persistence_failed:disk"), "error", "session_save_failed"),
        (_failed("interpreter_shutdown"), "error", "app_shutdown"),
        # The AgentX license, by its state.
        (_failed(READ_ONLY_CODE, license={"state": "expired"}), "error", "license_expired"),
        (_failed(READ_ONLY_CODE, license={"state": "revoked"}), "error", "license_revoked"),
        (_failed(READ_ONLY_CODE, license={"state": "none"}), "error", "license_required"),
        (_failed(READ_ONLY_CODE), "error", "license_read_only"),
        # Failed without a classified reason: why the loop ended says it, if anything does.
        (_failed(completed=False, turn_exit_reason="ollama_runtime_context_too_small"), "complete", "context_too_long"),
        (_failed(), "error", "operation_failed"),
        # No error, but no answer either: the turn's exit reason, in the shared words.
        (_unanswered("max_iterations_reached(90/90)", "summary"), "complete", "max_steps"),
        (_unanswered("budget_exhausted"), "complete", "max_steps"),
        (_unanswered("empty_response_exhausted"), "complete", "empty_response"),
        (_unanswered("all_retries_exhausted_no_response"), "complete", "no_response"),
        (_unanswered("partial_stream_recovery", "part"), "complete", "stream_interrupted"),
        (_unanswered("repeated_outer_errors(boom)"), "complete", "local_error"),
        (_unanswered("guardrail_halt"), "complete", "guardrail_halt"),
        (_unanswered("a_new_reason"), "complete", "a_new_reason"),
        (_unanswered("not a code!"), "complete", "operation_failed"),
        (_unanswered("unknown"), "complete", "operation_failed"),
    ],
)
def test_a_turn_counts_as_what_the_person_got(result, status, code):
    assert turn_failure_code(result, status) == code


def test_an_exception_that_ended_a_turn_is_classified():
    class RateLimited(Exception):
        status_code = 429

    assert exception_failure_code(LicenseReadOnly({"state": "revoked"})) == "license_revoked"
    assert exception_failure_code(RateLimited("Too many requests")) == "rate_limited"
    assert exception_failure_code(RuntimeError("something odd")) == "operation_failed"


# ── The frame the desktop reads ──────────────────────────────────────────────


class _InlineThread:
    def __init__(self, target=None, daemon=None, args=(), kwargs=None):
        self._target, self._args, self._kwargs = target, args, kwargs or {}

    def start(self):
        if self._target is not None:
            self._target(*self._args, **self._kwargs)

    def is_alive(self):
        return False

    def join(self, timeout=None):
        return None


@pytest.fixture()
def finish(monkeypatch, tmp_path):
    """Run one turn whose agent's ``run_conversation`` is the one given; the payload
    of its terminal frame."""
    emitted: list = []
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload=None: emitted.append((event, payload)))
    monkeypatch.setattr(server.threading, "Thread", _InlineThread)
    monkeypatch.setattr(server, "_wire_callbacks", lambda sid: None)
    monkeypatch.setattr(server, "_sync_agent_model_with_config", lambda sid, session: None)
    monkeypatch.setattr(server, "_session_cwd", lambda session: str(tmp_path))
    monkeypatch.setattr(server, "_register_session_cwd", lambda session: None)
    monkeypatch.setattr(server, "_tts_stream_begin", lambda: None)
    monkeypatch.setattr(server, "_sync_session_key_after_compress", lambda *a, **k: None)
    monkeypatch.setattr(server, "_get_usage", lambda agent: {})

    def run(run_conversation) -> dict:
        agent = types.SimpleNamespace(
            session_id="session-key", run_conversation=run_conversation, clear_interrupt=lambda: None
        )
        session = {
            "agent": agent,
            "session_key": "session-key",
            "history": [],
            "history_lock": threading.Lock(),
            "history_version": 0,
            "running": True,
            "attached_images": [],
            "image_counter": 0,
            "cols": 80,
            "slash_worker": None,
            "show_reasoning": False,
            "tool_progress_mode": "all",
            "inflight_turn": None,
        }
        server._start_inflight_turn(session, "hello")
        server._run_prompt_submit("rid", "sid", session, "hello")
        frames = [payload for event, payload in emitted if event == "message.complete"]
        assert len(frames) == 1
        return frames[0]

    return run


def test_an_answered_turn_carries_no_failure_code(finish):
    payload = finish(lambda *a, **k: {"final_response": "hi", "completed": True})
    assert payload["status"] == "complete"
    assert "failure_code" not in payload


def test_a_failed_turn_says_why_by_its_classified_reason(finish):
    payload = finish(lambda *a, **k: _failed("rate_limit", final_response="", error="HTTP 429: slow down"))
    assert payload["status"] == "error"
    assert payload["failure_code"] == "rate_limited"


def test_a_turn_that_ran_out_of_iterations_is_a_failure_though_it_completed(finish):
    payload = finish(
        lambda *a, **k: {
            "final_response": "Here is what I managed.",
            "completed": False,
            "turn_exit_reason": "max_iterations_reached(90/90)",
        }
    )
    assert payload["status"] == "complete"
    assert payload["failure_code"] == "max_steps"


def test_an_exception_out_of_the_turn_says_why(finish):
    def refuse(*args, **kwargs):
        raise LicenseReadOnly({"state": "expired"})

    payload = finish(refuse)
    assert payload["status"] == "error"
    assert payload["failure_code"] == "license_expired"
