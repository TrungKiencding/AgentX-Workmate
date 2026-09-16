"""``files_created`` on ``message.complete``: the desktop's file cards for a turn.

Drives ``_run_prompt_submit`` with a fake agent the way
``test_prompt_accept_logging`` does, and pins three contracts:

* a deliverable the turn produced rides the terminal frame and is pinned to
  the reply row's ``display_metadata`` so a rehydrated transcript agrees;
* a turn that produced nothing carries no key at all (the renderer treats
  absence and an empty list the same, but the wire stays quiet);
* a file already handed over through ``deliver_file`` is not listed twice.
"""

from __future__ import annotations

import json
import threading
import time
import types

import pytest

from tui_gateway import server


class _InlineThread:
    def __init__(self, target=None, daemon=None, args=(), kwargs=None):
        self._target = target
        self._args = args
        self._kwargs = kwargs or {}

    def start(self):
        if self._target is not None:
            self._target(*self._args, **self._kwargs)

    def is_alive(self):
        return False

    def join(self, timeout=None):
        return None


class _FakeDb:
    def __init__(self):
        self.merged: list[tuple] = []

    def latest_message_row_id(self, session_id, *, role="user", offset=0, require_text=True):
        return 42 if role == "assistant" else None

    def merge_message_display_metadata(self, session_id, row_id, patch):
        self.merged.append((session_id, row_id, patch))
        return True


def _session(agent, **extra):
    return {
        "agent": agent,
        "session_key": "gw-session-key",
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
        **extra,
    }


@pytest.fixture()
def turn_env(monkeypatch, tmp_path):
    emitted: list[tuple[str, str, dict | None]] = []
    monkeypatch.setattr(server.threading, "Thread", _InlineThread)
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload=None: emitted.append((event, sid, payload)))
    monkeypatch.setattr(server, "_wire_callbacks", lambda sid: None)
    monkeypatch.setattr(server, "_sync_agent_model_with_config", lambda sid, session: None)
    monkeypatch.setattr(server, "_session_cwd", lambda session: str(tmp_path))
    monkeypatch.setattr(server, "_register_session_cwd", lambda session: None)
    monkeypatch.setattr(server, "_tts_stream_begin", lambda: None)
    monkeypatch.setattr(server, "_sync_session_key_after_compress", lambda *a, **k: None)
    monkeypatch.setattr(server, "_get_usage", lambda agent: {})
    monkeypatch.setattr(server, "_session_home", lambda session: tmp_path / "agentx-home")
    return emitted


def _complete(emitted):
    frames = [payload for event, _sid, payload in emitted if event == "message.complete"]
    assert len(frames) == 1
    return frames[0]


def _agent(run, db=None):
    return types.SimpleNamespace(
        session_id="agent-sid",
        run_conversation=run,
        clear_interrupt=lambda: None,
        _session_db=db,
    )


def test_produced_file_is_reported_and_pinned(turn_env, tmp_path):
    report = tmp_path / "report.docx"
    db = _FakeDb()

    def run(message, **kwargs):
        report.write_bytes(b"PK" * 16)
        return {
            "final_response": f"Your report is ready at {report}.",
            "messages": [
                {"role": "user", "content": "make a report"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"id": "t1", "function": {"name": "terminal", "arguments": json.dumps({"command": "python gen.py"})}}
                    ],
                },
                {"role": "tool", "name": "terminal", "content": f"Saved {report}"},
                {"role": "assistant", "content": f"Your report is ready at {report}."},
            ],
        }

    server._run_prompt_submit("rid", "ui-sid", _session(_agent(run, db)), "make a report")

    payload = _complete(turn_env)
    assert [f["name"] for f in payload["files_created"]] == ["report.docx"]
    record = payload["files_created"][0]
    assert record["path"] == str(report)
    assert record["kind"] == "document"
    assert record["size_bytes"] == 32
    assert db.merged == [("agent-sid", 42, {"files_created": payload["files_created"]})]


def test_quiet_turn_carries_no_key(turn_env):
    def run(message, **kwargs):
        return {"final_response": "Sure.", "messages": [{"role": "assistant", "content": "Sure."}]}

    db = _FakeDb()
    server._run_prompt_submit("rid", "ui-sid", _session(_agent(run, db)), "hi")

    assert "files_created" not in _complete(turn_env)
    assert db.merged == []


def test_delivered_files_are_not_repeated(turn_env, tmp_path):
    deck = tmp_path / "deck.pptx"

    def run(message, **kwargs):
        deck.write_bytes(b"PK" * 4)
        return {
            "final_response": "Delivered the deck.",
            "messages": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"id": "t1", "function": {"name": "deliver_file", "arguments": json.dumps({"path": str(deck)})}}
                    ],
                },
                {"role": "tool", "name": "deliver_file", "content": json.dumps({"success": True, "path": str(deck)})},
                {"role": "assistant", "content": "Delivered the deck."},
            ],
        }

    server._run_prompt_submit("rid", "ui-sid", _session(_agent(run)), "make a deck")

    assert "files_created" not in _complete(turn_env)


def test_files_from_before_the_turn_are_ignored(turn_env, tmp_path):
    old = tmp_path / "old.pdf"
    old.write_bytes(b"%PDF")
    stale = time.time() - 3600
    import os

    os.utime(old, (stale, stale))

    def run(message, **kwargs):
        return {"final_response": f"See {old}", "messages": [{"role": "assistant", "content": f"See {old}"}]}

    server._run_prompt_submit("rid", "ui-sid", _session(_agent(run)), "look")

    assert "files_created" not in _complete(turn_env)


def test_collection_failure_never_breaks_the_turn(turn_env, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("scan exploded")

    monkeypatch.setattr("tui_gateway.deliverables.collect_turn_deliverables", boom)

    def run(message, **kwargs):
        return {"final_response": "ok", "messages": [{"role": "assistant", "content": "ok"}]}

    server._run_prompt_submit("rid", "ui-sid", _session(_agent(run)), "go")

    payload = _complete(turn_env)
    assert payload["status"] == "complete"
    assert "files_created" not in payload
