"""A 400 blaming fields the request never carried is retried, not fatal.

OpenRouter adds ``context_length_exceeded_behavior`` and ``prompt_cache_key``
to its own call to some providers, and GMICloud rejects both.  Through the
AgentX AI Gateway (a LiteLLM proxy) that reached Workmate as a 400, which the
loop treated as a deterministic format_error, so the turn died although the
identical request succeeds on the next provider OpenRouter picks.

The loop now hands the classifier the request that failed: when the body shows
neither field was ours, the same request is retried; when it carried one of
them, the rejection is ours and the turn still ends without a retry.
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import httpx
import openai
import pytest

from agent import conversation_loop as _conv_loop
from run_agent import AIAgent

GATEWAY = "https://aigw.example.test/v1"
MODEL = "z-ai/glm-5.3-flash"
REJECTED = "Validation: Unsupported parameter(s): `context_length_exceeded_behavior`, `prompt_cache_key`"


def _gmicloud_rejection() -> openai.BadRequestError:
    """The SDK error Workmate gets when the gateway relays GMICloud's 400
    (the shape the production LiteLLM build returns)."""
    raw = json.dumps(
        {"error": {"type": "Bad Request", "message": REJECTED, "backend_status": 400,
                   "details": f"Bad Request: {REJECTED}"}},
        separators=(",", ":"),
    )
    upstream = json.dumps(
        {"error": {"message": "Provider returned error", "code": 400,
                   "metadata": {"raw": raw, "provider_name": "GMICloud", "is_byok": False}},
         "user_id": "user_test"},
        separators=(",", ":"),
    )
    body = {
        "message": f"litellm.BadRequestError: OpenrouterException - {upstream}\n\n"
                   f"LiteLLM: model group '{MODEL}' failed with the error above. "
                   "No fallback was attempted.",
        "type": "invalid_request_error",
        "param": None,
        "code": "400",
    }
    response = httpx.Response(
        400,
        request=httpx.Request("POST", f"{GATEWAY}/chat/completions"),
        json={"error": body},
    )
    return openai.BadRequestError(f"Error code: 400 - {dict(error=body)}", response=response, body=body)


def _answer(content: str) -> SimpleNamespace:
    message = SimpleNamespace(content=content, tool_calls=None)
    return SimpleNamespace(
        choices=[SimpleNamespace(message=message, finish_reason="stop")],
        model=MODEL,
        usage=None,
    )


def _fast_time() -> MagicMock:
    """A time module whose backoff waits end at once."""
    mock_time = MagicMock()
    now = [1000.0]

    def _advance():
        now[0] += 500.0
        return now[0]

    mock_time.time.side_effect = _advance
    mock_time.sleep = MagicMock()
    mock_time.monotonic.return_value = 12345.0
    return mock_time


@pytest.fixture()
def agent():
    """Workmate's model route: the AgentX AI Gateway as provider ``litellm``."""
    tools = [{"type": "function",
              "function": {"name": "read_file", "description": "read_file tool",
                           "parameters": {"type": "object", "properties": {}}}}]
    with (
        patch("run_agent.get_tool_definitions", return_value=tools),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        a = AIAgent(
            api_key="sk-test-1234567890",
            base_url=GATEWAY,
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
        )
    a.client = MagicMock()
    a.provider = "litellm"
    a.model = MODEL
    a.api_mode = "chat_completions"
    a._cached_system_prompt = "You are helpful."
    a._use_prompt_caching = False
    a.compression_enabled = False
    a.save_trajectories = False
    return a


def _run(agent):
    with (
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
        patch.object(agent, "_compress_context") as compress,
        patch("run_agent.time", _fast_time()),
        patch.object(_conv_loop, "time", _fast_time()),
        patch.object(_conv_loop, "jittered_backoff", lambda *a, **k: 0.0),
    ):
        result = agent.run_conversation("hello")
    return result, agent.client.chat.completions.create.call_args_list, compress


def test_relayed_rejection_of_fields_never_sent_is_retried(agent):
    agent.client.chat.completions.create.side_effect = [_gmicloud_rejection(), _answer("done")]

    result, calls, compress = _run(agent)

    assert result["completed"] is True
    assert result["final_response"] == "done"
    assert len(calls) == 2
    first, retry = calls[0].kwargs, calls[1].kwargs
    # The request really carried neither field, and the retry is the same request.
    for field in ("prompt_cache_key", "context_length_exceeded_behavior"):
        assert field not in first
        assert field not in (first.get("extra_body") or {})
    assert retry == first
    compress.assert_not_called()


def test_rejection_of_a_field_the_request_carried_ends_the_turn(agent):
    """Boundary: a body that did carry ``prompt_cache_key`` owns the rejection —
    an identical retry would fail the same way, so the turn ends at once."""
    agent.request_overrides = {"prompt_cache_key": "pinned-cache-key"}
    agent.client.chat.completions.create.side_effect = [_gmicloud_rejection(), _answer("unreachable")]

    result, calls, compress = _run(agent)

    assert len(calls) == 1
    assert calls[0].kwargs["prompt_cache_key"] == "pinned-cache-key"
    assert result["completed"] is False
    assert result["failed"] is True
    assert "Unsupported parameter(s)" in result["error"]
    compress.assert_not_called()
