"""Tests for the Speech-to-Text category in `agentx tools` (tools_config).

Covers the STT provider picker rows, config writes (stt.provider /
use_gateway), the model picker catalog, config-only checklist exclusion,
and the faster_whisper post-setup readiness hook.
"""

import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from hermes_cli.tools_config import (  # noqa: E402
    _CONFIG_ONLY_TOOLSETS,
    CONFIGURABLE_TOOLSETS,
    STT_MODEL_CATALOG,
    TOOL_CATEGORIES,
    _checklist_toolset_keys,
    _configure_stt_model,
    _is_provider_active,
    _write_provider_config,
    apply_provider_selection,
)


def _stt_cat():
    return TOOL_CATEGORIES["stt"]


def _stt_provider_named(name):
    return next(p for p in _stt_cat()["providers"] if p["name"] == name)


class TestSttCategory:
    def test_stt_category_exists(self):
        cat = _stt_cat()
        assert cat["name"] == "Speech-to-Text"
        assert len(cat["providers"]) >= 5




    def test_managed_row_shares_tts_coverage_category(self):
        from hermes_cli.nous_subscription import MANAGED_FEATURE_COVERAGE_CATEGORY

        managed = [p for p in _stt_cat()["providers"] if p.get("managed_nous_feature")]
        assert managed, "expected a Nous Subscription row"
        for p in managed:
            assert p["managed_nous_feature"] == "stt"
        assert MANAGED_FEATURE_COVERAGE_CATEGORY["stt"] == "openai-audio"


class TestConfigWrites:
    def test_write_provider_config_sets_stt_provider(self):
        config = {}
        prov = _stt_provider_named("Groq")
        _write_provider_config(prov, config, managed_feature=None)
        assert config["stt"]["provider"] == "groq"
        assert config["stt"]["use_gateway"] is False


    def test_apply_provider_selection_stt(self):
        config = {}
        with patch(
            "hermes_cli.tools_config.get_nous_subscription_features"
        ) as feats:
            feats.return_value = MagicMock(
                nous_auth_present=False, account_info=None
            )
            apply_provider_selection("stt", "OpenAI", config)
        assert config["stt"]["provider"] == "openai"


class TestActiveDetection:
    def test_active_matches_config(self):
        config = {"stt": {"provider": "groq"}}
        assert _is_provider_active(_stt_provider_named("Groq"), config)
        assert not _is_provider_active(_stt_provider_named("OpenAI"), config)

    def test_unset_provider_defaults_to_local(self):
        assert _is_provider_active(_stt_provider_named("Local Whisper"), {})


class TestModelPicker:

    def test_catalog_matches_runtime_model_sets(self):
        from tools.transcription_tools import GROQ_MODELS, OPENAI_MODELS

        assert set(STT_MODEL_CATALOG["openai"]) == OPENAI_MODELS
        assert set(STT_MODEL_CATALOG["groq"]) == GROQ_MODELS




    def test_configure_stt_model_defaults_to_current(self):
        config = {"stt": {"openai": {"model": "gpt-transcribe"}}}
        with patch(
            "hermes_cli.tools_config._prompt_choice", return_value=0
        ) as pc:
            _configure_stt_model("openai", config)
        # default index should point at the currently configured model
        args = pc.call_args[0]
        assert args[2] == STT_MODEL_CATALOG["openai"].index("gpt-transcribe")


class TestConfigOnlyExclusion:
    def test_stt_is_config_only(self):
        assert "stt" in _CONFIG_ONLY_TOOLSETS

    def test_stt_excluded_from_checklist_universe(self):
        assert "stt" not in _checklist_toolset_keys("cli")
        # sanity: tts (a real toolset) stays in
        assert "tts" in _checklist_toolset_keys("cli")


class TestPostSetup:
    def test_faster_whisper_in_post_setup_ready(self):
        from hermes_cli.tools_config import _POST_SETUP_READY

        assert "faster_whisper" in _POST_SETUP_READY


class TestPluginSttProviders:
    """Plugin-registered STT backends become picker rows, as TTS ones do."""

    @pytest.fixture(autouse=True)
    def _reset_registry(self):
        from agent import transcription_registry

        transcription_registry._reset_for_tests()
        yield
        transcription_registry._reset_for_tests()

    def test_a_plugin_provider_is_a_row_after_the_builtins(self):
        from agent import transcription_registry
        from agent.transcription_provider import TranscriptionProvider
        from hermes_cli.tools_config import _visible_providers

        class _SenseAudio(TranscriptionProvider):
            @property
            def name(self):
                return "sensaudio"

            def get_setup_schema(self):
                return {
                    "name": "SenseAudio",
                    "tag": "cloud ASR",
                    "env_vars": [{"key": "SENSAUDIO_API_KEY", "prompt": "SenseAudio API key"}],
                }

            def transcribe(self, file_path, **kw):
                return {"success": True, "transcript": "", "provider": "sensaudio"}

        transcription_registry.register_provider(_SenseAudio())

        visible = _visible_providers(_stt_cat(), config={})
        names = [row["name"] for row in visible]
        assert names.index("SenseAudio") > names.index("Local Whisper")
        row = next(r for r in visible if r.get("stt_plugin_name") == "sensaudio")
        assert row["stt_provider"] == "sensaudio"
        assert row["env_vars"][0]["key"] == "SENSAUDIO_API_KEY"

        # Selecting it goes through the same write path as a built-in row.
        config = {}
        _write_provider_config(row, config, managed_feature=None)
        assert config["stt"]["provider"] == "sensaudio"
        assert _is_provider_active(row, config)

    def test_the_bundled_agentx_gateway_is_offered(self):
        from hermes_cli.plugins import _ensure_plugins_discovered
        from hermes_cli.tools_config import _plugin_stt_providers

        _ensure_plugins_discovered(force=True)

        row = next(r for r in _plugin_stt_providers() if r["stt_provider"] == "agentx-gateway")
        assert row["name"] == "AgentX AI Gateway"
        assert row["env_vars"] == []
