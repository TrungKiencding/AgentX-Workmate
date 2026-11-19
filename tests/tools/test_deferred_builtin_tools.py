"""Deferred built-ins: computer_use, the desktop pane tools, todo,
session_search, cronjob and process ship with every platform bundle but hide
behind the Tool Search bridge instead of sending their schema on every request
(mirrors the upstream agent's default ``tools.tool_search.defer`` list).

Eagerly listed, cheaper models reached for ``computer_use`` on plain file
tasks — opening Word/PowerPoint to "verify" a file they had just written —
which doubled turns and tripled input tokens. These tests pin the split so a
future edit cannot silently move them back into the never-defer core set, or
drop them from the bundles altogether, and pin the transcript-side peel
(``recorded_underlying_call``) that name-based classifiers rely on once the
calls are recorded under the ``tool_call`` bridge name.
"""

from __future__ import annotations

import json

import pytest

import model_tools
from tools.registry import discover_builtin_tools, invalidate_check_fn_cache
from toolsets import (
    TOOLSETS,
    _AGENTX_CORE_TOOLS,
    _AGENTX_DEFERRED_TOOLS,
    _AGENTX_PLATFORM_TOOLS,
    bundle_non_core_tools,
)

DESKTOP_DEFERRED = {"computer_use", "read_terminal", "close_terminal", "open_preview", "focus_pane"}
WORKFLOW_DEFERRED = {"todo", "session_search", "cronjob", "process"}
DEFERRED = DESKTOP_DEFERRED | WORKFLOW_DEFERRED
# Desktop tools that stay eager: deliver_file is how every produced file
# reaches the chat, react_to_message is eager upstream too.
EAGER_DESKTOP = {"deliver_file", "react_to_message"}


def _names(defs):
    return {d["function"]["name"] for d in defs}


def _reprobe():
    invalidate_check_fn_cache()
    model_tools._clear_tool_defs_cache()


@pytest.fixture
def desktop_host(monkeypatch):
    """An interactive desktop-app backend on a host with cua-driver installed:
    every deferred built-in passes its check_fn."""
    discover_builtin_tools()
    monkeypatch.setenv("AGENTX_DESKTOP", "1")
    monkeypatch.setenv("AGENTX_INTERACTIVE", "1")  # cronjob's check_fn
    monkeypatch.setattr(
        "tools.computer_use.cua_backend.cua_driver_binary_available", lambda: True
    )
    _reprobe()
    yield
    monkeypatch.undo()
    _reprobe()


# ---------------------------------------------------------------------------
# Static toolset structure
# ---------------------------------------------------------------------------


def test_deferred_list_is_exactly_the_nine_cold_builtins():
    assert set(_AGENTX_DEFERRED_TOOLS) == DEFERRED
    assert len(_AGENTX_DEFERRED_TOOLS) == len(DEFERRED), "duplicate entry"


def test_deferred_tools_are_not_core():
    assert not DEFERRED & set(_AGENTX_CORE_TOOLS)


def test_deliver_file_and_react_to_message_stay_core():
    assert EAGER_DESKTOP <= set(_AGENTX_CORE_TOOLS)


def test_platform_list_is_core_plus_deferred():
    assert _AGENTX_PLATFORM_TOOLS == _AGENTX_CORE_TOOLS + _AGENTX_DEFERRED_TOOLS


def test_every_core_bundle_still_ships_the_deferred_tools():
    """Deferring is not removing: every agentx-* bundle that carries the core
    set must also carry the deferred built-ins, or `agentx tools` would see
    computer_use as disabled and desktop sessions would lose the pane tools."""
    core = set(_AGENTX_CORE_TOOLS)
    bundles = [n for n, ts in TOOLSETS.items()
               if n.startswith("agentx-") and core <= set(ts["tools"])]
    assert "agentx-cli" in bundles and len(bundles) > 15, bundles
    for name in bundles:
        missing = DEFERRED - set(TOOLSETS[name]["tools"])
        assert not missing, f"{name} lost deferred built-ins: {missing}"


def test_disabling_a_bundle_keeps_shared_deferred_builtins():
    """Disabling a platform bundle subtracts only its own extras (#33924);
    the shared deferred built-ins must survive like core does."""
    removed = bundle_non_core_tools("agentx-discord")
    assert not removed & DEFERRED
    assert not removed & set(_AGENTX_CORE_TOOLS)
    assert removed  # discord's own extras are still subtracted


def test_disabling_coding_posture_keeps_shared_builtins():
    """The coding posture re-lists deferred built-ins (todo, process,
    session_search, read_terminal, close_terminal); disabling it must not
    strip them from the other enabled toolsets."""
    removed = bundle_non_core_tools("coding")
    assert not removed & (DEFERRED | {"deliver_file"})


# ---------------------------------------------------------------------------
# Deferral classification
# ---------------------------------------------------------------------------


def test_deferred_builtins_are_deferrable():
    from tools.tool_search import is_deferrable_tool_name

    discover_builtin_tools()
    for name in DEFERRED:
        assert is_deferrable_tool_name(name), name


def test_eager_desktop_tools_are_never_deferrable():
    from tools.tool_search import is_deferrable_tool_name

    discover_builtin_tools()
    for name in EAGER_DESKTOP:
        assert not is_deferrable_tool_name(name), name


# ---------------------------------------------------------------------------
# What the model actually receives
# ---------------------------------------------------------------------------


def test_desktop_session_sends_deferred_builtins_only_via_the_catalog(desktop_host):
    raw = model_tools.get_tool_definitions(
        enabled_toolsets=["agentx-cli"], quiet_mode=True, skip_tool_search_assembly=True
    )
    # The session is granted all of them (check_fns pass; react_to_message is
    # additionally opt-in via display.message_reactions, so not checked here)...
    assert DEFERRED | {"deliver_file"} <= _names(raw)

    sent = model_tools.get_tool_definitions(enabled_toolsets=["agentx-cli"], quiet_mode=True)
    sent_names = _names(sent)
    # ...but only the bridge and the eager tools go out with full schemas.
    assert not DEFERRED & sent_names
    assert "deliver_file" in sent_names
    assert {"tool_search", "tool_describe", "tool_call"} <= sent_names

    bridge = next(d for d in sent if d["function"]["name"] == "tool_search")
    listing = bridge["function"]["description"]
    for name in DEFERRED:
        assert f"- {name}:" in listing, f"{name} missing from the deferred catalog"


def test_tool_search_off_keeps_deferred_builtins_eager(desktop_host, monkeypatch):
    from tools import tool_search

    monkeypatch.setattr(
        tool_search, "load_config",
        lambda: tool_search.ToolSearchConfig.from_raw({"enabled": "off"}),
    )
    model_tools._clear_tool_defs_cache()
    sent_names = _names(
        model_tools.get_tool_definitions(enabled_toolsets=["agentx-cli"], quiet_mode=True)
    )
    assert DEFERRED <= sent_names
    assert "tool_search" not in sent_names


def test_session_may_invoke_deferred_builtins_through_tool_call(desktop_host):
    """The executor unwrap only lets tool_call reach names in the session's
    scoped deferrable set (agent/tool_executor.py::_tool_search_scoped_names)."""
    from tools.tool_search import scoped_deferrable_names

    raw = model_tools.get_tool_definitions(
        enabled_toolsets=["agentx-cli"], quiet_mode=True, skip_tool_search_assembly=True
    )
    scoped = scoped_deferrable_names(raw)
    assert DEFERRED <= scoped
    assert not EAGER_DESKTOP & scoped


def test_tool_describe_and_tool_call_reach_a_deferred_builtin(desktop_host):
    described = json.loads(model_tools.handle_function_call(
        function_name="tool_describe",
        function_args={"name": "computer_use"},
        enabled_toolsets=["agentx-cli"],
    ))
    assert "error" not in described, described
    assert "computer_use" in json.dumps(described)

    # focus_pane outside a live GUI returns its own handler error, which
    # proves the bridge dispatched into the underlying tool.
    result = json.loads(model_tools.handle_function_call(
        function_name="tool_call",
        function_args={"name": "focus_pane", "arguments": {"pane": "chat"}},
        enabled_toolsets=["agentx-cli"],
    ))
    assert "desktop app" in json.dumps(result), result


def test_delegated_child_cannot_reach_blocked_cronjob_through_the_bridge(desktop_host):
    """Subagents deny cronjob via disabled_toolsets (tools/delegate_tool.py);
    deferral must not reopen it through tool_call — the executor unwrap only
    admits names in the session's scoped deferrable set."""
    from tools.delegate_tool import _blocked_toolsets_for_role
    from tools.tool_search import scoped_deferrable_names

    disabled = _blocked_toolsets_for_role("leaf")
    assert "cronjob" in disabled
    raw = model_tools.get_tool_definitions(
        enabled_toolsets=["agentx-cli"], disabled_toolsets=disabled,
        quiet_mode=True, skip_tool_search_assembly=True,
    )
    scoped = scoped_deferrable_names(raw)
    assert "cronjob" not in scoped
    assert {"todo", "session_search", "process"} <= scoped


# ---------------------------------------------------------------------------
# Transcript peel: recorded_underlying_call
# ---------------------------------------------------------------------------


class TestRecordedUnderlyingCall:
    def test_non_bridge_call_is_returned_unchanged(self):
        from tools.tool_search import recorded_underlying_call

        assert recorded_underlying_call("terminal", '{"command": "ls"}') == (
            "terminal", '{"command": "ls"}'
        )

    @pytest.mark.parametrize("arguments", [
        json.dumps({"name": "todo", "arguments": {"todos": []}}),
        {"name": "todo", "arguments": {"todos": []}},
        json.dumps({"name": " todo ", "arguments": json.dumps({"todos": []})}),
    ])
    def test_bridge_is_peeled_from_string_or_dict_arguments(self, arguments):
        from tools.tool_search import recorded_underlying_call

        assert recorded_underlying_call("tool_call", arguments) == ("todo", {"todos": []})

    def test_missing_inner_arguments_mean_an_empty_call(self):
        from tools.tool_search import recorded_underlying_call

        assert recorded_underlying_call("tool_call", {"name": "process"}) == ("process", {})

    @pytest.mark.parametrize("arguments", [
        "not json",
        json.dumps(["todo"]),
        json.dumps({"arguments": {}}),
        json.dumps({"name": "", "arguments": {}}),
        json.dumps({"name": 7, "arguments": {}}),
        json.dumps({"name": "tool_search", "arguments": {}}),
        json.dumps({"name": "todo", "arguments": "not json"}),
        json.dumps({"name": "todo", "arguments": [1, 2]}),
        None,
    ])
    def test_malformed_bridge_calls_are_returned_unchanged(self, arguments):
        from tools.tool_search import recorded_underlying_call

        assert recorded_underlying_call("tool_call", arguments) == ("tool_call", arguments)

    def test_peel_ignores_live_tool_search_config(self, monkeypatch):
        """A transcript classifies the same way whatever the current settings."""
        from tools import tool_search

        monkeypatch.setattr(
            tool_search, "load_config",
            lambda: (_ for _ in ()).throw(AssertionError("config must not be read")),
        )
        monkeypatch.setattr(
            tool_search, "is_deferrable_tool_name",
            lambda name: (_ for _ in ()).throw(AssertionError("registry must not be read")),
        )
        assert tool_search.recorded_underlying_call(
            "tool_call", {"name": "todo", "arguments": {}}
        ) == ("todo", {})


# ---------------------------------------------------------------------------
# Name-based classifiers see through the bridge
# ---------------------------------------------------------------------------


def _bridged(name, arguments):
    return json.dumps({"name": name, "arguments": arguments})


def _tc(name, arguments="{}"):
    from types import SimpleNamespace

    return SimpleNamespace(function=SimpleNamespace(name=name, arguments=arguments))


class TestHousekeepingClassification:
    def test_bridged_todo_and_session_search_are_housekeeping(self):
        from agent.conversation_loop import _all_housekeeping_tool_calls

        assert _all_housekeeping_tool_calls([
            _tc("memory"),
            _tc("tool_call", _bridged("todo", {"todos": []})),
            _tc("tool_call", _bridged("session_search", {"query": "x"})),
        ])

    def test_bridged_substantive_tool_is_not_housekeeping(self):
        from agent.conversation_loop import _all_housekeeping_tool_calls

        assert not _all_housekeeping_tool_calls([
            _tc("memory"),
            _tc("tool_call", _bridged("cronjob", {"action": "list"})),
        ])
        assert not _all_housekeeping_tool_calls([_tc("memory"), _tc("terminal")])


class TestCompressionSummaryOfBridgedCalls:
    def test_bridged_todo_summarized_as_todo(self):
        from agent.context_compressor import _summarize_tool_result

        summary = _summarize_tool_result(
            "tool_call", _bridged("todo", {"todos": []}), '{"todos": []}'
        )
        assert summary == "[todo] updated task list"

    def test_bridged_terminal_style_args_reach_the_specific_branch(self):
        """The peeled arguments, not the bridge envelope, feed the summary."""
        from agent.context_compressor import _summarize_tool_result

        direct = _summarize_tool_result(
            "session_search", json.dumps({"query": "auth"}), "x" * 400
        )
        bridged = _summarize_tool_result(
            "tool_call", _bridged("session_search", {"query": "auth"}), "x" * 400
        )
        assert bridged == direct
        assert bridged.startswith("[session_search]")

    def test_malformed_bridge_falls_back_to_the_bridge_name(self):
        from agent.context_compressor import _summarize_tool_result

        summary = _summarize_tool_result("tool_call", "not json", "x" * 400)
        assert summary.startswith("[tool_call]")
