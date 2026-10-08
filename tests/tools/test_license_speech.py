"""Speech is refused while the AgentX license is read-only — every engine.

Read-only Workmate does no AI work, and speech recognition and synthesis are
AI work whether a provider or an on-device model does them, so one rule
covers all of them: the transcription and synthesis entry points answer with
a failed result carrying the license's reason and the refusal code, before a
file is read, a backend chosen or a provider called. Streaming synthesis
reports "no streamer", so every caller takes the sync path and is refused
there with the reason — said once.
"""

from __future__ import annotations

import json

import pytest

import tools.transcription_tools as stt
import tools.tts_streaming as tts_streaming
import tools.tts_tool as tts
from hermes_cli.account_license import READ_ONLY_CODE, read_only_message, remember_license

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

_ACTIVE = {**_REVOKED, "state": "active", "access": "full", "notice": None, "revoked_at": None}


@pytest.fixture
def home(tmp_path, monkeypatch):
    path = tmp_path / "account"
    path.mkdir()
    monkeypatch.setenv("AGENTX_HOME", str(path))
    return path


def _never(*_args, **_kwargs):
    raise AssertionError("a refused request must not reach an engine")


class TestTranscription:
    def test_it_is_refused_before_the_file_is_read(self, home, monkeypatch, tmp_path):
        remember_license(_REVOKED)
        monkeypatch.setattr(stt, "_prepare_audio_for_transcription", _never)
        monkeypatch.setattr(stt, "_transcribe_prepared_audio", _never)

        result = stt.transcribe_audio(str(tmp_path / "never-read.wav"))

        assert result["success"] is False
        assert result["transcript"] == ""
        assert result["code"] == READ_ONLY_CODE
        assert result["error"] == read_only_message(_REVOKED)
        assert result["license"]["state"] == "revoked"

    def test_the_gateways_local_fallback_is_refused_too(self, home, monkeypatch, tmp_path):
        # On-device whisper is AI work as well: the rule names no engine.
        remember_license(_REVOKED)
        monkeypatch.setattr(stt, "_transcribe_local", _never)
        monkeypatch.setattr(stt, "_transcribe_local_command", _never)

        result = stt.transcribe_audio_local_fallback(str(tmp_path / "voice.ogg"))

        assert result["code"] == READ_ONLY_CODE and result["success"] is False

    @pytest.mark.parametrize("known", [None, _ACTIVE], ids=["none-known", "active"])
    def test_it_runs_while_the_license_covers_ai(self, home, tmp_path, known):
        if known is not None:
            remember_license(known)

        result = stt.transcribe_audio(str(tmp_path / "missing.wav"))

        # Past the license: the file check answers instead.
        assert result["success"] is False
        assert "code" not in result


class TestSynthesis:
    def test_it_is_refused_before_a_provider_is_chosen(self, home, monkeypatch):
        remember_license(_REVOKED)
        monkeypatch.setattr(tts, "_load_tts_config", _never)

        result = json.loads(tts.text_to_speech_tool("Xin chào"))

        assert result["success"] is False
        assert result["code"] == READ_ONLY_CODE
        assert result["error"] == read_only_message(_REVOKED)
        assert result["license"]["state"] == "revoked"

    def test_a_named_provider_is_refused_alike(self, home, monkeypatch):
        remember_license(_REVOKED)
        monkeypatch.setattr(tts, "_load_tts_config", _never)

        result = json.loads(tts.text_to_speech_tool("Hello", provider="piper"))

        assert result["code"] == READ_ONLY_CODE

    def test_streaming_reports_no_streamer(self, home, monkeypatch):
        remember_license(_REVOKED)
        monkeypatch.setattr(tts_streaming, "_try_instantiate", _never)

        assert tts_streaming.resolve_streaming_provider({"streaming": {"provider": "auto"}}) is None

    @pytest.mark.parametrize("known", [None, _ACTIVE], ids=["none-known", "active"])
    def test_it_runs_while_the_license_covers_ai(self, home, monkeypatch, known):
        if known is not None:
            remember_license(known)
        sentinel = object()
        monkeypatch.setattr(tts_streaming, "_try_instantiate", lambda name, cfg: sentinel)

        assert tts_streaming.resolve_streaming_provider({"streaming": {"provider": "openai"}}) is sentinel
        # Past the license: the empty-text check answers instead.
        assert json.loads(tts.text_to_speech_tool("   "))["error"] == "Text is required"
