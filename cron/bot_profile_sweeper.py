"""Fire the scheduled jobs of Bot Mode profiles whose own backend is not running.

Bot Mode (the desktop's "Trợ lý" page) treats every AgentX profile as an
assistant, and an assistant's "Lịch tự động" are ordinary cron jobs in THAT
profile's store (``<profile home>/cron/jobs.json``). Cron is per-profile by
design (#4707, see the top of ``cron/jobs.py``): only a ticker running under
the profile's own AGENTX_HOME may fire its jobs. The desktop only runs a
profile's backend (and so its ticker) while that profile is in use, so a daily
task made for an assistant used to sit in its store and never fire.

This sweeper closes that gap from the desktop's primary backend WITHOUT running
another profile's job inside this process. Every interval it:

1. lists the bot-managed profiles (``ui_meta['agentx-bots']`` in profile.yaml)
   other than this process's own home;
2. skips a profile whose own ticker is alive (fresh ``cron/ticker_heartbeat``,
   written every loop by that profile's backend or gateway);
3. reads the profile's ``jobs.json`` (read-only — no lock, no write) and, only
   when a runnable job is due, spawns ``agentx cron tick`` with
   ``AGENTX_HOME=<profile home>``.

The child is exactly the standalone per-profile tick the CLI offers: its own
``.env``, config.yaml, skills, MCP servers, timezone and tick lock. Keys this
process loaded from its OWN ``.env`` are stripped from the child's environment
so the launch profile's credentials never reach another profile's run (the
same environment a desktop-spawned pool backend gets).

At-most-once with a profile's own backend is the tick lock's job
(``<profile home>/cron/.tick.lock``, held by the child for its whole sync tick)
plus ``advance_next_runs`` under that lock: a ticker that loses the lock skips,
and the one that wins moves ``next_run_at`` forward before running anything, so
the loser's next tick no longer sees the job as due.

One sweeper per user root: a process-lifetime advisory lock
(``<user root>/cron/.bot_profile_sweep.lock``) makes the primary backend and
any pool backends elect a single sweeper; the others keep retrying the lock so
one takes over if the sweeper's process exits.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Optional

try:
    import fcntl
except ImportError:  # pragma: no cover - non-Unix
    fcntl = None
try:
    import msvcrt
except ImportError:  # pragma: no cover - non-Windows
    msvcrt = None

logger = logging.getLogger("cron.bot_profile_sweeper")

SWEEP_LOCK_NAME = ".bot_profile_sweep.lock"
CHILD_LOG_NAME = "cron-sweep.log"
# Rotate the child log once it grows past this (one .1 backup kept).
_CHILD_LOG_MAX_BYTES = 2 * 1024 * 1024
# A heartbeat younger than this means the profile's own ticker is alive. Three
# intervals tolerates a slow tick and clock jitter; a backend that died leaves
# a stale heartbeat, so the sweeper takes over within a few minutes.
_LIVE_TICKER_INTERVALS = 3
# Cap for the backoff applied when the same due set survives a child's run
# (emergency stop engaged, read-only license, a record the tick cannot repair):
# without it the sweeper would start a Python process every minute for nothing.
_BACKOFF_MAX_SECONDS = 30 * 60

# Environment the child must not inherit from this process: runtime-location
# overrides would re-home it, and the dashboard token / ready file belong to
# this backend's HTTP surface, not to a job that can run shell commands.
_CHILD_ENV_DROP = (
    "AGENTX_CONFIG",
    "AGENTX_CONFIG_PATH",
    "AGENTX_ENV",
    "AGENTX_ENV_PATH",
    "AGENTX_PROFILE_NAME",
    "AGENTX_TUI",
    "AGENTX_DASHBOARD_SESSION_TOKEN",
    "AGENTX_DESKTOP_READY_FILE",
)


# ── discovery ───────────────────────────────────────────────────────────────


def bot_profile_homes(own_home: Optional[Path] = None) -> list[tuple[str, Path]]:
    """``(name, home)`` of every Bot Mode profile except ``own_home``.

    Resolved through ``profiles_to_serve(multiplex=True)`` — the same
    account-aware chokepoint the multiplexing gateway uses — so a signed-in
    account only ever sees its own profiles.
    """
    from hermes_cli.profiles import profiles_to_serve
    from hermes_constants import get_hermes_home
    from tools.bot_mode_protocol import read_bots_meta

    own = Path(own_home or get_hermes_home()).resolve()
    homes: list[tuple[str, Path]] = []
    for name, home in profiles_to_serve(multiplex=True):
        try:
            resolved = Path(home).resolve()
        except OSError:
            continue
        if resolved == own or not resolved.is_dir():
            continue
        if read_bots_meta(resolved) is None:
            continue
        homes.append((name, resolved))
    return homes


# ── read-only store probes ──────────────────────────────────────────────────


def has_live_ticker(home: Path, *, interval: float = 60, now: Optional[float] = None) -> bool:
    """True when the profile's own ticker wrote a heartbeat recently."""
    try:
        stamp = float((Path(home) / "cron" / "ticker_heartbeat").read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return False
    age = (time.time() if now is None else now) - stamp
    window = interval * _LIVE_TICKER_INTERVALS
    # A future-dated stamp beyond the window (clock moved back) must not
    # starve the profile forever: treat it as stale.
    return -window < age < window


def _as_aware(dt: datetime) -> datetime:
    # Naive legacy stamps are system-local wall time (see cron.jobs._ensure_aware).
    return dt if dt.tzinfo is not None else dt.astimezone()


def due_signature(home: Path, *, now: Optional[datetime] = None) -> tuple:
    """``((job_id, next_run_at), ...)`` of the store's runnable, due jobs.

    Empty when nothing is due. Reads ``jobs.json`` without the store lock and
    never writes: a torn or unparsable file reads as "nothing due" this time
    and is retried next interval. A runnable job with a missing or unparsable
    ``next_run_at`` counts as due — the real tick knows how to recover it.
    """
    from cron.jobs import is_job_runnable

    try:
        raw = (Path(home) / "cron" / "jobs.json").read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, ValueError):
        return ()
    jobs = data.get("jobs") if isinstance(data, dict) else data
    if not isinstance(jobs, list):
        return ()

    current = now or datetime.now(timezone.utc)
    due: list[tuple[str, str]] = []
    for job in jobs:
        if not isinstance(job, dict) or not is_job_runnable(job):
            continue
        job_id = str(job.get("id") or job.get("job_id") or "")
        next_run = job.get("next_run_at")
        if next_run:
            try:
                if _as_aware(datetime.fromisoformat(str(next_run))) > current:
                    continue
            except (TypeError, ValueError):
                pass
        due.append((job_id, str(next_run or "")))
    return tuple(sorted(due))


# ── the child tick ──────────────────────────────────────────────────────────


def _launch_dotenv_keys() -> set[str]:
    """Keys this process loaded for its own profile: its ``.env`` plus any
    external secret source (Bitwarden, 1Password, …) applied to os.environ."""
    from agent.secret_scope import _is_global_env
    from hermes_cli.env_loader import _env_keys_defined_in_dotenv, get_secret_source_values
    from hermes_constants import get_hermes_home

    home = Path(get_hermes_home())
    keys = set(_env_keys_defined_in_dotenv(home / ".env"))
    try:
        keys.update(get_secret_source_values(home))
    except Exception:
        pass
    return {key for key in keys if not _is_global_env(key)}


def child_env(name: str, home: Path, *, base: Optional[dict] = None) -> dict:
    """Environment for a child tick that runs as profile ``name``."""
    env = dict(os.environ if base is None else base)
    for key in _launch_dotenv_keys():
        env.pop(key, None)
    for key in _CHILD_ENV_DROP:
        env.pop(key, None)
    # An AGENTX_HOME whose parent is ``profiles/`` is trusted verbatim by the
    # CLI's profile resolution (hermes_cli/main.py step 1.5), and the account
    # is derived from the path, so this pins both halves of the scope.
    env["AGENTX_HOME"] = str(home)
    env["AGENTX_PROFILE"] = name
    return env


def _open_child_log(home: Path):
    log_dir = Path(home) / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / CHILD_LOG_NAME
    try:
        if path.stat().st_size > _CHILD_LOG_MAX_BYTES:
            os.replace(path, path.with_name(CHILD_LOG_NAME + ".1"))
    except OSError:
        pass
    return open(path, "ab")


def spawn_profile_tick(name: str, home: Path) -> subprocess.Popen:
    """Start ``agentx cron tick`` as profile ``name`` (non-blocking)."""
    cmd = [sys.executable, "-m", "hermes_cli.main", "cron", "tick"]
    log_f = _open_child_log(home)
    try:
        return subprocess.Popen(  # noqa: S603 - fixed argv, no shell
            cmd,
            env=child_env(name, home),
            stdin=subprocess.DEVNULL,
            stdout=log_f,
            stderr=subprocess.STDOUT,
            # Same process group as this backend: the desktop's tree kill on
            # quit / update reaches the child too.
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
    finally:
        # The child holds its own inherited handle.
        log_f.close()


# ── the sweeper ─────────────────────────────────────────────────────────────


@dataclass
class _ProfileState:
    proc: Optional[subprocess.Popen] = None
    last_signature: tuple = ()
    repeats: int = 0
    retry_at: float = 0.0


class BotProfileCronSweeper:
    """Ticks Bot Mode profile stores that no ticker of their own owns."""

    def __init__(
        self,
        *,
        interval: float = 60,
        list_homes: Optional[Callable[[], Iterable[tuple[str, Path]]]] = None,
        spawn: Optional[Callable[[str, Path], subprocess.Popen]] = None,
        clock: Callable[[], float] = time.monotonic,
        lock_path: Optional[Path] = None,
    ) -> None:
        self.interval = interval
        self._list_homes = list_homes or bot_profile_homes
        self._spawn = spawn or spawn_profile_tick
        self._clock = clock
        self._lock_path = lock_path
        self._lock_fd = None
        self._states: dict[str, _ProfileState] = {}

    # -- single-sweeper election --------------------------------------------

    def _resolve_lock_path(self) -> Path:
        if self._lock_path is not None:
            return Path(self._lock_path)
        from hermes_constants import get_user_root

        return Path(get_user_root()) / "cron" / SWEEP_LOCK_NAME

    def try_acquire(self) -> bool:
        """Hold the per-root sweeper lock for this process's lifetime."""
        if self._lock_fd is not None:
            return True
        path = self._resolve_lock_path()
        fd = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fd = open(path, "a+", encoding="utf-8")
            if fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            elif msvcrt is not None:  # pragma: no cover - Windows
                fd.seek(0)
                msvcrt.locking(fd.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            if fd is not None:
                fd.close()
            return False
        self._lock_fd = fd
        return True

    def release(self) -> None:
        fd, self._lock_fd = self._lock_fd, None
        if fd is None:
            return
        try:
            if fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_UN)
            elif msvcrt is not None:  # pragma: no cover - Windows
                fd.seek(0)
                msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        fd.close()

    # -- one pass ------------------------------------------------------------

    def _backoff(self, repeats: int) -> float:
        return min(self.interval * (2 ** repeats), _BACKOFF_MAX_SECONDS)

    def sweep_once(self) -> list[str]:
        """Spawn a tick for every bot profile with due jobs; return their names."""
        spawned: list[str] = []
        now = self._clock()
        for name, home in self._list_homes():
            state = self._states.setdefault(str(home), _ProfileState())
            if state.proc is not None:
                if state.proc.poll() is None:
                    continue  # its tick is still running the jobs it claimed
                state.proc = None
            if has_live_ticker(home, interval=self.interval):
                self._states[str(home)] = _ProfileState()
                continue
            signature = due_signature(home)
            if not signature:
                state.last_signature, state.repeats = (), 0
                continue
            if signature == state.last_signature:
                # The previous child left the same jobs due: it could not fire
                # them. Retry, but with an exponential gap.
                if now < state.retry_at:
                    continue
                state.repeats += 1
            else:
                state.repeats = 0
            try:
                state.proc = self._spawn(name, home)
            except Exception as exc:
                logger.warning("Could not start the cron tick for profile %s: %s", name, exc)
                state.proc = None
            state.last_signature = signature
            state.retry_at = now + self._backoff(state.repeats + 1)
            if state.proc is not None:
                logger.info("Ticking cron jobs of profile %s (%d due)", name, len(signature))
                spawned.append(name)
        return spawned

    def stop_children(self) -> None:
        for state in self._states.values():
            proc = state.proc
            if proc is not None and proc.poll() is None:
                try:
                    proc.terminate()
                except OSError:
                    pass

    # -- loop ----------------------------------------------------------------

    def run(self, stop_event: threading.Event) -> None:
        """Loop until ``stop_event``; the caller runs this in a daemon thread."""
        announced = False
        try:
            while not stop_event.is_set():
                if self.try_acquire():
                    if not announced:
                        logger.info("Bot profile cron sweeper active (interval=%ss)", self.interval)
                        announced = True
                    try:
                        self.sweep_once()
                    except Exception as exc:  # never let one bad pass end the loop
                        logger.error("Bot profile cron sweep failed: %s", exc, exc_info=True)
                stop_event.wait(self.interval)
        finally:
            self.stop_children()
            self.release()


def start_bot_profile_sweeper(stop_event: threading.Event, interval: float = 60) -> None:
    """Thread target for the desktop backend."""
    BotProfileCronSweeper(interval=interval).run(stop_event)
