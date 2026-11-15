"""`agentx chat -q` must not hand a delegation to a channel nobody drains.

Top-level delegations are forced into the background: ``delegate_task``
returns a handle and the subagent's result re-enters the conversation later
through ``process_registry.completion_queue``, which only the interactive
loop and the gateway watchers drain. A single-query run prints one response
and exits, so the subagent was interrupted mid-call and its result lost.

Single-query mode has to declare the channel stateless — like ``agentx -z``,
cron and Kanban workers — so ``delegate_task`` runs inline and the result is
in the same turn.
"""

import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from gateway.session_context import async_delivery_supported, reset_session_vars
from tests.cli.test_cli_interrupt_ack_race import _make_cli, _StubAgent


@pytest.fixture(autouse=True)
def _unbound_session_context():
    reset_session_vars()
    yield
    reset_session_vars()


@pytest.fixture
def inline_children(monkeypatch):
    """Real ``delegate_task`` with the child agent and the async pool stubbed.

    Returns the list of background dispatches the tool attempted.
    """
    import tools.delegate_tool as dt

    dispatched = []

    def _fake_dispatch(*args, **kwargs):
        dispatched.append(kwargs)
        return {"delegation_id": "deleg_test"}

    def _child(task_index, goal, child=None, parent_agent=None, **kwargs):
        return {
            "task_index": 0, "status": "completed", "summary": f"done: {goal}",
            "api_calls": 1, "duration_seconds": 0.1, "model": "m",
            "exit_reason": "completed",
        }

    creds = {
        "model": "m", "provider": None, "base_url": None, "api_key": None,
        "api_mode": None, "command": None, "args": None,
    }
    fake_child = type("C", (), {"_subagent_id": "s1"})()
    monkeypatch.setattr(dt, "_build_child_agent", lambda **kw: fake_child)
    monkeypatch.setattr(dt, "_run_single_child", _child)
    monkeypatch.setattr(dt, "_resolve_delegation_credentials", lambda *a, **k: creds)
    monkeypatch.setattr(
        "tools.async_delegation.dispatch_async_delegation_batch", _fake_dispatch
    )
    return dispatched


class _DelegatingAgent(_StubAgent):
    """A turn in which the model calls ``delegate_task`` once."""

    _delegate_depth = 0
    _subagent_id = None

    def __init__(self, session_id):
        super().__init__(session_id, turn_seconds=0)
        self.async_delivery_seen = None
        self.delegate_output = None

    def run_conversation(self, **kwargs):
        import tools.delegate_tool as dt

        self.async_delivery_seen = async_delivery_supported()
        # background=True is what run_agent._dispatch_delegate_task passes
        # for every top-level delegation.
        self.delegate_output = json.loads(
            dt.delegate_task(goal="sum 1..200", background=True, parent_agent=self)
        )
        return super().run_conversation(**kwargs)


def _run_chat(cli, agent):
    cli.agent = agent
    with patch.object(cli, "_ensure_runtime_credentials", return_value=True), \
         patch.object(cli, "_resolve_turn_agent_config", return_value={
             "signature": cli._active_agent_route_signature,
             "model": None, "runtime": None, "request_overrides": None,
         }), \
         patch.object(cli, "_init_agent", return_value=True):
        cli.chat("delegate the sum")


def test_single_query_chat_runs_the_delegation_inside_the_turn(inline_children):
    cli = _make_cli()
    cli._single_query_mode = True
    agent = _DelegatingAgent(cli.session_id)

    _run_chat(cli, agent)

    assert agent.async_delivery_seen is False
    assert not inline_children, "single-query dispatched a subagent it can never hear from"
    assert agent.delegate_output.get("status") != "dispatched"
    assert "done: sum 1..200" in json.dumps(agent.delegate_output)


def test_interactive_chat_keeps_background_delegation(inline_children):
    cli = _make_cli()
    agent = _DelegatingAgent(cli.session_id)

    _run_chat(cli, agent)

    assert agent.async_delivery_seen is True
    assert len(inline_children) == 1


def test_quiet_single_query_declares_the_channel_stateless(monkeypatch):
    # `-Q -q` runs the agent on the main thread, not through chat().
    import cli as cli_mod

    seen = []

    def run_conversation(*, user_message, conversation_history):
        seen.append(async_delivery_supported())
        return {"final_response": "ok"}

    class FakeCLI:
        def __init__(self, **_kwargs):
            self.provider = "test-provider"
            self.model = "test-model"
            self.session_id = "quiet-session"
            self.conversation_history = []
            self._active_agent_route_signature = "same-route"
            self.agent = SimpleNamespace(
                session_id="quiet-session",
                platform="cli",
                run_conversation=run_conversation,
            )

        def _claim_active_session(self, surface, *, stderr=False):
            return True

        def _ensure_runtime_credentials(self):
            return True

        def _resolve_turn_agent_config(self, effective_query):
            return {
                "signature": "same-route",
                "model": None,
                "runtime": None,
                "request_overrides": None,
            }

        def _init_agent(self, **kwargs):
            return True

    monkeypatch.delenv("AGENTX_KANBAN_TASK", raising=False)
    monkeypatch.delenv("AGENTX_KANBAN_GOAL_MODE", raising=False)
    # The account sign-in gate is not what this test is about.
    monkeypatch.setattr("hermes_cli.cli_sso.require_session", lambda **_k: None)
    monkeypatch.setattr(cli_mod, "HermesCLI", FakeCLI)
    monkeypatch.setattr(cli_mod.atexit, "register", lambda *_a, **_k: None)
    monkeypatch.setattr(cli_mod, "_finalize_single_query", lambda _cli: None)

    with pytest.raises(SystemExit) as exc_info:
        cli_mod.main(query="hello", quiet=True, toolsets="terminal")

    assert exc_info.value.code == 0
    assert seen == [False]
    # An in-process caller of main() is not left with a stateless channel.
    assert async_delivery_supported() is True
