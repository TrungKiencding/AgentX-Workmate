"""The messaging gateway starts no AI turn while the AgentX license is read-only.

A person whose license no longer covers AI writes to their Telegram bot: the
reply is the reason, and nothing behind it runs — no session slot, no
pre-turn model call (hygiene compression), no agent. Slash commands are
handled above the gate and keep working.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from gateway.platforms.base import MessageEvent, MessageType
from hermes_cli.account_license import read_only_message, remember_license
from tests.gateway.restart_test_helpers import make_restart_runner, make_restart_source

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


def _runner():
    runner, _adapter = make_restart_runner()
    runner._external_drain_active = False
    # Past the gate, the next thing the gateway does is claim a session slot.
    # Refusing it there marks "the gate let this through" without standing up
    # the whole agent pipeline.
    runner._claim_active_session_slot = MagicMock(return_value=(None, "past the license gate"))
    return runner


def _event(text: str = "draft the weekly report", *, internal: bool = False) -> MessageEvent:
    return MessageEvent(
        text=text,
        message_type=MessageType.TEXT,
        source=make_restart_source(),
        message_id="m1",
        internal=internal,
    )


@pytest.mark.asyncio
async def test_a_message_gets_the_reason_and_starts_nothing():
    remember_license(_REVOKED)
    runner = _runner()

    reply = await runner._handle_message(_event())

    assert reply == read_only_message(_REVOKED)
    assert "it@astralx.com.vn" in reply
    assert runner._claim_active_session_slot.called is False


@pytest.mark.asyncio
async def test_commands_keep_working():
    remember_license(_REVOKED)
    runner = _runner()

    reply = await runner._handle_message(_event("/help"))

    assert reply and reply != read_only_message(_REVOKED)
    assert "/new" in reply


@pytest.mark.asyncio
async def test_an_internal_event_would_start_a_turn_too():
    # A background-process completion asks the agent to carry on — a new AI
    # turn like any other, so it is refused the same way.
    remember_license(_REVOKED)
    runner = _runner()

    reply = await runner._handle_message(_event("[process finished]", internal=True))

    assert reply == read_only_message(_REVOKED)
    assert runner._claim_active_session_slot.called is False


@pytest.mark.asyncio
async def test_no_license_known_lets_the_turn_through():
    runner = _runner()

    reply = await runner._handle_message(_event())

    assert reply == "past the license gate"
    assert runner._claim_active_session_slot.called is True


@pytest.mark.asyncio
async def test_a_license_that_covers_ai_lets_the_turn_through():
    remember_license(
        {
            **_REVOKED,
            "state": "active",
            "access": "full",
            "notice": None,
            "revoked_at": None,
            "ends_at": "2027-07-01T00:00:00+07:00",
            "grace_until": "2027-07-08T00:00:00+07:00",
        }
    )
    runner = _runner()

    reply = await runner._handle_message(_event())

    assert reply == "past the license gate"


def test_the_kanban_dispatcher_spawns_no_worker_while_read_only():
    # Every worker would be a refused AI turn counting toward its task's
    # failure limit — the board would be blocked by the time the license is
    # renewed.
    from gateway.kanban_watchers import _kanban_dispatch_allowed

    assert _kanban_dispatch_allowed() is True

    remember_license(_REVOKED)

    assert _kanban_dispatch_allowed() is False


def _compress_runner():
    """A runner whose session holds enough history for /compress to act on."""
    from datetime import datetime

    from gateway.config import GatewayConfig, Platform, PlatformConfig
    from gateway.run import GatewayRunner
    from gateway.session import SessionEntry, build_session_key

    source = make_restart_source()
    runner = object.__new__(GatewayRunner)
    runner.config = GatewayConfig(platforms={Platform.TELEGRAM: PlatformConfig(enabled=True, token="***")})
    runner.session_store = MagicMock()
    runner.session_store.get_or_create_session.return_value = SessionEntry(
        session_key=build_session_key(source),
        session_id="sess-1",
        created_at=datetime.now(),
        updated_at=datetime.now(),
        platform=source.platform,
        chat_type=source.chat_type,
    )
    runner.session_store.load_transcript.return_value = [
        {"role": "user", "content": "one"},
        {"role": "assistant", "content": "two"},
        {"role": "user", "content": "three"},
        {"role": "assistant", "content": "four"},
    ]
    runner._session_db = None
    return runner


@pytest.mark.asyncio
async def test_compress_says_why_and_builds_no_agent(monkeypatch):
    # Compaction is model work: the command answers with the same reason a
    # message gets, and no throwaway agent is built to summarise anything.
    remember_license(_REVOKED)
    runner = _compress_runner()

    def no_agent(*_args, **_kwargs):
        raise AssertionError("a refused /compress must not build an agent")

    monkeypatch.setattr("run_agent.AIAgent", no_agent)

    reply = await runner._handle_compress_command(_event("/compress"))

    assert reply == read_only_message(_REVOKED)
    runner.session_store.rewrite_transcript.assert_not_called()


@pytest.mark.asyncio
async def test_compress_preview_is_local_arithmetic_and_still_answers():
    remember_license(_REVOKED)
    runner = _compress_runner()

    reply = await runner._handle_compress_command(_event("/compress --preview"))

    assert reply != read_only_message(_REVOKED)
    assert "🗜️" in reply
