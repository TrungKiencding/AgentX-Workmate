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


# ─── Hub toolsets that hold the server, and hand-added entries ──────────────


def _toolset_entry(ref: str, servers=None) -> dict:
    entry = _gateway_entry(ref)
    entry["url"] = f"https://hub.example/gw/t/{ref}"
    entry["gateway"] = {"kind": "toolset", "ref": ref, "label": ref}
    if servers is not None:
        entry["gateway"]["servers"] = servers
    return entry


TOOLSET_CFG = {
    "mcp_servers": {
        "agentx-ts-data": _toolset_entry("ts_data", ["agentx-data", "github"]),
        "agentx-ts-plain": _toolset_entry("ts_plain", ["github"]),
        "agentx-ts-old": _toolset_entry("ts_old"),  # added before members were recorded
        "finnhub": {"url": "https://finnhub.example/mcp", "enabled": True},
    }
}


def test_toolset_entries_by_membership():
    from hermes_cli.session_export import data_hub_entries

    entries = data_hub_entries(TOOLSET_CFG["mcp_servers"])
    assert entries.toolsets == {"agentx-ts-data"}
    assert entries.unknown == {"agentx-ts-old"}
    assert not entries.servers
    assert is_data_hub_tool_name("mcp__agentx_ts_data__data_search_knowledge", entries)
    assert is_data_hub_tool_name("mcp__agentx_ts_data__read_passage_context", entries)
    assert not is_data_hub_tool_name("mcp__agentx_ts_data__gh_search_issues", entries)
    assert not is_data_hub_tool_name("mcp__agentx_ts_plain__data_search_knowledge", entries)


@pytest.mark.parametrize("platform", ["telegram", "signal", "api_server", "cron"])
def test_toolsets_holding_or_maybe_holding_data_hub_stay_off_other_platforms(platform):
    from hermes_cli.tools_config import _get_platform_tools

    enabled = _get_platform_tools(TOOLSET_CFG, platform)
    assert not enabled & {"agentx-ts-data", "agentx-ts-old"}
    assert {"agentx-ts-plain", "finnhub"} <= enabled
    assert {"agentx-ts-data", "agentx-ts-old", "agentx-ts-plain"} <= _get_platform_tools(TOOLSET_CFG, "cli")


def test_gateway_entry_records_toolset_members():
    from hermes_cli.hub_sync import gateway_entry

    entry = gateway_entry({
        "kind": "toolset", "ref": "ts_data", "label": "Data", "url": "https://hub.example/gw/t/ts_data",
        "servers": [{"slug": "github", "alias": "gh"}, {"slug": "agentx-data", "alias": "data"}],
    })
    assert entry["gateway"]["servers"] == ["agentx-data", "github"]
    assert "servers" not in gateway_entry({"kind": "server", "ref": "github", "url": "https://hub.example/gw/s/github"})["gateway"]


def test_sync_records_members_of_toolset_entries():
    from hermes_cli.config import load_config, save_config
    from hermes_cli.hub_sync import HubSyncEngine
    from hermes_cli.session_export import data_hub_entries

    config = load_config()
    config["mcp_servers"] = {"agentx-ts-old": _toolset_entry("ts_old"), "agentx-ts-plain": _toolset_entry("ts_plain", ["github"])}
    save_config(config)
    listing = {"gateway": {"enabled": True, "url": "https://hub.example/gw"}, "endpoints": [
        {"kind": "toolset", "ref": "ts_old", "servers": [{"slug": "agentx-data"}]},
        {"kind": "toolset", "ref": "ts_plain", "servers": [{"slug": "github"}]},
    ]}
    client = SimpleNamespace(gateway_endpoints=MagicMock(return_value=listing))
    engine = SimpleNamespace(_members_seen=None)
    creds = SimpleNamespace(bearer="b", device_id="d", device_name="n")
    snapshot = {"mcp": {"endpoints_changed_at": "2026-10-21T10:00:00Z"}}

    assert HubSyncEngine._keep_toolset_members(engine, creds, client, snapshot) == ["agentx-ts-old"]
    assert data_hub_entries(load_config()["mcp_servers"]).toolsets == {"agentx-ts-old"}
    # Nothing unknown and nothing changed on the hub: not asked again.
    assert HubSyncEngine._keep_toolset_members(engine, creds, client, snapshot) == []
    assert client.gateway_endpoints.call_count == 1


def test_hand_added_entries_on_the_hub_gateway():
    from hermes_cli.session_export import data_hub_entries

    servers = {
        "my-data": {"url": "https://hub.example/gw/s/agentx-data"},
        "my-toolset": {"url": "https://hub.example/gw/t/ts_9"},
        "elsewhere": {"url": "https://other.example/gw/s/agentx-data"},
        "github": {"url": "https://hub.example/gw/s/github"},
    }
    with patch("hermes_cli.hub_client.hub_base_url", return_value="https://hub.example"):
        entries = data_hub_entries(servers)
    assert entries.servers == {"my-data"}
    assert entries.unknown == {"my-toolset"}
    assert not entries.toolsets


# ─── The sticky flag on the session row ─────────────────────────────────────


@pytest.fixture
def store(tmp_path):
    from hermes_state import SessionDB

    db = SessionDB(db_path=tmp_path / "flag.db")
    yield db
    db.close()


def test_a_data_hub_result_flags_its_session_and_the_parent_it_reports_to(store):
    store.create_session("parent", source="desktop")
    store.create_session("child", source="subagent", parent_session_id="parent")
    store.append_message("child", role="tool", content='{"result": "{}"}', tool_name=SEARCH)

    assert store.session_has_data_hub("child")
    assert store.session_has_data_hub("parent")
    assert store.get_session("parent")["data_hub"] == 1


def test_a_result_of_a_toolset_entry_is_flagged_by_its_shape(store):
    inner = json.dumps({"result": "no_evidence", "notice": "n", "result_id": "rs_1", "passages": []})
    store.create_session("s", source="cli")
    store.append_messages_batch("s", [{"role": "tool", "tool_name": "mcp__agentx_ts_x__data_search_knowledge",
                                       "content": json.dumps({"result": inner})}])

    assert store.session_has_data_hub("s")


def test_continuations_carry_the_flag(store):
    store.create_session("root", source="desktop")
    store.append_message("root", role="tool", content="{}", tool_name=SEARCH)
    store.publish_compression_child(
        parent_session_id="root", child_session_id="next", source="desktop",
        messages=[{"role": "user", "content": "[summary] … [S1]"}], require_compression_lease=False,
    )
    store.create_session("branch", source="desktop", parent_session_id="next")

    assert store.session_has_data_hub("next")
    assert store.session_has_data_hub("branch")
    store.create_session("other", source="desktop")
    store.append_message("other", role="tool", content="x", tool_name="read_file")
    assert not store.session_has_data_hub("other")
    assert store.any_session_has_data_hub()


def test_sessions_recorded_before_the_flag_are_backfilled(tmp_path):
    import sqlite3

    from hermes_state import SessionDB

    path = tmp_path / "old.db"
    db = SessionDB(db_path=path)
    db.create_session("old", source="cli")
    db.create_session("cont", source="cli", parent_session_id="old")
    db.append_message("old", role="tool", content="{}", tool_name=SEARCH)
    db.close()
    # As a store written by a build without the flag.
    conn = sqlite3.connect(path)
    conn.execute("UPDATE sessions SET data_hub = 0")
    conn.execute("DELETE FROM state_meta WHERE key = 'data_hub_backfilled'")
    conn.commit()
    conn.close()

    db = SessionDB(db_path=path)
    try:
        assert db.session_has_data_hub("old")
        assert db.session_has_data_hub("cont")
    finally:
        db.close()


def test_a_subagent_without_a_transcript_reports_to_the_parent(store):
    from tools.delegate_tool import _report_data_hub_to_parent

    store.create_session("parent", source="desktop")
    parent = SimpleNamespace(_session_db=store, session_id="parent")
    _report_data_hub_to_parent(_plain_messages(), parent)
    assert not store.session_has_data_hub("parent")
    _report_data_hub_to_parent(_data_hub_messages(), parent)
    assert store.session_has_data_hub("parent")


def test_export_refuses_a_flagged_session_without_data_hub_rows(state_db, tmp_path, monkeypatch, capsys):
    from hermes_state import SessionDB

    db = SessionDB(db_path=state_db)
    db.mark_session_data_hub("s-plain")  # e.g. its subagent read Data Hub
    db.close()
    out = tmp_path / "out.jsonl"

    _sessions_export(monkeypatch, "--session-id", "s-plain", str(out))

    assert REFUSAL_VI in capsys.readouterr().out
    assert not out.exists()


def test_rest_honours_the_profile_store(tmp_path, monkeypatch):
    from fastapi import HTTPException

    from hermes_cli import web_server
    from hermes_cli.web_routers import sessions as web_sessions
    from hermes_state import SessionDB

    other = tmp_path / "other-profile.db"
    db = SessionDB(db_path=other)
    db.create_session("s", source="desktop")
    db.mark_session_data_hub("s")
    db.close()
    opened = []

    def _open(profile=None, *, read_only):
        opened.append(profile)
        return SessionDB(db_path=other if profile == "work" else tmp_path / "active.db")

    monkeypatch.setattr(web_server, "_open_session_db_for_profile", _open)
    with pytest.raises(HTTPException) as refused:
        asyncio.run(web_sessions.export_session_endpoint("s", profile="work"))
    assert refused.value.status_code == 403
    assert opened == ["work"]
    page = asyncio.run(web_sessions.get_session_messages("s", profile="work", limit=None, offset=0))
    assert page["data_hub"] is True


# ─── Kanban workers ─────────────────────────────────────────────────────────


def test_a_kanban_worker_does_not_get_data_hub_tools(_registered_tools, monkeypatch):
    monkeypatch.setenv("AGENTX_KANBAN_TASK", "t_1")
    agent = _agent("cli", OWNER_TOOLSETS)

    assert agent._data_hub_platform == "kanban"
    assert SEARCH not in _scoped_names(agent)
    assert "mcp__finnhub__quote" in _scoped_names(agent)


# ─── A server added after the agent was built, then /reload-mcp ─────────────


def test_a_server_added_later_stays_off_a_platform_that_may_not_have_it(_registered_tools):
    from agent.tool_executor import _data_hub_scope_block, _tool_search_scoped_names
    from tools.mcp_tool import refresh_agent_mcp_tools

    later = {"mcp_servers": {"finnhub": CFG["mcp_servers"]["finnhub"]}}
    with (
        patch("hermes_cli.config.load_config_readonly", return_value=later),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        from run_agent import AIAgent

        agent = AIAgent(api_key="test-key-1234567890", base_url="https://openrouter.ai/api/v1",
                        enabled_toolsets=None, platform="telegram", quiet_mode=True,
                        skip_context_files=True, skip_memory=True)
    # Built before "kho-noi-bo" was in the config: nothing told it apart yet.
    assert "mcp__kho_noi_bo__search_knowledge" in _scoped_names(agent)

    with patch("hermes_cli.config.load_config_readonly", return_value=CFG):
        refresh_agent_mcp_tools(agent)  # /reload-mcp, no fresh selection
        assert "mcp-kho-noi-bo" in agent.disabled_toolsets
        assert "mcp__kho_noi_bo__search_knowledge" not in _scoped_names(agent)
        assert "mcp__kho_noi_bo__search_knowledge" not in _tool_search_scoped_names(agent)
        assert _data_hub_scope_block(agent, "mcp__kho_noi_bo__search_knowledge")
        assert _data_hub_scope_block(agent, "mcp__finnhub__quote") is None


def test_the_bridge_cannot_list_or_call_data_hub_tools(_registered_tools):
    import model_tools
    from agent.tool_executor import _session_disabled_toolsets

    agent = _agent("signal", None)
    with patch("hermes_cli.config.load_config_readonly", return_value=CFG):
        disabled = _session_disabled_toolsets(agent)
    found = json.loads(model_tools.handle_function_call(
        "tool_search", {"query": "search_knowledge"}, "task",
        enabled_toolsets=agent.enabled_toolsets, disabled_toolsets=disabled,
    ))
    assert SEARCH not in json.dumps(found)
    called = json.loads(model_tools.handle_function_call(
        "tool_call", {"name": SEARCH, "arguments": {}}, "task",
        enabled_toolsets=agent.enabled_toolsets, disabled_toolsets=disabled,
    ))
    assert "not available" in json.dumps(called)


# ─── Profile export ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("named", [True, False])
def test_profile_export_is_refused_when_a_session_holds_data_hub(tmp_path, named):
    from hermes_cli import profiles
    from hermes_cli.session_export import DataHubProfileExportRefused
    from hermes_constants import get_hermes_home
    from hermes_state import SessionDB

    if named:
        profiles.create_profile("work", no_alias=True)
        home, name = profiles.get_profile_dir("work"), "work"
    else:
        home, name = get_hermes_home(), "default"
    db = SessionDB(db_path=home / "state.db")
    db.create_session("s", source="desktop")
    db.close()

    out = tmp_path / f"{name}.tar.gz"
    assert profiles.export_profile(name, str(out)).exists()

    db = SessionDB(db_path=home / "state.db")
    db.mark_session_data_hub("s")
    db.close()
    with pytest.raises(DataHubProfileExportRefused, match="Data Hub"):
        profiles.export_profile(name, str(tmp_path / f"{name}-2.tar.gz"))
    assert not (tmp_path / f"{name}-2.tar.gz").exists()
