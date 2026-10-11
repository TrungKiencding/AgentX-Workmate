"""Immutable desktop code owns its update method, even with a legacy data home."""
from types import SimpleNamespace


def test_bundled_code_overrides_legacy_home_git_marker(tmp_path, monkeypatch):
    from hermes_cli.config import detect_install_method, recommended_update_command_for_method
    home = tmp_path / 'old-profile'
    code = tmp_path / 'app-runtime'
    home.mkdir()
    code.mkdir()
    (home / '.install_method').write_text('git\n')
    (code / '.install_method').write_text('bundled\n')
    monkeypatch.setenv('AGENTX_HOME', str(home))
    assert detect_install_method(code) == 'bundled'
    assert 'AgentX Workmate' in recommended_update_command_for_method('bundled')
    assert recommended_update_command_for_method('git') == 'agentx update'


def test_cli_update_and_check_leave_bundled_code_untouched(tmp_path, monkeypatch, capsys):
    from hermes_cli import update_cmd
    code = tmp_path / 'app-runtime'
    code.mkdir()
    marker = code / '.install_method'
    marker.write_text('bundled\n')
    monkeypatch.setattr(update_cmd, '_m', lambda: SimpleNamespace(PROJECT_ROOT=code))
    update_cmd._cmd_update_check()
    update_cmd._cmd_update_impl(SimpleNamespace(yes=True), gateway_mode=False)
    assert capsys.readouterr().out.count('AgentX Workmate') == 2
    assert list(code.iterdir()) == [marker]
    assert marker.read_text() == 'bundled\n'
