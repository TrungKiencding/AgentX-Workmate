"""A read-only AgentX license refuses agent turns, whatever the provider.

Drives the real ``AIAgent.run_conversation`` with a mocked model client, the
same way ``test_nonretryable_error_html_summary`` does, against a license
recorded in the test's own home. Two refusals are pinned:

* the turn that never starts — the license is read-only before anything is
  sent, so not even the person's own provider is called;
* the turn the AgentX AI Gateway refuses mid-way — the gateway blocks a
  read-only person's key, and the turn must end with the license reason
  rather than the provider's raw 401, and must not fail over to another
  provider on the way.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from hermes_cli import account_license
from hermes_cli.account_license import READ_ONLY_CODE, read_only_message, remember_license
from run_agent import AIAgent

GATEWAY = "https://aigw.test"


def _license(**overrides) -> dict:
    body = {
        "state": "revoked",
        "access": "read_only",
        "enforced": True,
        "notice": "read_only",
        "plan": {"slug": "pilot-2026", "name": "Pilot 2026"},
        "products": ["workmate", "webmate", "chat"],
        "starts_at": "2026-10-15T00:00:00+07:00",
        "ends_at": "2027-01-01T00:00:00+07:00",
        "grace_until": "2027-01-08T00:00:00+07:00",
        "starts_on": "2026-10-15",
        "last_day": "2026-12-31",
        "read_only_from": "2027-01-08",
        "revoked_at": "2026-11-02T10:00:00+07:00",
        "days_left": None,
        "reminder": None,
        "warn_days": [14, 7, 1],
        "contact": "it@astralx.com.vn",
        "server_time": "2026-11-02T10:00:00+07:00",
    }
    body.update(overrides)
    return body


def _make_agent(base_url: str = "https://api.openai.com/v1", **extra) -> AIAgent:
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
            **extra,
        )
    agent.client = MagicMock()
    agent._cached_system_prompt = "You are helpful."
    agent._use_prompt_caching = False
    agent.compression_enabled = False
    agent.save_trajectories = False
    return agent


def _auth_error(status: int = 401) -> Exception:
    err = Exception(f"Error code: {status} - Authentication Error, key is blocked")
    err.status_code = status
    return err


HISTORY = [
    {"role": "user", "content": "what's on today?"},
    {"role": "assistant", "content": "Two meetings."},
]


class TestNoTurnStarts:
    def test_a_read_only_account_reaches_no_provider(self):
        remember_license(_license())
        agent = _make_agent()

        with patch.object(agent, "_persist_session") as persisted:
            result = agent.run_conversation("and tomorrow?", conversation_history=list(HISTORY))

        assert agent.client.chat.completions.create.called is False
        assert result["failed"] is True
        assert result["failure_reason"] == READ_ONLY_CODE
        assert result["license"]["state"] == "revoked"
        assert result["final_response"] == read_only_message(result["license"])
        # Nothing was added to the conversation, and nothing was written.
        assert result["messages"] == HISTORY
        assert persisted.called is False

    def test_no_license_known_changes_nothing(self):
        agent = _make_agent()
        agent.client.chat.completions.create.side_effect = _auth_error(400)

        with (
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
        ):
            result = agent.run_conversation("hello")

        # The provider was asked; whatever it said is the provider's answer.
        assert agent.client.chat.completions.create.called
        assert result.get("failure_reason") != READ_ONLY_CODE

    def test_a_license_that_covers_ai_changes_nothing(self):
        remember_license(_license(state="active", access="full", notice=None, revoked_at=None))
        agent = _make_agent()
        agent.client.chat.completions.create.side_effect = _auth_error(400)

        with (
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
        ):
            agent.run_conversation("hello")

        assert agent.client.chat.completions.create.called


class TestTheGatewayRefusesMidTurn:
    @pytest.fixture
    def account_gateway(self):
        """This account's key was issued for GATEWAY (the provisioning sidecar says so)."""
        from hermes_cli.account_provisioning import write_state
        from hermes_constants import get_hermes_home

        write_state(get_hermes_home(), {"base_url": GATEWAY, "mode": "second_brain"})

    @pytest.fixture
    def sso_locks_on_refresh(self, monkeypatch):
        """The keys service, asked again, says the license was revoked."""
        from hermes_cli import sync_engine
        from hermes_cli.sync_engine import SyncCredentials

        asked: list[str] = []

        def _refresh(**kwargs):
            asked.append(kwargs.get("bearer", ""))
            remember_license(_license())
            return account_license.LicenseRefresh(status="ok", license=_license())

        monkeypatch.setattr(account_license, "refresh_license", _refresh)
        monkeypatch.setattr(
            sync_engine.mailbox(),
            "current",
            lambda: SyncCredentials(bearer="tok-live", device_id="dev-1"),
        )
        return asked

    def _run(self, agent, message="draft the report"):
        with (
            patch.object(agent, "_persist_session") as persisted,
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
        ):
            result = agent.run_conversation(message, conversation_history=list(HISTORY))
        return result, persisted

    @pytest.mark.parametrize("status", [401, 403])
    def test_the_license_reason_replaces_the_providers_error(
        self, account_gateway, sso_locks_on_refresh, status
    ):
        agent = _make_agent(base_url=f"{GATEWAY}/v1")
        agent.client.chat.completions.create.side_effect = _auth_error(status)

        result, persisted = self._run(agent)

        assert sso_locks_on_refresh == ["tok-live"]
        assert result["failed"] is True
        assert result["failure_reason"] == READ_ONLY_CODE
        assert result["license"]["state"] == "revoked"
        assert "Error code" not in result["final_response"]
        # One request, no retries of a request the license will refuse again.
        assert agent.client.chat.completions.create.call_count == 1
        # The turn's messages are kept, like any other failed turn.
        assert persisted.called
        assert result["messages"][: len(HISTORY)] == HISTORY

    def test_a_read_only_person_is_not_failed_over_to_another_provider(
        self, account_gateway, sso_locks_on_refresh
    ):
        agent = _make_agent(
            base_url=f"{GATEWAY}/v1",
            fallback_model=[{"provider": "openai", "model": "gpt-4o"}],
        )
        agent.client.chat.completions.create.side_effect = _auth_error(401)

        with patch.object(agent, "_try_activate_fallback") as fell_over:
            result, _persisted = self._run(agent)

        assert result["failure_reason"] == READ_ONLY_CODE
        assert fell_over.called is False

    def test_a_refusal_with_the_license_still_full_is_the_providers_error(
        self, account_gateway, monkeypatch
    ):
        from hermes_cli import sync_engine

        monkeypatch.setattr(sync_engine.mailbox(), "current", lambda: None)
        remember_license(_license(state="active", access="full", notice=None, revoked_at=None))
        agent = _make_agent(base_url=f"{GATEWAY}/v1")
        agent.client.chat.completions.create.side_effect = _auth_error(401)

        result, _persisted = self._run(agent)

        assert result["failed"] is True
        assert result.get("failure_reason") != READ_ONLY_CODE

    def test_another_providers_refusal_never_consults_the_license(
        self, account_gateway, sso_locks_on_refresh
    ):
        agent = _make_agent(base_url="https://api.openai.com/v1")
        agent.client.chat.completions.create.side_effect = _auth_error(401)

        result, _persisted = self._run(agent)

        assert sso_locks_on_refresh == []
        assert result.get("failure_reason") != READ_ONLY_CODE
