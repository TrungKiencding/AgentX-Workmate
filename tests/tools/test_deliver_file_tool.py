"""Tests for the desktop-gated ``deliver_file`` tool."""

import json
import os
import stat as stat_module

import pytest

from tools import deliver_file_tool as df
from tools.registry import registry


@pytest.fixture()
def home(tmp_path, monkeypatch):
    """A private $HOME so the media denylist (``~/.ssh`` …) resolves inside tmp."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("TERMINAL_CWD", raising=False)
    return tmp_path


def _write(path, content=b"hello"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


def test_gated_on_desktop(monkeypatch):
    """Hidden unless AGENTX_DESKTOP is set (mirrors open_preview / react_to_message)."""
    monkeypatch.delenv("AGENTX_DESKTOP", raising=False)
    assert df.check_deliver_file_requirements() is False

    monkeypatch.setenv("AGENTX_DESKTOP", "1")
    assert df.check_deliver_file_requirements() is True


def test_registered_with_desktop_gate():
    entry = registry.get_entry("deliver_file")
    assert entry is not None
    assert entry.schema["name"] == "deliver_file"
    assert entry.check_fn is df.check_deliver_file_requirements
    assert "path" in entry.schema["parameters"]["required"]


def test_delivers_a_real_file_with_identity(home):
    target = _write(home / "Documents" / "report.docx", b"PK\x03\x04" + b"x" * 40)

    result = json.loads(df.deliver_file_tool(str(target), caption="  Q3   summary  "))

    assert result["success"] is True
    assert result["delivered"] is True
    assert result["path"] == str(target.resolve())
    assert result["name"] == "report.docx"
    assert result["size_bytes"] == 44
    assert result["mime_type"] == (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    # Whitespace runs collapse; the caption is one line.
    assert result["caption"] == "Q3 summary"
    assert result["modified_at"] == pytest.approx(target.stat().st_mtime)
    # The note keeps the model from echoing the path or a MEDIA: tag in prose.
    assert "MEDIA:" in result["note"]


def test_caption_is_bounded(home):
    target = _write(home / "out.pdf", b"%PDF-1.4 " + b"x" * 10)

    result = json.loads(df.deliver_file_tool(str(target), caption="c" * 500))

    assert len(result["caption"]) == df.MAX_CAPTION_CHARS


def test_quotes_and_tilde_are_accepted(home):
    _write(home / "notes.md", b"# hi")

    result = json.loads(df.deliver_file_tool("`~/notes.md`"))

    assert result["success"] is True
    assert result["path"] == str((home / "notes.md").resolve())
    assert result["mime_type"] == "text/markdown"


def test_relative_path_resolves_against_session_cwd(home, monkeypatch):
    workspace = home / "project"
    _write(workspace / "out" / "deck.pptx", b"PK" * 8)
    monkeypatch.setenv("TERMINAL_CWD", str(workspace))

    result = json.loads(df.deliver_file_tool("out/deck.pptx"))

    assert result["success"] is True
    assert result["path"] == str((workspace / "out" / "deck.pptx").resolve())


def test_missing_path_argument():
    assert "path is required" in json.loads(df.deliver_file_tool("  "))["error"]


def test_missing_file_names_the_path(home):
    result = json.loads(df.deliver_file_tool(str(home / "nope.pdf")))

    assert "No file at" in result["error"]
    assert str(home / "nope.pdf") in result["error"]


def test_directory_is_refused(home):
    folder = home / "export"
    folder.mkdir()

    assert "folder" in json.loads(df.deliver_file_tool(str(folder)))["error"]


def test_empty_file_is_refused(home):
    target = _write(home / "empty.csv", b"")

    assert "empty" in json.loads(df.deliver_file_tool(str(target)))["error"]


def test_oversized_file_is_refused(home, monkeypatch):
    target = _write(home / "big.zip", b"z" * 64)
    monkeypatch.setattr(df, "MAX_DELIVER_BYTES", 32)

    assert "ceiling" in json.loads(df.deliver_file_tool(str(target)))["error"]


def test_credential_locations_are_blocked(home):
    """The same denylist gateway media delivery uses: ~/.ssh never leaves the machine."""
    key = _write(home / ".ssh" / "id_rsa", b"-----BEGIN OPENSSH PRIVATE KEY-----")

    result = json.loads(df.deliver_file_tool(str(key)))

    assert "cannot be delivered" in result["error"]


@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="permission bits need a non-root POSIX user")
def test_unreadable_file_is_refused(home):
    target = _write(home / "locked.txt", b"secret")
    target.chmod(0)
    try:
        assert "not readable" in json.loads(df.deliver_file_tool(str(target)))["error"]
    finally:
        target.chmod(stat_module.S_IRUSR | stat_module.S_IWUSR)


def test_mime_type_fallbacks():
    assert df.mime_type_for("/x/y.xlsx").endswith("spreadsheetml.sheet")
    assert df.mime_type_for("/x/y.csv") == "text/csv"
    assert df.mime_type_for("/x/y.unknownext") == "application/octet-stream"
    assert df.mime_type_for("/x/y.png") == "image/png"
