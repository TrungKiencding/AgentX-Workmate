"""Speech-to-text through the AgentX AI Gateway (tools/agentx_gateway_stt.py,
plugins/transcription/agentx_gateway/).

The gateway is LiteLLM's ``POST /v1/audio/transcriptions`` with the account's
granted transcription model (``openai/whisper-1`` in production). Covers
availability from the provisioning sidecar, the multipart request (the
account's key and model, ``response_format=json``), the language policy — never
the shipped ``stt.language: en``, which makes Whisper write Vietnamese down as
English — the error paths (the key never in an error), the retry as m4a when
the model refuses a container, discovery of the bundled plugin, and
``transcribe_audio`` end to end.
"""

from __future__ import annotations

import json
import logging
from unittest.mock import patch

import pytest

from agent import transcription_registry

KEY_ENV = "AGENTX_CUSTOM_LITELLM_API_KEY"
API_KEY = "sk-account-key-0123456789"
TRANSCRIPTION_MODEL = "openai/whisper-1"
AUDIO = b"OggS" + bytes(range(256)) * 8


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


def _write_config(home, stt: dict) -> None:
    import yaml

    (home / "config.yaml").write_text(yaml.safe_dump({"stt": stt}))


@pytest.fixture
def account_home(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
    monkeypatch.setenv(KEY_ENV, API_KEY)
    _write_state(tmp_path, transcription_model=TRANSCRIPTION_MODEL)
    return tmp_path


@pytest.fixture
def clip(tmp_path):
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    path = audio_dir / "clip.ogg"
    path.write_bytes(AUDIO)
    return path


@pytest.fixture(autouse=True)
def _reset_registry():
    transcription_registry._reset_for_tests()
    yield
    transcription_registry._reset_for_tests()


class _Reply:
    """What ``requests.post`` hands back."""

    def __init__(self, payload=None, *, status: int = 200, body: bytes | None = None):
        self.status_code = status
        self.headers = {"content-type": "application/json"}
        self._body = body if body is not None else json.dumps(payload).encode()

    def json(self):
        return json.loads(self._body)

    @property
    def text(self):
        return self._body.decode("utf-8", errors="replace")


class _Gateway:
    """Records each POST — URL, headers, form fields, uploaded file — and answers in turn."""

    def __init__(self, *replies):
        self.replies = list(replies) or [_Reply({"text": "xin chào"})]
        self.calls: list[dict] = []

    def __call__(self, url, *, headers=None, files=None, data=None, timeout=None, **_kw):
        name, handle = files["file"]
        self.calls.append(
            {
                "url": url,
                "headers": headers,
                "data": dict(data),
                "name": name,
                "bytes": handle.read(),
                "timeout": timeout,
            }
        )
        return self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]


def _provider():
    from plugins.transcription.agentx_gateway import AgentXGatewayTranscriptionProvider

    return AgentXGatewayTranscriptionProvider()


class TestAvailability:
    def test_available_for_an_account_with_a_transcription_grant(self, account_home):
        provider = _provider()
        assert provider.name == "agentx-gateway"
        assert provider.display_name == "AgentX AI Gateway"
        with patch("requests.post", side_effect=AssertionError("no network in is_available")):
            assert provider.is_available() is True
        assert provider.list_models() == [{"id": TRANSCRIPTION_MODEL, "display": TRANSCRIPTION_MODEL}]
        schema = provider.get_setup_schema()
        assert schema["env_vars"] == [] and schema["requires_account_sign_in"] is True

    def test_not_available_without_a_grant_or_a_key(self, account_home, monkeypatch):
        _write_state(account_home, transcription_model="")
        assert _provider().is_available() is False
        assert _provider().list_models() == []
        _write_state(account_home, transcription_model=TRANSCRIPTION_MODEL)
        monkeypatch.delenv(KEY_ENV)
        assert _provider().is_available() is False

    def test_not_available_signed_out(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
        assert _provider().is_available() is False

    @pytest.mark.parametrize("section", ["agentx_gateway", "agentx-gateway"])
    def test_a_configured_model_overrides_the_grant(self, account_home, section):
        from tools.agentx_gateway_stt import account_transcription_gateway

        _write_config(account_home, {section: {"model": "openai/gpt-4o-mini-transcribe"}})
        assert account_transcription_gateway()["model"] == "openai/gpt-4o-mini-transcribe"


class TestRequest:
    def test_multipart_upload_with_the_accounts_key_and_model(self, account_home, clip):
        gateway = _Gateway()
        with patch("requests.post", side_effect=gateway):
            result = _provider().transcribe(str(clip))

        assert result == {"success": True, "transcript": "xin chào", "provider": "agentx-gateway"}
        (call,) = gateway.calls
        assert call["url"] == "https://gateway.test/v1/audio/transcriptions"
        assert call["headers"] == {"Authorization": f"Bearer {API_KEY}"}
        # No language: Whisper detects it (see TestLanguage).
        assert call["data"] == {"model": TRANSCRIPTION_MODEL, "response_format": "json"}
        assert (call["name"], call["bytes"]) == ("clip.ogg", AUDIO)

    def test_the_backend_takes_a_model_but_the_provider_serves_the_grant(self, account_home, clip):
        from tools.agentx_gateway_stt import transcribe

        gateway = _Gateway()
        with patch("requests.post", side_effect=gateway):
            transcribe(str(clip), model="openai/gpt-4o-transcribe")
            # What the dispatcher may hand the provider — the CLI's legacy
            # top-level ``stt.model``, named for another provider — is not sent.
            _provider().transcribe(str(clip), model="whisper-large-v3")
        assert [call["data"]["model"] for call in gateway.calls] == [
            "openai/gpt-4o-transcribe",
            TRANSCRIPTION_MODEL,
        ]

    def test_the_timeout_knob(self, account_home, clip):
        _write_config(account_home, {"agentx_gateway": {"timeout": 30}})
        gateway = _Gateway()
        with patch("requests.post", side_effect=gateway):
            _provider().transcribe(str(clip))
        assert gateway.calls[0]["timeout"] == 30.0


class TestLanguage:
    def _sent_language(self, clip, **kwargs):
        gateway = _Gateway()
        with patch("requests.post", side_effect=gateway):
            result = _provider().transcribe(str(clip), **kwargs)
        assert result["success"] is True, result
        return gateway.calls[0]["data"].get("language")

    def test_never_the_shipped_english_default(self, account_home, clip):
        from hermes_cli.config import load_config

        # The premise: the merged config says "en" for every provider...
        assert load_config()["stt"]["language"] == "en"
        # ...and the dispatcher hands that to the plugin. Not sent: Whisper detects.
        assert self._sent_language(clip, language="en") is None

    @pytest.mark.parametrize("section", ["agentx_gateway", "agentx-gateway"])
    def test_the_backends_own_language_wins(self, account_home, clip, section):
        _write_config(account_home, {"language": "ja", section: {"language": "vi-VN"}})
        assert self._sent_language(clip) == "vi"

    def test_a_language_somebody_wrote_for_every_provider_is_used(self, account_home, clip):
        _write_config(account_home, {"language": "vi"})
        assert self._sent_language(clip) == "vi"

    def test_english_written_by_somebody_is_their_choice(self, account_home, clip):
        _write_config(account_home, {"language": "en"})
        assert self._sent_language(clip) == "en"

    def test_a_language_an_administrator_pinned_is_used(self, account_home, clip, tmp_path, monkeypatch):
        import yaml

        from hermes_cli import managed_scope

        managed = tmp_path / "managed"
        managed.mkdir()
        (managed / "config.yaml").write_text(yaml.safe_dump({"stt": {"language": "vi"}}))
        monkeypatch.setenv("AGENTX_MANAGED_DIR", str(managed))
        managed_scope.invalidate_managed_cache()
        try:
            assert self._sent_language(clip) == "vi"
        finally:
            managed_scope.invalidate_managed_cache()

    def test_auto_asks_for_detection_even_over_a_written_language(self, account_home, clip):
        _write_config(account_home, {"language": "en", "agentx_gateway": {"language": "auto"}})
        assert self._sent_language(clip) is None

    def test_a_locale_is_sent_as_its_language(self, account_home):
        from tools.agentx_gateway_stt import language_code

        assert language_code("vi-VN") == "vi"
        assert language_code("zh_CN") == "zh"
        assert language_code(" EN ") == "en"
        assert language_code("") is None and language_code(None) is None


class TestErrors:
    def test_an_error_names_the_status_and_never_the_key(self, account_home, clip, caplog):
        # An upstream error that quotes the key it was sent.
        message = f"Authentication Error, Invalid proxy server token passed. Received API Key = {API_KEY}"
        refused = _Reply({"error": {"message": message}}, status=401)
        with caplog.at_level(logging.DEBUG), patch("requests.post", side_effect=_Gateway(refused)):
            result = _provider().transcribe(str(clip))

        assert result["success"] is False and result["transcript"] == ""
        assert result["provider"] == "agentx-gateway"
        assert "(401)" in result["error"] and "Invalid proxy server token" in result["error"]
        assert API_KEY not in result["error"] and API_KEY not in caplog.text

    def test_a_failed_request_never_shows_the_key(self, account_home, clip, caplog):
        import requests

        leak = requests.exceptions.InvalidHeader(f"Invalid header value b'Bearer {API_KEY}\\n'")
        with caplog.at_level(logging.DEBUG), patch("requests.post", side_effect=leak):
            result = _provider().transcribe(str(clip))

        assert result["success"] is False and "Invalid header value" in result["error"]
        assert API_KEY not in result["error"] and API_KEY not in caplog.text

    def test_a_reply_without_a_transcript_is_an_error(self, account_home, clip):
        for reply in (_Reply({"ok": True}), _Reply(body=b"<html>gateway</html>")):
            with patch("requests.post", side_effect=_Gateway(reply)):
                result = _provider().transcribe(str(clip))
            assert result["success"] is False and "without a transcript" in result["error"]

    def test_silence_is_an_empty_transcript(self, account_home, clip):
        with patch("requests.post", side_effect=_Gateway(_Reply({"text": "  "}))):
            result = _provider().transcribe(str(clip))
        assert result == {"success": True, "transcript": "", "provider": "agentx-gateway"}

    def test_signed_out_says_how_to_fix_it(self, tmp_path, monkeypatch, clip):
        monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
        with patch("requests.post", side_effect=AssertionError("nothing to call")):
            result = _provider().transcribe(str(clip))
        assert result["success"] is False and "sign in" in result["error"]


class TestRefusedContainer:
    # How LiteLLM relays OpenAI refusing a container it does not take.
    REFUSED = {
        "error": {"message": "OpenAIException - Invalid file format. Supported formats: ['flac', 'm4a', 'mp3']"}
    }

    def test_a_refused_container_is_sent_again_as_m4a(self, account_home, tmp_path):
        voice_note = tmp_path / "audio.aac"
        voice_note.write_bytes(AUDIO)

        def transcode(path, work_dir):
            converted = f"{work_dir}/audio-stt.m4a"
            with open(converted, "wb") as handle:
                handle.write(b"m4a-bytes")
            return converted, None

        gateway = _Gateway(_Reply(self.REFUSED, status=400), _Reply({"text": "tin nhắn thoại"}))
        with patch("tools.transcription_tools._transcode_audio_for_stt", side_effect=transcode), patch(
            "requests.post", side_effect=gateway
        ):
            result = _provider().transcribe(str(voice_note))

        assert result["success"] is True and result["transcript"] == "tin nhắn thoại"
        assert [call["name"] for call in gateway.calls] == ["audio.aac", "audio-stt.m4a"]
        assert gateway.calls[1]["bytes"] == b"m4a-bytes"

    def test_without_ffmpeg_the_refusal_is_reported(self, account_home, clip):
        with patch(
            "tools.transcription_tools._transcode_audio_for_stt",
            return_value=(None, "audio needs transcoding for the STT API, but ffmpeg was not found"),
        ), patch("requests.post", side_effect=_Gateway(_Reply(self.REFUSED, status=400))) as post:
            result = _provider().transcribe(str(clip))

        assert result["success"] is False
        assert "Invalid file format" in result["error"] and "ffmpeg" in result["error"]
        assert post.call_count == 1

    def test_any_other_400_is_not_retried(self, account_home, clip):
        other = {"error": {"message": "team not allowed to access model openai/whisper-1"}}
        with patch("tools.transcription_tools._transcode_audio_for_stt") as transcode, patch(
            "requests.post", side_effect=_Gateway(_Reply(other, status=400))
        ):
            result = _provider().transcribe(str(clip))
        assert result["success"] is False and "(400)" in result["error"]
        transcode.assert_not_called()


class TestPlugin:
    def test_the_bundled_plugin_registers_the_provider(self):
        from plugins.transcription.agentx_gateway import register

        class _Ctx:
            def register_transcription_provider(self, provider):
                transcription_registry.register_provider(provider)

        register(_Ctx())
        assert transcription_registry.get_provider("agentx-gateway") is not None

    def test_discovery_loads_it_from_plugins_transcription(self, account_home):
        from hermes_cli.plugins import PluginManager

        manager = PluginManager()
        manager.discover_and_load()

        loaded = manager._plugins["transcription/agentx_gateway"]
        assert loaded.enabled is True, loaded.error
        provider = transcription_registry.get_provider("agentx-gateway")
        assert type(provider).__name__ == "AgentXGatewayTranscriptionProvider"
        assert provider.is_available() is True


class TestTranscribeAudio:
    """``tools.transcription_tools.transcribe_audio`` — what dictation, voice mode
    and voice messages call — with nothing patched but the HTTP layer."""

    def test_transcribes_through_the_gateway(self, account_home, clip):
        from tools.transcription_tools import transcribe_audio

        _write_config(account_home, {"provider": "agentx-gateway"})
        gateway = _Gateway(_Reply({"text": "Xin chào, tôi là Kiên."}))
        with patch("requests.post", side_effect=gateway):
            result = transcribe_audio(str(clip))

        assert result == {"success": True, "transcript": "Xin chào, tôi là Kiên.", "provider": "agentx-gateway"}
        (call,) = gateway.calls
        assert call["url"] == "https://gateway.test/v1/audio/transcriptions"
        assert call["data"]["model"] == TRANSCRIPTION_MODEL
        # The dispatcher resolved the shipped "en"; the gateway still lets Whisper detect.
        assert "language" not in call["data"]

    def test_without_a_grant_the_dispatcher_says_so(self, account_home, clip):
        from tools.transcription_tools import transcribe_audio

        _write_config(account_home, {"provider": "agentx-gateway"})
        _write_state(account_home, transcription_model="")
        with patch("requests.post", side_effect=AssertionError("nothing to call")):
            result = transcribe_audio(str(clip))

        assert result["success"] is False
        assert result["provider"] == "agentx-gateway" and "not available" in result["error"]
