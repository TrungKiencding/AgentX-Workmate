"""Data Hub results stay in Workmate (Data Hub plan D2.8, §9.3 #22–#23).

The hub's ``agentx-data`` server returns passages from the organisation's
documents. Two guards keep them on the owner's machine:

* its tools are only offered to the owner's own desktop/TUI/CLI sessions (and
  the subagents they delegate to) — never to a messaging platform, the API
  server, a webhook or cron, also not through an ``all`` toolset or the cron
  fallback that loads every toolset;
* a session holding one of its results is never exported, on any export path
  (bulk exports leave it out and say how many).
"""

from __future__ import annotations

import asyncio
import json
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from hermes_cli.session_export import (
    data_hub_export_refusal,
    data_hub_server_keys,
    is_data_hub_tool_name,
    partition_exportable_sessions,
    session_has_data_hub_result,
)

SEARCH = "mcp__agentx_agentx_data__search_knowledge"
REFUSAL_VI = "Phiên này có kết quả từ Data Hub — chỉ được đọc trong Workmate, nên không xuất được."
REFUSAL_EN = (
    "This session contains Data Hub results, which may only be read in Workmate; exporting is blocked."
)


def _gateway_entry(ref: str) -> dict:
    return {
        "url": f"https://hub.example/gw/s/{ref}",
        "headers": {"Authorization": "Bearer ${AGENTX_HUB_GATEWAY_TOKEN}"},
        "enabled": True,
        "source": "hub-gateway",
        "gateway": {"kind": "server", "ref": ref, "label": ref},
    }


CFG = {
    "mcp_servers": {
        "agentx-agentx-data": _gateway_entry("agentx-data"),
        # The same server under a name the person chose: told by its gateway ref.
        "kho-noi-bo": _gateway_entry("agentx-data"),
        "agentx-github": _gateway_entry("github"),
        "finnhub": {"url": "https://finnhub.example/mcp", "enabled": True},
    }
}
DATA_HUB_NAMES = {"agentx-agentx-data", "kho-noi-bo"}


def _data_hub_messages(name: str = SEARCH, *, with_tool_name: bool = True) -> list:
    tool = {"role": "tool", "tool_call_id": "call_1", "content": '{"result": "{}"}'}
    if with_tool_name:
        tool["tool_name"] = name
    return [
        {"role": "user", "content": "Công tác phí 2026?"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "call_1", "type": "function", "function": {"name": name, "arguments": "{}"}}
            ],
        },
        tool,
        {"role": "assistant", "content": "Mức chi là 300.000 đồng [S1]."},
    ]


def _plain_messages() -> list:
    return [
        {"role": "user", "content": "hi"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "c9", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}],
        },
        {"role": "tool", "tool_call_id": "c9", "tool_name": "read_file", "content": "x"},
        {"role": "assistant", "content": "hello"},
    ]


@pytest.fixture(autouse=True)
def _vietnamese(monkeypatch):
    monkeypatch.setenv("AGENTX_LANGUAGE", "vi")


# ─── The predicate ──────────────────────────────────────────────────────────


def test_tool_name_family():
    no_keys = frozenset()
    assert is_data_hub_tool_name(SEARCH, no_keys)
    assert is_data_hub_tool_name("mcp__agentx_agentx_data__read_passage_context", no_keys)
    assert is_data_hub_tool_name("mcp__agentx_agentx_data_2__list_knowledge_bases", no_keys)
    assert not is_data_hub_tool_name("mcp__agentx_agentx_database__query", no_keys)
    assert not is_data_hub_tool_name("mcp__agentx_github__search", no_keys)
    assert not is_data_hub_tool_name("search_knowledge", no_keys)
    assert not is_data_hub_tool_name(None, no_keys)


def test_server_keys_come_from_the_gateway_ref():
    keys = data_hub_server_keys(CFG["mcp_servers"])
    assert keys == DATA_HUB_NAMES
    assert is_data_hub_tool_name("mcp__kho_noi_bo__search_knowledge", keys)
    assert not is_data_hub_tool_name("mcp__kho_noi_bo__search_knowledge", frozenset())


def test_session_predicate():
    keys = frozenset()
    assert session_has_data_hub_result({"messages": _data_hub_messages()}, server_keys=keys)
    # A row without tool_name is named by the assistant call it answers.
    assert session_has_data_hub_result(_data_hub_messages(with_tool_name=False), server_keys=keys)
    assert not session_has_data_hub_result({"messages": _plain_messages()}, server_keys=keys)
    assert not session_has_data_hub_result({"messages": []}, server_keys=keys)
    # Stored rows carry tool_calls as JSON text.
    stored = _data_hub_messages(with_tool_name=False)
    stored[1] = {**stored[1], "tool_calls": json.dumps(stored[1]["tool_calls"])}
    assert session_has_data_hub_result(stored, server_keys=keys)
    renamed = _data_hub_messages("mcp__kho_noi_bo__search_knowledge")
    assert not session_has_data_hub_result(renamed, server_keys=keys)
    assert session_has_data_hub_result(renamed, server_keys=data_hub_server_keys(CFG["mcp_servers"]))


def test_partition_counts_the_left_out_sessions():
    sessions = [
        {"id": "a", "messages": _plain_messages()},
        {"id": "b", "messages": _data_hub_messages()},
        {"id": "c", "messages": _plain_messages()},
    ]
    kept, left_out = partition_exportable_sessions(sessions, server_keys=frozenset())
    assert [s["id"] for s in kept] == ["a", "c"]
    assert left_out == 1


def test_refusal_is_vietnamese_by_default_and_english_on_request(monkeypatch):
    assert data_hub_export_refusal() == REFUSAL_VI
    monkeypatch.setenv("AGENTX_LANGUAGE", "en")
    assert data_hub_export_refusal() == REFUSAL_EN


# ─── Tools: only the owner's own desktop/TUI/CLI ────────────────────────────


@pytest.mark.parametrize(
    "platform", ["signal", "whatsapp", "telegram", "webhook", "api_server", "msgraph", "cron"]
)
def test_other_platforms_never_get_data_hub_servers(platform):
    from hermes_cli.tools_config import _get_platform_tools

    enabled = _get_platform_tools(CFG, platform)
    assert not enabled & DATA_HUB_NAMES
    assert {"finnhub", "agentx-github"} <= enabled

    # Not even when the platform's saved list names the server.
    named = {**CFG, "platform_toolsets": {platform: ["web", "agentx-agentx-data", "mcp-kho-noi-bo", "finnhub"]}}
    enabled = _get_platform_tools(named, platform)
    assert not enabled & (DATA_HUB_NAMES | {"mcp-kho-noi-bo"})
    assert "finnhub" in enabled


def test_owner_cli_keeps_data_hub_servers():
    from hermes_cli.tools_config import _get_platform_tools

    assert DATA_HUB_NAMES <= _get_platform_tools(CFG, "cli")


def test_enabled_mcp_server_names_by_platform():
    from hermes_cli.tools_config import enabled_mcp_server_names

    assert DATA_HUB_NAMES <= enabled_mcp_server_names(CFG)
    assert DATA_HUB_NAMES <= enabled_mcp_server_names(CFG, platform="desktop")
    assert not enabled_mcp_server_names(CFG, platform="webhook") & DATA_HUB_NAMES


def test_cron_jobs_never_get_data_hub_servers():
    from cron.scheduler import _merge_mcp_into_per_job_toolsets, _resolve_cron_enabled_toolsets

    merged = _merge_mcp_into_per_job_toolsets(["web"], CFG)
    assert not set(merged) & DATA_HUB_NAMES
    assert {"finnhub", "agentx-github"} <= set(merged)
    # A job that names the server keeps its allowlist meaning, minus the server.
    assert _merge_mcp_into_per_job_toolsets(["web", "agentx-agentx-data"], CFG) == ["web"]
    assert not set(_resolve_cron_enabled_toolsets({}, CFG)) & DATA_HUB_NAMES


def test_disabled_toolsets_and_tool_defs_by_platform():
    from hermes_cli.tools_config import data_hub_disabled_toolsets, drop_data_hub_tools

    assert data_hub_disabled_toolsets(["memory"], "desktop", CFG) == ["memory"]
    assert data_hub_disabled_toolsets(None, "cron", CFG) == [
        "mcp-agentx-agentx-data",
        "mcp-kho-noi-bo",
    ]
    assert data_hub_disabled_toolsets(None, None, {"mcp_servers": {}}) is None

    defs = [
        {"type": "function", "function": {"name": SEARCH}},
        {"type": "function", "function": {"name": "mcp__finnhub__quote"}},
    ]
    with patch("hermes_cli.config.load_config_readonly", return_value=CFG):
        assert drop_data_hub_tools(defs, "tui") == defs
        assert [d["function"]["name"] for d in drop_data_hub_tools(defs, "signal")] == ["mcp__finnhub__quote"]


@pytest.fixture
def _registered_tools():
    """Fake tools for the Data Hub server (under both entries) and finnhub."""
    from tools.registry import registry

    tools = {
        SEARCH: "agentx-agentx-data",
        "mcp__kho_noi_bo__search_knowledge": "kho-noi-bo",
        "mcp__finnhub__quote": "finnhub",
    }
    for name, server in tools.items():
        registry.register(
            name=name,
            toolset=f"mcp-{server}",
            schema={"name": name, "description": "test", "parameters": {"type": "object", "properties": {}}},
            handler=lambda args, **kw: "{}",
        )
        registry.register_toolset_alias(server, f"mcp-{server}")
    try:
        yield set(tools)
    finally:
        for name in tools:
            registry.deregister(name)


def _agent(platform, enabled_toolsets, **kwargs):
    with (
        patch("hermes_cli.config.load_config_readonly", return_value=CFG),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        from run_agent import AIAgent

        return AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            enabled_toolsets=enabled_toolsets,
            platform=platform,
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            **kwargs,
        )


def _scoped_names(agent) -> set:
    """Every tool the session can reach, Tool Search bridge included."""
    import model_tools

    defs = model_tools.get_tool_definitions(
        enabled_toolsets=agent.enabled_toolsets,
        disabled_toolsets=agent.disabled_toolsets,
        quiet_mode=True,
        skip_tool_search_assembly=True,
    )
    return {d["function"]["name"] for d in defs} | set(agent.valid_tool_names)


@pytest.mark.parametrize(
    ("platform", "enabled"),
    [("cron", None), ("telegram", ["all"]), ("api_server", ["*"]), (None, None)],
)
def test_agent_on_other_platforms_cannot_reach_data_hub_tools(_registered_tools, platform, enabled):
    agent = _agent(platform, enabled)

    reachable = _scoped_names(agent)
    assert SEARCH not in reachable
    assert "mcp__kho_noi_bo__search_knowledge" not in reachable
    assert "mcp__finnhub__quote" in reachable

    # An explicit reload with a freshly-resolved selection does not bring it back.
    from tools.mcp_tool import refresh_agent_mcp_tools

    with patch("hermes_cli.config.load_config_readonly", return_value=CFG):
        refresh_agent_mcp_tools(agent, enabled_override=None, disabled_override=[])
    assert SEARCH not in _scoped_names(agent)


@pytest.mark.parametrize("platform", ["desktop", "tui", "cli"])
def test_owner_agent_reaches_data_hub_tools(_registered_tools, platform):
    agent = _agent(platform, None)

    assert {SEARCH, "mcp__kho_noi_bo__search_knowledge"} <= _scoped_names(agent)


# A delegate_task child acts for its parent's person on the same machine: it
# keeps the tools only when the parent session may have them.


def _child_of(parent):
    """A real delegate_task child of *parent*, built the way delegate_task builds it."""
    from tools.delegate_tool import _build_child_agent

    with (
        patch("hermes_cli.config.load_config_readonly", return_value=CFG),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        return _build_child_agent(
            task_index=0,
            goal="Tra cứu công tác phí",
            context=None,
            toolsets=None,
            model=None,
            max_iterations=5,
            task_count=1,
            parent_agent=parent,
        )


# A parent session's toolsets as its surface resolves them; the foreign ones
# name the Data Hub servers outright, so only the child's own guard stops them.
OWNER_TOOLSETS = ["terminal", "finnhub", "agentx-agentx-data", "kho-noi-bo"]


@pytest.mark.parametrize("platform", ["desktop", "tui", "cli"])
def test_subagent_of_an_owner_session_keeps_data_hub_tools(_registered_tools, platform):
    child = _child_of(_agent(platform, OWNER_TOOLSETS))

    assert child.platform == "subagent"
    assert {SEARCH, "mcp__kho_noi_bo__search_knowledge"} <= _scoped_names(child)
    # …and so does a child it delegates to in turn.
    assert SEARCH in _scoped_names(_child_of(child))


@pytest.mark.parametrize("platform", ["signal", "api_server", "cron"])
def test_subagent_of_another_session_does_not(_registered_tools, platform):
    child = _child_of(_agent(platform, OWNER_TOOLSETS))

    assert child.platform == "subagent"
    reachable = _scoped_names(child)
    assert SEARCH not in reachable
    assert "mcp__kho_noi_bo__search_knowledge" not in reachable
    assert "mcp__finnhub__quote" in reachable
    assert SEARCH not in _scoped_names(_child_of(child))


@pytest.mark.parametrize("parent_platform", [None, "subagent", "signal"])
def test_subagent_with_an_unknown_or_foreign_parent_does_not(_registered_tools, parent_platform):
    agent = _agent("subagent", None, delegated_from_platform=parent_platform)

    assert SEARCH not in _scoped_names(agent)


def test_delegate_task_hands_the_parent_platform_to_the_child():
    from tools.delegate_tool import _build_child_agent

    parent = MagicMock()
    parent._data_hub_platform = "desktop"
    parent.enabled_toolsets = None
    parent.disabled_toolsets = None
    parent._delegate_depth = 0
    parent._session_db = None
    with patch("run_agent.AIAgent") as child_cls:
        child_cls.return_value = MagicMock()
        _build_child_agent(
            task_index=0, goal="g", context=None, toolsets=None, model=None,
            max_iterations=5, task_count=1, parent_agent=parent,
        )

    assert child_cls.call_args.kwargs["platform"] == "subagent"
    assert child_cls.call_args.kwargs["delegated_from_platform"] == "desktop"


# ─── Export paths ───────────────────────────────────────────────────────────


@pytest.fixture
def state_db(tmp_path, monkeypatch):
    """A real session store with one session holding a Data Hub result
    (``s-data``) and one without (``s-plain``)."""
    import hermes_state
    from hermes_state import SessionDB

    path = tmp_path / "state.db"
    db = SessionDB(db_path=path)
    for sid, messages in (("s-data", _data_hub_messages()), ("s-plain", _plain_messages())):
        db.create_session(session_id=sid, source="cli", model="test")
        for message in messages:
            db.append_message(
                sid,
                role=message["role"],
                content=message.get("content"),
                tool_name=message.get("tool_name"),
                tool_calls=message.get("tool_calls"),
                tool_call_id=message.get("tool_call_id"),
            )
        db.end_session(sid, "test")
    db.close()
    monkeypatch.setattr(hermes_state, "SessionDB", lambda *a, **kw: SessionDB(db_path=path))
    return path


def _sessions_export(monkeypatch, *argv):
    import hermes_cli.main as main_mod

    monkeypatch.setattr(sys, "argv", ["agentx", "sessions", "export", *argv])
    main_mod.main()


@pytest.mark.parametrize("fmt", ["jsonl", "md", "html", "trace"])
def test_sessions_export_refuses_a_data_hub_session(state_db, tmp_path, monkeypatch, capsys, fmt):
    out = tmp_path / "out" / f"export.{fmt}"
    out.parent.mkdir()
    target = str(out.parent if fmt == "md" else out)

    _sessions_export(monkeypatch, "--format", fmt, "--session-id", "s-data", target)

    assert REFUSAL_VI in capsys.readouterr().out
    assert list(out.parent.iterdir()) == []


@pytest.mark.parametrize("fmt", ["jsonl", "md", "html", "trace"])
def test_sessions_export_allows_a_plain_session(state_db, tmp_path, monkeypatch, capsys, fmt):
    out = tmp_path / "out" / f"export.{fmt}"
    out.parent.mkdir()
    target = str(out.parent if fmt == "md" else out)

    _sessions_export(monkeypatch, "--format", fmt, "--session-id", "s-plain", target)

    assert REFUSAL_VI not in capsys.readouterr().out
    assert list(out.parent.iterdir())


def test_sessions_export_only_prompts_refuses_a_data_hub_session(state_db, monkeypatch, capsys):
    _sessions_export(monkeypatch, "-", "--session-id", "s-data", "--only", "user-prompts")

    output = capsys.readouterr().out
    assert REFUSAL_VI in output
    assert "Công tác phí" not in output


def test_sessions_export_upload_is_refused_before_upload(state_db, monkeypatch, capsys):
    with patch("agent.trace_upload.upload_session_trace") as upload:
        _sessions_export(monkeypatch, "--format", "trace", "--upload", "--session-id", "s-data")

    upload.assert_not_called()
    assert REFUSAL_VI in capsys.readouterr().out


def test_bulk_jsonl_export_leaves_data_hub_sessions_out(state_db, monkeypatch, capsys):
    _sessions_export(monkeypatch, "-")

    captured = capsys.readouterr()
    ids = [json.loads(line)["id"] for line in captured.out.splitlines()]
    assert ids == ["s-plain"]
    assert "Đã bỏ qua 1 phiên" in captured.err


def test_bulk_md_export_leaves_data_hub_sessions_out(state_db, tmp_path, monkeypatch, capsys):
    out = tmp_path / "md"

    _sessions_export(monkeypatch, "--format", "md", "--source", "cli", str(out))

    captured = capsys.readouterr()
    assert "Exported 1 session(s)" in captured.out
    assert "Đã bỏ qua 1 phiên" in captured.err
    texts = [p.read_text(encoding="utf-8") for p in out.glob("*.md")]
    assert len(texts) == 1 and "Công tác phí" not in texts[0]


def test_bulk_trace_export_leaves_data_hub_sessions_out(state_db, tmp_path, monkeypatch, capsys):
    out = tmp_path / "traces"

    _sessions_export(monkeypatch, "--format", "trace", "--source", "cli", "--no-redact", str(out))

    captured = capsys.readouterr()
    assert sorted(p.name for p in out.iterdir()) == ["s-plain.trace.jsonl"]
    assert "Đã bỏ qua 1 phiên" in captured.err


def test_console_engine_export(state_db, tmp_path, monkeypatch):
    from hermes_cli.console_engine import ConsoleCommandError, _sessions_export

    with pytest.raises(ConsoleCommandError, match="Data Hub"):
        _sessions_export(None, [str(tmp_path / "one.jsonl"), "--session-id", "s-data"])
    assert not (tmp_path / "one.jsonl").exists()

    text = _sessions_export(None, [str(tmp_path / "all.jsonl")])
    ids = [json.loads(line)["id"] for line in (tmp_path / "all.jsonl").read_text().splitlines()]
    assert ids == ["s-plain"]
    assert "Đã bỏ qua 1 phiên" in text


def test_rest_export_endpoint(state_db, monkeypatch):
    from fastapi import HTTPException

    from hermes_cli import web_server
    from hermes_cli.web_routers import sessions as web_sessions
    from hermes_state import SessionDB

    monkeypatch.setattr(
        web_server,
        "_open_session_db_for_profile",
        lambda profile=None, *, read_only: SessionDB(db_path=state_db),
    )

    with pytest.raises(HTTPException) as refused:
        asyncio.run(web_sessions.export_session_endpoint("s-data"))
    assert refused.value.status_code == 403
    assert refused.value.detail == REFUSAL_VI

    data = asyncio.run(web_sessions.export_session_endpoint("s-plain"))
    assert data["id"] == "s-plain"


def _cli(monkeypatch, tmp_path, export):
    import cli as cli_mod
    from cli import HermesCLI

    cwd = tmp_path / "cwd"
    cwd.mkdir()
    monkeypatch.chdir(cwd)
    printed: list[str] = []
    monkeypatch.setattr(cli_mod, "_cprint", printed.append)
    cli_obj = HermesCLI.__new__(HermesCLI)
    cli_obj.session_id = "sess-export"
    cli_obj._session_db = MagicMock()
    cli_obj._session_db.export_session.return_value = export
    return cli_obj, cwd, printed


def test_cli_export_command(monkeypatch, tmp_path):
    cli_obj, cwd, printed = _cli(monkeypatch, tmp_path, {"id": "sess-export", "messages": _data_hub_messages()})

    cli_obj.process_command("/export json")

    assert printed == [f"  {REFUSAL_VI}"]
    assert list(cwd.iterdir()) == []

    cli_obj._session_db.export_session.return_value = {"id": "sess-export", "messages": _plain_messages()}
    cli_obj.process_command("/export json")
    assert (cwd / "session_sess-export.json").exists()


def test_cli_save_command(monkeypatch, tmp_path, capsys):
    from datetime import datetime

    import cli as cli_mod

    home = tmp_path / ".agentx"
    home.mkdir()
    monkeypatch.setenv("AGENTX_HOME", str(home))
    stub = SimpleNamespace(
        conversation_history=_data_hub_messages(),
        model="m",
        session_id="s",
        session_start=datetime(2026, 1, 1),
    )

    cli_mod.HermesCLI.save_conversation(stub)

    assert REFUSAL_VI in capsys.readouterr().out
    assert not (home / "sessions" / "saved").exists()


@pytest.mark.asyncio
async def test_gateway_export_command():
    from tests.gateway.test_export_command import _make_event, _make_runner, _recording_adapter
    from gateway.config import Platform

    adapter, sent = _recording_adapter()
    runner = _make_runner({Platform.TELEGRAM: adapter})
    runner._session_db._db.export_session.return_value = {"id": "sess-1", "messages": _data_hub_messages()}

    result = await runner._handle_export_command(_make_event("/export json"))

    assert result == REFUSAL_VI
    adapter.send_document.assert_not_called()


def test_tui_session_save(monkeypatch, tmp_path):
    import threading

    from tui_gateway import server

    home = tmp_path / ".agentx"
    home.mkdir()
    monkeypatch.setenv("AGENTX_HOME", str(home))
    sid = "save-data-hub"
    server._sessions[sid] = {
        "agent": SimpleNamespace(model="m", session_id="s", session_start=None, _cached_system_prompt=""),
        "session_key": "k",
        "history": _data_hub_messages(),
        "history_lock": threading.Lock(),
        "created_at": 1735732800.0,
    }
    try:
        resp = server._methods["session.save"]("1", {"session_id": sid})
    finally:
        server._sessions.pop(sid, None)

    assert resp["error"]["message"] == REFUSAL_VI
    assert not list((home / "sessions" / "saved").glob("*.json"))


def test_trace_upload_is_refused(monkeypatch):
    from agent import trace_upload

    monkeypatch.setenv("HF_TOKEN", "hf_test")
    with (
        patch.object(trace_upload, "load_session_messages", return_value=(_data_hub_messages(), {})),
        patch.object(trace_upload, "_do_upload") as upload,
    ):
        assert trace_upload.upload_session_trace("s1") == REFUSAL_VI
    upload.assert_not_called()
