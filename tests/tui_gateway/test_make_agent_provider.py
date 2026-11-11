"""Regression test for #11884: _make_agent must resolve runtime provider.

Without resolve_runtime_provider(), bare-slug models in config
(e.g. ``claude-opus-4-6`` with ``model.provider: anthropic``) leave
provider/base_url/api_key empty in AIAgent, causing HTTP 404.
"""

import os
from unittest.mock import MagicMock, patch


def test_make_agent_passes_resolved_provider():
    """_make_agent forwards provider/base_url/api_key/api_mode from
    resolve_runtime_provider to AIAgent."""

    fake_runtime = {
        "provider": "anthropic",
        "base_url": "https://api.anthropic.com",
        "api_key": "sk-test-key",
        "api_mode": "anthropic_messages",
        "command": None,
        "args": None,
        "credential_pool": None,
    }

    fake_cfg = {
        "model": {"default": "claude-opus-4-6", "provider": "anthropic"},
        "agent": {"system_prompt": "test"},
    }

    with (
        patch("tui_gateway.server._load_cfg", return_value=fake_cfg),
        patch("tui_gateway.server._get_db", return_value=MagicMock()),
        patch("tui_gateway.server._load_tool_progress_mode", return_value="compact"),
        patch("tui_gateway.server._load_reasoning_config", return_value=None),
        patch("tui_gateway.server._load_service_tier", return_value=None),
        patch("tui_gateway.server._load_enabled_toolsets", return_value=None),
        patch(
            "hermes_cli.runtime_provider.resolve_runtime_provider",
            return_value=fake_runtime,
        ) as mock_resolve,
        patch("run_agent.AIAgent") as mock_agent,
    ):

        from tui_gateway.server import _make_agent

        _make_agent("sid-1", "key-1")

        # target_model comes from _resolve_startup_runtime() which reads
        # _load_cfg().  Due to module-level caching in tui_gateway.server,
        # the patched config may not take effect when the module was already
        # imported by an earlier test.  Assert the stable part of the call.
        mock_resolve.assert_called_once()
        assert mock_resolve.call_args.kwargs.get("requested") is None

        call_kwargs = mock_agent.call_args
        assert call_kwargs.kwargs["provider"] == "anthropic"
        assert call_kwargs.kwargs["base_url"] == "https://api.anthropic.com"
        assert call_kwargs.kwargs["api_key"] == "sk-test-key"
        assert call_kwargs.kwargs["api_mode"] == "anthropic_messages"


def test_probe_config_health_flags_null_sections():
    """Bare YAML keys (`agent:` with no value) parse as None and silently
    drop nested settings; probe must surface them so users can fix."""
    from tui_gateway.server import _probe_config_health

    assert _probe_config_health({"agent": {"x": 1}}) == ""
    assert _probe_config_health({}) == ""

    msg = _probe_config_health({"agent": None, "display": None, "model": {}})
    assert "agent" in msg and "display" in msg
    assert "model" not in msg


def test_apply_model_switch_does_not_leak_process_env():
    """Core fix for cross-session contamination: an in-session /model switch
    must mutate only the target session (record a per-session override + switch
    that session's agent in place) and must NOT write process-global env vars,
    which the single-process desktop backend shares across every live session.
    """
    from tui_gateway import server

    class _FakeResult:
        success = True
        error_message = ""
        warning_message = ""
        new_model = "zai/glm-5.1"
        target_provider = "zai"
        base_url = "https://api.z.ai/v1"
        api_key = "sk-glm"
        api_mode = "chat_completions"

    class _FakeAgent:
        def __init__(self):
            self.model = "minimax/m3"
            self.provider = "minimax"
            self.base_url = ""
            self.api_key = ""

        def switch_model(self, **kw):
            self.model = kw["new_model"]
            self.provider = kw["new_provider"]

    env_keys = (
        "AGENTX_MODEL",
        "AGENTX_INFERENCE_MODEL",
        "AGENTX_TUI_PROVIDER",
        "AGENTX_INFERENCE_PROVIDER",
    )

    sess_b = {"agent": _FakeAgent(), "session_key": "k-B", "model_override": None}
    sess_a = {"agent": _FakeAgent(), "session_key": "k-A", "model_override": None}

    with (
        patch("hermes_cli.model_switch.parse_model_flags",
              return_value=("glm-5.1", None, False, False, True)),
        patch("hermes_cli.model_switch.resolve_persist_behavior",
              return_value=False),
        patch("hermes_cli.model_switch.switch_model", return_value=_FakeResult()),
        patch("tui_gateway.server._emit"),
        patch("tui_gateway.server._restart_slash_worker"),
        patch("tui_gateway.server._session_info", return_value={}),
        patch("tui_gateway.server._persist_model_switch") as mock_persist,
    ):
        before = {k: os.environ.get(k) for k in env_keys}
        result = server._apply_model_switch("sidB", sess_b, "glm-5.1")
        after = {k: os.environ.get(k) for k in env_keys}

    assert result["value"] == "zai/glm-5.1"
    # No process-global env mutation (the contamination vector).
    assert before == after
    # persist_global was False → config untouched.
    mock_persist.assert_not_called()
    # Target session recorded a per-session override.
    assert sess_b["model_override"]["model"] == "zai/glm-5.1"
    assert sess_b["model_override"]["provider"] == "zai"
    # The switched agent mutated in place.
    assert sess_b["agent"].model == "zai/glm-5.1"
    # Sibling session is completely untouched.
    assert sess_a["model_override"] is None
    assert sess_a["agent"].model == "minimax/m3"


def _make_agent_with_override(runtime, override):
    """Build an agent for a session that persisted ``override``; return the
    kwargs AIAgent was constructed with."""
    from types import SimpleNamespace

    fake_cfg = {"model": {"default": "gateway-model"}, "agent": {"system_prompt": "test"}}
    resolution = SimpleNamespace(runtime=dict(runtime), used_fallback=False, selected_model=None)

    with (
        patch("tui_gateway.server._load_cfg", return_value=fake_cfg),
        patch("tui_gateway.server._get_db", return_value=MagicMock()),
        patch("tui_gateway.server._load_tool_progress_mode", return_value="compact"),
        patch("tui_gateway.server._load_reasoning_config", return_value=None),
        patch("tui_gateway.server._load_service_tier", return_value=None),
        patch("tui_gateway.server._load_enabled_toolsets", return_value=None),
        patch("tui_gateway.server._resolve_runtime_with_fallback", return_value=resolution),
        patch("hermes_cli.runtime_provider.canonical_custom_identity", return_value=None),
        patch("run_agent.AIAgent") as mock_agent,
    ):
        from tui_gateway.server import _make_agent

        _make_agent("sid-override", "key-override", model_override=override)

        return mock_agent.call_args.kwargs


def test_a_saved_gateway_address_never_replaces_the_one_on_record():
    """A chat saved before the gateway moved carries the retired address. It is
    accepted as "the gateway" on the promise that the request goes to the
    address on record — the saved one must not be written back over it, or the
    turn (and the account's key) goes to a host the gateway has left."""
    managed = {
        "provider": "custom",
        "api_mode": "chat_completions",
        "base_url": "https://aigw.astralx.com.vn/v1",
        "api_key": "sk-account",
        "source": "account-gateway",
    }

    kwargs = _make_agent_with_override(
        managed,
        {
            "model": "gateway-model",
            "provider": "custom",
            "base_url": "https://aigw.dev-server.cloud/v1",
            "api_key": "sk-stale",
            "api_mode": "codex_responses",
        },
    )

    assert kwargs["base_url"] == "https://aigw.astralx.com.vn/v1"
    assert kwargs["api_key"] == "sk-account"
    assert kwargs["api_mode"] == "chat_completions"


def test_a_saved_endpoint_still_applies_outside_a_managed_account():
    """The standalone behaviour is unchanged: a session that switched to a
    custom endpoint keeps it."""
    runtime = {
        "provider": "custom",
        "api_mode": "chat_completions",
        "base_url": "https://resolved.example/v1",
        "api_key": "sk-resolved",
    }

    kwargs = _make_agent_with_override(
        runtime,
        {"model": "m", "provider": "custom", "base_url": "https://mine.example/v1", "api_key": "sk-mine"},
    )

    assert kwargs["base_url"] == "https://mine.example/v1"
    assert kwargs["api_key"] == "sk-mine"


def test_agent_init_error_frame_carries_the_failures_own_code():
    from hermes_cli.account_inference import AccountProviderNotAllowed
    from tui_gateway.server import _agent_init_error_payload

    typed = _agent_init_error_payload(AccountProviderNotAllowed())
    assert typed["code"] == "model_not_allowed"
    assert typed["message"].startswith("agent init failed: This account can only use models")

    plain = _agent_init_error_payload(RuntimeError("boom"))
    assert plain == {"message": "agent init failed: boom"}
    # A non-string ``code`` attribute (an OSError errno, an HTTP status) is not one of ours.
    assert "code" not in _agent_init_error_payload(OSError(2, "No such file"))
