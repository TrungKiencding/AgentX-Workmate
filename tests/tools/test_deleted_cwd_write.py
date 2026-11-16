"""A process whose working directory was deleted can still write files.

Pilot feedback 2026-11 (Telegram): a reply ended with "⚠️ File-mutation
verifier: 2 file(s) were NOT modified … [write_file] [Errno 2] No such file or
directory". The files HAD been written. The messaging gateway had outlived the
checkout it was started from (an app upgrade removes it), so ``os.getcwd()``
raised — a bare errno with no filename — inside the post-write LSP check, and
the tool reported that as its own failure.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile

import pytest

import hermes_constants


@pytest.fixture
def deleted_cwd(tmp_path, monkeypatch):
    """Run with the process parked in a directory that no longer exists."""
    monkeypatch.setenv("AGENTX_HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    monkeypatch.delenv("TERMINAL_CWD", raising=False)
    original = os.getcwd()
    doomed = tempfile.mkdtemp(prefix="doomed-cwd-")
    os.chdir(doomed)
    shutil.rmtree(doomed)
    with pytest.raises(OSError):
        os.getcwd()
    try:
        yield tmp_path
    finally:
        os.chdir(original)


def test_write_file_succeeds_and_says_so_from_a_deleted_cwd(deleted_cwd):
    from tools.file_tools import write_file_tool

    target = deleted_cwd / "verify_tools.py"

    result = json.loads(write_file_tool(str(target), "print('hi')\n", task_id="deleted-cwd"))

    assert "error" not in result, result
    assert target.read_text() == "print('hi')\n"


def test_safe_getcwd_falls_back_instead_of_raising(deleted_cwd, monkeypatch):
    assert hermes_constants.safe_getcwd() == os.path.expanduser("~")

    monkeypatch.setenv("TERMINAL_CWD", str(deleted_cwd))
    assert hermes_constants.safe_getcwd() == str(deleted_cwd)

    # A TERMINAL_CWD that is itself gone is no fallback.
    monkeypatch.setenv("TERMINAL_CWD", str(deleted_cwd / "missing"))
    assert hermes_constants.safe_getcwd() == os.path.expanduser("~")


def test_heal_moves_the_process_to_a_directory_that_exists(deleted_cwd):
    moved_to = hermes_constants.heal_working_directory()

    assert moved_to is not None
    assert os.path.samefile(os.getcwd(), moved_to)
    # Healed: a second call has nothing to do.
    assert hermes_constants.heal_working_directory() is None


def test_heal_leaves_a_healthy_cwd_alone(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    assert hermes_constants.heal_working_directory() is None
    assert os.path.samefile(os.getcwd(), tmp_path)


def test_tool_dispatch_heals_the_cwd_before_running_the_tool(deleted_cwd):
    """Every tool, not just write_file: relative paths and getcwd are everywhere."""
    import model_tools

    target = deleted_cwd / "from-dispatch.txt"
    raw = model_tools.handle_function_call(
        "write_file", {"path": str(target), "content": "ok\n"}, task_id="deleted-cwd-dispatch"
    )

    assert "No such file or directory" not in raw
    assert target.read_text() == "ok\n"
    os.getcwd()  # no longer raises


def test_local_environment_resolves_its_cwd_from_a_deleted_one(deleted_cwd):
    from tools.environments.local import _resolve_local_initial_cwd

    # No configured cwd: the fallback, not an exception.
    assert _resolve_local_initial_cwd("") == os.path.expanduser("~")
    # A relative one is anchored somewhere real.
    assert os.path.isabs(_resolve_local_initial_cwd("workspace"))
