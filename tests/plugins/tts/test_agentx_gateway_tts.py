"""Text-to-speech through the AgentX AI Gateway (tools/agentx_gateway_tts.py,
plugins/tts/agentx_gateway/, tools.tts_streaming.AgentXGatewayStreamer).

The gateway's speech model (Gemini TTS through OpenRouter) answers raw PCM only —
24 kHz, int16 LE, mono — and takes Gemini voice names only. Covers availability
from the provisioning sidecar, the request (always PCM, a Gemini voice, the
account's key), the containers written from PCM (WAV directly, MP3/Opus through
ffmpeg, WAV when ffmpeg is missing), the error paths, sample-aligned streaming,
and the ``text_to_speech`` tool end to end.
"""

from __future__ import annotations

import json
import shutil
import struct
from unittest.mock import patch

import pytest

from agent import tts_registry

KEY_ENV = "AGENTX_CUSTOM_LITELLM_API_KEY"
SPEECH_MODEL = "google/gemini-3.8-flash-lite-tts"
#: Half a second of a quiet 440 Hz-ish square wave: real-looking int16 PCM.
PCM = b"".join(struct.pack("<h", 3000 if (i // 27) % 2 else -3000) for i in range(12000))
HAS_FFMPEG = shutil.which("ffmpeg") is not None


def _write_state(home, **overrides) -> None:
    state = {
        "base_url": "https://gateway.test",
        "key_env": KEY_ENV,
        "provider": "litellm",
        "mode": "second_brain",
        "models": ["chat-a"],
        **overrides,
    }
    (home / "litellm-account.json").write_text(json.dumps(state))


def _write_config(home, tts: dict) -> None:
    import yaml

    (home / "config.yaml").write_text(yaml.safe_dump({"tts": tts}))


@pytest.fixture
def account_home(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
    monkeypatch.setenv(KEY_ENV, "sk-account-key")
    _write_state(tmp_path, speech_model=SPEECH_MODEL)
    return tmp_path


@pytest.fixture(autouse=True)
def _reset_registry():
    tts_registry._reset_for_tests()
    yield
    tts_registry._reset_for_tests()


class _Reply:
    """What ``requests.post(..., stream=True)`` hands back."""

    def __init__(self, body: bytes = PCM, *, status: int = 200, content_type: str = "audio/pcm", chunks=None):
        self.status_code = status
        self.headers = {"content-type": content_type}
        self._body = body
        self._chunks = chunks
        self.closed = False

    def iter_content(self, chunk_size=1):
        if self._chunks is not None:
            yield from self._chunks
            return
        for start in range(0, len(self._body), chunk_size):
            yield self._body[start : start + chunk_size]

    def json(self):
        return json.loads(self._body)

    @property
    def text(self):
        return self._body.decode("utf-8", errors="replace")

    def close(self):
        self.closed = True


def _provider():
    from plugins.tts.agentx_gateway import AgentXGatewayTTSProvider

    return AgentXGatewayTTSProvider()


def _wav_header(data: bytes) -> tuple:
    riff, _size, wave = struct.unpack("<4sI4s", data[:12])
    _fmt, _len, audio_format, channels, rate, _byte_rate, _align, bits = struct.unpack("<4sIHHIIHH", data[12:36])
    return riff, wave, audio_format, channels, rate, bits


class TestAvailability:
    def test_available_for_an_account_with_a_speech_grant(self, account_home):
        provider = _provider()
        assert provider.name == "agentx-gateway"
        assert provider.display_name == "AgentX AI Gateway"
        with patch("requests.post", side_effect=AssertionError("no network in is_available")):
            assert provider.is_available() is True
        assert provider.list_models() == [{"id": SPEECH_MODEL, "display": SPEECH_MODEL}]
        assert provider.default_voice() == "Kore"
        assert "Kore" in [v["id"] for v in provider.list_voices()]
        assert provider.voice_compatible is False  # desktop and CLI keep the container they ask for

    def test_not_available_without_a_grant_or_a_key(self, account_home, monkeypatch):
        _write_state(account_home, speech_model="")
        assert _provider().is_available() is False
        _write_state(account_home, speech_model=SPEECH_MODEL)
        monkeypatch.delenv(KEY_ENV)
        assert _provider().is_available() is False

    def test_not_available_signed_out(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
        assert _provider().is_available() is False

    def test_a_configured_model_overrides_the_grant(self, account_home):
        from tools.agentx_gateway_tts import account_speech_gateway

        _write_config(account_home, {"agentx_gateway": {"model": "google/other-tts"}})
        assert account_speech_gateway()["model"] == "google/other-tts"


class TestVoice:
    def test_kore_by_default_and_gemini_names_only(self, account_home):
        from tools.agentx_gateway_tts import resolve_voice

        assert resolve_voice() == "Kore"
        assert resolve_voice("puck") == "Puck"  # the canonical spelling
        assert resolve_voice("alloy") == "Kore"  # an OpenAI name would be a 400
        _write_config(account_home, {"agentx_gateway": {"voice": "Zephyr"}})
        assert resolve_voice("Puck") == "Zephyr"  # the backend's own setting wins


class TestSynthesize:
    def test_asks_for_pcm_with_a_gemini_voice_and_writes_a_wav(self, account_home, tmp_path):
        out = tmp_path / "reply.wav"
        with patch("requests.post", return_value=_Reply()) as post:
            written = _provider().synthesize("Xin chào", str(out), voice="alloy")
        assert written == str(out)
        url = post.call_args.args[0]
        kwargs = post.call_args.kwargs
        assert url == "https://gateway.test/v1/audio/speech"
        assert kwargs["json"] == {"model": SPEECH_MODEL, "input": "Xin chào", "voice": "Kore", "response_format": "pcm"}
        assert kwargs["headers"]["Authorization"] == "Bearer sk-account-key"
        data = out.read_bytes()
        assert _wav_header(data) == (b"RIFF", b"WAVE", 1, 1, 24000, 16)
        assert data[44:] == PCM

    def test_without_ffmpeg_the_audio_stays_wav_and_says_so(self, account_home, tmp_path, monkeypatch):
        monkeypatch.setattr("tools.agentx_gateway_tts.shutil.which", lambda _name: None)
        with patch("requests.post", return_value=_Reply()):
            written = _provider().synthesize("Xin chào", str(tmp_path / "reply.mp3"))
        assert written.endswith("reply.wav")
        assert (tmp_path / "reply.wav").read_bytes()[:4] == b"RIFF"
        assert not (tmp_path / "reply.mp3").exists()

    @pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")
    def test_mp3_and_opus_go_through_ffmpeg(self, account_home, tmp_path):
        with patch("requests.post", return_value=_Reply()):
            mp3 = _provider().synthesize("Xin chào", str(tmp_path / "reply.mp3"))
        head = (tmp_path / "reply.mp3").read_bytes()[:3]
        assert mp3.endswith(".mp3") and (head == b"ID3" or head[:1] == b"\xff")
        with patch("requests.post", return_value=_Reply()):
            ogg = _provider().synthesize("Xin chào", str(tmp_path / "voice.ogg"))
        data = (tmp_path / "voice.ogg").read_bytes()
        assert ogg.endswith(".ogg") and data[:4] == b"OggS" and b"OpusHead" in data[:200]

    def test_a_trailing_half_sample_is_dropped(self, account_home, tmp_path):
        with patch("requests.post", return_value=_Reply(PCM + b"\x01")):
            _provider().synthesize("x", str(tmp_path / "a.wav"))
        assert (tmp_path / "a.wav").read_bytes()[44:] == PCM

    def test_the_gateways_error_is_named(self, account_home, tmp_path):
        refused = json.dumps({"error": {"message": "Gemini TTS only supports response_format=\"pcm\""}}).encode()
        with patch("requests.post", return_value=_Reply(refused, status=400, content_type="application/json")):
            with pytest.raises(RuntimeError, match=r"\(400\).*only supports"):
                _provider().synthesize("x", str(tmp_path / "a.wav"))

    def test_a_reply_without_audio_is_an_error(self, account_home, tmp_path):
        with patch("requests.post", return_value=_Reply(b'{"ok": true}', content_type="application/json")):
            with pytest.raises(RuntimeError, match="without audio"):
                _provider().synthesize("x", str(tmp_path / "a.wav"))
        with patch("requests.post", return_value=_Reply(b"")):
            with pytest.raises(RuntimeError, match="no audio"):
                _provider().synthesize("x", str(tmp_path / "b.wav"))

    def test_signed_out_says_how_to_fix_it(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
        with pytest.raises(ValueError, match="sign in"):
            _provider().synthesize("x", str(tmp_path / "a.wav"))


class TestStreaming:
    def test_chunks_are_whole_samples(self, account_home):
        from tools.agentx_gateway_tts import iter_pcm

        pieces = [PCM[:3], PCM[3:8], PCM[8:9], PCM[9:200]]
        with patch("requests.post", return_value=_Reply(chunks=pieces)):
            out = list(iter_pcm("x"))
        assert all(len(chunk) % 2 == 0 for chunk in out)
        assert b"".join(out) == PCM[:200]

    def test_voice_mode_streams_from_the_gateway(self, account_home):
        from tools.tts_streaming import AgentXGatewayStreamer, resolve_streaming_provider

        streamer = resolve_streaming_provider({"provider": "agentx-gateway"})
        assert isinstance(streamer, AgentXGatewayStreamer) and streamer.sample_rate == 24000
        with patch("requests.post", return_value=_Reply()) as post:
            assert b"".join(streamer.stream("Xin chào")) == PCM
        assert post.call_args.kwargs["stream"] is True

    def test_no_streamer_without_a_grant(self, account_home):
        from tools.tts_streaming import resolve_streaming_provider

        _write_state(account_home, speech_model="")
        assert resolve_streaming_provider({"provider": "agentx-gateway"}) is None


class TestTool:
    @pytest.fixture
    def registered(self, account_home, monkeypatch):
        import hermes_cli.plugins as plugins_module

        monkeypatch.setattr(plugins_module, "_ensure_plugins_discovered", lambda force=False: None)
        tts_registry.register_provider(_provider())
        _write_config(account_home, {"provider": "agentx-gateway"})
        return account_home

    def test_text_to_speech_reads_aloud_through_the_gateway(self, registered, tmp_path):
        from tools.tts_tool import check_tts_requirements, text_to_speech_tool

        assert check_tts_requirements() is True
        with patch("requests.post", return_value=_Reply()) as post:
            result = json.loads(text_to_speech_tool("Xin chào, tôi là AgentX.", output_path=str(tmp_path / "r.wav")))
        assert result["success"] is True, result
        assert result["provider"] == "agentx-gateway"
        assert result["file_path"].endswith("r.wav")
        assert post.call_args.kwargs["json"]["model"] == SPEECH_MODEL

    @pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")
    def test_a_messaging_platform_gets_an_opus_voice_bubble(self, registered, tmp_path, monkeypatch):
        from tools.tts_tool import text_to_speech_tool

        monkeypatch.setenv("AGENTX_SESSION_PLATFORM", "telegram")
        assert _provider().voice_compatible is True
        with patch("requests.post", return_value=_Reply()):
            result = json.loads(text_to_speech_tool("Xin chào", output_path=str(tmp_path / "r.mp3")))
        assert result["success"] is True, result
        assert result["file_path"].endswith(".ogg") and result["voice_compatible"] is True
        assert result["media_tag"].startswith("[[audio_as_voice]]")

    def test_without_a_grant_the_tool_says_so(self, registered, tmp_path):
        from tools.tts_tool import check_tts_requirements, text_to_speech_tool

        _write_state(registered, speech_model="")
        assert check_tts_requirements() is False
        result = json.loads(text_to_speech_tool("Xin chào", output_path=str(tmp_path / "r.wav")))
        assert result["success"] is False and "sign in" in result["error"]


def test_the_bundled_plugin_registers_the_provider():
    from plugins.tts.agentx_gateway import register

    class _Ctx:
        def register_tts_provider(self, provider):
            tts_registry.register_provider(provider)

    register(_Ctx())
    assert tts_registry.get_provider("agentx-gateway") is not None
