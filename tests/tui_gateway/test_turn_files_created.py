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
import os
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

    session = _session(_agent(run, db))
    server._run_prompt_submit("rid", "ui-sid", session, "make a report")

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


def test_files_from_before_the_turn_are_ignored(turn_env, tmp_path, monkeypatch):
    old = tmp_path / "old.pdf"
    old.write_bytes(b"%PDF")
    stale = time.time() - 3600
    os.utime(old, (stale, stale))
    # Written just now, the file's inode change time is fresh whatever its
    # mtime says; a file from before the turn has an old one too.
    monkeypatch.setattr("tui_gateway.deliverables.changed_time", lambda path, stat: stale)

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


@pytest.fixture()
def clean_workspace_turns(monkeypatch):
    monkeypatch.setattr(server, "_WORKSPACE_TURNS", {})
    return server._WORKSPACE_TURNS


def _walk_only_turn(path):
    """A turn whose script writes *path* without ever printing it."""

    def run(message, **kwargs):
        path.write_bytes(b"PK" * 8)
        return {"final_response": "Done.", "messages": [{"role": "assistant", "content": "Done."}]}

    return run


def test_the_workspace_walk_reports_unnamed_files(turn_env, tmp_path, clean_workspace_turns):
    out = tmp_path / "export.xlsx"

    server._run_prompt_submit("rid", "ui-sid", _session(_agent(_walk_only_turn(out)), explicit_cwd=True), "go")

    assert [f["name"] for f in _complete(turn_env)["files_created"]] == ["export.xlsx"]
    # The turn is recorded as finished once it ends.
    assert all(ended is not None for _folder, _began, ended in clean_workspace_turns.values())


def test_another_conversation_in_the_same_folder_turns_the_walk_off(turn_env, tmp_path, clean_workspace_turns):
    """Its files would otherwise land on this turn's card (found in QA: a long
    turn claimed a spreadsheet another chat saved into the shared folder)."""
    other = server._workspace_turn_begin(str(tmp_path / "sub"), time.time() - 1)
    out = tmp_path / "theirs.xlsx"

    server._run_prompt_submit("rid", "ui-sid", _session(_agent(_walk_only_turn(out)), explicit_cwd=True), "go")

    assert "files_created" not in _complete(turn_env)
    server._workspace_turn_end(other)


class TestWorkspaceOverlap:
    def test_overlap_needs_a_shared_folder_and_time(self, clean_workspace_turns, tmp_path):
        a, b = tmp_path / "a", tmp_path / "b"
        a.mkdir()
        b.mkdir()
        now = time.time()
        mine = server._workspace_turn_begin(str(a), now - 10)
        theirs = server._workspace_turn_begin(str(b), now - 5)

        assert not server._workspace_shared_during(mine, str(a), now - 10, now)

        server._workspace_turn_end(theirs)
        nested = server._workspace_turn_begin(str(a / "deeper"), now - 5)
        assert server._workspace_shared_during(mine, str(a), now - 10, now)
        server._workspace_turn_end(nested)

    def test_a_turn_that_finished_before_this_one_started_does_not_count(self, clean_workspace_turns, tmp_path):
        now = time.time()
        clean_workspace_turns[999] = (os.path.realpath(str(tmp_path)), now - 100, now - 50)

        assert not server._workspace_shared_during(None, str(tmp_path), now - 10, now)

    def test_siblings_with_a_common_prefix_do_not_overlap(self):
        assert not server._folders_overlap("/work/app", "/work/app-2")
        assert server._folders_overlap("/work/app", "/work/app/src")
        assert server._folders_overlap("/work", "/work")


def test_files_survive_a_transcript_rebuilt_from_the_live_history(turn_env, tmp_path):
    """/compress (even one that removes nothing), undo and retry rebuild the
    transcript from the session's in-memory history, not from the database.
    Pinned only to the stored row, the cards vanished from a conversation
    that was still open (found in QA after a refused /compress)."""
    report = tmp_path / "Báo cáo.docx"

    def run(message, **kwargs):
        report.write_bytes(b"PK" * 4)
        return {
            "final_response": f"Đã lưu tại `{report}`.",
            "messages": [
                {"role": "user", "content": "make it"},
                {"role": "assistant", "content": f"Đã lưu tại `{report}`."},
            ],
        }

    session = _session(_agent(run, _FakeDb()))
    server._run_prompt_submit("rid", "ui-sid", session, "make it")

    rebuilt = server._history_to_messages(session["history"])
    reply = [m for m in rebuilt if m.get("role") == "assistant"][-1]
    assert [f["name"] for f in reply["display_metadata"]["files_created"]] == ["Báo cáo.docx"]
    # Only the reply carries it; the provider never sees it (stripped when
    # the request is built).
    assert "display_metadata" not in [m for m in rebuilt if m.get("role") == "user"][-1]


def test_a_branch_seed_keeps_only_real_files_on_assistant_turns(tmp_path):
    """session.create seeds a branch from client text; files the client says a
    turn produced are re-checked on disk and kept on that reply only."""
    real = tmp_path / "report.docx"
    real.write_bytes(b"PK")

    history = server._coerce_seed_history(
        [
            {"role": "user", "content": "make it", "files_created": [{"path": str(real)}]},
            {
                "role": "assistant",
                "content": "Done.",
                "files_created": [{"path": str(real)}, {"path": str(tmp_path / "gone.pdf")}, {"path": "rel.pdf"}, "x"],
            },
        ]
    )

    assert "display_metadata" not in history[0]
    assert [f["name"] for f in history[1]["display_metadata"]["files_created"]] == ["report.docx"]
