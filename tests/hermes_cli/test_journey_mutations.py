"""Behavior contracts for ``agentx journey delete|edit`` on memory nodes.

A memory node id is positional (``memory:<source>:<index>``). Between showing an
entry — at the confirm prompt, or in $EDITOR, which can stay open for minutes —
and writing it back, the agent can delete an earlier entry and shift every later
id. The CLI must still land on the entry it showed, or refuse. Runs the real CLI
wiring against the per-test AGENTX_HOME; only the editor and the prompt are
stood in for, and the agent's moves go through its own memory store.
"""

from __future__ import annotations

import argparse

import pytest

from hermes_constants import get_hermes_home
from tools.memory_tool import MemoryStore, load_on_disk_store


def _journey(*argv: str) -> int:
    from hermes_cli.journey import register_cli

    parser = argparse.ArgumentParser(add_help=False)
    register_cli(parser)
    args = parser.parse_args(list(argv))
    return args.func(args)


@pytest.fixture
def memory_file():
    path = get_hermes_home() / "memories" / "MEMORY.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    MemoryStore._write_file(path, ["first", "second", "third"])
    return path


def _agent_removes(text: str) -> None:
    assert load_on_disk_store().remove("memory", text)["success"]


def test_edit_lands_on_the_entry_shown_after_the_agent_shifts_ids_mid_edit(memory_file, monkeypatch):
    def editor(initial, *, suffix):
        assert initial == "second"
        _agent_removes("first")  # "third" now holds index 1
        return "second, revised"

    monkeypatch.setattr("hermes_cli.journey._open_in_editor", editor)

    assert _journey("edit", "memory:memory:1") == 0
    assert MemoryStore._read_file(memory_file) == ["second, revised", "third"]


def test_edit_refuses_an_entry_the_agent_rewrote_mid_edit(memory_file, monkeypatch, capsys):
    """By position the user's text would silently replace the agent's rewrite."""

    def editor(initial, *, suffix):
        assert load_on_disk_store().replace("memory", "second", "second, per the agent")["success"]
        return "second, per the user"

    monkeypatch.setattr("hermes_cli.journey._open_in_editor", editor)

    assert _journey("edit", "memory:memory:1") == 1
    assert "no longer in memory" in capsys.readouterr().out
    assert MemoryStore._read_file(memory_file) == ["first", "second, per the agent", "third"]


def test_delete_removes_the_entry_confirmed_after_the_agent_shifts_ids_at_the_prompt(memory_file, monkeypatch):
    def confirm(prompt):
        assert "'second'" in prompt
        _agent_removes("first")
        return "y"

    monkeypatch.setattr("builtins.input", confirm)

    assert _journey("delete", "memory:memory:1") == 0
    assert MemoryStore._read_file(memory_file) == ["third"]
