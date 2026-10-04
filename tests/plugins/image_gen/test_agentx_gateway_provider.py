"""The AgentX AI Gateway image backend (plugins/image_gen/agentx_gateway/).

Covers availability from the provisioning sidecar, the generations and edits
requests (shape, key, size), saving the returned picture with the right
extension, the error paths, and how ``tools.image_generation_tool`` makes it
the default for a signed-in account without overriding a deliberate choice.
"""

from __future__ import annotations

import base64
import json
from unittest.mock import MagicMock, patch

import pytest

from agent import image_gen_registry

KEY_ENV = "AGENTX_CUSTOM_LITELLM_API_KEY"
IMAGE_MODEL = "google/gemini-3.1-flash-lite-image"
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


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


@pytest.fixture
def account_home(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
    monkeypatch.setenv(KEY_ENV, "sk-account-key")
    _write_state(tmp_path, image_model=IMAGE_MODEL)
    return tmp_path


@pytest.fixture(autouse=True)
def _reset_registry():
    image_gen_registry._reset_for_tests()
    yield
    image_gen_registry._reset_for_tests()


def _provider():
    from plugins.image_gen.agentx_gateway import AgentXGatewayImageProvider

    return AgentXGatewayImageProvider()


def _resp(payload, status_code=200):
    m = MagicMock()
    m.status_code = status_code
    m.json.return_value = payload
    m.text = json.dumps(payload)
    return m


def _image_reply(raw: bytes) -> dict:
    return {"created": 1, "data": [{"b64_json": base64.b64encode(raw).decode(), "url": None}]}


class TestAvailability:
    def test_available_for_an_account_with_an_image_grant(self, account_home):
        provider = _provider()
        assert provider.name == "agentx-gateway"
        with patch("httpx.post", side_effect=AssertionError("no network in is_available")):
            assert provider.is_available() is True
        assert provider.default_model() == IMAGE_MODEL
        assert provider.capabilities()["modalities"] == ["text", "image"]

    def test_not_available_without_a_grant_or_a_key(self, account_home, monkeypatch):
        _write_state(account_home, image_model="")
        assert _provider().is_available() is False
        _write_state(account_home, image_model=IMAGE_MODEL)
        monkeypatch.delenv(KEY_ENV)
        assert _provider().is_available() is False

    def test_not_available_signed_out(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
        assert _provider().is_available() is False


class TestGenerate:
    def test_text_to_image_posts_generations_and_saves_a_jpeg(self, account_home):
        captured = {}

        def fake_post(url, **kwargs):
            captured.update(url=url, **kwargs)
            return _resp(_image_reply(JPEG))

        with patch("httpx.post", side_effect=fake_post):
            result = _provider().generate("một chú mèo", aspect_ratio="landscape")

        assert result["success"] is True, result
        assert captured["url"] == "https://gateway.test/v1/images/generations"
        assert captured["headers"]["Authorization"] == "Bearer sk-account-key"
        assert captured["json"] == {"model": IMAGE_MODEL, "prompt": "một chú mèo", "n": 1, "size": "1536x1024"}
        assert result["image"].endswith(".jpg")
        assert result["provider"] == "agentx-gateway" and result["modality"] == "text"
        with open(result["image"], "rb") as fh:
            assert fh.read() == JPEG

    def test_a_png_keeps_its_extension(self, account_home):
        with patch("httpx.post", return_value=_resp(_image_reply(PNG))):
            result = _provider().generate("x", aspect_ratio="square")
        assert result["image"].endswith(".png")

    def test_an_edit_posts_the_source_as_multipart(self, account_home, tmp_path):
        source = tmp_path / "cat.jpg"
        source.write_bytes(JPEG)
        captured = {}

        def fake_post(url, **kwargs):
            captured.update(url=url, **kwargs)
            return _resp(_image_reply(JPEG))

        with patch("httpx.post", side_effect=fake_post):
            result = _provider().generate("ban đêm", aspect_ratio="square", image_url=str(source))

        assert result["success"] is True, result
        assert captured["url"] == "https://gateway.test/v1/images/edits"
        assert captured["data"] == {"model": IMAGE_MODEL, "prompt": "ban đêm", "n": "1", "size": "1024x1024"}
        name, raw, mime = captured["files"][0][1]
        assert captured["files"][0][0] == "image[]" and raw == JPEG and mime == "image/jpeg"
        assert result["modality"] == "image"

    def test_a_data_uri_reference_is_decoded(self, account_home):
        captured = {}

        def fake_post(url, **kwargs):
            captured.update(kwargs)
            return _resp(_image_reply(JPEG))

        uri = "data:image/png;base64," + base64.b64encode(PNG).decode()
        with patch("httpx.post", side_effect=fake_post):
            _provider().generate("x", reference_image_urls=[uri])
        assert captured["files"][0][1][1] == PNG

    def test_a_model_for_another_backend_is_ignored(self, account_home):
        captured = {}

        def fake_post(url, **kwargs):
            captured.update(kwargs)
            return _resp(_image_reply(JPEG))

        with patch("httpx.post", side_effect=fake_post):
            _provider().generate("x", model="fal-ai/flux-2/klein/9b")
        assert captured["json"]["model"] == IMAGE_MODEL

    def test_access_denied_names_the_model(self, account_home):
        denied = {"error": {"message": "key not allowed to access model", "type": "key_model_access_denied"}}
        with patch("httpx.post", return_value=_resp(denied, status_code=401)):
            result = _provider().generate("x")
        assert result["success"] is False
        assert IMAGE_MODEL in result["error"] and result["error_type"] == "model_access"

    def test_a_reply_without_an_image_is_an_error(self, account_home):
        with patch("httpx.post", return_value=_resp({"data": []})):
            result = _provider().generate("x")
        assert result["success"] is False and result["error_type"] == "empty_response"

    def test_signed_out_is_an_auth_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
        result = _provider().generate("x")
        assert result["success"] is False and result["error_type"] == "auth_required"


class TestDefaultBackend:
    """``tools.image_generation_tool`` picks the gateway only when nothing else is chosen."""

    def _register(self, monkeypatch):
        from hermes_cli import plugins as plugins_module

        image_gen_registry.register_provider(_provider())
        monkeypatch.setattr(plugins_module, "_ensure_plugins_discovered", lambda force=False: None)

    def test_a_signed_in_account_draws_through_the_gateway(self, account_home, monkeypatch):
        from tools import image_generation_tool as tool

        self._register(monkeypatch)
        monkeypatch.setattr(tool, "check_fal_api_key", lambda: False)
        # An image_gen.model left from a FAL setup must not reach the gateway.
        (account_home / "config.yaml").write_text("image_gen:\n  model: fal-ai/flux-2/klein/9b\n")

        assert tool.check_image_generation_requirements() is True
        captured = {}

        def fake_post(url, **kwargs):
            captured.update(url=url, **kwargs)
            return _resp(_image_reply(JPEG))

        with patch("httpx.post", side_effect=fake_post):
            payload = json.loads(tool._dispatch_to_plugin_provider("mèo", "square"))

        assert payload["success"] is True and payload["provider"] == "agentx-gateway"
        assert captured["json"]["model"] == IMAGE_MODEL

    def test_a_fal_key_keeps_the_fal_default(self, account_home, monkeypatch):
        from tools import image_generation_tool as tool

        self._register(monkeypatch)
        monkeypatch.setattr(tool, "check_fal_api_key", lambda: True)

        assert tool._gateway_image_default() is None
        assert tool._dispatch_to_plugin_provider("x", "square") is None

    def test_an_explicit_choice_wins(self, account_home, monkeypatch):
        from tools import image_generation_tool as tool

        self._register(monkeypatch)
        monkeypatch.setattr(tool, "check_fal_api_key", lambda: False)
        monkeypatch.setattr(tool, "_read_configured_image_provider", lambda: "fal")

        assert tool._dispatch_to_plugin_provider("x", "square") is None

    def test_without_an_image_grant_nothing_changes(self, account_home, monkeypatch):
        from tools import image_generation_tool as tool

        _write_state(account_home, image_model="")
        self._register(monkeypatch)
        monkeypatch.setattr(tool, "check_fal_api_key", lambda: False)

        assert tool.check_image_generation_requirements() is False
        assert tool._dispatch_to_plugin_provider("x", "square") is None

    def test_the_schema_describes_the_gateway(self, account_home, monkeypatch):
        from tools import image_generation_tool as tool

        self._register(monkeypatch)
        monkeypatch.setattr(tool, "check_fal_api_key", lambda: False)

        info = tool._active_image_capabilities()
        assert info["provider"] == "AgentX AI Gateway"
        assert info["model"] == IMAGE_MODEL
        assert info["modalities"] == ["text", "image"]
