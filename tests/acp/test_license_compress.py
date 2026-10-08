"""An editor's ``/compress`` (ACP) says why while the AgentX license is read-only."""

from __future__ import annotations

from unittest.mock import MagicMock

from acp_adapter.server import HermesACPAgent
from acp_adapter.session import SessionManager
from hermes_cli.account_license import read_only_message, remember_license

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


def test_compress_says_why_and_leaves_the_history():
    remember_license(_REVOKED)
    manager = SessionManager(agent_factory=lambda: MagicMock(name="MockAIAgent"))
    adapter = HermesACPAgent(session_manager=manager)
    state = manager.create_session(cwd="/tmp")
    history = [
        {"role": "user", "content": "one"},
        {"role": "assistant", "content": "two"},
    ]
    state.history = list(history)

    reply = adapter._handle_slash_command("/compress", state)

    assert reply == read_only_message(_REVOKED)
    assert state.history == history
    state.agent._compress_context.assert_not_called()
