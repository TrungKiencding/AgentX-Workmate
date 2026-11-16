"""Bring the messaging gateway back when the desktop opens.

The messaging gateway (Telegram, Discord, …) is its own process. The desktop
starts it detached from the backend, so it outlives the window and any backend
restart, but a reboot ends it, and nothing started it again: the bot stayed
silent until the person went looking for "Restart gateway". The desktop now
calls ``POST /api/gateway/autostart`` after every successful local boot (behind
sign-in, once it has settled whose home this is), and this route starts the
gateway when there is work for it and nobody else is in charge of it.

It never stops or replaces a healthy gateway. It starts one only when:

- at least one platform is enabled and configured: the same rule the gateway
  itself uses to pick the adapters it connects;
- no gateway is running for this home. That is the PID file / runtime lock the
  gateway owns, which is scoped to ``AGENTX_HOME``. A process-table scan is not
  scoped that way, and would take another account's gateway for this one;
- no service manager (launchd, systemd, a Windows Scheduled Task or Startup
  entry) is installed for it. That manager owns the lifecycle, and a copy
  started here would hold the lock and leave the supervised one flapping;
- no gateway start, stop or restart from this backend is still running.

One gateway is not left alone: one that is running code which is no longer on
disk. The gateway is started detached so that it survives the window — which
also means it survives an app upgrade that replaces the checkout it was loaded
from and deletes the old one. That gateway keeps answering on the old version,
with a deleted working directory and modules it can no longer import (pilot
feedback 2026-11: a Telegram reply reported files "NOT modified … [Errno 2] No
such file or directory" for files it had written). It is restarted, through
the same action the "Restart gateway" button runs, so it comes back on the
installed version. A service manager still owns its own gateway.

The launch matches what "Restart gateway" ends up doing on each OS, minus the
stop. On macOS and Linux the detached action process *is* the gateway
(``gateway run``). It runs quiet, because the gateway already writes its own
rotating logs and the unrotated action log only needs what it prints while
starting. On Windows ``gateway start`` hands off to the canonical detached
launcher, which never installs login persistence from a non-interactive action.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from starlette.concurrency import run_in_threadpool

from hermes_cli.web_deps import late, late_attr

_log = logging.getLogger("hermes_cli.web_server")

router = APIRouter()

_load_configured_gateway_platforms = late("_load_configured_gateway_platforms")
_spawn_hermes_action = late("_spawn_hermes_action")
_spawn_gateway_restart = late("_spawn_gateway_restart")

#: The action name this route spawns under (its log is logs/gateway-autostart.log).
ACTION_NAME = "gateway-autostart"

#: Lifecycle actions this backend can have in flight. While one runs, the
#: gateway is about to change state and a start here would race it.
_LIFECYCLE_ACTIONS = ("gateway-start", "gateway-restart", "gateway-stop", ACTION_NAME)

# Two calls at once (two windows booting, a boot retried) must not both pass
# the checks before either has spawned.
_decide_lock = threading.Lock()


def gateway_launch_command() -> List[str]:
    """The ``agentx`` argv that starts this home's gateway without a service."""
    if sys.platform == "win32":
        return ["gateway", "start"]
    return ["gateway", "run", "--quiet"]


def _service_installed() -> bool:
    if sys.platform == "win32":
        from hermes_cli import gateway_windows

        return gateway_windows.is_installed()

    from hermes_cli.gateway import get_gateway_runtime_snapshot

    return get_gateway_runtime_snapshot().service_installed


def _lifecycle_action_in_flight() -> Optional[str]:
    procs = late_attr("_ACTION_PROCS")
    for name in _LIFECYCLE_ACTIONS:
        proc = procs.get(name)
        if proc is not None and proc.poll() is None:
            return name
    return None


def _process_cwd_is_gone(pid: int) -> bool:
    """True when the process's working directory has been deleted.

    For a gateway that predates the ``code_root`` record: the desktop starts
    it with the checkout as its working directory, so a deleted cwd is the
    deleted checkout. Unknown (no psutil, no access, an empty answer) is False:
    a gateway is only restarted on evidence.
    """
    try:
        import psutil  # type: ignore

        cwd = psutil.Process(pid).cwd()
    except FileNotFoundError:
        return True
    except Exception:  # noqa: BLE001 - NoSuchProcess, AccessDenied, ZombieProcess, ImportError
        return False
    if not cwd:
        return False
    # Linux reports an unlinked directory as "<path> (deleted)".
    return cwd.endswith(" (deleted)") or not os.path.isdir(cwd)


def running_gateway_is_stale(pid: int) -> bool:
    """Is the gateway at ``pid`` running code that is no longer on disk?"""
    from gateway.status import running_gateway_code_root

    code_root = running_gateway_code_root()
    if code_root is not None:
        return not os.path.isdir(code_root)
    return _process_cwd_is_gone(pid)


def autostart_gateway() -> Dict[str, Any]:
    """Start the gateway if it has work and nothing else owns it; say why not otherwise."""
    from gateway.status import get_running_pid

    with _decide_lock:
        platforms = sorted(_load_configured_gateway_platforms())
        if not platforms:
            return {"started": False, "reason": "no_platforms", "platforms": []}

        pid = get_running_pid()
        service = _service_installed() if pid is None else None

        if pid is not None:
            stale = running_gateway_is_stale(pid)
            if not stale:
                return {"started": False, "reason": "running", "pid": pid, "platforms": platforms}
            if _service_installed():
                # Its manager restarts it on its own terms (and on upgrade).
                return {"started": False, "reason": "service", "platforms": platforms}
            busy = _lifecycle_action_in_flight()
            if busy is not None:
                return {"started": False, "reason": "busy", "action": busy, "platforms": platforms}
            proc, _reused = _spawn_gateway_restart()
            _log.info(
                "Gateway autostart: gateway pid %s runs a checkout that is gone; "
                "restarting it (pid %s) for %s",
                pid,
                proc.pid,
                ", ".join(platforms),
            )
            return {"started": True, "reason": "restarted_stale", "pid": pid, "platforms": platforms}

        if service:
            return {"started": False, "reason": "service", "platforms": platforms}

        busy = _lifecycle_action_in_flight()
        if busy is not None:
            return {"started": False, "reason": "busy", "action": busy, "platforms": platforms}

        command = gateway_launch_command()
        proc = _spawn_hermes_action(command, ACTION_NAME)
        _log.info(
            "Gateway autostart: `agentx %s` (pid %s) for %s",
            " ".join(command),
            proc.pid,
            ", ".join(platforms),
        )
        return {"started": True, "reason": "started", "platforms": platforms}


@router.post("/api/gateway/autostart")
async def post_gateway_autostart():
    try:
        return await run_in_threadpool(autostart_gateway)
    except Exception as exc:
        _log.exception("Gateway autostart failed")
        raise HTTPException(status_code=500, detail=f"Failed to start gateway: {exc}")
