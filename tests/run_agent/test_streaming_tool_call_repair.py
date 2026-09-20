"""Tests for tool call argument repair in the streaming assembly path.

The streaming path (run_agent._call_chat_completions) assembles tool call
deltas into full arguments.  When a model truncates or malforms the JSON
(e.g. GLM-5.1 via Ollama), the assembly path used to pass the broken JSON
straight through — setting has_truncated_tool_args but NOT repairing it.
That triggered the truncation handler to kill the session with /new required.

The fix: repair arguments in the streaming assembly path using
_repair_tool_call_arguments() so repairable malformations (trailing commas,
unclosed brackets, Python None) don't kill the session.
"""

import json

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from run_agent import AIAgent, _repair_tool_call_arguments


@pytest.mark.parametrize("raw, repaired", [
    ('{"edits": [{"path": "a.py", "mode": "w"}, {"path": "b.py", "mode": "w"}}', True),
    ('{"q": "unterminated string', False),
])
def test_streaming_assembly_repairs_structure_without_guessing_string_content(raw, repaired):
    tool_delta = SimpleNamespace(
        index=0, id="call_1", type="function",
        function=SimpleNamespace(name="edit", arguments=raw),
    )
    chunk = SimpleNamespace(
        choices=[SimpleNamespace(
            index=0,
            delta=SimpleNamespace(content=None, tool_calls=[tool_delta],
                                  reasoning_content=None, reasoning=None),
            finish_reason="tool_calls",
        )], model="test/model", usage=None,
    )
    client = MagicMock()
    client.chat.completions.create.return_value = iter([chunk])
    agent = AIAgent(api_key="test-key", base_url="https://openrouter.ai/api/v1",
                    model="test/model", quiet_mode=True,
                    skip_context_files=True, skip_memory=True)
    agent.api_mode = "chat_completions"
    with patch.object(agent, "_create_request_openai_client", return_value=client), \
            patch.object(agent, "_close_request_openai_client"):
        response = agent._interruptible_streaming_api_call({})
    call = response.choices[0].message.tool_calls[0]
    if repaired:
        assert response.choices[0].finish_reason == "tool_calls"
        assert json.loads(call.function.arguments) == {
            "edits": [{"path": "a.py", "mode": "w"}, {"path": "b.py", "mode": "w"}],
        }
    else:
        assert response.choices[0].finish_reason == "length"
        assert call.function.arguments == raw


class TestStreamingAssemblyRepair:
    """Verify that _repair_tool_call_arguments is applied to streaming tool
    call arguments before they're assembled into mock_tool_calls.

    These tests verify the REPAIR FUNCTION itself works correctly for the
    cases that arise during streaming assembly.  Integration tests that
    exercise the full streaming path are in run_agent.py's streaming tests.
    """

    # -- Truncation cases (most common streaming failure) --

    def test_truncated_object_no_close_brace(self):
        """Model stops mid-JSON, common with output length limits."""
        raw = '{"command": "ls -la", "timeout": 30'
        result = _repair_tool_call_arguments(raw, "terminal")
        parsed = json.loads(result)
        assert parsed["command"] == "ls -la"
        assert parsed["timeout"] == 30



    # -- Trailing comma cases (Ollama/GLM common) --



    # -- Python None from model output --


    # -- Empty arguments (some models emit empty string) --

    def test_empty_string(self):
        assert _repair_tool_call_arguments("", "test") == "{}"


    # -- Already-valid JSON passes through unchanged --


    # -- Extra closing brackets (rare but happens) --


    # -- Real-world GLM-5.1 truncation pattern --


