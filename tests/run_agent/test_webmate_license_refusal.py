"""A WebMate tool refused for the AgentX license ends the turn — when the license agrees.

WebMate's extension checks the license of the account signed in to it on
its own; its MCP server (1.4.0+) answers a refused browser task with
``license_read_only: <why>``. Workmate treats that like the AgentX AI
Gateway refusing mid-turn: it asks the keys service again (with the bearer
the desktop handed the process, on a short timeout) and, when the license is
now read-only, ends the turn with the license refusal instead of letting the
model carry on. When its license still covers AI, the two disagree and the
model just reads the tool's error.

Drives the real ``AIAgent.run_conversation`` with a mocked model client and
a mocked tool dispatcher.
"""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from hermes_cli import account_license
from hermes_cli.account_license import READ_ONLY_CODE, is_extension_license_refusal, remember_license
from run_agent import AIAgent

WEBMATE_RUN = "mcp__webmate__webmate_run"

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

_EXTENSION_REFUSAL = json.dumps(
    {"error": "license_read_only: Your AgentX license has been revoked. Contact it@astralx.com.vn."}
)


def _tool_defs(*names: str) -> list[dict]:
    return [
        {
            "type": "function",
            "function": {"name": name, "description": name, "parameters": {"type": "object", "properties": {}}},
        }
        for name in names
    ]


def _tool_call(name: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=f"call_{uuid.uuid4().hex[:8]}",
        type="function",
        function=SimpleNamespace(name=name, arguments=json.dumps({"task": "open the dashboard"})),
    )


def _response(content="", tool_calls=None, finish_reason="stop"):
    message = SimpleNamespace(content=content, tool_calls=tool_calls)
    return SimpleNamespace(
        choices=[SimpleNamespace(message=message, finish_reason=finish_reason)], model="test/model", usage=None
    )


def _agent(*tools: str) -> AIAgent:
    with (
        patch("run_agent.get_tool_definitions", return_value=_tool_defs(*tools)),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        agent = AIAgent(
            api_key="test-key-1234567890",
            base_url="https://api.openai.com/v1",
            provider="openai",
            api_mode="chat_completions",
            model="gpt-5.5",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
        )
    agent.client = MagicMock()
    agent._cached_system_prompt = "You are helpful."
    agent._use_prompt_caching = False
    agent.compression_enabled = False
    agent.save_trajectories = False
    return agent


@pytest.fixture
def keys_service(monkeypatch):
    """The keys service, asked again with the desktop's bearer, answers *license*."""
    from hermes_cli import sync_engine
    from hermes_cli.sync_engine import SyncCredentials

    asked: list[str] = []
    answer = {"license": _REVOKED}

    def _refresh(**kwargs):
        asked.append(kwargs.get("bearer", ""))
        remember_license(answer["license"])
        return account_license.LicenseRefresh(status="ok", license=answer["license"])

    monkeypatch.setattr(account_license, "refresh_license", _refresh)
    monkeypatch.setattr(sync_engine.mailbox(), "current", lambda: SyncCredentials(bearer="tok-live", device_id="dev-1"))
    return SimpleNamespace(asked=asked, answer=answer)


def _run(agent: AIAgent, tool_result: str, tool: str = WEBMATE_RUN):
    agent.client.chat.completions.create.side_effect = [
        _response(tool_calls=[_tool_call(tool)], finish_reason="tool_calls"),
        _response(content="The browser said no; nothing was opened."),
    ]
    with (
        patch("run_agent.handle_function_call", return_value=tool_result),
        patch.object(agent, "_persist_session") as persisted,
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
    ):
        result = agent.run_conversation("open my dashboard", conversation_history=[])
    return result, persisted


class TestTheExtensionRefusesForTheLicense:
    def test_the_turn_ends_with_the_license_refusal_when_the_license_agrees(self, keys_service):
        remember_license(_ACTIVE)
        agent = _agent(WEBMATE_RUN)

        result, persisted = _run(agent, _EXTENSION_REFUSAL)

        assert keys_service.asked == ["tok-live"]
        assert result["failed"] is True
        assert result["failure_reason"] == READ_ONLY_CODE
        assert result["license"]["state"] == "revoked"
        # The model was not asked to carry on after the refusal.
        assert agent.client.chat.completions.create.call_count == 1
        # The call and its refused result stay in the conversation.
        roles = [m.get("role") for m in result["messages"]]
        assert roles[-2:] == ["assistant", "tool"]
        assert persisted.called

    def test_the_turn_goes_on_when_workmates_license_still_covers_ai(self, keys_service):
        remember_license(_ACTIVE)
        keys_service.answer["license"] = _ACTIVE
        agent = _agent(WEBMATE_RUN)

        result, _persisted = _run(agent, _EXTENSION_REFUSAL)

        assert keys_service.asked == ["tok-live"]
        assert result.get("failure_reason") != READ_ONLY_CODE
        assert agent.client.chat.completions.create.call_count == 2
        assert result["final_response"] == "The browser said no; nothing was opened."

    def test_a_webmate_setup_error_never_consults_the_license(self, keys_service):
        remember_license(_ACTIVE)
        agent = _agent(WEBMATE_RUN)

        result, _persisted = _run(agent, json.dumps({"error": "WEBMATE_NOT_CONNECTED: no browser attached"}))

        assert keys_service.asked == []
        assert agent.client.chat.completions.create.call_count == 2

    def test_another_tool_quoting_the_code_is_not_a_refusal(self, keys_service):
        remember_license(_ACTIVE)
        agent = _agent("web_extract")

        result, _persisted = _run(agent, json.dumps({"result": "license_read_only: a page about codes"}), "web_extract")

        assert keys_service.asked == []
        assert agent.client.chat.completions.create.call_count == 2


@pytest.mark.parametrize(
    ("name", "content", "expected"),
    [
        (WEBMATE_RUN, _EXTENSION_REFUSAL, True),
        ("mcp__webmate__webmate_extract", "license_read_only: read-only", True),
        # The guardrail may append guidance after the JSON; still the refusal.
        (WEBMATE_RUN, _EXTENSION_REFUSAL + "\n\n[Tool loop warning: …]", True),
        (WEBMATE_RUN, json.dumps({"error": "WEBMATE_NOT_SIGNED_IN: sign in"}), False),
        (WEBMATE_RUN, json.dumps({"result": "the page mentions xlicense_read_only:x"}), False),
        ("web_extract", _EXTENSION_REFUSAL, False),
        (WEBMATE_RUN, None, False),
    ],
)
def test_what_counts_as_the_extensions_refusal(name, content, expected):
    assert is_extension_license_refusal(name, content) is expected
