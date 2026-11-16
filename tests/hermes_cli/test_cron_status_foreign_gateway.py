"""`agentx cron status` must only count gateways of the current AGENTX_HOME.

The process-table scan attributes a flag-less ``gateway run`` to the current
home from its argv alone, but AGENTX_HOME travels in the environment. A
gateway that belongs to another home (a second account, a leaked sandbox)
used to make this home report "Gateway is running — cron jobs will fire
automatically" while nothing was ticking its jobs.

These tests run a real child process whose argv is a gateway entrypoint, so
the real scan and the real process-environment read are exercised.
"""

import subprocess
import sys
import time

import pytest

import hermes_cli.gateway as gateway_mod
from hermes_cli import cron as cron_cli

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="spawns a POSIX-style stand-in gateway process"
)

RUNNING = "Gateway is running"
NOT_RUNNING = "Gateway is not running"


@pytest.fixture
def current_home(tmp_path, monkeypatch):
    home = tmp_path / "current-home"
    home.mkdir()
    monkeypatch.setenv("AGENTX_HOME", str(home))
    # No service manager in the picture: only the PID file and the scan count.
    monkeypatch.setattr(gateway_mod, "_get_service_pids", lambda *a, **k: set())
    monkeypatch.setattr(cron_cli, "_active_cron_provider_name", lambda: "builtin")
    monkeypatch.setattr("cron.jobs.list_jobs", lambda **k: [])
    return home


@pytest.fixture
def spawn_gateway(tmp_path):
    """Start a process the scan recognises as ``gateway run`` in a given home."""
    script = tmp_path / "stand-in" / "gateway" / "run.py"
    script.parent.mkdir(parents=True)
    script.write_text("import time\ntime.sleep(120)\n", encoding="utf-8")
    children = []

    def _spawn(home):
        env = {"PATH": "/usr/bin:/bin"}
        if home is not None:
            env["AGENTX_HOME"] = str(home)
        child = subprocess.Popen([sys.executable, str(script)], env=env)
        children.append(child)
        # The scan reads the process table; give the child time to exec.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if child.pid in gateway_mod._scan_gateway_pids(set(), all_profiles=True):
                break
            time.sleep(0.05)
        else:
            pytest.fail("stand-in gateway never showed up in the process scan")
        return child.pid

    yield _spawn

    for child in children:
        child.kill()
        child.wait(timeout=10)


def test_gateway_of_another_home_is_not_reported_running(
    current_home, spawn_gateway, tmp_path, capsys
):
    foreign_home = tmp_path / "other-account-home"
    foreign_home.mkdir()
    foreign_pid = spawn_gateway(foreign_home)

    cron_cli.cron_status()
    out = capsys.readouterr().out

    assert NOT_RUNNING in out
    assert RUNNING not in out
    assert str(foreign_pid) not in out
    assert cron_cli._builtin_gateway_liveness() is False


def test_gateway_with_no_home_in_its_environment_is_not_this_custom_home(
    current_home, spawn_gateway, capsys
):
    # No AGENTX_HOME in the environment means the platform default root,
    # which is not this (custom) home.
    spawn_gateway(None)

    cron_cli.cron_status()
    out = capsys.readouterr().out

    assert NOT_RUNNING in out
    assert RUNNING not in out


def test_gateway_of_this_home_is_still_found_without_a_pid_file(
    current_home, spawn_gateway, capsys
):
    # The scan exists to spot a live gateway whose PID file is missing.
    own_pid = spawn_gateway(current_home)

    assert gateway_mod.find_gateway_pids(home_verified=True) == [own_pid]

    cron_cli.cron_status()
    out = capsys.readouterr().out

    assert RUNNING in out
    assert f"PID: {own_pid}" in out
    assert cron_cli._builtin_gateway_liveness() is True


def test_other_callers_keep_the_unverified_scan(current_home, spawn_gateway, tmp_path):
    # `gateway status`/`stop` and `agentx update` are deliberately unchanged.
    foreign_home = tmp_path / "other-account-home"
    foreign_home.mkdir()
    foreign_pid = spawn_gateway(foreign_home)

    assert foreign_pid in gateway_mod.find_gateway_pids()
    assert foreign_pid in gateway_mod.find_gateway_pids(all_profiles=True)
    assert foreign_pid not in gateway_mod.find_gateway_pids(home_verified=True)


def test_account_gateway_is_not_attributed_to_a_flagless_home(current_home, monkeypatch):
    # ``--account <slug>`` re-homes the gateway in-process; argv is the only
    # place it shows.
    listing = "4242 /opt/agentx/venv/bin/python -m hermes_cli.main --account kien gateway run\n"
    monkeypatch.setattr(gateway_mod.os.path, "isdir", lambda p: False)
    monkeypatch.setattr(
        gateway_mod.subprocess,
        "run",
        lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout=listing, stderr=""),
    )
    monkeypatch.setattr(
        gateway_mod, "_gateway_pid_runs_in_home", lambda pid, home: True
    )

    assert gateway_mod._scan_gateway_pids(set(), home_verified=True) == []


# ── The desktop app runs the scheduler itself ──────────────────────────────
#
# A desktop backend (AGENTX_DESKTOP=1) ticks this home's jobs while the app is
# open, with no gateway process. The `cronjob` tool used to read "no gateway"
# as "will NOT fire" and the model told desktop users to run
# `agentx gateway install` for a reminder the app then fired on time.

APP_RUNNING = "desktop app is running the scheduler"


def _write_heartbeat(home, age_seconds):
    cron_dir = home / "cron"
    cron_dir.mkdir(parents=True, exist_ok=True)
    (cron_dir / "ticker_heartbeat").write_text(str(time.time() - age_seconds), encoding="utf-8")


def test_desktop_backend_counts_as_a_running_scheduler(current_home, monkeypatch):
    monkeypatch.setenv("AGENTX_DESKTOP", "1")

    assert cron_cli._builtin_gateway_liveness() is True

    from tools.cronjob_tools import _gateway_liveness_notice

    notice = _gateway_liveness_notice()
    assert notice == {"gateway_running": True}
    assert "warning" not in notice


def test_fresh_app_ticker_heartbeat_reports_jobs_will_fire(current_home, monkeypatch, capsys):
    monkeypatch.delenv("AGENTX_DESKTOP", raising=False)
    _write_heartbeat(current_home, age_seconds=30)

    assert cron_cli._builtin_gateway_liveness() is True

    cron_cli.cron_status()
    out = capsys.readouterr().out
    assert APP_RUNNING in out
    assert NOT_RUNNING not in out


def test_stale_ticker_heartbeat_still_reports_not_running(current_home, monkeypatch, capsys):
    # The app closed long ago: its last heartbeat must not keep claiming jobs fire.
    monkeypatch.delenv("AGENTX_DESKTOP", raising=False)
    _write_heartbeat(current_home, age_seconds=3600)

    assert cron_cli._builtin_gateway_liveness() is False

    from tools.cronjob_tools import _gateway_liveness_notice

    notice = _gateway_liveness_notice()
    assert notice["gateway_running"] is False
    assert "warning" in notice

    cron_cli.cron_status()
    out = capsys.readouterr().out
    assert NOT_RUNNING in out
    assert APP_RUNNING not in out
