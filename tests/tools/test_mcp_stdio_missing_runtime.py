"""Stdio MCP servers launched with ``uvx``/``uv`` (every PyPI server the AgentX
Hub renders) and what happens when a command cannot be found at all.

AgentX's own uv lives in ``$AGENTX_HOME/bin``, which is never on PATH, so a
bare ``uvx`` has to be resolved there the way a bare ``npx`` is resolved in the
managed Node tree. A command that is nowhere must fail before anything is
spawned: on POSIX the spawn goes through the parent-death watchdog, whose own
failed exec reached the client only as "Connection closed".
"""

import asyncio
import errno
import os
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from tools import mcp_stdio_watchdog
from tools.mcp_tool import (
    MCPServerTask,
    MissingStdioCommandError,
    _classify_mcp_failure,
    _find_uv_launcher,
    _format_connect_error,
    _resolve_stdio_command,
    _unwrap_exception_group,
    _windows_spawn_finds,
)


def _executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    path.chmod(0o755)
    return path


@pytest.fixture
def machine(tmp_path, monkeypatch):
    """A user without uv anywhere: own HOME, AGENTX_HOME at its default, an empty PATH dir."""
    home = tmp_path / "user"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    agentx_home = home / ".agentx"
    agentx_home.mkdir()
    monkeypatch.setenv("AGENTX_HOME", str(agentx_home))
    empty_path = tmp_path / "empty-path"
    empty_path.mkdir()
    return {"home": home, "agentx_home": agentx_home, "path": str(empty_path)}


# ---------------------------------------------------------------------------
# Resolving uvx / uv
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("command", ["uvx", "uv"])
def test_bare_uv_launcher_resolves_to_agentx_home_bin(machine, command):
    managed = _executable(machine["agentx_home"] / "bin" / command)

    resolved, env = _resolve_stdio_command(command, {"PATH": machine["path"]})

    assert resolved == str(managed)
    # The managed bin dir leads the child's PATH, so a server that shells out
    # to `uv` itself finds the same copy.
    assert env["PATH"].split(os.pathsep)[0] == str(managed.parent)


def test_account_home_falls_back_to_the_install_roots_bin(machine, monkeypatch):
    """The signed-in desktop runs the backend inside accounts/<slug>, while
    install.sh / install.ps1 put uv in the install root's bin."""
    account_home = machine["agentx_home"] / "accounts" / "kien"
    account_home.mkdir(parents=True)
    monkeypatch.setenv("AGENTX_HOME", str(account_home))
    managed = _executable(machine["agentx_home"] / "bin" / "uvx")

    resolved, _env = _resolve_stdio_command("uvx", {"PATH": machine["path"]})

    assert resolved == str(managed)


def test_uv_installed_by_the_standalone_installer_is_found(machine):
    user_uvx = _executable(machine["home"] / ".local" / "bin" / "uvx")

    resolved, _env = _resolve_stdio_command("uvx", {"PATH": machine["path"]})

    assert resolved == str(user_uvx)


def test_uvx_on_the_servers_path_wins_over_the_managed_copy(machine, tmp_path):
    """Like npx: PATH first, AgentX's copy only when PATH has none."""
    _executable(machine["agentx_home"] / "bin" / "uvx")
    on_path = _executable(tmp_path / "homebrew" / "uvx")

    resolved, _env = _resolve_stdio_command("uvx", {"PATH": str(on_path.parent)})

    assert resolved == str(on_path)


def test_windows_looks_for_uvx_exe_in_the_managed_bin(machine):
    exe = _executable(machine["agentx_home"] / "bin" / "uvx.exe")

    assert _find_uv_launcher("uvx", windows=True) == str(exe)
    assert _find_uv_launcher("uvx.exe", windows=True) == str(exe)
    # The POSIX lookup wants the extensionless file the uv installer writes there.
    assert _find_uv_launcher("uvx", windows=False) is None


# ---------------------------------------------------------------------------
# A command that cannot be found
# ---------------------------------------------------------------------------


def test_missing_uv_is_a_missing_runtime_error(machine):
    with pytest.raises(MissingStdioCommandError) as caught:
        _resolve_stdio_command("uvx", {"PATH": machine["path"]})

    error = caught.value
    assert isinstance(error, FileNotFoundError)
    assert error.errno == errno.ENOENT
    assert error.filename == "uvx"
    assert error.runtime == "uv"
    message = str(error)
    assert message.startswith("missing runtime uv: 'uvx' is not on PATH")
    # Says where it looked (the managed bin, home-relative) and what to do.
    assert os.path.join("~", ".agentx", "bin") in message
    assert "agentx update" in message
    assert "https://docs.astral.sh/uv/" in message
    # Deterministic: parked at once instead of burning the retry ladder, and
    # the status line is the message itself.
    assert _classify_mcp_failure(error) == "permanent"
    assert _format_connect_error(error) == message


def test_missing_node_launcher_keeps_its_hint(machine, monkeypatch):
    # CI runners ship Node in /usr/local/bin, one of the real fallback dirs.
    monkeypatch.setattr(
        "tools.mcp_tool._node_launcher_dirs",
        lambda: [str(machine["agentx_home"] / "node" / "bin")],
    )
    with pytest.raises(MissingStdioCommandError) as caught:
        _resolve_stdio_command("npx", {"PATH": machine["path"]})

    assert caught.value.runtime == "Node.js"
    assert str(caught.value).startswith("missing runtime Node.js: 'npx' is not on PATH")
    assert "ensure Node.js is installed" in str(caught.value)


def test_missing_other_command_or_path(machine, tmp_path):
    with pytest.raises(MissingStdioCommandError) as caught:
        _resolve_stdio_command("no-such-mcp-server", {"PATH": machine["path"]})
    assert caught.value.runtime is None
    assert str(caught.value).startswith("missing executable 'no-such-mcp-server' (not on PATH")

    missing_path = str(tmp_path / "gone" / "server")
    with pytest.raises(MissingStdioCommandError) as caught:
        _resolve_stdio_command(missing_path, {"PATH": machine["path"]})
    assert caught.value.runtime is None
    assert str(caught.value) == f"missing executable '{missing_path}' (no such file)"


def test_an_existing_path_is_left_to_the_spawn(tmp_path):
    server = _executable(tmp_path / "bin" / "server")

    resolved, env = _resolve_stdio_command(str(server), {"PATH": "/usr/bin"})

    assert resolved == str(server)
    assert env["PATH"].split(os.pathsep)[0] == str(server.parent)


def test_windows_spawn_lookup_is_consulted_before_calling_a_command_missing():
    """On Windows the MCP SDK resolves against the PARENT's PATH and tries
    .cmd/.bat/.exe/.ps1, so a miss in the server's PATH is not yet a miss."""
    def _which(candidate, *_args, **_kwargs):
        return r"C:\tools\server.cmd" if candidate == "server.cmd" else None

    with patch("tools.mcp_tool.shutil.which", side_effect=_which):
        assert _windows_spawn_finds("server", windows=True) is True
        assert _windows_spawn_finds("other", windows=True) is False
        # POSIX execvp only searches the PATH the caller already searched.
        assert _windows_spawn_finds("server", windows=False) is False


def test_run_stdio_fails_before_the_osv_lookup_and_the_watchdog(machine, monkeypatch):
    monkeypatch.setenv("PATH", machine["path"])
    osv_check = MagicMock(return_value=None)
    wrap = MagicMock(side_effect=lambda command, args: (command, args))
    stdio_client = MagicMock()

    async def _test():
        with patch("tools.mcp_tool._ensure_mcp_sdk", return_value=True), \
             patch("tools.osv_check.check_package_for_malware", osv_check), \
             patch("tools.mcp_tool._wrap_command_with_watchdog", wrap), \
             patch("tools.mcp_tool.stdio_client", stdio_client, create=True):
            server = MCPServerTask("time")
            with pytest.raises(MissingStdioCommandError):
                await server._run_stdio({"command": "uvx", "args": ["mcp-server-time"]})

    asyncio.run(_test())

    osv_check.assert_not_called()
    wrap.assert_not_called()
    stdio_client.assert_not_called()


def test_start_parks_at_once_on_a_missing_runtime(machine, monkeypatch):
    """Before: three "transient" Connection-closed retries, then a park."""
    monkeypatch.setenv("PATH", machine["path"])
    attempts = []
    original_run_stdio = MCPServerTask._run_stdio

    async def _counting_run_stdio(self, config):
        attempts.append(config["command"])
        return await original_run_stdio(self, config)

    async def _test():
        with patch("tools.mcp_tool._ensure_mcp_sdk", return_value=True), \
             patch.object(MCPServerTask, "_run_stdio", _counting_run_stdio):
            server = MCPServerTask("time")
            started = time.monotonic()
            with pytest.raises(MissingStdioCommandError):
                await server.start({"command": "uvx", "args": ["mcp-server-time"]})
            elapsed = time.monotonic() - started
            assert server._was_parked is True
            await server.shutdown()
        return elapsed

    elapsed = asyncio.run(_test())
    assert attempts == ["uvx"]
    assert elapsed < 1.0


# ---------------------------------------------------------------------------
# Formatting the error the probe re-raises
# ---------------------------------------------------------------------------


def _reraised_like_probe(leaf: Exception) -> BaseException:
    """The shape ``_probe_single_server`` hands its callers: a TaskGroup's child
    re-raised while the group is being handled, so the child's ``__context__``
    is the group that contains it."""
    try:
        try:
            raise ExceptionGroup("unhandled errors in a TaskGroup", [leaf])
        except BaseException as group:
            raise _unwrap_exception_group(group) from None
    except BaseException as raised:
        return raised


def test_format_connect_error_survives_a_context_cycle():
    error = _reraised_like_probe(RuntimeError("Connection closed"))
    assert error.__context__.exceptions[0] is error

    assert _format_connect_error(error) == "Connection closed"


def test_format_connect_error_names_a_missing_uv_inside_a_cycle():
    error = _reraised_like_probe(FileNotFoundError(errno.ENOENT, "No such file or directory", "uvx"))

    message = _format_connect_error(error)

    assert message.startswith("missing executable 'uvx' (run `agentx update`")


# ---------------------------------------------------------------------------
# The watchdog's own spawn failure
# ---------------------------------------------------------------------------


def _run_watchdog(command: str) -> subprocess.CompletedProcess:
    """Run the watchdog as the MCP client does: its own process, real pipes."""
    return subprocess.run(
        [sys.executable, mcp_stdio_watchdog.__file__, "--ppid", str(os.getpid()), "--", command],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_watchdog_reports_a_command_it_cannot_start_in_one_line(tmp_path):
    missing = str(tmp_path / "gone" / "uvx")

    result = _run_watchdog(missing)

    assert result.returncode == 127
    assert result.stderr.strip().splitlines() == [
        f"mcp_stdio_watchdog: cannot start {missing!r}: No such file or directory"
    ]


@pytest.mark.skipif(os.name != "posix", reason="exec permission bits are POSIX")
def test_watchdog_exits_126_for_a_file_it_cannot_execute(tmp_path):
    not_executable = tmp_path / "server"
    not_executable.write_text("#!/bin/sh\n", encoding="utf-8")
    not_executable.chmod(0o644)

    result = _run_watchdog(str(not_executable))

    assert result.returncode == 126
    assert "Traceback" not in result.stderr
