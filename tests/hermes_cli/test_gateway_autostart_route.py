"""``POST /api/gateway/autostart``: the desktop's once-per-launch gateway start.

The route is one decision followed by at most one spawn. These tests pin every
reason it declines for, that concurrent calls never spawn twice, and the exact
launch on each OS: argv, detachment and log file, through the real
``_spawn_hermes_action`` with only ``Popen`` captured.
"""

from __future__ import annotations

import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from hermes_cli import web_server
from hermes_cli.web_routers import gateway_autostart as autostart


class _Proc:
    def __init__(self, pid: int = 4242, alive: bool = True) -> None:
        self.pid = pid
        self.alive = alive

    def poll(self):
        return None if self.alive else 0


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Telegram is configured, no gateway runs, no service, nothing in flight."""
    state = SimpleNamespace(platforms={"telegram"}, running_pid=None, service=False, spawns=[])

    monkeypatch.setattr(web_server, "_load_configured_gateway_platforms", lambda: set(state.platforms))
    monkeypatch.setattr("gateway.status.get_running_pid", lambda *a, **k: state.running_pid)
    monkeypatch.setattr(autostart, "_service_installed", lambda: state.service)
    monkeypatch.setattr(web_server, "_ACTION_PROCS", {})

    def spawn(command, name):
        # Registers the handle the way the real _spawn_hermes_action does, so
        # a second call can see the first one in flight.
        proc = _Proc(pid=5000 + len(state.spawns))
        state.spawns.append((list(command), name))
        web_server._ACTION_PROCS[name] = proc
        return proc

    monkeypatch.setattr(web_server, "_spawn_hermes_action", spawn)
    return state


def test_starts_the_gateway_when_a_channel_is_on_and_nothing_runs_it(world, monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")

    assert autostart.autostart_gateway() == {"started": True, "reason": "started", "platforms": ["telegram"]}
    assert world.spawns == [(["gateway", "run", "--quiet"], "gateway-autostart")]


def test_no_channel_turned_on_starts_nothing(world):
    world.platforms = set()

    assert autostart.autostart_gateway() == {"started": False, "reason": "no_platforms", "platforms": []}
    assert world.spawns == []


def test_a_running_gateway_is_left_alone(world):
    world.running_pid = 777

    result = autostart.autostart_gateway()

    assert result == {"started": False, "reason": "running", "pid": 777, "platforms": ["telegram"]}
    assert world.spawns == []


def test_a_service_manager_keeps_the_lifecycle(world):
    """launchd/systemd/Scheduled Task owns it; an unsupervised copy would make it flap."""
    world.service = True

    assert autostart.autostart_gateway() == {"started": False, "reason": "service", "platforms": ["telegram"]}
    assert world.spawns == []


@pytest.mark.parametrize("action", ["gateway-start", "gateway-restart", "gateway-stop", "gateway-autostart"])
def test_an_in_flight_lifecycle_action_is_not_raced(world, action):
    web_server._ACTION_PROCS[action] = _Proc(alive=True)

    result = autostart.autostart_gateway()

    assert result == {"started": False, "reason": "busy", "action": action, "platforms": ["telegram"]}
    assert world.spawns == []


def test_a_finished_lifecycle_action_does_not_block_a_start(world):
    # A restart that ran and exited earlier (its gateway since died) is history.
    web_server._ACTION_PROCS["gateway-restart"] = _Proc(alive=False)

    assert autostart.autostart_gateway()["started"] is True
    assert len(world.spawns) == 1


def test_a_second_call_while_the_gateway_boots_does_not_spawn_again(world):
    """The gateway writes its PID file seconds after spawn; the in-flight action covers that gap."""
    assert autostart.autostart_gateway()["started"] is True

    assert autostart.autostart_gateway() == {
        "started": False,
        "reason": "busy",
        "action": "gateway-autostart",
        "platforms": ["telegram"],
    }
    assert len(world.spawns) == 1


def test_concurrent_calls_spawn_exactly_once(world, monkeypatch):
    def slow_platforms():
        time.sleep(0.05)  # widen the check-then-spawn window
        return {"telegram"}

    monkeypatch.setattr(web_server, "_load_configured_gateway_platforms", slow_platforms)
    results = []
    threads = [threading.Thread(target=lambda: results.append(autostart.autostart_gateway())) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(world.spawns) == 1
    assert sorted(r["reason"] for r in results) == ["busy"] * 7 + ["started"]


def test_windows_hands_off_to_the_detached_launcher(world, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")

    assert autostart.autostart_gateway()["started"] is True
    assert world.spawns == [(["gateway", "start"], "gateway-autostart")]


def test_service_check_asks_the_platform_service_manager(monkeypatch):
    import hermes_cli.gateway as gateway
    import hermes_cli.gateway_windows as gateway_windows

    monkeypatch.setattr(sys, "platform", "darwin")
    snapshot = SimpleNamespace(service_installed=True)
    monkeypatch.setattr(gateway, "get_gateway_runtime_snapshot", lambda: snapshot)
    assert autostart._service_installed() is True
    snapshot.service_installed = False
    assert autostart._service_installed() is False

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(gateway_windows, "is_installed", lambda: True)
    assert autostart._service_installed() is True
    monkeypatch.setattr(gateway_windows, "is_installed", lambda: False)
    assert autostart._service_installed() is False


@pytest.mark.skipif(sys.platform == "win32", reason="the POSIX detachment is what is under test")
def test_posix_launch_is_a_detached_quiet_gateway_run_logging_to_its_own_file(monkeypatch, tmp_path):
    """Through the real _spawn_hermes_action: only Popen is captured."""
    monkeypatch.setattr(web_server, "_load_configured_gateway_platforms", lambda: {"telegram"})
    monkeypatch.setattr("gateway.status.get_running_pid", lambda *a, **k: None)
    monkeypatch.setattr(autostart, "_service_installed", lambda: False)
    monkeypatch.setattr(web_server, "_ACTION_PROCS", {})
    monkeypatch.setattr(web_server, "_ACTION_COMMANDS", {})
    monkeypatch.setattr(web_server, "_ACTION_LOG_DIR", tmp_path / "logs")
    monkeypatch.setenv("_AGENTX_GATEWAY", "1")
    captured = {}

    def fake_popen(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        return _Proc(pid=31337)

    monkeypatch.setattr(web_server.subprocess, "Popen", fake_popen)

    assert autostart.autostart_gateway()["started"] is True

    assert captured["cmd"] == [sys.executable, "-m", "hermes_cli.main", "gateway", "run", "--quiet"]
    kwargs = captured["kwargs"]
    assert kwargs["start_new_session"] is True
    assert kwargs["stdin"] is subprocess.DEVNULL
    assert kwargs["env"]["AGENTX_NONINTERACTIVE"] == "1"
    # Inherited from a gateway-hosted dashboard, this would trip the gateway's
    # restart-loop guard and make it exit at once.
    assert "_AGENTX_GATEWAY" not in kwargs["env"]
    log = tmp_path / "logs" / "gateway-autostart.log"
    assert "=== gateway-autostart started" in log.read_text(encoding="utf-8")
    assert web_server._ACTION_PROCS["gateway-autostart"].pid == 31337


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(web_server.app.state, "auth_required", False, raising=False)
    # start_server() tests elsewhere leave a bound host on the shared app, and
    # the Host-header middleware then answers "testserver" with a 400.
    monkeypatch.setattr(web_server.app.state, "bound_host", None, raising=False)
    with TestClient(web_server.app) as test_client:
        yield test_client


def _auth_headers():
    return {web_server._SESSION_HEADER_NAME: web_server._SESSION_TOKEN}


def test_route_answers_with_the_decision(world, client):
    response = client.post("/api/gateway/autostart", headers=_auth_headers())

    assert response.status_code == 200
    assert response.json() == {"started": True, "reason": "started", "platforms": ["telegram"]}


def test_route_reports_a_failed_spawn_as_a_server_error(world, client, monkeypatch):
    def broken_spawn(command, name):
        raise OSError("no such interpreter")

    monkeypatch.setattr(web_server, "_spawn_hermes_action", broken_spawn)

    response = client.post("/api/gateway/autostart", headers=_auth_headers())

    assert response.status_code == 500
    assert "no such interpreter" in response.json()["detail"]


def test_route_requires_the_session_credential(world, client):
    response = client.post("/api/gateway/autostart")

    assert response.status_code == 401
    assert world.spawns == []


# ── a gateway that outlived the checkout it runs ───────────────────────────
#
# The gateway is started detached, so it survives an app upgrade that replaces
# its checkout and deletes the old one. It then keeps answering on the old
# version from a deleted working directory (pilot feedback 2026-11: a Telegram
# reply reported "[write_file] [Errno 2] No such file or directory" for files
# it had written).


@pytest.fixture
def restarts(world, monkeypatch):
    calls: list[tuple] = []

    def restart(profile=None):
        calls.append((profile,))
        proc = _Proc(pid=6000 + len(calls))
        web_server._ACTION_PROCS["gateway-restart"] = proc
        return proc, False

    monkeypatch.setattr(web_server, "_spawn_gateway_restart", restart)
    return calls


def test_a_gateway_whose_checkout_is_gone_is_restarted(world, restarts, monkeypatch):
    world.running_pid = 777
    monkeypatch.setattr(autostart, "running_gateway_is_stale", lambda pid: True)

    result = autostart.autostart_gateway()

    assert result == {"started": True, "reason": "restarted_stale", "pid": 777, "platforms": ["telegram"]}
    assert restarts == [(None,)]
    # A restart, never a second gateway beside the first.
    assert world.spawns == []


def test_a_stale_gateway_under_a_service_manager_is_left_to_it(world, restarts, monkeypatch):
    world.running_pid = 777
    world.service = True
    monkeypatch.setattr(autostart, "running_gateway_is_stale", lambda pid: True)

    assert autostart.autostart_gateway()["reason"] == "service"
    assert restarts == []


def test_a_stale_gateway_is_not_restarted_twice_at_once(world, restarts, monkeypatch):
    world.running_pid = 777
    monkeypatch.setattr(autostart, "running_gateway_is_stale", lambda pid: True)

    autostart.autostart_gateway()
    second = autostart.autostart_gateway()

    assert second["reason"] == "busy"
    assert second["action"] == "gateway-restart"
    assert len(restarts) == 1


def test_stale_means_the_recorded_code_root_no_longer_exists(tmp_path, monkeypatch):
    from gateway import status

    here = tmp_path / "checkout"
    here.mkdir()
    monkeypatch.setattr(status, "running_gateway_code_root", lambda pid_path=None: str(here))
    assert autostart.running_gateway_is_stale(777) is False

    here.rmdir()
    assert autostart.running_gateway_is_stale(777) is True


def test_a_gateway_without_a_record_is_judged_by_its_working_directory(tmp_path, monkeypatch):
    """Gateways started before the record existed are the ones an upgrade to
    this version finds running."""
    import psutil

    from gateway import status

    monkeypatch.setattr(status, "running_gateway_code_root", lambda pid_path=None: None)

    def process(cwd=None, error=None):
        class _Process:
            def __init__(self, pid):
                pass

            def cwd(self):
                if error is not None:
                    raise error
                return cwd

        monkeypatch.setattr(psutil, "Process", _Process)

    process(cwd=str(tmp_path))
    assert autostart.running_gateway_is_stale(777) is False

    process(cwd=str(tmp_path / "removed"))
    assert autostart.running_gateway_is_stale(777) is True

    process(cwd="/opt/agentx/checkout (deleted)")
    assert autostart.running_gateway_is_stale(777) is True

    process(error=FileNotFoundError(2, "No such file or directory"))
    assert autostart.running_gateway_is_stale(777) is True

    # No evidence, no restart.
    process(cwd="")
    assert autostart.running_gateway_is_stale(777) is False
    process(error=psutil.AccessDenied(777))
    assert autostart.running_gateway_is_stale(777) is False
    process(error=psutil.NoSuchProcess(777))
    assert autostart.running_gateway_is_stale(777) is False


def test_the_gateway_records_the_checkout_it_runs(tmp_path):
    from pathlib import Path

    from gateway import status

    record = status._build_pid_record()

    assert Path(record["code_root"]) == Path(status.__file__).resolve().parent.parent
    pid_file = tmp_path / "gateway.pid"
    pid_file.write_text(__import__("json").dumps(record))
    assert status.running_gateway_code_root(pid_file) == record["code_root"]
    pid_file.write_text(__import__("json").dumps({"pid": 1, "kind": record["kind"]}))
    assert status.running_gateway_code_root(pid_file) is None
