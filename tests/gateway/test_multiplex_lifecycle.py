"""Phase 4: lifecycle guard + per-profile observability."""
import pytest


class TestServedProfilesStatus:
    def test_write_and_read_served_profiles(self, tmp_path, monkeypatch):
        monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
        import importlib
        import gateway.status as status
        importlib.reload(status)
        try:
            status.write_runtime_status(
                gateway_state="running", served_profiles=["default", "coder"]
            )
            rec = status.read_runtime_status()
            assert rec.get("served_profiles") == ["default", "coder"]
        finally:
            importlib.reload(status)


class TestNamedProfileMultiplexerGuard:
    """_guard_named_profile_under_multiplexer is inert unless all conditions hold."""


    def test_force_bypasses(self, monkeypatch):
        from hermes_cli import gateway as gw
        # Even if it looks like a named profile, force returns immediately.
        monkeypatch.setattr(gw, "_profile_suffix", lambda: "coder")
        gw._guard_named_profile_under_multiplexer(force=True)

    def test_inert_when_no_default_gateway_running(self, monkeypatch, tmp_path):
        from hermes_cli import gateway as gw
        monkeypatch.setattr(gw, "_profile_suffix", lambda: "coder")
        monkeypatch.setattr(
            "hermes_constants.get_default_hermes_root", lambda: tmp_path
        )
        # No gateway.pid in tmp_path => no running default gateway => no raise.
        gw._guard_named_profile_under_multiplexer(force=False)

    def _fake_running_default_gateway(self, monkeypatch, tmp_path):
        """Make the guard believe a live default gateway exists at tmp_path."""
        from hermes_cli import gateway as gw
        import gateway.status as status

        monkeypatch.setattr(gw, "_profile_suffix", lambda: "coder")
        monkeypatch.setattr(
            "hermes_constants.get_default_hermes_root", lambda: tmp_path
        )
        (tmp_path / "gateway.pid").write_text("12345", encoding="utf-8")
        monkeypatch.setattr(status, "_read_pid_record", lambda p: {"pid": 12345})
        monkeypatch.setattr(status, "_pid_from_record", lambda rec: 12345)
        monkeypatch.setattr(status, "_pid_exists", lambda pid: True)




class TestMultiplexerGuardSignedIn:
    """Signed-in desktop: the account home is the person's default profile and
    its gateway is the multiplexer for the profiles inside that account."""

    @pytest.fixture()
    def layout(self, tmp_path, monkeypatch):
        from pathlib import Path

        from hermes_constants import get_default_hermes_root

        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "AppData" / "Local"))
        monkeypatch.delenv("AGENTX_HOME", raising=False)
        monkeypatch.delenv("GATEWAY_MULTIPLEX_PROFILES", raising=False)
        root = get_default_hermes_root()
        account = root / "accounts" / "xuan-1234abcd"
        (account / "profiles" / "work").mkdir(parents=True)
        return root, account

    def _multiplexer_running_at(self, monkeypatch, home):
        import gateway.status as status

        home.mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text(
            "gateway:\n  multiplex_profiles: true\n", encoding="utf-8"
        )
        pid_file = (home / "gateway.pid").resolve()
        pid_file.write_text("12345", encoding="utf-8")
        monkeypatch.setattr(
            status,
            "_read_pid_record",
            lambda p: {"pid": 12345} if p.resolve() == pid_file else None,
        )
        monkeypatch.setattr(status, "_pid_from_record", lambda rec: 12345)
        monkeypatch.setattr(status, "_pid_exists", lambda pid: True)

    def test_account_default_gateway_ignores_a_stale_root_multiplexer(
        self, layout, monkeypatch
    ):
        from hermes_cli import gateway as gw

        root, account = layout
        self._multiplexer_running_at(monkeypatch, root)
        monkeypatch.setenv("AGENTX_HOME", str(account))
        gw._guard_named_profile_under_multiplexer(force=False)  # must not exit

    def test_profile_inside_account_is_refused_under_the_account_multiplexer(
        self, layout, monkeypatch, capsys
    ):
        from hermes_cli import gateway as gw

        root, account = layout
        self._multiplexer_running_at(monkeypatch, account)
        monkeypatch.setenv("AGENTX_HOME", str(account / "profiles" / "work"))
        with pytest.raises(SystemExit):
            gw._guard_named_profile_under_multiplexer(force=False)
        assert "serves profile 'work'" in capsys.readouterr().out

    def test_profile_inside_account_ignores_the_root_multiplexer(self, layout, monkeypatch):
        from hermes_cli import gateway as gw

        root, account = layout
        self._multiplexer_running_at(monkeypatch, root)
        monkeypatch.setenv("AGENTX_HOME", str(account / "profiles" / "work"))
        gw._guard_named_profile_under_multiplexer(force=False)  # must not exit
