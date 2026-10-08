"""The gateway's AI methods outside an agent turn refuse while the license is read-only.

One-off generations (the desktop's commit-message and project-idea buttons),
manual compaction on all three routes, pet and image generation, voice and
the wake word: each answers with the same refusal — JSON-RPC error 4403, the
reason in the display language as the message, ``data.code`` the
``license_read_only`` a refused turn carries and the license beside it —
before a status line, a compute-host round trip, a microphone or a provider.
"""

from __future__ import annotations

import sys
import threading
import types
from unittest.mock import MagicMock

import pytest

from hermes_cli.account_license import READ_ONLY_CODE, LicenseReadOnly, read_only_message, remember_license
from tui_gateway import server
from tui_gateway.transport import bind_transport, reset_transport

_EXPIRED = {
    "state": "expired",
    "access": "read_only",
    "enforced": True,
    "notice": "read_only",
    "plan": {"slug": "pilot-2026", "name": "Pilot 2026"},
    "last_day": "2026-12-31",
    "read_only_from": "2027-01-08",
    "contact": "it@astralx.com.vn",
    "warn_days": [14, 7, 1],
    "server_time": "2027-01-09T09:00:00+07:00",
}


def _never(*_args, **_kwargs):
    raise AssertionError("a refused request must not get this far")


def _dispatch(method: str, params: dict, transport=None) -> dict:
    token = bind_transport(transport)
    try:
        return server.handle_request({"id": "r1", "method": method, "params": params})
    finally:
        reset_transport(token)


def _assert_refused(response: dict) -> None:
    error = response["error"]
    assert error["code"] == server.LICENSE_READ_ONLY_RPC_CODE == 4403
    assert error["message"] == read_only_message(_EXPIRED)
    assert error["data"]["code"] == READ_ONLY_CODE
    assert error["data"]["license"]["state"] == "expired"


@pytest.fixture
def read_only():
    remember_license(_EXPIRED)
    return _EXPIRED


def _history():
    return [
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "c"},
        {"role": "assistant", "content": "d"},
    ]


@pytest.fixture
def session(monkeypatch):
    agent = MagicMock()
    agent._compress_context.side_effect = _never
    entry = {
        "agent": agent,
        "history_lock": threading.Lock(),
        "history": _history(),
        "history_version": 1,
        "running": False,
        "session_key": "sess-license",
    }
    sid = "sid-license"
    server._sessions[sid] = entry
    try:
        yield sid, entry
    finally:
        server._sessions.pop(sid, None)


class TestOneOffGeneration:
    def test_it_is_refused_before_the_model_is_asked(self, read_only, monkeypatch):
        monkeypatch.setattr("agent.oneshot.run_oneshot", _never)

        _assert_refused(_dispatch("llm.oneshot", {"template": "commit_message", "variables": {"diff": "+x"}}))

    def test_a_license_that_turned_read_only_on_the_way_reads_the_same(self, monkeypatch):
        def refuse(**_kwargs):
            raise LicenseReadOnly(_EXPIRED)

        monkeypatch.setattr("agent.oneshot.run_oneshot", refuse)

        _assert_refused(_dispatch("llm.oneshot", {"instructions": "x", "input": "y"}))

    def test_it_runs_while_the_license_covers_ai(self, monkeypatch):
        monkeypatch.setattr("agent.oneshot.run_oneshot", lambda **_kwargs: "feat: a commit")

        assert _dispatch("llm.oneshot", {"instructions": "x", "input": "y"})["result"] == {"text": "feat: a commit"}


class TestManualCompaction:
    def test_the_rpc_is_refused_before_a_status_line_or_a_compute_host(self, read_only, session, monkeypatch):
        sid, entry = session
        monkeypatch.setattr(server, "_status_update", _never)
        monkeypatch.setattr(server, "_session_uses_compute_host", _never)

        _assert_refused(_dispatch("session.compress", {"session_id": sid}))
        assert entry["history"] == _history() and entry["history_version"] == 1

    def test_the_slash_command_is_refused(self, read_only, session, monkeypatch):
        sid, entry = session
        monkeypatch.setattr(server, "_session_uses_compute_host", _never)

        _assert_refused(_dispatch("command.dispatch", {"name": "compress", "arg": "", "session_id": sid}))
        assert entry["history"] == _history()

    @pytest.mark.parametrize("command", ["/compress", "/compact here 2"])
    def test_the_slash_mirror_says_why(self, read_only, session, monkeypatch, command):
        sid, entry = session
        monkeypatch.setattr(server, "_session_uses_compute_host", _never)

        assert server._mirror_slash_side_effects(sid, entry, command) == read_only_message(_EXPIRED)
        assert entry["history"] == _history()

    def test_a_license_that_turned_read_only_mid_rpc_changes_nothing(self, session, monkeypatch):
        sid, entry = session
        monkeypatch.setattr(server, "_session_uses_compute_host", lambda _session: False)
        monkeypatch.setattr(server, "_status_update", lambda *_args, **_kwargs: None)
        monkeypatch.setattr("agent.model_metadata.estimate_request_tokens_rough", lambda *a, **k: 100)

        def refuse(*_args, **_kwargs):
            raise LicenseReadOnly(_EXPIRED)

        entry["agent"]._compress_context.side_effect = refuse

        _assert_refused(_dispatch("session.compress", {"session_id": sid}))
        assert entry["history"] == _history() and entry["history_version"] == 1


class TestImages:
    def test_pet_drafts_are_refused(self, read_only, monkeypatch):
        monkeypatch.setattr("agent.pet.generate.generate_base_drafts", _never)

        _assert_refused(_dispatch("pet.generate", {"prompt": "a small fox"}))

    def test_hatching_is_refused(self, read_only, monkeypatch):
        monkeypatch.setattr("agent.pet.generate.hatch_pet", _never)

        _assert_refused(_dispatch("pet.hatch", {"token": "t1", "index": 0, "name": "Fox"}))

    def test_image_generation_is_refused_but_still_reports_availability(self, read_only, monkeypatch):
        monkeypatch.setattr("tools.image_generation_tool._handle_image_generate", _never)
        monkeypatch.setattr("tools.image_generation_tool.check_image_generation_requirements", lambda: True)

        assert _dispatch("image.generate", {"probe": True})["result"] == {"available": True}
        _assert_refused(_dispatch("image.generate", {"prompt": "a lighthouse"}))


class TestVoice:
    def test_voice_mode_cannot_be_turned_on(self, read_only, monkeypatch):
        monkeypatch.setenv("AGENTX_VOICE", "0")

        _assert_refused(_dispatch("voice.toggle", {"action": "on"}))
        assert server._voice_mode_enabled() is False

    def test_it_can_always_be_turned_off(self, read_only, monkeypatch):
        monkeypatch.setenv("AGENTX_VOICE", "1")
        monkeypatch.setattr(server, "_voice_tts_enabled", lambda: False)

        assert "error" not in _dispatch("voice.toggle", {"action": "off"})

    def test_recording_does_not_start(self, read_only, monkeypatch):
        monkeypatch.setenv("AGENTX_VOICE", "1")
        monkeypatch.setitem(
            sys.modules,
            "hermes_cli.voice",
            types.SimpleNamespace(start_continuous=_never, stop_continuous=lambda **_k: None),
        )
        server._wake_owner_transport = None

        _assert_refused(_dispatch("voice.record", {"action": "start"}))

    def test_nothing_is_spoken(self, read_only, monkeypatch):
        monkeypatch.setattr(server, "_speak_text_with_barge", _never)

        _assert_refused(_dispatch("voice.tts", {"text": "Xin chào"}))


class TestWakeWord:
    @pytest.fixture
    def engine(self, monkeypatch):
        from tools import wake_word

        state = {"callback": None, "paused": False, "persisted": []}

        def start_listening(callback, *, owner, config, external_audio=False):
            state["callback"] = callback

        def pause_listening(*, owner):
            state["paused"] = True
            return True

        monkeypatch.setattr(wake_word, "load_wake_word_config", lambda: {"enabled": False, "surface": "auto"})
        monkeypatch.setattr(
            wake_word,
            "check_wake_word_requirements",
            lambda _cfg: {"available": True, "phrase": "hey agentx", "provider": "test", "hint": ""},
        )
        monkeypatch.setattr(wake_word, "start_listening", start_listening)
        monkeypatch.setattr(wake_word, "pause_listening", pause_listening)
        monkeypatch.setattr(wake_word, "owns_listener", lambda owner: True)
        monkeypatch.setattr(wake_word, "get_last_match", lambda: None)
        monkeypatch.setattr(server, "_persist_wake_enabled", lambda enabled: state["persisted"].append(enabled))
        server._wake_owner_transport = None
        server._wake_owner_surface = ""
        try:
            yield state
        finally:
            server._wake_owner_transport = None
            server._wake_owner_surface = ""

    def test_it_is_not_armed_and_config_is_left_alone(self, read_only, engine):
        result = _dispatch("wake.start", {"surface": "gui", "persist": True})["result"]

        assert result == {"started": False, "reason": "license_read_only", "hint": read_only_message(_EXPIRED)}
        assert engine["callback"] is None and engine["persisted"] == []

    def test_a_paused_listener_stays_paused(self, read_only):
        assert _dispatch("wake.resume", {})["result"] == {"resumed": False, "reason": "license_read_only"}

    def test_a_detection_after_the_license_turned_read_only_starts_nothing(self, engine, monkeypatch):
        emitted = []
        monkeypatch.setattr(server, "_emit", lambda *args: emitted.append(args))
        monkeypatch.setattr(server, "_transport_is_dead", lambda transport: False)
        monkeypatch.setattr(
            "tools.wake_word.load_wake_word_config",
            lambda: {"enabled": True, "surface": "auto", "start_new_session": True},
        )
        transport = types.SimpleNamespace(_closed=False)

        started = _dispatch("wake.start", {"surface": "gui", "session_id": "s1"}, transport=transport)
        assert started["result"]["started"] is True

        remember_license(_EXPIRED)
        engine["callback"]()

        assert emitted == [] and engine["paused"] is False
