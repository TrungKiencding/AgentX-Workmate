"""The background review never asks the user for a skill's missing API key.

The review thread runs after the turn ended. A ``skill_view`` of a skill whose required env var is
missing inside the review must resolve to "skipped" instead of opening the masked "enter value"
prompt (the desktop's secret.request overlay, the CLI's prompt) on the user's screen.
"""

from unittest.mock import patch

from tests.run_agent.test_background_review_toolset_restriction import _make_agent_stub, _SyncThread
from tools import skills_tool
from tools.skills_tool import _capture_required_environment_variables

_MISSING = [{"name": "LINEAR_API_KEY", "prompt": "Enter value for LINEAR_API_KEY"}]


def _viewer_prompt(calls):
    def prompt(var_name, prompt, metadata=None):
        calls.append(var_name)
        return {"success": True, "stored_as": var_name, "validated": False, "skipped": False}
    return prompt


def _run_review_that_opens_skill():
    """Spawn a background review whose fork loads a skill with a missing key; return that result."""
    import run_agent

    results = []

    def _fork_init(self, *args, **kwargs):
        results.append(_capture_required_environment_variables("linear", _MISSING))
        raise RuntimeError("stop after the skill load")

    agent = _make_agent_stub(run_agent.AIAgent)
    with patch.object(run_agent.AIAgent, "__init__", _fork_init), patch("threading.Thread", _SyncThread):
        agent._spawn_background_review(messages_snapshot=[], review_memory=False, review_skills=True)
    assert len(results) == 1, "the review fork did not run"
    return results[0]


def test_review_does_not_use_the_process_secret_prompt(monkeypatch):
    calls = []
    monkeypatch.setattr(skills_tool, "_secret_capture_callback", _viewer_prompt(calls))
    monkeypatch.setattr(skills_tool, "_is_gateway_surface", lambda: False)

    result = _run_review_that_opens_skill()

    assert calls == []
    assert result["missing_names"] == ["LINEAR_API_KEY"]
    assert result["setup_skipped"] is True


def test_live_turn_still_prompts_for_the_key(monkeypatch):
    """Control: outside the review the same skill load still reaches the viewer's prompt."""
    calls = []
    monkeypatch.setattr(skills_tool, "_secret_capture_callback", _viewer_prompt(calls))
    monkeypatch.setattr(skills_tool, "_is_gateway_surface", lambda: False)

    result = _capture_required_environment_variables("linear", _MISSING)

    assert calls == ["LINEAR_API_KEY"]
    assert result["missing_names"] == []


def test_a_bound_capture_wins_over_the_process_slot(monkeypatch):
    process_calls, bound_calls = [], []
    monkeypatch.setattr(skills_tool, "_secret_capture_callback", _viewer_prompt(process_calls))
    with skills_tool.bind_turn_secret_capture(_viewer_prompt(bound_calls)):
        _capture_required_environment_variables("linear", _MISSING)
    assert (process_calls, bound_calls) == ([], ["LINEAR_API_KEY"])
    assert skills_tool._turn_secret_capture.get() is None
