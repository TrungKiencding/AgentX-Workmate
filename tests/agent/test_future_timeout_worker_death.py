"""TimeoutError from a settled worker must never be treated as a polling timeout."""

import threading
from unittest.mock import MagicMock

import pytest

from agent.conversation_compression import (
    CompressionCommitFence,
    run_compress_context_with_progress_timeout,
)

pytestmark = pytest.mark.timeout(5)


def _run(worker, **kwargs):
    return run_compress_context_with_progress_timeout(
        worker=worker, messages=[{"role": "user", "content": "keep me"}],
        system_prompt_fallback="fallback", idle_timeout_seconds=0.2,
        total_ceiling_seconds=1.0, **kwargs,
    )


@pytest.mark.parametrize("exc", [TimeoutError("stalled"), __import__("asyncio").TimeoutError("stalled")])
def test_dead_summary_worker_takes_fallback_without_repolling(exc, caplog):
    def worker(fence):
        raise exc

    with caplog.at_level("INFO", logger="agent.conversation_compression"):
        messages, prompt = _run(worker)
    assert messages == [{"role": "user", "content": "keep me"}]
    assert prompt == "fallback"
    assert not any("still streaming" in record.message for record in caplog.records)


def test_non_timeout_worker_failure_propagates():
    def worker(fence):
        raise ValueError("boom")

    with pytest.raises(ValueError, match="boom"):
        _run(worker)


def test_commit_wait_surfaces_worker_timeout(monkeypatch):
    # Exercise the losing-cancellation branch after a commit has won admission.
    monkeypatch.setattr(CompressionCommitFence, "try_cancel_before_commit", lambda self: False)

    def worker(fence):
        raise TimeoutError("commit stalled")

    with pytest.raises(TimeoutError, match="commit stalled"):
        _run(worker)


def test_sequential_tool_surfaces_worker_timeout(monkeypatch):
    import agent.tool_executor as executor

    monkeypatch.setattr(executor, "_resolve_concurrent_tool_timeout", lambda: 30.0)

    def worker(*args, **kwargs):
        raise TimeoutError("tool stalled")

    monkeypatch.setattr(executor, "_run_agent_tool_execution_middleware", worker)
    agent = MagicMock()
    agent._interrupt_requested = False
    agent._tool_worker_threads = set()
    agent._tool_worker_threads_lock = threading.Lock()
    with pytest.raises(TimeoutError, match="tool stalled"):
        executor._run_sequential_tool_execution_middleware(
            agent, function_name="terminal", function_args={},
            effective_task_id="timeout-regression", tool_call_id="call", execute=lambda args: None,
        )
    assert not agent._tool_worker_threads
