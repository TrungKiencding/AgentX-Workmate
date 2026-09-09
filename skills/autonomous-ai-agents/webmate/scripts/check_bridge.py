#!/usr/bin/env python3
"""Health check for the AgentX WebMate MCP bridge.

Answers the questions that explain nearly every "WebMate tools don't work"
report, without needing a chat session:

1. Is ``mcp_servers.webmate`` configured (and enabled) in AgentX's config.yaml?
2. Does the server it points at exist on disk (the bundled
   ``server/agentx-webmate-mcp.mjs`` that ships with AgentX, or a checkout's
   ``mcp-server/dist/index.js``)?
3. Is the launcher (``node``) runnable and new enough (>= 20)?
4. Is the extension folder Workmate manages installed, and what does the
   bridge's own ``state.json`` say — connected to which browser, signed in?
5. Is anything listening on the bridge port right now?

The last two are informational: the MCP host starts the server for the
duration of a session, so "not listening" between sessions is expected, and
state.json is only written once the server has run.

Usage:
    python check_bridge.py            # human-readable report
    python check_bridge.py --json     # machine-readable
    python check_bridge.py --config /path/to/config.yaml --port 17374

Exit status is 0 when config, build and node checks pass, 1 otherwise.
Stdlib only; PyYAML is used when available and reported when it is not.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_PORT = 17374
SERVER_NAME = "webmate"
MIN_NODE_MAJOR = 20
# The folder Workmate points the browser at; see apps/desktop/WEBMATE-INTEGRATION-PLAN.md §2.1.
EXTENSION_DIR_NAME = "AgentX WebMate"
EXPECTED_TOOLS = (
    "webmate_connection",
    "webmate_run",
    "webmate_extract",
    "webmate_status",
    "webmate_respond",
    "webmate_abort",
)


def agentx_home() -> Path:
    """Profile home: ``AGENTX_HOME`` when set, else ``~/.agentx``."""
    override = os.environ.get("AGENTX_HOME", "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".agentx"


def default_config_path() -> Path:
    return agentx_home() / "config.yaml"


def agentx_root() -> Path:
    """The install root above ``accounts/<slug>`` and ``profiles/<name>``.

    Mirrors ``hermes_constants._strip_home_scoping_segments``: the WebMate
    folder is per machine, so it anchors above the per-account home."""
    home = agentx_home()
    if home.parent.name == "profiles":
        home = home.parent.parent
    if home.parent.name == "accounts":
        home = home.parent.parent
    return home


def webmate_dir(entry: Optional[Dict[str, Any]] = None) -> Path:
    """``WEBMATE_DIR`` (env, then the server entry's env), else ``<root>/webmate``."""
    override = os.environ.get("WEBMATE_DIR", "").strip()
    if not override and entry:
        env = entry.get("env") or {}
        override = str(env.get("WEBMATE_DIR", "")).strip()
    if override:
        return Path(os.path.expandvars(override)).expanduser()
    return agentx_root() / "webmate"


def read_json_file(path: Path) -> Optional[Dict[str, Any]]:
    """A small JSON document, or None when missing/unreadable (never raises)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def installed_extension_version(root: Path) -> Optional[str]:
    manifest = read_json_file(root / EXTENSION_DIR_NAME / "manifest.json")
    version = manifest.get("version") if manifest else None
    return str(version) if isinstance(version, str) and version else None


def bridge_state(root: Path) -> Optional[Dict[str, Any]]:
    """``state.json`` as the MCP server wrote it; ``stale`` when its pid is gone."""
    state = read_json_file(root / "state.json")
    if state is None:
        return None
    pid = state.get("pid")
    stale = False
    if isinstance(pid, int) and pid > 0 and pid != os.getpid():
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            stale = True
        except OSError:
            pass
    state = dict(state)
    state["stale"] = bool(state.get("listening")) and stale
    return state


def load_config(path: Path) -> Dict[str, Any]:
    """Return the parsed config.yaml, or raise with a readable reason."""
    if not path.is_file():
        raise FileNotFoundError(f"config not found: {path}")
    try:
        import yaml  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on environment
        raise RuntimeError("PyYAML is not installed; cannot read config.yaml") from exc
    with open(path, "r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a mapping")
    return data


def server_entry(config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    servers = config.get("mcp_servers") or {}
    if not isinstance(servers, dict):
        return None
    entry = servers.get(SERVER_NAME)
    return entry if isinstance(entry, dict) else None


def entry_enabled(entry: Dict[str, Any]) -> bool:
    enabled = entry.get("enabled", True)
    if isinstance(enabled, str):
        return enabled.strip().lower() in {"true", "1", "yes", "on"}
    return bool(enabled)


def server_script(entry: Dict[str, Any]) -> Optional[Path]:
    """The server file the entry launches: the bundled ``agentx-webmate-mcp.mjs``
    that ships with AgentX, or a checkout's ``dist/index.js``."""
    for arg in entry.get("args") or []:
        text = os.path.expandvars(str(arg))
        if text.endswith((".mjs", "index.js")):
            return Path(text).expanduser()
    return None


def configured_port(entry: Optional[Dict[str, Any]], override: Optional[int]) -> int:
    if override:
        return override
    env = (entry or {}).get("env") or {}
    for key in ("WEBMATE_BRIDGE_PORT", "WEBBRAIN_BRIDGE_PORT"):
        raw = str(env.get(key, "")).strip()
        if raw.isdigit():
            return int(raw)
    return DEFAULT_PORT


def node_version(command: str) -> Optional[str]:
    """``vX.Y.Z`` reported by the launcher, or None when it cannot run."""
    try:
        proc = subprocess.run(
            [command, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def node_major(version: Optional[str]) -> Optional[int]:
    if not version:
        return None
    match = re.match(r"v?(\d+)", version)
    return int(match.group(1)) if match else None


def port_listening(port: int, host: str = "127.0.0.1", timeout: float = 0.5) -> bool:
    """True when a TCP connect to host:port succeeds."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def run_checks(config_path: Optional[Path] = None, port: Optional[int] = None) -> Dict[str, Any]:
    """Run every check and return a report dict (see ``--json``)."""
    path = config_path or default_config_path()
    report: Dict[str, Any] = {
        "config_path": str(path),
        "checks": [],
        "next_steps": [],
        "ok": False,
    }
    checks: List[Dict[str, Any]] = report["checks"]
    steps: List[str] = report["next_steps"]

    entry: Optional[Dict[str, Any]] = None
    try:
        config = load_config(path)
        entry = server_entry(config)
    except Exception as exc:  # noqa: BLE001 - every failure is reported, not raised
        checks.append({"name": "config", "ok": False, "detail": str(exc)})
        steps.append("Run `agentx mcp install webmate` (the server ships with AgentX — no clone, no npm).")
    else:
        if entry is None:
            checks.append({"name": "config", "ok": False, "detail": f"mcp_servers.{SERVER_NAME} is missing"})
            steps.append("Run `agentx mcp install webmate` (the server ships with AgentX — no clone, no npm).")
        elif not entry_enabled(entry):
            checks.append({"name": "config", "ok": False, "detail": f"mcp_servers.{SERVER_NAME} is disabled"})
            steps.append(f"Set mcp_servers.{SERVER_NAME}.enabled: true in {path} (or `agentx mcp enable {SERVER_NAME}`).")
        else:
            command = str(entry.get("command") or "")
            checks.append({
                "name": "config",
                "ok": True,
                "detail": f"{command} {' '.join(str(a) for a in entry.get('args') or [])}".strip(),
            })

    script = server_script(entry) if entry else None
    if entry is not None and entry_enabled(entry):
        if script is None:
            checks.append({"name": "server_build", "ok": False, "detail": "entry does not launch a server file (.mjs or index.js); cannot locate the server"})
            steps.append("Re-run `agentx mcp install webmate` so the entry points at the bundled server.")
        elif script.is_file():
            checks.append({"name": "server_build", "ok": True, "detail": str(script)})
        else:
            checks.append({"name": "server_build", "ok": False, "detail": f"{script} does not exist"})
            steps.append("Re-run `agentx mcp install webmate` (bundled server), or `agentx mcp install webmate --dev` to build from a checkout.")

        command = str(entry.get("command") or "node")
        resolved = shutil.which(command)
        version = node_version(resolved) if resolved else None
        major = node_major(version)
        if not resolved:
            checks.append({"name": "node", "ok": False, "detail": f"{command!r} not found on PATH"})
            steps.append("Install Node.js >= 20 and make sure it is on PATH for the AgentX process.")
        elif major is None:
            checks.append({"name": "node", "ok": False, "detail": f"{resolved} did not report a version"})
            steps.append("Reinstall Node.js >= 20.")
        elif major < MIN_NODE_MAJOR:
            checks.append({"name": "node", "ok": False, "detail": f"{resolved} is {version}; need >= {MIN_NODE_MAJOR}"})
            steps.append("Upgrade Node.js to >= 20.")
        else:
            checks.append({"name": "node", "ok": True, "detail": f"{resolved} {version}"})

    # The Workmate-managed folder and the bridge's own account of itself.
    root = webmate_dir(entry)
    report["webmate_dir"] = str(root)
    extension_version = installed_extension_version(root)
    report["extension_version"] = extension_version
    checks.append({
        "name": "extension",
        "ok": True,
        "informational": True,
        "detail": (
            f"AgentX WebMate {extension_version} installed at {root / EXTENSION_DIR_NAME}"
            if extension_version
            else f"no extension folder at {root / EXTENSION_DIR_NAME} — install it from Workmate → Settings → Browser (or load a WebMate build unpacked yourself)"
        ),
    })
    state = bridge_state(root)
    report["bridge_state"] = state
    if state is None:
        state_detail = f"no state.json in {root} — the MCP server has not run yet"
    elif state.get("stale"):
        state_detail = f"state.json is from a server (pid {state.get('pid')}) that is no longer running"
    elif state.get("connected"):
        state_detail = (
            f"connected — {state.get('browser') or 'unknown browser'}, extension {state.get('extensionVersion') or '?'} "
            f"({state.get('installType') or 'unknown install'}), protocol v{state.get('protocolVersion')}, "
            + ("signed in" if state.get("signedIn") is True else "NOT signed in" if state.get("signedIn") is False else "sign-in unknown")
        )
    elif state.get("listening"):
        state_detail = "server listening, no browser attached" + (f" — last error: {state['error']}" if state.get("error") else "")
    else:
        state_detail = "server stopped" + (f" — last error: {state['error']}" if state.get("error") else "")
    checks.append({"name": "bridge_state", "ok": True, "informational": True, "detail": state_detail})

    bridge_port = configured_port(entry, port)
    listening = port_listening(bridge_port)
    report["bridge_port"] = bridge_port
    report["bridge_listening"] = listening
    checks.append({
        "name": "bridge_port",
        "ok": True,
        "informational": True,
        "detail": (
            f"127.0.0.1:{bridge_port} listening — the MCP server is up; the extension can attach"
            if listening
            else f"127.0.0.1:{bridge_port} not listening — normal between sessions; the MCP host starts the server on demand"
        ),
    })

    required = [c for c in checks if not c.get("informational")]
    report["ok"] = bool(required) and all(c["ok"] for c in required)
    if report["ok"]:
        if state and state.get("connected") and not state.get("stale"):
            if state.get("signedIn") is False:
                steps.append("Open the AgentX WebMate side panel in that browser and sign in, then call webmate_connection.")
            else:
                steps.append("Call webmate_connection in a session; the browser is attached.")
        elif (root / "pairing.json").is_file():
            steps.append(
                "Open the browser AgentX WebMate is installed into (Workmate → Settings → Browser); if it is not "
                "installed yet, install it from there. Then call webmate_connection."
            )
        else:
            steps.append(
                "In Chrome: AgentX WebMate → Settings → General → Advanced → Cloud bridge → "
                f"ws://127.0.0.1:{bridge_port}/extension → enable, then call webmate_connection."
            )
    return report


def format_report(report: Dict[str, Any]) -> str:
    lines = [f"AgentX WebMate bridge check ({report['config_path']})"]
    for check in report["checks"]:
        mark = "OK " if check["ok"] else "FAIL"
        if check.get("informational"):
            mark = "INFO"
        lines.append(f"  [{mark}] {check['name']}: {check['detail']}")
    if report["next_steps"]:
        lines.append("Next steps:")
        lines.extend(f"  - {step}" for step in report["next_steps"])
    lines.append("Expected tools: " + ", ".join(f"mcp__{SERVER_NAME}__{t}" for t in EXPECTED_TOOLS))
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", type=Path, default=None, help="config.yaml to inspect (default: $AGENTX_HOME/config.yaml)")
    parser.add_argument("--port", type=int, default=None, help="bridge port to probe (default: from config, else 17374)")
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    args = parser.parse_args(argv)

    report = run_checks(config_path=args.config, port=args.port)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(format_report(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
