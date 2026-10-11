"""Search argument normalization through the registered handler."""

import pytest
import tools.file_tools  # register built-in handlers
from tools.registry import registry


@pytest.mark.parametrize("target", ["content", "files"])
@pytest.mark.parametrize("blank_path", ["", " \t ", None])
def test_handler_normalizes_blank_path_to_current_directory(monkeypatch, target, blank_path):
    """#112424: a present-but-blank (or null) path must fall back to the documented '.' default."""
    captured = {}

    def fake_search_tool(**kwargs):
        captured.update(kwargs)
        return "{}"

    monkeypatch.setattr("tools.file_tools.search_tool", fake_search_tool)

    registry.dispatch("search_files", {"pattern": "needle", "target": target, "path": blank_path})

    assert captured["target"] == target
    assert captured["path"] == "."


@pytest.mark.parametrize("raw_path", ["src", 5, ["src"]])
def test_handler_preserves_nonblank_path(monkeypatch, raw_path):
    """Only None/blank normalise to '.'; a wrong-typed path reaches search_tool's own error path."""
    captured = {}

    def fake_search_tool(**kwargs):
        captured.update(kwargs)
        return "{}"

    monkeypatch.setattr("tools.file_tools.search_tool", fake_search_tool)

    registry.dispatch("search_files", {"pattern": "needle", "path": raw_path})

    assert captured["path"] == raw_path




def test_blank_search_paths_read_real_workspace(tmp_path, monkeypatch):
    import json
    from tools.file_tools import reset_file_dedup
    from tools.terminal_tool import cleanup_all_environments

    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home.mkdir()
    workspace.mkdir()
    (workspace / "sample.txt").write_text("agentx_normalized_path\n", encoding="utf-8")
    (home / "config.yaml").write_text("terminal:\n  env_type: local\n", encoding="utf-8")
    monkeypatch.setenv("AGENTX_HOME", str(home))
    monkeypatch.setenv("TERMINAL_ENV", "local")
    monkeypatch.setenv("TERMINAL_CWD", str(workspace))
    try:
        for blank in ("", " \t ", None):
            reset_file_dedup()
            result = json.loads(registry.dispatch("search_files", {
                "pattern": "agentx_normalized_path", "target": "content", "path": blank,
            }))
            assert "error" not in result, result
            assert result["matches"], result
            assert any("agentx_normalized_path" in item["content"] for item in result["matches"])
    finally:
        cleanup_all_environments()
        reset_file_dedup()
