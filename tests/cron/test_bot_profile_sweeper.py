"""Bot Mode profiles' scheduled tasks fire from the desktop's primary backend.

``cron/bot_profile_sweeper.py`` spawns an isolated per-profile ``cron tick``
for every Bot Mode profile ("Trợ lý") that has a due job and no live ticker of
its own. The unit tests pin the read-only probes, the child environment and
the sweep bookkeeping; the end-to-end tests run REAL child processes (no
network: a ``no_agent`` script job, and an agent job that stops at the
no-model guard) to prove the job fires, runs as that profile, and fires once.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from cron import bot_profile_sweeper as sweeper_mod
from cron.bot_profile_sweeper import (
    BotProfileCronSweeper,
    bot_profile_homes,
    child_env,
    due_signature,
    has_live_ticker,
    spawn_profile_tick,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
BOT_META = "ui_meta:\n  agentx-bots:\n    title: Trợ lý\n"
# The no_agent probe jobs are bash scripts.
needs_bash = pytest.mark.skipif(sys.platform == "win32", reason="bash script job")


# ── helpers ─────────────────────────────────────────────────────────────────


@pytest.fixture
def agentx_root(tmp_path, monkeypatch):
    """An AgentX root (the launch/default profile) this process runs as."""
    root = tmp_path / "agentx-root"
    root.mkdir()
    monkeypatch.setenv("AGENTX_HOME", str(root))
    return root


def make_profile(root: Path, name: str, *, bot: bool = True, env: str = "") -> Path:
    home = root / "profiles" / name
    (home / "scripts").mkdir(parents=True)
    if bot:
        (home / "profile.yaml").write_text(BOT_META, encoding="utf-8")
    if env:
        (home / ".env").write_text(env, encoding="utf-8")
    return home


def write_jobs(home: Path, jobs: list[dict]) -> None:
    cron_dir = home / "cron"
    cron_dir.mkdir(parents=True, exist_ok=True)
    (cron_dir / "jobs.json").write_text(json.dumps({"jobs": jobs}), encoding="utf-8")


def read_jobs(home: Path) -> list[dict]:
    return json.loads((home / "cron" / "jobs.json").read_text(encoding="utf-8"))["jobs"]


def iso(delta_seconds: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=delta_seconds)).isoformat()


class FakeProc:
    def __init__(self):
        self.returncode = None
        self.terminated = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = -15


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


# ── read-only probes ────────────────────────────────────────────────────────


def test_due_signature_lists_only_runnable_due_jobs(tmp_path):
    write_jobs(
        tmp_path,
        [
            {"id": "due", "enabled": True, "next_run_at": iso(-30)},
            {"id": "future", "enabled": True, "next_run_at": iso(3600)},
            {"id": "disabled", "enabled": False, "next_run_at": iso(-30)},
            {"id": "paused", "enabled": True, "state": "paused", "next_run_at": iso(-30)},
            # The real tick recovers a missing / garbled next_run_at, so the
            # probe must not hide such a job from it.
            {"id": "unanchored", "enabled": True},
            {"id": "garbled", "enabled": True, "next_run_at": "not-a-date"},
        ],
    )

    ids = [job_id for job_id, _ in due_signature(tmp_path)]

    assert ids == ["due", "garbled", "unanchored"]


def test_due_signature_never_writes_and_tolerates_bad_stores(tmp_path):
    assert due_signature(tmp_path) == ()  # no cron dir at all

    (tmp_path / "cron").mkdir()
    (tmp_path / "cron" / "jobs.json").write_text('{"jobs": [', encoding="utf-8")
    assert due_signature(tmp_path) == ()  # torn write: retried next pass
    assert (tmp_path / "cron" / "jobs.json").read_text(encoding="utf-8") == '{"jobs": ['

    write_jobs(tmp_path, [{"id": "naive", "next_run_at": "2001-01-01T00:00:00"}])
    assert [j for j, _ in due_signature(tmp_path)] == ["naive"]


def test_has_live_ticker_reads_the_profile_heartbeat(tmp_path):
    (tmp_path / "cron").mkdir()
    beat = tmp_path / "cron" / "ticker_heartbeat"
    assert has_live_ticker(tmp_path, now=10_000) is False  # never ran

    beat.write_text("10000", encoding="utf-8")
    assert has_live_ticker(tmp_path, interval=60, now=10_000 + 90) is True
    assert has_live_ticker(tmp_path, interval=60, now=10_000 + 600) is False  # backend gone
    assert has_live_ticker(tmp_path, interval=60, now=10_000 - 3600) is False  # clock skew


def test_bot_profile_homes_lists_bot_profiles_but_not_this_process(agentx_root):
    bot_a = make_profile(agentx_root, "bot-a")
    make_profile(agentx_root, "plain", bot=False)
    bot_b = make_profile(agentx_root, "bot-b")

    names = [name for name, _ in bot_profile_homes()]
    assert names == ["bot-a", "bot-b"]

    # A pool backend of bot-a must not sweep its own store.
    names = [name for name, _ in bot_profile_homes(own_home=bot_a)]
    assert names == ["bot-b"]
    assert dict(bot_profile_homes(own_home=bot_a))["bot-b"] == bot_b.resolve()


# ── the child environment ───────────────────────────────────────────────────


def test_child_env_runs_as_the_profile_without_launch_secrets(agentx_root):
    (agentx_root / ".env").write_text(
        "LAUNCH_API_KEY=launch-secret\nexport OTHER_TOKEN=x\nPATH=/launch/bin\n",
        encoding="utf-8",
    )
    bot = make_profile(agentx_root, "bot-a")
    base = {
        "LAUNCH_API_KEY": "launch-secret",
        "OTHER_TOKEN": "x",
        "PATH": "/usr/bin",
        "SHELL_EXPORT": "kept",
        "AGENTX_HOME": str(agentx_root),
        "AGENTX_CONFIG": str(agentx_root / "config.yaml"),
        "AGENTX_DASHBOARD_SESSION_TOKEN": "backend-token",
        "AGENTX_DESKTOP_READY_FILE": "/tmp/ready",
        "AGENTX_DESKTOP": "1",
    }

    env = child_env("bot-a", bot, base=base)

    assert env["AGENTX_HOME"] == str(bot)
    assert env["AGENTX_PROFILE"] == "bot-a"
    for gone in (
        "LAUNCH_API_KEY",
        "OTHER_TOKEN",
        "AGENTX_CONFIG",
        "AGENTX_DASHBOARD_SESSION_TOKEN",
        "AGENTX_DESKTOP_READY_FILE",
    ):
        assert gone not in env, gone
    # Process-global settings survive even when the launch .env names them.
    assert env["PATH"] == "/usr/bin"
    assert env["SHELL_EXPORT"] == "kept"
    assert env["AGENTX_DESKTOP"] == "1"


def test_child_env_drops_external_secret_source_values(agentx_root, monkeypatch):
    import hermes_cli.env_loader as env_loader

    monkeypatch.setitem(
        env_loader._SECRET_SOURCE_VALUES_BY_HOME,
        str(agentx_root.resolve()),
        {"VAULT_API_KEY": "from-bitwarden"},
    )
    bot = make_profile(agentx_root, "bot-a")

    env = child_env("bot-a", bot, base={"VAULT_API_KEY": "from-bitwarden", "PATH": "/usr/bin"})

    assert "VAULT_API_KEY" not in env
    assert env["PATH"] == "/usr/bin"


# ── sweep bookkeeping ───────────────────────────────────────────────────────


def _sweeper(tmp_path, homes, clock=None):
    spawned: list[tuple[str, Path, FakeProc]] = []

    def spawn(name, home):
        proc = FakeProc()
        spawned.append((name, home, proc))
        return proc

    sweeper = BotProfileCronSweeper(
        interval=60,
        list_homes=lambda: homes,
        spawn=spawn,
        clock=clock or Clock(),
        lock_path=tmp_path / "sweep.lock",
    )
    return sweeper, spawned


def test_sweep_spawns_only_for_due_profiles_and_one_child_at_a_time(tmp_path):
    due_home, idle_home = tmp_path / "due", tmp_path / "idle"
    write_jobs(due_home, [{"id": "j1", "next_run_at": iso(-5)}])
    write_jobs(idle_home, [{"id": "j2", "next_run_at": iso(3600)}])
    sweeper, spawned = _sweeper(tmp_path, [("due", due_home), ("idle", idle_home)])

    assert sweeper.sweep_once() == ["due"]
    assert [(n, h) for n, h, _ in spawned] == [("due", due_home)]

    # Its tick is still running: never start a second one for the same store.
    assert sweeper.sweep_once() == []

    # The tick finished and advanced the job: nothing is due any more.
    spawned[0][2].returncode = 0
    write_jobs(due_home, [{"id": "j1", "next_run_at": iso(3600)}])
    assert sweeper.sweep_once() == []
    assert len(spawned) == 1


def test_sweep_leaves_profiles_with_a_live_ticker_alone(tmp_path):
    home = tmp_path / "busy"
    write_jobs(home, [{"id": "j1", "next_run_at": iso(-5)}])
    (home / "cron" / "ticker_heartbeat").write_text(str(__import__("time").time()), encoding="utf-8")
    sweeper, spawned = _sweeper(tmp_path, [("busy", home)])

    assert sweeper.sweep_once() == []
    assert spawned == []


def test_unfireable_due_set_backs_off_instead_of_spawning_every_minute(tmp_path):
    """An emergency stop / read-only license leaves due jobs untouched: the
    sweeper must not start a Python process every interval for nothing."""
    home = tmp_path / "stuck"
    write_jobs(home, [{"id": "j1", "next_run_at": iso(-5)}])
    clock = Clock()
    sweeper, spawned = _sweeper(tmp_path, [("stuck", home)], clock=clock)

    assert sweeper.sweep_once() == ["stuck"]
    spawned[-1][2].returncode = 0  # exited without firing (same due set)

    clock.now += 60
    assert sweeper.sweep_once() == []  # first retry waits 2 intervals
    clock.now += 61
    assert sweeper.sweep_once() == ["stuck"]
    spawned[-1][2].returncode = 0

    clock.now += 121
    assert sweeper.sweep_once() == []  # the gap doubles
    clock.now += 120
    assert sweeper.sweep_once() == ["stuck"]
    spawned[-1][2].returncode = 0

    # A change in the due set (a new job, an edit) retries at once.
    write_jobs(home, [{"id": "j1", "next_run_at": iso(-5)}, {"id": "j2", "next_run_at": iso(-1)}])
    clock.now += 1
    assert sweeper.sweep_once() == ["stuck"]


def test_backoff_is_capped(tmp_path):
    sweeper, _ = _sweeper(tmp_path, [])
    assert sweeper._backoff(1) == 120
    assert sweeper._backoff(30) == 30 * 60


def test_one_sweeper_per_root(tmp_path):
    lock = tmp_path / "cron" / sweeper_mod.SWEEP_LOCK_NAME
    first = BotProfileCronSweeper(list_homes=list, lock_path=lock)
    second = BotProfileCronSweeper(list_homes=list, lock_path=lock)

    assert first.try_acquire() is True
    assert second.try_acquire() is False
    first.release()
    assert second.try_acquire() is True
    second.release()


def test_run_sweeps_then_terminates_children_and_releases_on_stop(tmp_path):
    home = tmp_path / "bot"
    write_jobs(home, [{"id": "j1", "next_run_at": iso(-5)}])
    stop = threading.Event()
    procs: list[FakeProc] = []

    def spawn(name, home):
        procs.append(FakeProc())
        stop.set()  # one pass is enough
        return procs[-1]

    lock = tmp_path / "sweep.lock"
    sweeper = BotProfileCronSweeper(
        interval=0.01, list_homes=lambda: [("bot", home)], spawn=spawn, lock_path=lock
    )
    sweeper.run(stop)

    assert len(procs) == 1 and procs[0].terminated
    other = BotProfileCronSweeper(list_homes=list, lock_path=lock)
    assert other.try_acquire() is True  # the lock was released
    other.release()


# ── end to end: real child ticks ────────────────────────────────────────────


@pytest.fixture
def child_python_path(monkeypatch):
    """Children run ``sys.executable -m hermes_cli.main``: make them import
    this checkout, and keep the cron conftest's AGENTX_MODEL out of them (a
    configured model would let an agent job try to reach a provider)."""
    existing = os.environ.get("PYTHONPATH", "")
    monkeypatch.setenv("PYTHONPATH", os.pathsep.join(p for p in (str(REPO_ROOT), existing) if p))
    monkeypatch.delenv("AGENTX_MODEL", raising=False)


def _add_script_job(bot: Path, script_body: str, *, next_run_at: str) -> str:
    from cron.jobs import create_job, load_jobs, save_jobs, use_cron_store
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    (bot / "scripts" / "probe.sh").write_text(script_body, encoding="utf-8")
    token = set_hermes_home_override(str(bot))
    try:
        with use_cron_store(bot):
            job = create_job(
                prompt=None,
                schedule="every 5m",
                script="probe.sh",
                no_agent=True,
                deliver="local",
                name="probe",
            )
            jobs = load_jobs()
            jobs[0]["next_run_at"] = next_run_at
            save_jobs(jobs)
    finally:
        reset_hermes_home_override(token)
    return job["id"]


def _sweep_and_wait(sweeper: BotProfileCronSweeper) -> list[str]:
    names = sweeper.sweep_once()
    for state in sweeper._states.values():
        if state.proc is not None:
            assert state.proc.wait(timeout=120) == 0
    return names


def test_cron_manage_add_job_fires_from_the_default_backend(
    agentx_root, child_python_path, tmp_path
):
    """The done criterion: a job added through ``cron.manage add`` with
    ``profile: <bot>`` fires with only the default backend running, in that
    profile's store. No model is configured, so the run stops at the
    no-model guard before any provider call — it still counts as a fire."""
    from tui_gateway import server

    bot = make_profile(agentx_root, "bot-a")
    resp = server.handle_request(
        {
            "id": "1",
            "method": "cron.manage",
            "params": {
                "action": "add",
                "name": "Bản tin sáng",
                "schedule": "* * * * *",
                "prompt": "Tóm tắt tin công nghệ",
                "profile": "bot-a",
            },
        }
    )
    assert resp["result"]["success"] is True, resp
    # Make it due now, at an instant its cron expression matches.
    jobs = read_jobs(bot)
    jobs[0]["next_run_at"] = datetime.now().astimezone().replace(second=0, microsecond=0).isoformat()
    write_jobs(bot, jobs)

    sweeper = BotProfileCronSweeper(lock_path=tmp_path / "sweep.lock")
    assert _sweep_and_wait(sweeper) == ["bot-a"]

    job = read_jobs(bot)[0]
    assert job["last_run_at"], job
    assert "no model configured" in (job.get("last_error") or ""), job
    assert any((bot / "cron" / "output" / job["id"]).iterdir())
    assert "Running job 'Bản tin sáng'" in (bot / "logs" / "agent.log").read_text(encoding="utf-8")
    # Nothing leaked into the launch profile's store.
    assert not (agentx_root / "cron" / "jobs.json").exists()
    assert not (agentx_root / "cron" / "output").exists()


@needs_bash
def test_job_runs_with_the_profile_env_not_the_launch_env(
    agentx_root, child_python_path, tmp_path, monkeypatch
):
    (agentx_root / ".env").write_text("LAUNCH_SECRET=launch\n", encoding="utf-8")
    monkeypatch.setenv("LAUNCH_SECRET", "launch")  # as if loaded at startup
    bot = make_profile(agentx_root, "bot-a", env="BOT_SECRET=bot\n")
    out = tmp_path / "out.txt"
    _add_script_job(
        bot,
        f'echo "$AGENTX_HOME|${{LAUNCH_SECRET:-}}|${{BOT_SECRET:-}}|$AGENTX_PROFILE" >> "{out}"\n',
        next_run_at=iso(-10),
    )

    sweeper = BotProfileCronSweeper(lock_path=tmp_path / "sweep.lock")
    assert _sweep_and_wait(sweeper) == ["bot-a"]

    assert out.read_text(encoding="utf-8").splitlines() == [f"{bot}||bot|bot-a"]
    assert read_jobs(bot)[0]["last_status"] == "ok"
    # The run advanced next_run_at, so the next pass has nothing to do.
    assert sweeper.sweep_once() == []


@needs_bash
def test_job_fires_once_alongside_another_ticker(agentx_root, child_python_path, tmp_path):
    """At-most-once with the profile's own backend comes from the per-profile
    tick lock plus ``advance_next_runs`` under it."""
    import fcntl

    bot = make_profile(agentx_root, "bot-a")
    out = tmp_path / "out.txt"
    _add_script_job(bot, f'sleep 1\necho fired >> "{out}"\n', next_run_at=iso(-10))

    # 1) The profile's own ticker is mid-tick (holds the lock): the child skips.
    lock_file = bot / "cron" / ".tick.lock"
    with open(lock_file, "w", encoding="utf-8") as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert spawn_profile_tick("bot-a", bot).wait(timeout=120) == 0
        fcntl.flock(held, fcntl.LOCK_UN)
    assert not out.exists()
    assert due_signature(bot)  # still due for whoever ticks next

    # 2) Two tickers race for the same due job: it fires exactly once.
    racers = [spawn_profile_tick("bot-a", bot) for _ in range(2)]
    assert [proc.wait(timeout=120) for proc in racers] == [0, 0]
    assert out.read_text(encoding="utf-8").splitlines() == ["fired"]
    assert due_signature(bot) == ()


# ── wiring ──────────────────────────────────────────────────────────────────


def test_desktop_backend_starts_the_sweeper(monkeypatch):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")
    import cron.scheduler as sched
    from hermes_cli.web_server import app

    started = threading.Event()
    monkeypatch.setattr(sched, "tick", lambda *a, **k: 0)
    monkeypatch.setattr(sweeper_mod, "start_bot_profile_sweeper", lambda stop, **k: started.set())
    monkeypatch.setenv("AGENTX_DESKTOP", "1")

    with TestClient(app):
        assert started.wait(3.0), "expected the bot profile sweeper under AGENTX_DESKTOP=1"
