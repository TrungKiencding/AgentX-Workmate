"""CLI dispatch for /export (session history) and the profile-sharing pair
/export-profile + /import.

Both exports used to register as ``/export``: the session handler won the
dispatch while the profile one only showed up — twice — in help and in the
TUI/desktop catalog. These pin which handler each name reaches.
"""

import json
from unittest.mock import MagicMock, patch

import cli as cli_mod
from cli import HermesCLI

_EXPORT = {
    "id": "sess-export",
    "title": "Quarterly plan",
    "messages": [
        {"role": "user", "content": "Draft the plan"},
        {"role": "assistant", "content": "Here it is"},
    ],
}


def _make_cli(monkeypatch, tmp_path):
    """A bare CLI whose cwd is an empty folder (tmp_path also holds the test home)."""
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    monkeypatch.chdir(cwd)
    printed: list[str] = []
    monkeypatch.setattr(cli_mod, "_cprint", printed.append)
    cli_obj = HermesCLI.__new__(HermesCLI)
    cli_obj.session_id = "sess-export"
    cli_obj._session_db = MagicMock()
    cli_obj._session_db.export_session.return_value = _EXPORT
    return cli_obj, cwd, printed


def test_bare_export_writes_session_markdown(monkeypatch, tmp_path):
    cli_obj, cwd, printed = _make_cli(monkeypatch, tmp_path)

    with patch("hermes_cli.profiles.export_profile") as export_profile:
        assert cli_obj.process_command("/export") is True

    export_profile.assert_not_called()
    cli_obj._session_db.export_session.assert_called_once_with("sess-export")
    body = (cwd / "session_sess-export.md").read_text(encoding="utf-8")
    assert body.startswith("# Session Export: sess-export")
    assert "## User\n\nDraft the plan" in body
    assert printed == ["  Session exported successfully to session_sess-export.md"]


def test_export_json_writes_the_raw_export(monkeypatch, tmp_path):
    cli_obj, cwd, _ = _make_cli(monkeypatch, tmp_path)

    cli_obj.process_command("/export json")

    written = (cwd / "session_sess-export.json").read_text(encoding="utf-8")
    assert json.loads(written) == _EXPORT


def test_export_keeps_the_filename_the_user_typed(monkeypatch, tmp_path):
    cli_obj, cwd, _ = _make_cli(monkeypatch, tmp_path)

    cli_obj.process_command("/export md Plan-Notes.md")
    cli_obj.process_command("/export Board.MD")

    assert sorted(p.name for p in cwd.iterdir()) == ["Board.MD", "Plan-Notes.md"]
    assert (cwd / "Board.MD").read_text(encoding="utf-8").startswith("# Session Export")


def test_export_profile_exports_the_active_profile(monkeypatch, tmp_path, capsys):
    cli_obj, _, _ = _make_cli(monkeypatch, tmp_path)

    with patch("hermes_cli.profiles.get_active_profile_name", return_value="work"), patch(
        "hermes_cli.profiles.export_profile", return_value=tmp_path / "work.tar.gz"
    ) as export_profile:
        assert cli_obj.process_command("/export-profile") is True

    export_profile.assert_called_once_with("work", "work.tar.gz")
    cli_obj._session_db.export_session.assert_not_called()
    assert "Exported 'work'" in capsys.readouterr().out


def test_export_profile_takes_a_name_and_output_path(monkeypatch, tmp_path):
    cli_obj, _, _ = _make_cli(monkeypatch, tmp_path)

    with patch(
        "hermes_cli.profiles.export_profile", return_value=tmp_path / "research.tar.gz"
    ) as export_profile:
        cli_obj.process_command("/export-profile research -o shared/research.tar.gz")

    export_profile.assert_called_once_with("research", "shared/research.tar.gz")


def test_export_profile_without_output_path_prints_usage(monkeypatch, tmp_path, capsys):
    cli_obj, _, _ = _make_cli(monkeypatch, tmp_path)

    with patch("hermes_cli.profiles.export_profile") as export_profile:
        cli_obj.process_command("/export-profile research -o")

    export_profile.assert_not_called()
    assert "Usage: /export-profile [profile] [-o output.tar.gz]" in capsys.readouterr().out


def test_import_still_imports_a_profile_archive(monkeypatch, tmp_path):
    cli_obj, _, _ = _make_cli(monkeypatch, tmp_path)

    with patch(
        "hermes_cli.profiles.import_profile", return_value=tmp_path / "profiles" / "shared"
    ) as import_profile, patch("hermes_cli.profiles.check_alias_collision", return_value=True):
        cli_obj.process_command("/import team.tar.gz --name shared")

    import_profile.assert_called_once_with("team.tar.gz", name="shared")
