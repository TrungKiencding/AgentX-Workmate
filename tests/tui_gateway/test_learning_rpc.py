"""``learning.delete`` / ``learning.edit`` over the gateway (the TUI ``/journey``
overlay). The overlay mutates the timeline it loaded, and once an earlier memory
is deleted that timeline's positional ids name the next entry. Sent with the
row's ``entry`` text, a mutation lands on that entry or fails with MemoryStore's
``code``; without it, the id resolves by position as before."""

from __future__ import annotations

import pytest

import tui_gateway.server as server
from hermes_constants import get_hermes_home
from tools.memory_tool import MemoryStore


def _call(method: str, **params) -> dict:
    response = server._methods[method]("r1", params)
    assert "error" not in response, response.get("error")
    return response["result"]


def _rows() -> dict[str, dict]:
    """The timeline rows the overlay walks, by node id."""
    frames = _call("learning.frames", cols=80, rows=24, frames=2)
    return {node["id"]: node for bucket in frames["buckets"] for node in bucket["nodes"]}


@pytest.fixture
def memory_file():
    path = get_hermes_home() / "memories" / "MEMORY.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    MemoryStore._write_file(path, ["first", "second", "third"])
    return path


def test_deleting_two_rows_of_one_timeline_removes_exactly_those(memory_file):
    rows = _rows()

    for node_id in ("memory:memory:0", "memory:memory:1"):
        assert _call("learning.delete", id=node_id, entry=rows[node_id]["entry"])["ok"]

    # By id alone the second delete would have removed "third".
    assert MemoryStore._read_file(memory_file) == ["third"]


def test_an_edit_to_an_entry_changed_since_the_timeline_loaded_fails_as_missing(memory_file):
    rows = _rows()
    MemoryStore._write_file(memory_file, ["first", "second, per the agent", "third"])

    res = _call("learning.edit", id="memory:memory:1", content="second, per the user", entry=rows["memory:memory:1"]["entry"])

    assert (res["ok"], res["code"]) == (False, "missing")
    assert MemoryStore._read_file(memory_file) == ["first", "second, per the agent", "third"]


def test_without_entry_the_id_still_resolves_by_position(memory_file):
    assert _call("learning.edit", id="memory:memory:1", content="second, revised")["ok"]
    assert _call("learning.delete", id="memory:memory:0")["ok"]

    assert MemoryStore._read_file(memory_file) == ["second, revised", "third"]
