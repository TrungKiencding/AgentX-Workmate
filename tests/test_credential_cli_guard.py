"""The conftest credential-CLI guard keeps the developer's gh login and Keychain out.

``tests/conftest.py`` installs an audit hook that refuses to run the real
``gh`` / ``security`` binaries, because they hand the code under test the
developer's GitHub token and macOS Keychain entries. It has to hold outside any
single test: the Keychain leak it replaced came from a daemon thread that
outlived the test that started it.

Every command here is harmless if the guard ever regresses (``--version``,
``--help``, a lookup of an item that does not exist), so a failing run cannot
print a real credential.
"""

import os
import subprocess
import sys
import threading

import pytest

GUARD = "credential-CLI guard"


def _refused(cmd, **kwargs):
    with pytest.raises(FileNotFoundError) as excinfo:
        subprocess.run(cmd, capture_output=True, timeout=30, **kwargs)
    return str(excinfo.value)


# Spawned while this module is collected -- outside every test and every
# fixture, like the update-check and picker-prewarm threads that read real
# credentials before. A guard that only lived inside per-test fixtures would
# let this one run.
try:
    subprocess.run(["gh", "--version"], capture_output=True, timeout=30)
    _AT_COLLECTION = None
except FileNotFoundError as exc:
    _AT_COLLECTION = str(exc)


def test_guard_is_active_outside_any_test():
    assert _AT_COLLECTION is not None and GUARD in _AT_COLLECTION


@pytest.mark.parametrize(
    "cmd",
    [
        ["gh", "--version"],
        ["gh", "auth", "--help"],
        ["security", "find-generic-password", "-s", "agentx-test-no-such-item"],
    ],
)
def test_real_gh_and_security_are_refused(cmd):
    assert GUARD in _refused(cmd)


def test_absolute_path_to_gh_is_refused():
    for path in ("/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"):
        if os.path.exists(path):
            assert GUARD in _refused([path, "--version"])
            return
    pytest.skip("no gh installed at a well-known absolute path")


@pytest.mark.parametrize(
    "command",
    [
        "gh auth --help",
        "FOO=1 gh auth --help",
        "true && security find-generic-password -s agentx-test-no-such-item",
    ],
)
def test_credential_subcommand_through_a_shell_is_refused(command):
    assert GUARD in _refused(command, shell=True)


@pytest.mark.parametrize(
    "cmd",
    [
        "gh --version",
        "cd . && gh api --help",
        ["env", "GH_PAGER=", "gh", "--version"],
        ["nohup", "gh", "pr", "--help"],
    ],
)
def test_any_gh_command_through_a_shell_or_wrapper_is_refused(cmd):
    # Not only `gh auth`: every gh command runs as the developer's GitHub login.
    assert GUARD in _refused(cmd, shell=isinstance(cmd, str))


def test_spawn_from_a_background_thread_is_refused():
    errors = []

    def _spawn():
        try:
            subprocess.run(["gh", "--version"], capture_output=True, timeout=30)
        except FileNotFoundError as exc:
            errors.append(str(exc))

    worker = threading.Thread(target=_spawn, daemon=True)
    worker.start()
    worker.join(30)
    assert len(errors) == 1 and GUARD in errors[0]


def test_unrelated_commands_still_run():
    out = subprocess.run(
        [sys.executable, "-c", "print('gh auth')"], capture_output=True, text=True, timeout=30
    )
    assert out.stdout.strip() == "gh auth"
    if sys.platform != "win32":
        echoed = subprocess.run("echo gh", shell=True, capture_output=True, text=True, timeout=30)
        assert echoed.stdout.strip() == "gh"
        probed = subprocess.run(
            "command -v gh >/dev/null; echo probed",
            shell=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert probed.stdout.strip() == "probed"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shebang fake")
def test_fake_gh_written_under_tmp_path_still_runs(tmp_path):
    fake = tmp_path / "gh"
    fake.write_text('#!/bin/sh\necho "fake-gh $*"\n')
    fake.chmod(0o755)

    direct = subprocess.run([str(fake), "auth", "token"], capture_output=True, text=True, timeout=30)
    via_path = subprocess.run(
        ["gh", "auth", "token"],
        capture_output=True,
        text=True,
        timeout=30,
        env={**os.environ, "PATH": str(tmp_path)},
    )

    assert direct.stdout.strip() == "fake-gh auth token"
    assert via_path.stdout.strip() == "fake-gh auth token"
