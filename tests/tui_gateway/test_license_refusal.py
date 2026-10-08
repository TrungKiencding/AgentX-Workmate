"""The desktop's chat learns WHY a turn was refused by the AgentX license.

``_run_prompt_submit`` drives a real ``AIAgent`` here (the model client is a
mock that must never be called): the agent loop refuses the turn because the
license is read-only, and the terminal ``message.complete`` frame carries the
code and the license as data — the way a billing wall travels — so the
renderer can say it in its own words and lock the composer, instead of
pattern-matching the text.
"""

from __future__ import annotations

import threading
from unittest.mock import MagicMock, patch

import pytest

from hermes_cli.account_license import READ_ONLY_CODE, read_only_message, remember_license
from tui_gateway import server

_EXPIRED = {
    "state": "expired",
    "access": "read_only",
    "enforced": True,
    "notice": "read_only",
    "plan": {"slug": "pilot-2026", "name": "Pilot 2026"},
    "starts_at": "2026-10-15T00:00:00+07:00",
    "ends_at": "2027-01-01T00:00:00+07:00",
    "grace_until": "2027-01-08T00:00:00+07:00",
    "last_day": "2026-12-31",
    "read_only_from": "2027-01-08",
    "contact": "it@astralx.com.vn",
    "warn_days": [14, 7, 1],
    "server_time": "2027-01-09T09:00:00+07:00",
}


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
def emits(monkeypatch):
    captured: list = []
    monkeypatch.setattr(
        server, "_emit", lambda event, sid, payload=None: captured.append((event, sid, payload))
    )
    return captured


@pytest.fixture()
def turn_env(monkeypatch, tmp_path):
    monkeypatch.setattr(server.threading, "Thread", _InlineThread)
    monkeypatch.setattr(server, "_wire_callbacks", lambda sid: None)
    monkeypatch.setattr(server, "_sync_agent_model_with_config", lambda sid, session: None)
    monkeypatch.setattr(server, "_session_cwd", lambda session: str(tmp_path))
    monkeypatch.setattr(server, "_register_session_cwd", lambda session: None)
    monkeypatch.setattr(server, "_tts_stream_begin", lambda: None)
    monkeypatch.setattr(server, "_sync_session_key_after_compress", lambda *a, **k: None)
    monkeypatch.setattr(server, "_get_usage", lambda agent: {})


@pytest.fixture()
def agent():
    """A real agent, built before ``turn_env`` makes threads run inline.

    (Construction starts a logging thread that never returns; run inline it
    would hang the test.)
    """
    from run_agent import AIAgent

    with (
        patch("run_agent.get_tool_definitions", return_value=[]),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        agent = AIAgent(
            api_key="sk-own-key-1234567890",
            base_url="https://api.openai.com/v1",
            provider="openai",
            api_mode="chat_completions",
            model="gpt-5.5",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
        )
    agent.client = MagicMock()
    return agent


def _session(agent, history):
    return {
        "agent": agent,
        "session_key": "session-key",
        "history": list(history),
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


def test_a_refused_turn_tells_the_renderer_why(agent, emits, turn_env):
    remember_license(_EXPIRED)
    history = [
        {"role": "user", "content": "summarise the thread"},
        {"role": "assistant", "content": "Three decisions were made."},
    ]
    session = _session(agent, history)
    server._start_inflight_turn(session, "and the next steps?")

    server._run_prompt_submit("rid", "sid", session, "and the next steps?")

    # Even the person's own provider was never asked.
    assert agent.client.chat.completions.create.called is False
    completes = [payload for event, _sid, payload in emits if event == "message.complete"]
    assert len(completes) == 1
    payload = completes[0]
    assert payload["status"] == "error"
    assert payload["failure_reason"] == READ_ONLY_CODE
    assert payload["license"]["state"] == "expired"
    assert payload["license"]["plan"]["name"] == "Pilot 2026"
    assert payload["text"] == read_only_message(payload["license"])
    # The conversation is exactly what it was: nothing lost, nothing added.
    assert session["history"] == history
    assert session["running"] is False


def test_a_turn_that_fails_otherwise_carries_no_license(emits, turn_env):
    import types

    stub = types.SimpleNamespace(
        session_id="session-key",
        run_conversation=lambda *a, **k: {
            "final_response": "",
            "error": "HTTP 401: invalid api key",
            "failed": True,
        },
        clear_interrupt=lambda: None,
    )
    session = _session(stub, [])
    server._start_inflight_turn(session, "hello")

    server._run_prompt_submit("rid", "sid", session, "hello")

    payload = [payload for event, _sid, payload in emits if event == "message.complete"][0]
    assert payload["status"] == "error"
    assert "license" not in payload
    assert payload.get("failure_reason") != READ_ONLY_CODE
