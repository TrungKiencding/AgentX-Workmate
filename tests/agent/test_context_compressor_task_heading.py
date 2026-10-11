"""The iterative-update instruction must name the heading the template emits."""

from unittest.mock import MagicMock, patch

from agent.context_compressor import (
    ContextCompressor,
    HISTORICAL_TASK_HEADING,
    _HISTORICAL_TASK_SECTION_RE,
)


def _iterative_prompt() -> str:
    """The prompt built when a previous summary exists (the update path)."""
    with patch("agent.context_compressor.get_model_context_length", return_value=100000):
        compressor = ContextCompressor(model="test/model", quiet_mode=True)
    compressor._previous_summary = "PREVIOUS SUMMARY BODY"
    response = MagicMock()
    response.choices[0].message.content = "Updated summary"
    with patch("agent.context_compressor.call_llm", return_value=response) as call:
        compressor._generate_summary([
            {"role": "user", "content": "do X"},
            {"role": "assistant", "content": "I will do X"},
        ])
    return call.call_args.kwargs["messages"][-1]["content"]


def test_update_instruction_names_the_emitted_heading():
    prompt = _iterative_prompt()
    assert f'Update "{HISTORICAL_TASK_HEADING}"' in prompt
    assert '"## Active Task"' not in prompt


def test_grounding_prepends_when_the_task_heading_differs():
    """Why the names must agree: a foreign heading yields two task sections."""
    body = "## Active Task\nUser asked: 'do X'\n\n## Goal\nthing\n"
    assert _HISTORICAL_TASK_SECTION_RE.search(body) is None

    grounded = ContextCompressor._ground_historical_task_snapshot.__func__(
        ContextCompressor, body, [{"role": "user", "content": "do X"}]
    )
    headings = [line for line in grounded.splitlines() if line.startswith("## ")]
    assert headings.count(HISTORICAL_TASK_HEADING) == 1
    assert "## Active Task" in headings
