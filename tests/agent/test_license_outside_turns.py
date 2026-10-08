"""Model work outside an agent turn is refused while the AgentX license is read-only.

Agent turns are refused at ``AIAgent.run_conversation``. Everything else that
reaches a model funnels through two choke points, tested here: the auxiliary
client (``call_llm`` / ``async_call_llm`` — titles, one-off generations,
summaries, vision, judges, whichever provider) and compaction
(``AIAgent._compress_context`` — every ``/compress`` route, the gateway's
hygiene sweep, the loop's own). Each refuses before anything is resolved,
sent or changed, and lets the work run when the license covers AI.
"""

from __future__ import annotations

import asyncio

import pytest

import agent.auxiliary_client as aux
import agent.conversation_compression as cc
from hermes_cli.account_license import READ_ONLY_CODE, LicenseReadOnly, read_only_message, remember_license

_EXPIRED = {
    "state": "expired",
    "access": "read_only",
    "enforced": True,
    "notice": "read_only",
    "plan": {"slug": "pilot-2026", "name": "Pilot 2026"},
    "last_day": "2026-12-31",
    "read_only_from": "2027-01-08",
    "contact": "it@astralx.com.vn",
    "warn_days": [14, 7, 1],
    "server_time": "2027-01-09T09:00:00+07:00",
}

_ACTIVE = {**_EXPIRED, "state": "active", "access": "full", "notice": None}


@pytest.fixture
def home(tmp_path, monkeypatch):
    path = tmp_path / "account"
    path.mkdir()
    monkeypatch.setenv("AGENTX_HOME", str(path))
    return path


def _never(*_args, **_kwargs):
    raise AssertionError("a refused call must not reach the provider path")


class TestAuxiliaryCalls:
    def test_call_llm_is_refused_before_anything_is_resolved(self, home, monkeypatch):
        remember_license(_EXPIRED)
        monkeypatch.setattr(aux, "_call_llm_impl", _never)
        monkeypatch.setattr(aux, "_acquire_sync_aux_semaphore", _never)

        with pytest.raises(LicenseReadOnly) as refused:
            aux.call_llm("title_generation", messages=[{"role": "user", "content": "hi"}])

        assert refused.value.code == READ_ONLY_CODE
        assert str(refused.value) == read_only_message(_EXPIRED)

    def test_async_call_llm_is_refused_too(self, home, monkeypatch):
        remember_license(_EXPIRED)
        monkeypatch.setattr(aux, "_async_call_llm_impl", _never)
        monkeypatch.setattr(aux, "_acquire_async_aux_semaphore", _never)

        with pytest.raises(LicenseReadOnly):
            asyncio.run(aux.async_call_llm("vision", messages=[{"role": "user", "content": "hi"}]))

    def test_a_one_off_generation_is_refused_through_it(self, home, monkeypatch):
        from agent.oneshot import run_oneshot

        remember_license(_EXPIRED)
        monkeypatch.setattr(aux, "_call_llm_impl", _never)

        with pytest.raises(LicenseReadOnly):
            run_oneshot(template="commit_message", variables={"diff": "+ a line"})

    @pytest.mark.parametrize("known", [None, _ACTIVE], ids=["none-known", "active"])
    def test_it_runs_while_the_license_covers_ai(self, home, monkeypatch, known):
        if known is not None:
            remember_license(known)
        calls = []
        monkeypatch.setattr(aux, "_call_llm_impl", lambda **kwargs: calls.append(kwargs) or "response")

        assert aux.call_llm("title_generation", messages=[{"role": "user", "content": "hi"}]) == "response"
        assert len(calls) == 1


class _Agent:
    def _conversation_root_id(self):
        return "root"


class TestCompaction:
    def test_it_is_refused_before_anything_is_summarised_or_changed(self, home, monkeypatch):
        from run_agent import AIAgent

        remember_license(_EXPIRED)
        monkeypatch.setattr(cc, "compress_context", _never)
        messages = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
        before = [dict(m) for m in messages]
        agent = _Agent()

        with pytest.raises(LicenseReadOnly):
            AIAgent._compress_context(agent, messages, "sys", force=True)

        assert messages == before
        # Nothing was registered for a compaction that never started.
        assert "_active_compression_commit_fence" not in vars(agent)

    def test_it_runs_while_the_license_covers_ai(self, home, monkeypatch):
        from run_agent import AIAgent

        remember_license(_ACTIVE)
        seen = []
        monkeypatch.setattr(
            cc,
            "compress_context",
            lambda agent, messages, system_message, **kwargs: seen.append(messages) or ([], "sys"),
        )
        monkeypatch.setattr(cc, "resolve_context_compression_timeouts", lambda: (0, 0))

        assert AIAgent._compress_context(_Agent(), [{"role": "user", "content": "a"}], "sys") == ([], "sys")
        assert len(seen) == 1
