"""Building an agent must not import agent.bedrock_adapter for a non-Mantle
endpoint: the module lazy-installs boto3 at import time. On a fresh desktop
install that pip run queued behind the wake.status faster-whisper install, so
the first chat turn showed nothing for minutes."""
import sys
from unittest.mock import MagicMock, patch

from run_agent import AIAgent


def _make_tool_defs():
    return [{"type": "function", "function": {"name": "terminal",
             "description": "Run shell commands.", "parameters": {"type": "object", "properties": {}}}}]


def _build_agent(base_url, **kwargs):
    with patch("run_agent.get_tool_definitions", return_value=_make_tool_defs()), \
         patch("run_agent.check_toolset_requirements", return_value={}), \
         patch("run_agent.OpenAI", return_value=MagicMock()):
        return AIAgent(
            provider="custom",
            base_url=base_url,
            api_key="sk-test",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            **kwargs,
        )


def test_non_mantle_endpoint_never_imports_bedrock_adapter(monkeypatch):
    installs = []
    monkeypatch.setattr("tools.lazy_deps.ensure", lambda feature, **_kw: installs.append(feature))
    monkeypatch.delitem(sys.modules, "agent.bedrock_adapter", raising=False)

    _build_agent("https://aigw.example.test/v1", model="Qwen/Qwen3.6-35B-A3B-FP8")

    assert "provider.bedrock" not in installs
    assert "agent.bedrock_adapter" not in sys.modules


def test_mantle_endpoint_still_configures_bedrock_client(monkeypatch):
    import agent.bedrock_adapter as bedrock_adapter

    seen = []

    def _configure(client_kwargs, **_kw):
        seen.append(str(client_kwargs.get("base_url")))
        return client_kwargs

    monkeypatch.setattr(bedrock_adapter, "configure_bedrock_openai_client_kwargs", _configure)

    _build_agent(
        "https://bedrock-mantle.us-west-2.api.aws/openai/v1",
        model="openai.gpt-5.5",
        api_mode="codex_responses",
    )

    assert len(seen) == 1
    assert "bedrock-mantle." in seen[0]
