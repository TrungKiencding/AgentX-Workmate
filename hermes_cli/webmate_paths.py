"""Where AgentX WebMate lives on this machine.

One folder for everything WebMate-related, anchored at the **install root**
rather than the per-account home: the browser extension belongs to the
machine, not to whoever is signed in. Layout (see
``apps/desktop/WEBMATE-INTEGRATION-PLAN.md`` §2.1)::

    <root>/webmate/
      AgentX WebMate/          the unpacked extension folder the browser loads
        workmate.json          written by Workmate, read by the extension
      pairing.json             the pairing token the MCP server checks
      state.json               written by the MCP server (bridge state)
      commands/<uuid>.json     Workmate → server commands
      versions/, update-check.json

The MCP server (``optional-mcps/webmate/server``) resolves the same folder
from ``WEBMATE_DIR`` → ``AGENTX_HOME`` stripped of ``accounts/<slug>`` and
``profiles/<name>`` → the platform default, so the catalog passes
``WEBMATE_DIR`` explicitly and both sides agree even in a Docker-style
deployment where ``AGENTX_HOME`` is somewhere unusual.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from hermes_constants import get_default_hermes_root

#: Fixed Chrome/Edge extension ID — derived from the manifest ``key`` pinned in
#: WebMate's ``brand/brand.config.json`` (``product.extensionId``).
WEBMATE_EXTENSION_ID = "pfadeibckkgklmmjghiikadphihbpape"

#: The folder name the browser is pointed at. Never changes between versions
#: because Chrome stores the absolute path of an unpacked extension.
WEBMATE_INSTALL_DIR_NAME = "AgentX WebMate"

#: Default bridge port (the MCP server listens, the extension dials).
WEBMATE_BRIDGE_PORT = 17374


def get_webmate_dir() -> Path:
    """``WEBMATE_DIR`` when set, else ``<install root>/webmate``."""
    override = os.environ.get("WEBMATE_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    return get_default_hermes_root() / "webmate"


def get_webmate_install_dir(root: Optional[Path] = None) -> Path:
    return (root or get_webmate_dir()) / WEBMATE_INSTALL_DIR_NAME


def get_webmate_state_file(root: Optional[Path] = None) -> Path:
    return (root or get_webmate_dir()) / "state.json"


def get_webmate_pairing_file(root: Optional[Path] = None) -> Path:
    return (root or get_webmate_dir()) / "pairing.json"


def get_webmate_update_check_file(root: Optional[Path] = None) -> Path:
    return (root or get_webmate_dir()) / "update-check.json"


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    """Parse a small JSON file; ``None`` when missing, unreadable or not an object.

    Every file here is written by another process through temp + rename, so a
    torn read is not expected — but a reader that raises on a half-written
    file would take a dashboard endpoint down with it, so it never raises.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


def read_installed_extension_version(root: Optional[Path] = None) -> Optional[str]:
    """The ``version`` of the unpacked extension folder, or ``None`` when absent."""
    manifest = _read_json(get_webmate_install_dir(root) / "manifest.json")
    version = manifest.get("version") if manifest else None
    return str(version) if isinstance(version, str) and version else None


def read_bridge_state(root: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """``state.json`` as the MCP server wrote it, or ``None``.

    A ``listening: true`` from a process that no longer exists is a force-quit
    server's last words; callers get the raw document plus ``stale`` so they
    can say "not running" instead of "connected".
    """
    state = _read_json(get_webmate_state_file(root))
    if state is None:
        return None
    pid = state.get("pid")
    alive: Optional[bool] = None
    if isinstance(pid, int) and pid > 0:
        alive = _pid_alive(pid)
    state = dict(state)
    state["stale"] = bool(state.get("listening")) and alive is False
    return state


def _pid_alive(pid: int) -> bool:
    if pid == os.getpid():
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def read_pairing_summary(root: Optional[Path] = None) -> Dict[str, Any]:
    """Whether a pairing exists — never the token itself."""
    pairing = _read_json(get_webmate_pairing_file(root))
    if not pairing:
        return {"present": False, "installId": None, "port": None, "createdAt": None}
    return {
        "present": bool(pairing.get("token")),
        "installId": pairing.get("installId"),
        "port": pairing.get("port"),
        "createdAt": pairing.get("createdAt"),
    }


def read_update_check(root: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """Workmate's cached feed check (``pendingVersion`` lives here, not in state.json)."""
    return _read_json(get_webmate_update_check_file(root))
