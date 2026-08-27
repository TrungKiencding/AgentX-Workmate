"""Parent-death watchdog for a desktop-spawned gateway.

Problem this fixes: the desktop app spawns its backend (``agentx serve``) as an
ordinary, non-detached child and tears it down from Electron's ``before-quit``
SIGTERM (``apps/desktop/electron/main.ts``). POSIX has no equivalent of Linux's
``prctl(PR_SET_PDEATHSIG)``, so "not detached" does NOT mean the kernel reaps
the child — it is merely reparented to init. Every Electron death that skips
``before-quit`` therefore leaves a fully working gateway running forever:

  * ``concurrently -k`` killing ``electron .`` when the dev script is stopped
  * an Electron crash, a force-quit, or a FATAL GPU abort
  * a dev reload that replaces the Electron process

An orphaned gateway is not harmless. It keeps serving, and it keeps its stdio
MCP children alive — including the WebMate bridge server, which owns a FIXED
loopback port (``127.0.0.1:17374``). The next launch spawns its own bridge
server, that one loses the bind with ``EADDRINUSE`` and exits, and the new
session silently has no browser tools while the orphan keeps the extension
attached — "the extension says Connected but MCP cannot connect".

Fix: the same trick ``tools/mcp_stdio_watchdog.py`` plays one level down,
applied one level up. A daemon thread polls the direct POSIX parent identity;
the moment the original parent is gone we SIGTERM ourselves — exactly the
teardown a clean quit performs, since ``web_server`` runs uvicorn under
``capture_signals()`` — and hard-exit if that does not finish within a grace
period. The gateway's own stdio MCP children then die on their own watchdog
within ~2s, so no separate reaping is needed here.

Deliberately narrow. It only arms for desktop-spawned gateways
(``AGENTX_DESKTOP=1``), only on POSIX, and ``AGENTX_NO_PARENT_WATCHDOG=1``
switches it off. A gateway started from a shell has no parent worth watching:
the shell may exit long before the server should.
"""

from __future__ import annotations

import logging
import os
import signal
import threading
import time
from typing import Callable, Mapping, Optional

logger = logging.getLogger(__name__)

#: How often to compare the current parent against the original one.
_POLL_INTERVAL_S = 2.0

#: How long a self-addressed SIGTERM gets to finish before we insist. Generous
#: on purpose: an orphan holding its ports a few extra seconds costs nothing,
#: while cutting a legitimate graceful shutdown short would strand children.
_TERM_GRACE_S = 10.0

#: Exit status when the graceful path wedged and we had to hard-exit. Distinct
#: from 0/1 so it is recognisable in logs as "parent died, we self-terminated".
_ORPHAN_EXIT_CODE = 143  # 128 + SIGTERM, the status a SIGTERM'd process reports

DESKTOP_ENV_VAR = "AGENTX_DESKTOP"
DISABLE_ENV_VAR = "AGENTX_NO_PARENT_WATCHDOG"

_install_lock = threading.Lock()
_installed = False


def _is_orphaned(original_ppid: int, getppid: Callable[[], int] = os.getppid) -> bool:
    """Return whether this process no longer has its original POSIX parent."""
    return getppid() != original_ppid


def should_watch(
    *,
    env: Optional[Mapping[str, str]] = None,
    os_name: Optional[str] = None,
) -> bool:
    """Return whether this process is one whose parent's death should kill it.

    Three conditions, all required: POSIX (the check relies on reparenting),
    spawned by the desktop app, and not explicitly disabled.
    """
    from utils import is_truthy_value

    environ = os.environ if env is None else env
    if (os.name if os_name is None else os_name) != "posix":
        return False
    if is_truthy_value(environ.get(DISABLE_ENV_VAR, ""), default=False):
        return False
    return is_truthy_value(environ.get(DESKTOP_ENV_VAR, ""), default=False)


def _terminate_self(
    *,
    kill: Callable[[int, int], None] = os.kill,
    getpid: Callable[[], int] = os.getpid,
    sleep: Callable[[float], None] = time.sleep,
    hard_exit: Callable[[int], None] = os._exit,
    grace_s: float = _TERM_GRACE_S,
) -> None:
    """Shut down the way a clean quit does, then insist if that wedges.

    The SIGTERM is the whole point: uvicorn captures it and unwinds the server
    properly, which is the same path Electron's ``before-quit`` drives. If no
    handler is installed yet (we fired before startup finished) the default
    action terminates us here and the rest of this function never runs.
    """
    logger.warning(
        "Desktop parent process is gone — shutting this gateway down so it "
        "cannot outlive the app and hold its ports (e.g. the WebMate bridge)."
    )
    try:
        kill(getpid(), signal.SIGTERM)
    except OSError:  # pragma: no cover - only if the process is already dying
        pass
    sleep(grace_s)
    logger.error(
        "Graceful shutdown did not finish within %.0fs after the parent died; "
        "exiting hard.",
        grace_s,
    )
    hard_exit(_ORPHAN_EXIT_CODE)


def _watch_loop(
    original_ppid: int,
    *,
    poll_interval_s: float = _POLL_INTERVAL_S,
    is_orphaned: Optional[Callable[[int], bool]] = None,
    on_orphaned: Optional[Callable[[], None]] = None,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Poll the parent identity until it changes, then hand off to the killer."""
    check = is_orphaned or _is_orphaned
    handle = on_orphaned or _terminate_self
    while True:
        if check(original_ppid):
            handle()
            return
        sleep(poll_interval_s)


def install_parent_death_watchdog(
    *,
    env: Optional[Mapping[str, str]] = None,
    os_name: Optional[str] = None,
    getppid: Callable[[], int] = os.getppid,
    is_orphaned: Optional[Callable[[int], bool]] = None,
    on_orphaned: Optional[Callable[[], None]] = None,
) -> bool:
    """Arm the watchdog for this process. True when a watcher thread started.

    Idempotent: a second call is a no-op, so callers on more than one startup
    path do not each get a thread. ``is_orphaned`` / ``on_orphaned`` exist so a
    test can arm a real thread without handing it a live SIGTERM.
    """
    global _installed

    if not should_watch(env=env, os_name=os_name):
        return False

    with _install_lock:
        if _installed:
            return False

        original_ppid = getppid()
        if original_ppid <= 1:
            # Already reparented (or genuinely started by init): there is no
            # parent whose death carries information. Arming here would make
            # the watchdog fire on its first tick and kill a healthy gateway.
            logger.debug(
                "Parent-death watchdog not armed: no meaningful parent (ppid=%s)",
                original_ppid,
            )
            return False

        thread = threading.Thread(
            target=_watch_loop,
            args=(original_ppid,),
            kwargs={"is_orphaned": is_orphaned, "on_orphaned": on_orphaned},
            name="parent-death-watchdog",
            daemon=True,
        )
        thread.start()
        _installed = True

    logger.debug("Parent-death watchdog armed (parent pid %s)", original_ppid)
    return True
