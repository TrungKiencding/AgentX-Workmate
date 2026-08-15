"""Tests for the parts of ``agentx uninstall`` that decide whether it is DONE.

Every case here comes from the same report: "I uninstalled AgentX on Windows
and ``agentx`` is still in my terminal, and I ran it many times." Three
separate defects added up to that:

  * the default was keep-data, so a wipe had to be asked for;
  * the rmtree of the checkout ran from inside that checkout, and Windows
    mandatory-locks a running image, so it aborted partway and left the venv
    (and ``agentx.exe`` in it) behind;
  * shortcuts and the desktop app's own per-user directories were never in
    scope at all, so they survived every mode.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace

import pytest

import hermes_cli.uninstall as uninstall


# ---------------------------------------------------------------------------
# Which mode a set of flags asks for
# ---------------------------------------------------------------------------


class TestTheDefaultIsAFullWipe:
    def test_bare_uninstall_removes_everything(self):
        # The heart of it. Somebody typing `agentx uninstall` means it.
        assert uninstall.wants_full_uninstall(SimpleNamespace()) is True

    def test_keep_data_is_how_you_opt_out(self):
        assert uninstall.wants_full_uninstall(SimpleNamespace(keep_data=True)) is False

    def test_the_old_full_flag_still_means_a_full_wipe(self):
        # Scripts and docs carry --full. It must not quietly start meaning the
        # opposite of what it says.
        assert uninstall.wants_full_uninstall(SimpleNamespace(full=True)) is True

    def test_keep_data_wins_over_full_because_it_is_the_cautious_one(self):
        assert (
            uninstall.wants_full_uninstall(SimpleNamespace(full=True, keep_data=True))
            is False
        )

    def test_the_parser_accepts_both_flags(self):
        import argparse

        from hermes_cli.subcommands.uninstall import build_uninstall_parser

        parser = argparse.ArgumentParser()
        build_uninstall_parser(
            parser.add_subparsers(dest="command"), cmd_uninstall=lambda args: args
        )

        assert parser.parse_args(["uninstall"]).keep_data is False
        assert parser.parse_args(["uninstall", "--keep-data"]).keep_data is True
        assert parser.parse_args(["uninstall", "--full"]).full is True

    def test_the_desktops_lite_mode_maps_onto_keep_data(self):
        # The desktop calls this module with --mode lite/full; "lite" is its
        # name for "remove the agent, keep my data".
        assert uninstall.wants_full_uninstall(uninstall._UninstallArgs(mode="lite")) is False
        assert uninstall.wants_full_uninstall(uninstall._UninstallArgs(mode="full")) is True


# ---------------------------------------------------------------------------
# Deleting a tree we are running from
# ---------------------------------------------------------------------------


class TestRunningInside:
    def test_true_when_the_interpreter_lives_under_the_target(self, tmp_path, monkeypatch):
        venv_python = tmp_path / "agentx-agent" / "venv" / "bin" / "python"
        venv_python.parent.mkdir(parents=True)
        venv_python.write_text("", encoding="utf-8")
        monkeypatch.setattr(sys, "executable", str(venv_python))

        # This is the Windows uninstall in one line: the thing being deleted
        # contains the process doing the deleting.
        assert uninstall.running_inside(tmp_path / "agentx-agent") is True

    def test_false_for_an_unrelated_tree(self, tmp_path, monkeypatch):
        elsewhere = tmp_path / "system" / "python"
        elsewhere.parent.mkdir(parents=True)
        elsewhere.write_text("", encoding="utf-8")
        monkeypatch.setattr(sys, "executable", str(elsewhere))

        assert uninstall.running_inside(tmp_path / "agentx-agent") is False

    def test_a_missing_target_is_not_a_crash(self, tmp_path):
        assert uninstall.running_inside(tmp_path / "never-existed") is False


class TestRemoveTree:
    def test_a_clean_tree_is_removed_and_reported_gone(self, tmp_path):
        tree = tmp_path / "checkout"
        (tree / "hermes_cli").mkdir(parents=True)
        (tree / "hermes_cli" / "main.py").write_text("x", encoding="utf-8")

        assert uninstall._remove_tree(tree) is True
        assert not tree.exists()

    def test_an_absent_tree_counts_as_removed(self, tmp_path):
        assert uninstall._remove_tree(tmp_path / "gone") is True

    def test_a_partial_failure_still_deletes_what_it_can(self, tmp_path):
        """The reason an error handler is passed at all.

        A bare ``shutil.rmtree`` stops dead at the first undeletable file,
        which on Windows is inside the venv — near the top of the walk — so
        almost the whole checkout survived. Getting through everything else
        means a machine that never runs the deferred pass is still mostly
        clean.

        Windows' mandatory lock on a running image has no POSIX equivalent, so
        the undeletable file here is one whose parent directory denies writes.
        Different cause, identical shape: ``os.unlink`` raises PermissionError
        partway through the walk.
        """
        tree = tmp_path / "checkout"
        (tree / "venv").mkdir(parents=True)
        (tree / "docs").mkdir()
        locked = tree / "venv" / "python.exe"
        locked.write_text("locked", encoding="utf-8")
        (tree / "docs" / "readme.md").write_text("removable", encoding="utf-8")

        os.chmod(tree / "venv", 0o500)
        try:
            assert uninstall._remove_tree(tree) is False
            assert locked.exists()
            # The rest of the tree went, rather than the walk aborting at the
            # first refusal and leaving the whole checkout behind.
            assert not (tree / "docs").exists()
        finally:
            os.chmod(tree / "venv", 0o700)


class TestWindowsCleanupScript:
    def test_it_waits_for_our_pid_before_deleting_anything(self):
        script = uninstall.build_windows_cleanup_script(4242, [Path(r"C:\x\agentx")])

        assert 'set "PID=4242"' in script
        # An exact PID filter, and a whole-token match, so PID 99 cannot match
        # 990 the way a bare `find` would.
        assert 'tasklist /NH /FI "PID eq %PID%"' in script
        assert 'findstr /r /c:" %PID% "' in script
        # The wait must be bounded or a mismatched PID wedges it forever.
        assert "if %waited% geq 60 goto gone" in script

    def test_every_target_is_deleted_with_a_retry(self):
        targets = [Path(r"C:\a\agentx-agent"), Path(r"C:\a\agentx")]
        script = uninstall.build_windows_cleanup_script(1, targets)

        for target in targets:
            assert f'rmdir /s /q "{target}"' in script
        # Windows releases directory handles lazily, so one pass half-fails.
        assert script.count("geq 10 goto done") == len(targets)

    def test_it_deletes_itself_so_temp_does_not_fill_up(self):
        script = uninstall.build_windows_cleanup_script(1, [Path(r"C:\x")])

        assert 'del /f /q "%~f0"' in script

    def test_it_uses_crlf_because_cmd_is_the_reader(self):
        script = uninstall.build_windows_cleanup_script(1, [Path(r"C:\x")])

        assert "\r\n" in script
        assert "\n" not in script.replace("\r\n", "")

    def test_a_quote_in_a_path_cannot_break_out_of_the_argument(self):
        # cmd.exe has no escaping inside quotes, so the only safe answer is to
        # drop them. AgentX install paths never contain quotes; a crafted one
        # must not become a second command either way.
        script = uninstall.build_windows_cleanup_script(1, [Path('C:\\a"b')])

        assert '"C:\\ab"' in script


class TestSpawnDetachedCleanup:
    def test_nothing_is_scheduled_off_windows(self, tmp_path, monkeypatch):
        """POSIX can unlink a running executable, so there is nothing to defer.

        Writing a cleanup script here would be ritual, not engineering — and an
        untestable one, since no POSIX uninstall ever needs it.
        """
        monkeypatch.setattr(uninstall, "_is_windows", lambda: False)
        target = tmp_path / "left-behind"
        target.mkdir()

        assert uninstall.spawn_detached_cleanup([target]) is None

    def test_nothing_is_scheduled_when_the_paths_are_already_gone(self, tmp_path, monkeypatch):
        monkeypatch.setattr(uninstall, "_is_windows", lambda: True)

        assert uninstall.spawn_detached_cleanup([tmp_path / "gone"]) is None

    def test_it_writes_a_script_and_starts_it_detached(self, tmp_path, monkeypatch):
        monkeypatch.setattr(uninstall, "_is_windows", lambda: True)
        monkeypatch.setenv("TMPDIR", str(tmp_path))
        target = tmp_path / "locked-checkout"
        target.mkdir()

        started: list[dict] = []

        def fake_popen(argv, **kwargs):
            started.append({"argv": argv, "kwargs": kwargs})
            return SimpleNamespace(pid=999)

        monkeypatch.setattr(uninstall.subprocess, "Popen", fake_popen)

        script = uninstall.spawn_detached_cleanup([target])

        assert script is not None and script.exists()
        assert str(target) in script.read_text(encoding="utf-8")
        assert started[0]["argv"] == ["cmd.exe", "/c", str(script)]
        # Detached and in its own process group, or closing the terminal that
        # ran the uninstall kills the thing finishing it.
        assert started[0]["kwargs"]["creationflags"] == 0x00000008 | 0x00000200

    def test_a_failed_spawn_reports_failure_rather_than_pretending(self, tmp_path, monkeypatch):
        monkeypatch.setattr(uninstall, "_is_windows", lambda: True)
        monkeypatch.setenv("TMPDIR", str(tmp_path))
        target = tmp_path / "locked-checkout"
        target.mkdir()

        def refuse(*_a, **_kw):
            raise OSError("no cmd.exe here")

        monkeypatch.setattr(uninstall.subprocess, "Popen", refuse)

        # Telling somebody the uninstall finished while their venv is still on
        # disk is the failure mode this whole file is about.
        assert uninstall.spawn_detached_cleanup([target]) is None


# ---------------------------------------------------------------------------
# The leftovers neither rmtree could ever reach
# ---------------------------------------------------------------------------


class TestDesktopLeftovers:
    def test_windows_sweeps_both_installers_shortcut_names(self, monkeypatch, tmp_path):
        monkeypatch.setattr(uninstall.sys, "platform", "win32")
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
        monkeypatch.setenv("APPDATA", str(tmp_path / "AppData" / "Roaming"))

        names = {p.name for p in uninstall.desktop_shortcut_paths()}

        # install.ps1 writes AgentX.lnk; the NSIS installer writes one named
        # after build.nsis.shortcutName. A machine that has seen both has both.
        assert "AgentX.lnk" in names
        assert "AgentX Workmate.lnk" in names

        parents = {p.parent.name for p in uninstall.desktop_shortcut_paths()}
        assert "Desktop" in parents
        assert "Programs" in parents

    def test_no_shortcuts_are_claimed_on_macos(self, monkeypatch):
        monkeypatch.setattr(uninstall.sys, "platform", "darwin")

        assert uninstall.desktop_shortcut_paths() == []

    @pytest.mark.parametrize(
        "platform,expected_fragment",
        [("darwin", "Library"), ("win32", "AppData"), ("linux", ".cache")],
    )
    def test_every_platform_names_its_own_runtime_dirs(
        self, monkeypatch, tmp_path, platform, expected_fragment
    ):
        monkeypatch.setattr(uninstall.sys, "platform", platform)
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
        monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "AppData" / "Local"))
        monkeypatch.delenv("XDG_CACHE_HOME", raising=False)

        paths = uninstall.desktop_runtime_data_paths()

        assert paths
        assert all(expected_fragment in str(p) for p in paths)

    def test_macos_covers_the_dirs_keyed_on_the_bundle_id(self, monkeypatch, tmp_path):
        from branding import APP_ID

        monkeypatch.setattr(uninstall.sys, "platform", "darwin")
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))

        rendered = " ".join(str(p) for p in uninstall.desktop_runtime_data_paths())

        # These are keyed on the bundle id, not on AGENTX_HOME, which is
        # exactly why wiping AGENTX_HOME never touched them.
        assert f"{APP_ID}.plist" in rendered
        assert f"{APP_ID}.savedState" in rendered

    def test_it_removes_what_exists_and_shrugs_at_what_does_not(self, monkeypatch, tmp_path):
        shortcut = tmp_path / "Desktop" / "AgentX.lnk"
        shortcut.parent.mkdir(parents=True)
        shortcut.write_text("lnk", encoding="utf-8")
        cache = tmp_path / "cache-dir"
        (cache / "GPUCache").mkdir(parents=True)

        monkeypatch.setattr(
            uninstall, "desktop_shortcut_paths", lambda: [shortcut, tmp_path / "absent.lnk"]
        )
        monkeypatch.setattr(uninstall, "desktop_runtime_data_paths", lambda: [cache])

        removed = uninstall.remove_desktop_leftovers()

        assert set(removed) == {shortcut, cache}
        assert not shortcut.exists()
        assert not cache.exists()

    def test_a_removal_that_fails_does_not_abort_the_rest(self, monkeypatch, tmp_path):
        first = tmp_path / "held-open.lnk"
        first.write_text("lnk", encoding="utf-8")
        second = tmp_path / "fine.lnk"
        second.write_text("lnk", encoding="utf-8")

        real_unlink = Path.unlink

        def refuse_the_first(self, *a, **kw):
            if self == first:
                raise PermissionError(13, "in use")
            return real_unlink(self, *a, **kw)

        monkeypatch.setattr(Path, "unlink", refuse_the_first)
        monkeypatch.setattr(uninstall, "desktop_shortcut_paths", lambda: [first, second])
        monkeypatch.setattr(uninstall, "desktop_runtime_data_paths", lambda: [])

        assert uninstall.remove_desktop_leftovers() == [second]
        assert not second.exists()


# ---------------------------------------------------------------------------
# End to end, against a real tree on disk
# ---------------------------------------------------------------------------


@pytest.fixture()
def install(tmp_path, monkeypatch):
    """A believable install: AGENTX_HOME with the checkout and a venv inside."""
    home = tmp_path / "agentx"
    project = home / "agentx-agent"
    (project / "hermes_cli").mkdir(parents=True)
    (project / "hermes_cli" / "main.py").write_text("x", encoding="utf-8")
    (project / "venv" / "Scripts").mkdir(parents=True)
    (project / "venv" / "Scripts" / "agentx.exe").write_text("exe", encoding="utf-8")
    (home / "config.yaml").write_text("model: {}\n", encoding="utf-8")
    (home / ".env").write_text("LITELLM_API_KEY=sk-old\n", encoding="utf-8")

    # Neutralise everything that would reach outside tmp_path.
    monkeypatch.setattr(uninstall, "get_project_root", lambda: project)
    monkeypatch.setattr(uninstall, "get_hermes_home", lambda: home)
    monkeypatch.setattr(uninstall, "uninstall_gateway_service", lambda: False)
    monkeypatch.setattr(uninstall, "remove_path_from_shell_configs", lambda: [])
    monkeypatch.setattr(uninstall, "remove_wrapper_script", lambda: [])
    monkeypatch.setattr(uninstall, "remove_node_symlinks", lambda _home: [])
    monkeypatch.setattr(uninstall, "desktop_shortcut_paths", lambda: [])
    monkeypatch.setattr(uninstall, "desktop_runtime_data_paths", lambda: [])
    monkeypatch.setattr(uninstall, "_is_default_hermes_home", lambda _home: False)
    monkeypatch.setattr(uninstall, "_discover_named_profiles", lambda: [])
    monkeypatch.setattr("hermes_cli.gui_uninstall.uninstall_gui", lambda _home: [])

    return SimpleNamespace(home=home, project=project)


class TestPerformUninstall:
    def test_a_full_wipe_leaves_nothing(self, install):
        uninstall._perform_uninstall(
            project_root=install.project,
            hermes_home=install.home,
            full_uninstall=True,
            remove_profiles=False,
            named_profiles=[],
        )

        # Including the .env with the model key in it — the file whose survival
        # made a reinstall silently adopt the old key.
        assert not install.home.exists()

    def test_keep_data_keeps_the_data_and_only_the_data(self, install):
        uninstall._perform_uninstall(
            project_root=install.project,
            hermes_home=install.home,
            full_uninstall=False,
            remove_profiles=False,
            named_profiles=[],
        )

        assert not install.project.exists()
        assert (install.home / "config.yaml").exists()
        assert (install.home / ".env").exists()

    def test_a_locked_venv_is_handed_to_a_deferred_cleanup(self, install, monkeypatch, capsys):
        """The Windows case, reproduced without Windows.

        A file the process cannot delete must not end as a shrug and an
        "Uninstall Complete!" banner — the leftovers get handed to a child that
        finishes after we exit, and the user is told which paths those are.
        """
        scripts = install.project / "venv" / "Scripts"
        deferred: list[list[Path]] = []
        monkeypatch.setattr(
            uninstall,
            "spawn_detached_cleanup",
            lambda targets: (deferred.append(list(targets)), Path("cleanup.cmd"))[1],
        )

        os.chmod(scripts, 0o500)
        try:
            uninstall._perform_uninstall(
                project_root=install.project,
                hermes_home=install.home,
                full_uninstall=True,
                remove_profiles=False,
                named_profiles=[],
            )
        finally:
            os.chmod(scripts, 0o700)

        assert deferred, "a locked path must be handed to the deferred cleanup"
        assert install.home in deferred[0] or install.project in deferred[0]
        assert "background cleanup" in capsys.readouterr().out

    def test_an_unschedulable_leftover_is_reported_not_hidden(self, install, monkeypatch, capsys):
        scripts = install.project / "venv" / "Scripts"
        monkeypatch.setattr(uninstall, "spawn_detached_cleanup", lambda _targets: None)

        os.chmod(scripts, 0o500)
        try:
            uninstall._perform_uninstall(
                project_root=install.project,
                hermes_home=install.home,
                full_uninstall=True,
                remove_profiles=False,
                named_profiles=[],
            )
        finally:
            os.chmod(scripts, 0o700)

        output = capsys.readouterr().out
        assert "still on disk" in output
        assert str(install.home) in output or str(install.project) in output

    def test_shortcuts_and_desktop_data_go_in_both_modes(self, install, monkeypatch):
        """They live outside the checkout AND outside AGENTX_HOME, so neither
        rmtree would ever reach them — which is why the icon used to survive."""
        for full in (True, False):
            calls: list[int] = []
            monkeypatch.setattr(
                uninstall, "remove_desktop_leftovers", lambda: (calls.append(1), [])[1]
            )

            uninstall._perform_uninstall(
                project_root=install.project,
                hermes_home=install.home,
                full_uninstall=full,
                remove_profiles=False,
                named_profiles=[],
            )

            assert calls == [1], f"leftovers not swept with full_uninstall={full}"


@pytest.mark.parametrize(
    "entry",
    [
        # What Set-PathVariable in scripts/install.ps1 actually prepends.
        r"C:\Users\someone\AppData\Local\agentx\agentx-agent\venv\Scripts",
        r"C:\Users\someone\AppData\Local\agentx\git\cmd",
        r"C:\Users\someone\AppData\Local\agentx\node",
    ],
)
def test_windows_registry_markers_cover_every_path_entry_the_installer_writes(entry):
    """If the markers miss an entry, ``agentx`` (or the bundled git/node) stays
    resolvable in every new terminal long after the files are gone — which is
    half of "I uninstalled it and it is still in my terminal".

    ``PureWindowsPath`` because these strings are Windows paths regardless of
    the host running the test; ``Path`` would join them with forward slashes on
    a Mac and quietly test nothing.
    """
    home = PureWindowsPath(r"C:\Users\someone\AppData\Local\agentx")

    markers = uninstall._hermes_path_markers(home)

    assert any(entry.lower().startswith(m.lower()) for m in markers)


@pytest.mark.parametrize(
    "unrelated",
    [
        r"C:\Program Files\Git\cmd",
        # Near-misses on the marker text. Stripping these would break tools
        # that have nothing to do with AgentX.
        r"C:\Users\someone\AppData\Local\agentx-other\bin",
        r"C:\Users\someone\ephemeral\bin",
    ],
)
def test_windows_registry_markers_leave_unrelated_entries_alone(unrelated):
    home = PureWindowsPath(r"C:\Users\someone\AppData\Local\agentx")
    markers = uninstall._hermes_path_markers(home)

    assert not any(unrelated.lower().startswith(m.lower()) for m in markers)
