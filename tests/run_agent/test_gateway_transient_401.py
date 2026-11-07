"""A 401 from the AgentX AI Gateway is waited out before it fails the turn.

LiteLLM answers 401 to a valid key while it cannot read its key table: during
the 2026-11-07 Postgres primary switchover it did so four times in about two
seconds, and the key worked again right after. A turn that met one of those
used to end on the spot as "your AI key has expired or been revoked".

Drives the real ``AIAgent.run_conversation`` with a mocked model client, like
``test_license_read_only``, against a provisioning sidecar that names the
account's gateway. Pinned here:

* a short burst of 401s is retried with backoff and the turn completes;
* a 401 that outlasts the retries still fails the turn — as an auth failure,
  after a bounded number of requests;
* the env key is re-read before each resend, so a key provisioning just
  collected is the one sent;
* nothing is resent once text from that attempt reached the screen;
* other providers' 401s are left to the existing handling.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from agent import conversation_loop
from hermes_cli.account_license import remember_license
from run_agent import AIAgent

GATEWAY = "https://aigw.test"

HISTORY = [
    {"role": "user", "content": "what's on today?"},
    {"role": "assistant", "content": "Two meetings."},
]


def _make_agent(base_url: str = f"{GATEWAY}/v1") -> AIAgent:
    with (
        patch("run_agent.get_tool_definitions", return_value=[]),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        agent = AIAgent(
            api_key="test-key-1234567890",
            base_url=base_url,
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
    agent._fallback_chain = []
    return agent


def _unauthorized() -> Exception:
    err = Exception(
        "Error code: 401 - {'error': {'message': 'Authentication Error, "
        "Invalid proxy server token passed.', 'type': 'auth_error', 'code': '401'}}"
    )
    err.status_code = 401
    return err


def _reply(content: str = "Here is the report.") -> SimpleNamespace:
    msg = SimpleNamespace(content=content, tool_calls=None)
    choice = SimpleNamespace(message=msg, finish_reason="stop")
    return SimpleNamespace(choices=[choice], model="gpt-5.5", usage=None)


@pytest.fixture(autouse=True)
def account_gateway():
    """This account's key was issued for GATEWAY, under a license that covers AI."""
    from hermes_cli.account_provisioning import write_state
    from hermes_constants import get_hermes_home

    write_state(get_hermes_home(), {"base_url": GATEWAY, "mode": "keys"})
    remember_license(
        {
            "state": "active",
            "access": "full",
            "enforced": True,
            "notice": None,
            "server_time": "2026-11-07T10:00:00+07:00",
        }
    )


@pytest.fixture(autouse=True)
def no_keys_service(monkeypatch):
    """No bearer in the mailbox: the license check reads the local record only."""
    from hermes_cli import account_credentials

    monkeypatch.setattr(account_credentials.mailbox(), "current", lambda: None)


@pytest.fixture
def waits(monkeypatch):
    """Record the backoff the loop asks for without spending it."""
    asked: list[float] = []
    monkeypatch.setattr(conversation_loop, "GATEWAY_REFUSAL_RETRY_DELAYS", (0.0, 0.0, 0.0))
    real_buffer = AIAgent._buffer_status

    def _buffer(self, text, *args, **kwargs):
        if "AgentX AI Gateway refused the key" in str(text):
            asked.append(text)
        return real_buffer(self, text, *args, **kwargs)

    monkeypatch.setattr(AIAgent, "_buffer_status", _buffer)
    return asked


def _run(agent, message="draft the report"):
    with (
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
    ):
        return agent.run_conversation(message, conversation_history=list(HISTORY))


def test_the_delays_add_up_to_a_few_seconds():
    delays = conversation_loop.GATEWAY_REFUSAL_RETRY_DELAYS
    assert list(delays) == sorted(delays)
    assert 3.0 <= sum(delays) <= 15.0


def test_a_burst_of_401s_is_waited_out_and_the_turn_completes(waits):
    agent = _make_agent()
    agent.client.chat.completions.create.side_effect = [
        _unauthorized(),
        _unauthorized(),
        _reply(),
    ]

    result = _run(agent)

    assert agent.client.chat.completions.create.call_count == 3
    assert len(waits) == 2
    assert result.get("failed") is not True
    assert result["final_response"] == "Here is the report."


def test_the_credential_pool_does_not_bench_the_key_for_a_blip(waits):
    agent = _make_agent()
    agent.client.chat.completions.create.side_effect = [_unauthorized(), _reply()]

    with patch.object(agent, "_recover_with_credential_pool") as pool:
        result = _run(agent)

    assert result["final_response"] == "Here is the report."
    assert pool.called is False


def test_the_env_key_is_reread_before_each_resend(waits):
    """Provisioning may have just collected a key another device rotated to."""
    agent = _make_agent()
    agent.client.chat.completions.create.side_effect = [_unauthorized(), _reply()]

    with patch.object(agent, "_try_refresh_env_client_credentials", return_value=False) as refresh:
        _run(agent)

    # Once at the start of the turn, once before the resend.
    assert refresh.call_count == 2


def test_a_401_that_persists_still_fails_the_turn_as_an_auth_failure(waits):
    agent = _make_agent()
    agent.client.chat.completions.create.side_effect = _unauthorized()

    result = _run(agent)

    retries = len(conversation_loop.GATEWAY_REFUSAL_RETRY_DELAYS)
    assert len(waits) == retries
    # Bounded: the first request and one per backoff step, then the existing
    # handling ends the turn instead of retrying a dead key forever.
    assert agent.client.chat.completions.create.call_count == retries + 1
    assert result["failed"] is True
    assert result["failure_reason"] in {"auth", "auth_permanent"}
    assert result["messages"][: len(HISTORY)] == HISTORY


def test_nothing_is_resent_once_text_reached_the_screen(waits):
    agent = _make_agent()

    def _streamed_then_refused(*_args, **_kwargs):
        agent._current_streamed_assistant_text = "Here is the rep"
        raise _unauthorized()

    agent.client.chat.completions.create.side_effect = _streamed_then_refused

    result = _run(agent)

    assert waits == []
    assert agent.client.chat.completions.create.call_count == 1
    assert result["failed"] is True


def test_another_providers_401_is_not_waited_out(waits):
    agent = _make_agent(base_url="https://api.openai.com/v1")
    agent.client.chat.completions.create.side_effect = _unauthorized()

    result = _run(agent)

    assert waits == []
    assert agent.client.chat.completions.create.call_count == 1
    assert result["failed"] is True


def test_an_interrupt_during_the_wait_ends_the_turn(monkeypatch):
    monkeypatch.setattr(conversation_loop, "GATEWAY_REFUSAL_RETRY_DELAYS", (30.0,))
    agent = _make_agent()

    def _refused(*_args, **_kwargs):
        agent._interrupt_requested = True
        raise _unauthorized()

    agent.client.chat.completions.create.side_effect = _refused

    result = _run(agent)

    assert result["interrupted"] is True
    assert agent.client.chat.completions.create.call_count == 1
