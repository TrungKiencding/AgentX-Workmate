"""Behavior contracts for journey node edit/delete (agent.learning_mutations).

Exercises the real on-disk resolution (skills dir + MEMORY.md/USER.md chunking)
against a temp AGENTX_HOME, never mocks — the id→file mapping is the whole point.
"""

from __future__ import annotations

import pytest

from agent import learning_mutations as lm
from hermes_constants import get_hermes_home

_SKILL = """---
name: my-skill
description: A test skill.
---

# My Skill

Body.
"""


@pytest.fixture
def home():
    base = get_hermes_home()
    (base / "memories").mkdir(parents=True, exist_ok=True)
    (base / "memories" / "MEMORY.md").write_text("alpha note\nline two\n§\nbeta note", encoding="utf-8")
    (base / "memories" / "USER.md").write_text("user profile note", encoding="utf-8")
    skill = base / "skills" / "my-skill"
    skill.mkdir(parents=True, exist_ok=True)
    (skill / "SKILL.md").write_text(_SKILL, encoding="utf-8")
    return base


def test_parse_node_kind():
    assert lm.parse_node_kind("memory:memory:0") == "memory"
    assert lm.parse_node_kind("memory:profile:3") == "memory"
    assert lm.parse_node_kind("debugging-agentx") == "skill"








def test_edit_memory_replaces_chunk(home):
    assert lm.edit_node("memory:profile:2", "rewritten profile")["ok"]
    assert (home / "memories" / "USER.md").read_text(encoding="utf-8").strip() == "rewritten profile"








def test_skill_detail_returns_skill_md(home):
    d = lm.node_detail("my-skill")
    assert d["ok"] and d["kind"] == "skill"
    assert "name: my-skill" in d["content"]




def test_delete_pinned_skill_refused(home):
    from tools import skill_usage

    skill_usage.set_pinned("my-skill", True)
    res = lm.delete_node("my-skill")
    assert not res["ok"]
    assert "pinned" in res["message"]
    assert (home / "skills" / "my-skill").exists()






def test_memory_writes_match_memory_tool_format(home):
    """A journey mutation must leave the file byte-identical to what the memory
    tool itself writes — same §-join, no trailing-newline drift — so the two
    surfaces never fight over format and indices stay aligned."""
    from tools.memory_tool import ENTRY_DELIMITER, MemoryStore

    assert lm.edit_node("memory:memory:0", "alpha rewritten")["ok"]
    path = home / "memories" / "MEMORY.md"
    entries = MemoryStore._read_file(path)

    assert entries == ["alpha rewritten", "beta note"]
    assert path.read_text(encoding="utf-8") == ENTRY_DELIMITER.join(entries)


def _shown(graph):
    """Memory node id → the exact entry text its card carries, as the star map holds them."""
    return {f"memory:{card['source']}:{i}": card["entry"] for i, card in enumerate(graph["memory"])}


def test_deleting_two_memory_nodes_in_a_row_removes_exactly_those(home):
    """The star map deletes from the graph it loaded: once the first delete
    lands, every later positional id in that file points one entry too far.
    Sent with the text its card showed, each delete still removes that entry —
    by id alone the second would have removed "fourth"."""
    from agent.learning_graph import build_learning_graph
    from tools.memory_tool import MemoryStore

    path = home / "memories" / "MEMORY.md"
    MemoryStore._write_file(path, ["first", "second", "third", "fourth"])
    shown = _shown(build_learning_graph())
    assert [shown["memory:memory:1"], shown["memory:memory:2"]] == ["second", "third"]

    for node_id in ("memory:memory:1", "memory:memory:2"):
        assert lm.delete_node(node_id, shown[node_id])["ok"]

    assert MemoryStore._read_file(path) == ["first", "fourth"]
    assert (home / "memories" / "USER.md").read_text(encoding="utf-8") == "user profile note"


def test_memory_delete_by_entry_refuses_an_entry_changed_elsewhere(home):
    """If the entry a node showed was rewritten since the graph loaded, the
    delete fails as ``missing`` and leaves the file alone — it never falls
    through to whatever now sits at the node's index."""
    from tools.memory_tool import MemoryStore

    path = home / "memories" / "MEMORY.md"
    MemoryStore._write_file(path, ["alpha note, revised", "beta note"])

    res = lm.delete_node("memory:memory:0", "alpha note\nline two")

    assert not res["ok"] and res["code"] == "missing"
    assert MemoryStore._read_file(path) == ["alpha note, revised", "beta note"]


def test_memory_edit_by_entry_follows_the_entry_not_the_index(home):
    """Once an earlier entry is deleted, a node's old id is out of range or
    names its neighbour; the edit still rewrites the entry it showed, in the
    file its source names."""
    from tools.memory_tool import MemoryStore

    assert lm.delete_node("memory:memory:0", "alpha note\nline two")["ok"]
    # Both ids below date from before that delete.
    assert lm.edit_node("memory:memory:1", "beta rewritten", "beta note")["ok"]
    assert lm.edit_node("memory:profile:2", "profile rewritten", "user profile note")["ok"]

    assert MemoryStore._read_file(home / "memories" / "MEMORY.md") == ["beta rewritten"]
    assert MemoryStore._read_file(home / "memories" / "USER.md") == ["profile rewritten"]
