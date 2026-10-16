"""The desktop backend's own Python paths stay out of the commands the agent runs.

The desktop app starts the backend with PYTHONPATH on its own interpreter's
packages — the agent root plus the venv's Python 3.11 site-packages, or the
bundled runtime's source with PYTHONHOME on the bundled Python — and names
what it added in AGENTX_BACKEND_PYTHONPATH / AGENTX_BACKEND_PYTHONHOME. Every
child inherited them, so a command running another Python (``uvx <tool>``,
``uv run --python 3.13``, a pipx tool, a project venv) imported the backend's
compiled packages and died ("No module named 'pydantic_core._pydantic_core'"),
or did not start at all under the bundled PYTHONHOME.

AgentX's own Python children (slash worker, ``cli.exec``, gateway, cron) keep
the overlay: under the bundled runtime the source is importable only through it.
"""

import json
import os
import subprocess
import sys
import threading
from unittest.mock import MagicMock, patch

import pytest

from tools.environments import local as local_mod
from tools.environments.local import LocalEnvironment, _make_run_env, hermes_subprocess_env

ROOT = "/Users/me/.agentx/agentx-agent"
SITE = "/Users/me/.agentx/agentx-agent/venv/lib/python3.11/site-packages"
USER_LIB = "/Users/me/mylibs"
BUNDLED_SOURCE = "/Applications/AgentX Workmate.app/Contents/Resources/bundled-runtime/source"
BUNDLED_HOME = "/Applications/AgentX Workmate.app/Contents/Resources/bundled-runtime/python"

DESKTOP_ENV = {
    "PATH": "/usr/bin:/bin",
    "HOME": "/Users/me",
    "PYTHONPATH": f"{ROOT}:{SITE}:{USER_LIB}",
    "AGENTX_BACKEND_PYTHONPATH": f"{ROOT}:{SITE}",
}

BUNDLED_ENV = {
    "PATH": "/usr/bin:/bin",
    "HOME": "/Users/me",
    "PYTHONPATH": BUNDLED_SOURCE,
    "PYTHONHOME": BUNDLED_HOME,
    "AGENTX_BACKEND_PYTHONPATH": BUNDLED_SOURCE,
    "AGENTX_BACKEND_PYTHONHOME": BUNDLED_HOME,
}


@pytest.fixture
def posix(monkeypatch):
    monkeypatch.setattr(local_mod, "_IS_WINDOWS", False)


class TestStripBackendPythonEnv:
    def test_removes_the_backend_entries_and_keeps_the_users(self, posix):
        env = local_mod.strip_backend_python_env(dict(DESKTOP_ENV))
        assert env["PYTHONPATH"] == USER_LIB

    def test_drops_pythonpath_holding_only_backend_entries(self, posix):
        env = local_mod.strip_backend_python_env({**DESKTOP_ENV, "PYTHONPATH": f"{ROOT}:{SITE}"})
        assert "PYTHONPATH" not in env

    def test_bundled_runtime_pythonhome_goes_too(self, posix):
        env = local_mod.strip_backend_python_env(dict(BUNDLED_ENV))
        assert "PYTHONPATH" not in env
        assert "PYTHONHOME" not in env

    def test_a_pythonhome_the_user_set_stays(self, posix):
        env = local_mod.strip_backend_python_env({**BUNDLED_ENV, "PYTHONHOME": "/opt/python"})
        assert env["PYTHONHOME"] == "/opt/python"

    def test_without_the_desktop_markers_nothing_changes(self, posix):
        # The CLI, or a gateway the desktop did not start: a PYTHONPATH there
        # is the user's own.
        env = {"PYTHONPATH": f"{ROOT}:{SITE}", "PYTHONHOME": BUNDLED_HOME}
        assert local_mod.strip_backend_python_env(dict(env)) == env

    def test_windows_paths_match_across_case_and_separators(self, monkeypatch):
        monkeypatch.setattr(local_mod, "_IS_WINDOWS", True)
        root = r"C:\Users\me\AppData\Local\agentx\agentx-agent"
        site = root + r"\venv\Lib\site-packages"
        env = local_mod.strip_backend_python_env({
            "PYTHONPATH": f"{root};{site};D:\\libs",
            "AGENTX_BACKEND_PYTHONPATH": "c:/users/me/appdata/local/agentx/agentx-agent;" + site + "\\",
            "PYTHONHOME": r"C:\Program Files\AgentX Workmate\resources\bundled-runtime\python",
            "AGENTX_BACKEND_PYTHONHOME": r"c:\program files\agentx workmate\resources\bundled-runtime\python",
        })
        assert env["PYTHONPATH"] == "D:\\libs"
        assert "PYTHONHOME" not in env

    def test_markers_stay_for_an_agentx_started_from_the_child(self, posix):
        # The bundled `agentx` shim re-exports the same PYTHONPATH/PYTHONHOME;
        # with the markers it strips them from its own children too.
        env = local_mod.strip_backend_python_env(dict(BUNDLED_ENV))
        assert env["AGENTX_BACKEND_PYTHONPATH"] == BUNDLED_SOURCE
        assert env["AGENTX_BACKEND_PYTHONHOME"] == BUNDLED_HOME


class TestTerminal:
    def test_child_python_cannot_import_the_backend_site_packages(self, tmp_path, monkeypatch):
        site = tmp_path / "venv" / "lib" / "python3.11" / "site-packages"
        site.mkdir(parents=True)
        (site / "backend_only_pkg.py").write_text("")
        user_lib = tmp_path / "mylibs"
        user_lib.mkdir()
        (user_lib / "users_own_pkg.py").write_text("")
        monkeypatch.setenv("PYTHONPATH", os.pathsep.join([str(tmp_path), str(site), str(user_lib)]))
        monkeypatch.setenv("AGENTX_BACKEND_PYTHONPATH", os.pathsep.join([str(tmp_path), str(site)]))

        probe = (
            "import importlib.util as u; "
            "print(u.find_spec('backend_only_pkg') is not None, u.find_spec('users_own_pkg') is not None)"
        )
        result = subprocess.run(
            [sys.executable, "-c", probe],
            env=_make_run_env({}),
            capture_output=True,
            text=True,
            check=True,
        )
        assert result.stdout.split() == ["False", "True"]

    def test_foreground_command_env(self, posix):
        captured = {}

        def fake_popen(cmd, **kwargs):
            captured["env"] = kwargs.get("env", {})
            proc = MagicMock()
            proc.poll.return_value = 0
            proc.returncode = 0
            proc.stdout = MagicMock(
                __iter__=lambda s: iter([]),
                __next__=lambda s: (_ for _ in ()).throw(StopIteration),
            )
            return proc

        with patch("tools.environments.local._find_bash", return_value="/bin/bash"), \
             patch("subprocess.Popen", side_effect=fake_popen), \
             patch("tools.terminal_tool._interrupt_event", threading.Event()), \
             patch.dict(os.environ, BUNDLED_ENV, clear=True):
            LocalEnvironment(cwd="/tmp", timeout=10).execute("uvx browser-use --help")

        assert "PYTHONPATH" not in captured["env"]
        assert "PYTHONHOME" not in captured["env"]

    def test_background_process_env(self, posix):
        import tools.process_registry as pr

        captured = {}

        def fake_popen(cmd, **kwargs):
            captured["env"] = kwargs["env"]
            proc = MagicMock()
            proc.pid = 4321
            proc.stdout = iter([])
            proc.poll.return_value = None
            return proc

        registry = pr.ProcessRegistry()
        with patch.dict(os.environ, DESKTOP_ENV, clear=True), \
             patch.object(pr, "_SYSTEMD_SCOPE_AVAILABLE", False), \
             patch("tools.process_registry._find_shell", return_value="/bin/bash"), \
             patch("subprocess.Popen", side_effect=fake_popen), \
             patch("threading.Thread", return_value=MagicMock()), \
             patch.object(registry, "_write_checkpoint"):
            registry.spawn_local("uv run --python 3.13 app.py", cwd="/tmp")

        assert captured["env"]["PYTHONPATH"] == USER_LIB


class TestExecuteCode:
    @staticmethod
    def _child_pythonpath(same_env: bool) -> list:
        from tools.code_execution_tool import execute_code

        captured = {}

        def fake_popen(cmd, **kwargs):
            captured["PYTHONPATH"] = (kwargs.get("env") or {}).get("PYTHONPATH", "")
            proc = MagicMock()
            proc.stdout.read.return_value = b""
            proc.stderr.read.return_value = b""
            proc.wait.return_value = 0
            proc.returncode = 0
            proc.poll.return_value = 0
            return proc

        desktop = {key: DESKTOP_ENV[key] for key in ("PYTHONPATH", "AGENTX_BACKEND_PYTHONPATH")}
        with patch.dict(os.environ, {**desktop, "TERMINAL_ENV": "local"}), \
             patch.object(local_mod, "_IS_WINDOWS", False), \
             patch("tools.code_execution_tool._load_config", return_value={"mode": "strict"}), \
             patch("model_tools.handle_function_call", return_value=json.dumps({})), \
             patch("tools.code_execution_tool._uses_hermes_python_environment", return_value=same_env), \
             patch("subprocess.Popen", side_effect=fake_popen):
            try:
                execute_code(code="pass", task_id="backend-pp", enabled_tools=[])
            except Exception:
                pass

        return captured["PYTHONPATH"].split(os.pathsep)

    def test_interpreter_on_another_python(self):
        # code_execution.mode=project with a project venv on another Python.
        parts = self._child_pythonpath(same_env=False)
        assert parts[1:] == [USER_LIB]  # the staging dir, then the user's own

    def test_agentx_interpreter_keeps_agentx_root_only(self):
        from tools import code_execution_tool

        agentx_root = os.path.dirname(os.path.dirname(os.path.abspath(code_execution_tool.__file__)))
        parts = self._child_pythonpath(same_env=True)
        assert parts[1:] == [agentx_root, USER_LIB]


class TestSpawnedClis:
    def test_agentx_python_children_keep_the_overlay_by_default(self, posix):
        # slash worker / cli.exec: `sys.executable -m …` needs the bundled source.
        with patch.dict(os.environ, BUNDLED_ENV, clear=True):
            env = hermes_subprocess_env(inherit_credentials=True)
        assert env["PYTHONPATH"] == BUNDLED_SOURCE
        assert env["PYTHONHOME"] == BUNDLED_HOME

    def test_other_programs_lose_it(self, posix):
        with patch.dict(os.environ, BUNDLED_ENV, clear=True):
            env = hermes_subprocess_env(inherit_credentials=False, inherit_backend_python=False)
        assert "PYTHONPATH" not in env
        assert "PYTHONHOME" not in env

    def test_browser_env(self, posix):
        from tools.browser_tool import _build_browser_env

        with patch.dict(os.environ, DESKTOP_ENV, clear=True):
            env = _build_browser_env()
        assert env["PYTHONPATH"] == USER_LIB

    def test_copilot_acp_env(self, posix):
        from agent.copilot_acp_client import _build_subprocess_env

        with patch.dict(os.environ, DESKTOP_ENV, clear=True):
            env = _build_subprocess_env()
        assert env["PYTHONPATH"] == USER_LIB

    @pytest.mark.parametrize("runner", [
        "tools.tts_tool._run_command_tts",
        "tools.transcription_tools._run_command_stt",
    ])
    def test_tts_and_stt_commands(self, posix, monkeypatch, runner):
        module_name, func_name = runner.rsplit(".", 1)
        module = __import__(module_name, fromlist=[func_name])
        captured = {}

        class _Stream:
            def read(self, size=-1):
                return ""

        class Proc:
            returncode = 0
            stdout = _Stream()
            stderr = _Stream()

            def wait(self, timeout=None):
                return 0

            def poll(self):
                return 0

        def fake_popen(command, **kwargs):
            captured["env"] = kwargs["env"]
            return Proc()

        monkeypatch.setattr(f"{module_name}.subprocess.Popen", fake_popen)
        with patch.dict(os.environ, DESKTOP_ENV, clear=True):
            getattr(module, func_name)("uvx kokoro-tts hi.txt out.wav", timeout=1)
        assert captured["env"]["PYTHONPATH"] == USER_LIB

    def test_local_whisper_command(self, posix, tmp_path, monkeypatch):
        # The whisper CLI is usually a pipx tool on its own Python.
        import shlex

        import tools.transcription_tools as tt

        audio = tmp_path / "note.wav"
        audio.write_bytes(b"")
        writer = "import os,sys; open(os.path.join(sys.argv[1], 'out.txt'), 'w').write(os.environ.get('PYTHONPATH', ''))"
        monkeypatch.setattr(
            tt, "_get_local_command_template",
            lambda: f"{shlex.quote(sys.executable)} -c {shlex.quote(writer)} {{output_dir}}",
        )
        monkeypatch.setattr(tt, "_prepare_local_audio", lambda path, work_dir: (path, None))
        with patch.dict(os.environ, DESKTOP_ENV):
            result = tt._transcribe_local_command(str(audio), "base")
        assert result["success"], result
        assert result["transcript"] == USER_LIB
