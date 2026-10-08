"""The classic CLI's AI work outside a turn says why while the license is read-only.

``/compress`` (the preview is local arithmetic and still answers), voice
mode, a recording and the wake word each print the license's reason and
leave everything as it was: no summary, no microphone, no transcription.
"""

from __future__ import annotations

import queue
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from hermes_cli.account_license import READ_ONLY_CODE, read_only_message, remember_license
from tests.cli.test_cli_init import _make_cli

_REVOKED = {
    "state": "revoked",
    "access": "read_only",
    "enforced": True,
    "notice": "read_only",
    "plan": {"slug": "pilot-2026", "name": "Pilot 2026"},
    "revoked_at": "2026-11-02T10:00:00+07:00",
    "contact": "it@astralx.com.vn",
    "warn_days": [14, 7, 1],
    "server_time": "2026-11-02T10:00:00+07:00",
}

_HISTORY = [
    {"role": "user", "content": "one"},
    {"role": "assistant", "content": "two"},
    {"role": "user", "content": "three"},
    {"role": "assistant", "content": "four"},
]


def _never(*_args, **_kwargs):
    raise AssertionError("a refused request must not get this far")


@pytest.fixture
def read_only():
    remember_license(_REVOKED)


def _voice_cli(**overrides):
    """A HermesCLI with only the voice state set up (bypasses __init__)."""
    from cli import HermesCLI

    shell = HermesCLI.__new__(HermesCLI)
    shell._voice_lock = threading.Lock()
    shell._voice_mode = False
    shell._voice_tts = False
    shell._voice_recorder = None
    shell._voice_recording = False
    shell._voice_processing = False
    shell._voice_continuous = False
    shell._voice_tts_done = threading.Event()
    shell._voice_tts_done.set()
    shell._voice_tts_stop = None
    shell._voice_barge_capture = threading.Event()
    shell._pending_input = queue.Queue()
    shell._app = None
    shell._attached_images = []
    shell.console = SimpleNamespace(width=80)
    for key, value in overrides.items():
        setattr(shell, key, value)
    return shell


def _printed(mock) -> str:
    return "\n".join(str(call.args[0]) for call in mock.call_args_list if call.args)


class TestCompress:
    def _shell(self):
        shell = _make_cli()
        shell.conversation_history = list(_HISTORY)
        shell.agent = MagicMock()
        shell.agent._cached_system_prompt = ""
        shell.agent.tools = None
        shell.agent._compress_context.side_effect = _never
        return shell

    def test_it_says_why_and_changes_nothing(self, read_only, capsys):
        shell = self._shell()

        shell._manual_compress("/compress")

        assert read_only_message(_REVOKED) in capsys.readouterr().out
        assert shell.conversation_history == _HISTORY

    def test_the_preview_still_answers(self, read_only, capsys):
        shell = self._shell()

        with patch("agent.model_metadata.estimate_request_tokens_rough", return_value=100):
            shell._manual_compress("/compress --preview")

        out = capsys.readouterr().out
        assert "🗜️" in out and read_only_message(_REVOKED) not in out


class TestVoice:
    def test_voice_mode_stays_off(self, read_only):
        shell = _voice_cli()

        with patch("cli._cprint") as printed, patch("tools.voice_mode.check_voice_requirements", _never):
            shell._enable_voice_mode()

        assert shell._voice_mode is False
        assert read_only_message(_REVOKED) in _printed(printed)

    def test_a_recording_does_not_start(self, read_only):
        shell = _voice_cli(_voice_mode=True)

        with patch("tools.voice_mode.create_audio_recorder", _never), pytest.raises(RuntimeError) as refused:
            shell._voice_start_recording()

        assert str(refused.value) == read_only_message(_REVOKED)
        assert shell._voice_recording is False

    @patch("tools.voice_mode.play_beep")
    @patch("hermes_cli.config.load_config", return_value={"stt": {}})
    def test_a_refused_transcription_ends_voice_mode(self, _cfg, _beep):
        refused = {
            "success": False,
            "transcript": "",
            "error": read_only_message(_REVOKED),
            "code": READ_ONLY_CODE,
            "license": _REVOKED,
        }
        recorder = MagicMock()
        recorder.stop.return_value = "/tmp/never-kept.wav"
        shell = _voice_cli(_voice_mode=True, _voice_continuous=True, _voice_recording=True, _voice_recorder=recorder)

        with (
            patch("cli._cprint") as printed,
            patch("tools.voice_mode.transcribe_recording", return_value=refused),
            patch("cli.os.path.isfile", return_value=False),
        ):
            shell._voice_stop_and_transcribe()

        assert shell._voice_mode is False and shell._voice_continuous is False
        assert shell._pending_input.empty()
        assert read_only_message(_REVOKED) in _printed(printed)
        assert "Recording preserved" not in _printed(printed)


def test_the_wake_word_says_why_and_keeps_listening(read_only):
    shell = _voice_cli(_agent_running=False, _should_exit=False)

    with patch("cli._cprint") as printed, patch("tools.wake_word.pause_listening", _never):
        shell._on_wake_word()

    assert read_only_message(_REVOKED) in _printed(printed)
    assert shell._voice_mode is False
