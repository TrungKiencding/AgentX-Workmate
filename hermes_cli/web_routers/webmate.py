"""AgentX WebMate status for the desktop app.

One read-only endpoint that folds together what the desktop needs to render
the browser-connection state without knowing where the pieces live: the MCP
server's registration in ``config.yaml``, the unpacked extension folder
Workmate manages, the pairing, the bridge's own ``state.json`` (written by the
running MCP server) and the cached update check. Enabling/disabling reuses
``PUT /api/mcp/servers/webmate/enabled``.

Every file read here is written by another process (the desktop app or the
MCP server) through temp + rename; a missing or half-written file yields
``null`` fields, never a 500 — the desktop polls this while things are being
installed.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter

from hermes_cli.web_deps import late

_log = logging.getLogger("hermes_cli.web_server")

router = APIRouter()

_profile_scope = late("_profile_scope")

SERVER_NAME = "webmate"

#: Priority order of the codes this endpoint reports (first match wins). They
#: are the same six codes the MCP server's tools attach to failures, so the
#: desktop reacts to one vocabulary whether the trigger is a tool result or
#: this status poll.
CODE_ORDER = (
    "WEBMATE_NOT_INSTALLED",
    "WEBMATE_DISABLED",
    "WEBMATE_NOT_CONNECTED",
    "WEBMATE_OUTDATED",
    "WEBMATE_NOT_SIGNED_IN",
)

MIN_BRIDGE_PROTOCOL = 3


def _server_registration() -> Dict[str, Any]:
    from hermes_cli import mcp_catalog

    servers = mcp_catalog.installed_servers()
    cfg = servers.get(SERVER_NAME) if isinstance(servers, dict) else None
    if not isinstance(cfg, dict):
        return {"registered": False, "enabled": False, "command": None, "args": [], "bundled": False}
    args = [str(a) for a in (cfg.get("args") or [])] if isinstance(cfg.get("args"), list) else []
    return {
        "registered": True,
        "enabled": mcp_catalog.is_enabled(SERVER_NAME),
        "command": str(cfg.get("command") or "") or None,
        "args": args,
        # The catalog's bundled install launches the single-file server that
        # ships with AgentX; a checkout build launches mcp-server/dist/index.js.
        "bundled": any(a.endswith("agentx-webmate-mcp.mjs") for a in args),
    }


def derive_code(
    *,
    extension_present: bool,
    server_enabled: bool,
    connected: bool,
    protocol_version: Optional[int],
    signed_in: Optional[bool],
    pairing_required: bool,
) -> Optional[str]:
    """The single most actionable problem, or ``None`` when WebMate is ready."""
    if not extension_present:
        return "WEBMATE_NOT_INSTALLED"
    if not server_enabled:
        return "WEBMATE_DISABLED"
    if not connected:
        return "WEBMATE_NOT_CONNECTED"
    if pairing_required and protocol_version is not None and protocol_version < MIN_BRIDGE_PROTOCOL:
        return "WEBMATE_OUTDATED"
    if signed_in is False:
        return "WEBMATE_NOT_SIGNED_IN"
    return None


def build_status(profile: Optional[str] = None) -> Dict[str, Any]:
    from hermes_cli import webmate_paths as wp

    root = wp.get_webmate_dir()
    with _profile_scope(profile):
        server = _server_registration()
    installed_version = wp.read_installed_extension_version(root)
    state = wp.read_bridge_state(root)
    pairing = wp.read_pairing_summary(root)
    update_check = wp.read_update_check(root) or {}

    live = bool(state) and not state.get("stale")
    connected = bool(live and state.get("connected"))
    protocol_version = state.get("protocolVersion") if live else None
    signed_in = state.get("signedIn") if live else None
    pending_version = update_check.get("pendingVersion")

    return {
        "schema": 1,
        "webmateDir": str(root),
        "extensionId": wp.WEBMATE_EXTENSION_ID,
        "bridgePort": (state or {}).get("port") or wp.WEBMATE_BRIDGE_PORT,
        "server": server,
        "extension": {
            "present": installed_version is not None,
            "installedVersion": installed_version,
            "installDir": str(wp.get_webmate_install_dir(root)),
            "runningVersion": state.get("extensionVersion") if live else None,
        },
        "pairing": pairing,
        "bridge": state,
        "connected": connected,
        "browser": state.get("browser") if connected else None,
        "installType": state.get("installType") if connected else None,
        "signedIn": signed_in if connected else None,
        "protocolVersion": protocol_version if connected else None,
        "serverRunning": bool(live and state.get("listening")),
        "pendingVersion": str(pending_version) if isinstance(pending_version, str) and pending_version else None,
        "updateCheck": update_check or None,
        "code": derive_code(
            extension_present=installed_version is not None,
            server_enabled=bool(server["enabled"]),
            connected=connected,
            protocol_version=protocol_version if isinstance(protocol_version, int) else None,
            signed_in=signed_in if isinstance(signed_in, bool) else None,
            pairing_required=bool(pairing.get("present")),
        ),
    }


@router.get("/api/webmate/status")
async def webmate_status(profile: Optional[str] = None):
    """Everything the desktop needs to show the browser-connection state."""
    try:
        return build_status(profile)
    except Exception:  # noqa: BLE001 — a status poll must never take the dashboard down
        _log.exception("webmate_status failed")
        return {"schema": 1, "error": "status-failed", "code": None, "connected": False}
