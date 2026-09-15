"""Search argument normalization through the registered handler."""

import pytest
import tools.file_tools  # register built-in handlers
from tools.registry import registry


@pytest.mark.parametrize("target", ["content", "files"])
@pytest.mark.parametrize("blank_path", ["", " \t "])
def test_handler_normalizes_blank_path_to_current_directory(monkeypatch, target, blank_path):
    captured = {}

    def fake_search_tool(**kwargs):
        captured.update(kwargs)
        return "{}"

    monkeypatch.setattr("tools.file_tools.search_tool", fake_search_tool)

    registry.dispatch("search_files", {"pattern": "needle", "target": target, "path": blank_path})

    assert captured["target"] == target
    assert captured["path"] == "."


def test_handler_preserves_nonblank_path(monkeypatch):
    captured = {}

    def fake_search_tool(**kwargs):
        captured.update(kwargs)
        return "{}"

    monkeypatch.setattr("tools.file_tools.search_tool", fake_search_tool)

    registry.dispatch("search_files", {"pattern": "needle", "path": "src"})

    assert captured["path"] == "src"


