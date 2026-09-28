"""The WebMate bridge belongs to the desktop app, and every other AgentX
process still reaches the browser.

The extension dials one loopback port (17374), but every AgentX process that
loads MCP tools spawns its own copy of the WebMate MCP server — the desktop
backend, and the messaging gateway that ``/api/gateway/autostart`` starts
detached so it outlives the app. Whichever copy bound first used to keep the
browser: a gateway started while the app was closed held the port for days
and the app's own agent got ``WEBMATE_PORT_IN_USE`` (28/09/2026).

Two halves, tested here:

* AgentX names the process to the servers it spawns (``AGENTX_MCP_HOST``,
  from ``set_mcp_host_role``) without that name leaking to child processes;
* the vendored server (optional-mcps/webmate, 1.3.0+) acts on it: a gateway
  copy that holds the port hands it to the desktop copy and relays through
  it, and takes it back when the desktop copy exits.
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from hermes_cli import mcp_startup
from tools import mcp_tool

REPO = Path(__file__).resolve().parents[2]
BUNDLE = REPO / "optional-mcps" / "webmate" / "server" / "agentx-webmate-mcp.mjs"


# ---------------------------------------------------------------------------
# AGENTX_MCP_HOST reaches the servers a process spawns, and nothing else
# ---------------------------------------------------------------------------


class _Captured(Exception):
    pass


def _spawn_env(config: dict, role: str | None) -> dict:
    """The environment a stdio MCP server would be spawned with, under ``role``."""
    captured: dict = {}

    def fake_stdio_client(server_params, errlog=None):
        captured["params"] = server_params
        raise _Captured()

    server = mcp_tool.MCPServerTask("host-role-probe")
    previous = mcp_startup.get_mcp_host_role()
    mcp_startup.set_mcp_host_role(role)
    try:
        with patch.object(mcp_tool, "stdio_client", fake_stdio_client), \
             patch.object(mcp_tool, "_resolve_stdio_command", lambda c, e: (c, e)), \
             patch.object(mcp_tool, "_kill_orphaned_mcp_children", lambda *a, **k: None), \
             patch.object(mcp_tool, "_write_stderr_log_header", lambda *a, **k: None), \
             patch.object(mcp_tool, "_get_mcp_stderr_log", lambda: None), \
             patch("tools.osv_check.check_package_for_malware", lambda *a, **k: None):
            with pytest.raises(_Captured):
                asyncio.run(server._run_stdio(config))
    finally:
        mcp_startup.set_mcp_host_role(previous)
    return dict(captured["params"].env or {})


class TestMcpHostRole:
    def test_the_role_reaches_every_stdio_server_the_process_spawns(self):
        env = _spawn_env({"command": "fake-mcp", "args": [], "env": {"WEBMATE_DIR": "/x"}}, "desktop")
        assert env["AGENTX_MCP_HOST"] == "desktop"
        assert env["WEBMATE_DIR"] == "/x", "the server's own env is kept"

    def test_a_server_config_can_still_set_its_own(self):
        env = _spawn_env({"command": "fake-mcp", "env": {"AGENTX_MCP_HOST": "pinned"}}, "gateway")
        assert env["AGENTX_MCP_HOST"] == "pinned"

    def test_no_role_adds_nothing(self):
        assert "AGENTX_MCP_HOST" not in _spawn_env({"command": "fake-mcp"}, None)

    def test_blank_role_counts_as_none(self):
        assert "AGENTX_MCP_HOST" not in _spawn_env({"command": "fake-mcp"}, "   ")

    def test_an_inherited_value_never_passes_through(self, monkeypatch):
        # The gateway is spawned by the desktop backend and inherits its env;
        # only a process's own role may reach the servers it starts.
        monkeypatch.setenv("AGENTX_MCP_HOST", "desktop")
        assert _spawn_env({"command": "fake-mcp"}, "gateway")["AGENTX_MCP_HOST"] == "gateway"
        assert "AGENTX_MCP_HOST" not in _spawn_env({"command": "fake-mcp"}, None)

    def test_setting_the_role_leaves_os_environ_alone(self, monkeypatch):
        monkeypatch.delenv("AGENTX_MCP_HOST", raising=False)
        previous = mcp_startup.get_mcp_host_role()
        try:
            mcp_startup.set_mcp_host_role("desktop")
            assert "AGENTX_MCP_HOST" not in os.environ, "a gateway spawned from here would inherit it"
        finally:
            mcp_startup.set_mcp_host_role(previous)


# ---------------------------------------------------------------------------
# The vendored server, driven through AgentX's own MCP client in two processes
# ---------------------------------------------------------------------------

#: One AgentX process: names itself, connects the webmate server through
#: tools.mcp_tool exactly as discovery does, then calls tools on request.
_HOST_SCRIPT = r"""
import json, sys
from hermes_cli.mcp_startup import set_mcp_host_role
from tools import mcp_tool

set_mcp_host_role(sys.argv[1])
names = mcp_tool.register_mcp_servers({"webmate": json.loads(sys.argv[2])})
print(json.dumps({"event": "ready", "tools": names}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if request["op"] == "quit":
        break
    handler = mcp_tool._make_tool_handler("webmate", request["tool"], 60)
    value = json.loads(handler(request.get("args", {})))
    print(json.dumps({"event": "result", "id": request["id"], "value": value}), flush=True)
mcp_tool.shutdown_mcp_servers()
"""

TOKEN = "workmate-bridge-ownership-test".ljust(44, "x")


def _node() -> str | None:
    node = shutil.which("node")
    if not node:
        return None
    try:
        version = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10).stdout
        major = int(version.strip().lstrip("v").split(".")[0])
    except Exception:
        return None
    return node if major >= 20 else None


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _until(predicate, label: str, timeout: float = 15.0):
    deadline = time.monotonic() + timeout
    while True:
        value = predicate()
        if value:
            return value
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for: {label}")
        time.sleep(0.05)


class _Host:
    """An AgentX-like process hosting the webmate MCP server under ``role``."""

    def __init__(self, role: str, config: dict, home: Path):
        env = {
            **os.environ,
            "AGENTX_HOME": str(home),
            "PYTHONPATH": str(REPO),
        }
        env.pop("AGENTX_MCP_HOST", None)
        self.role = role
        self.proc = subprocess.Popen(
            [sys.executable, "-c", _HOST_SCRIPT, role, json.dumps(config)],
            cwd=str(REPO),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._events: queue.Queue = queue.Queue()
        self._next_id = 0
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        for line in self.proc.stdout:
            try:
                self._events.put(json.loads(line))
            except ValueError:
                continue

    def expect(self, event: str, timeout: float = 60.0) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"{self.role}: no '{event}' within {timeout}s")
            try:
                message = self._events.get(timeout=remaining)
            except queue.Empty:
                continue
            if message.get("event") == event:
                return message

    def tool(self, name: str, args: dict | None = None) -> dict:
        self._next_id += 1
        self.proc.stdin.write(json.dumps({"op": "call", "id": self._next_id, "tool": name, "args": args or {}}) + "\n")
        self.proc.stdin.flush()
        return self.expect("result")["value"]

    def quit(self) -> None:
        if self.proc.poll() is not None:
            return
        try:
            self.proc.stdin.write(json.dumps({"op": "quit"}) + "\n")
            self.proc.stdin.flush()
            self.proc.wait(timeout=15)
        except Exception:
            self.proc.kill()
            self.proc.wait(timeout=5)


class _FakeExtension:
    """The paired WebMate extension: v3 hello with the token, redials 50ms after any close."""

    def __init__(self, port: int):
        self.port = port
        self.tasks: list[str] = []
        self.closes: list[int] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=lambda: asyncio.run(self._main()), daemon=True)
        self._thread.start()

    async def _main(self) -> None:
        from websockets.asyncio.client import connect

        hello = {
            "type": "hello",
            "client": "webbrain-extension",
            "protocolVersion": 3,
            "version": "1.0.7",
            "browser": "Edge 154",
            "installType": "workmate",
            "signedIn": True,
            "instanceId": "inst-edge",
            "token": TOKEN,
            "capabilities": ["run_modes_v1"],
            "status": {},
        }
        while not self._stop.is_set():
            try:
                async with connect(
                    f"ws://127.0.0.1:{self.port}/extension",
                    origin="chrome-extension://pfadeibckkgklmmjghiikadphihbpape",
                    open_timeout=2,
                ) as ws:
                    await ws.send(json.dumps(hello))
                    while not self._stop.is_set():
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=0.2)
                        except asyncio.TimeoutError:
                            continue
                        msg = json.loads(raw)
                        if not msg.get("action"):
                            continue
                        payload = msg.get("payload") or {}
                        if msg["action"] == "cloud_run":
                            self.tasks.append(payload.get("task"))
                        result = {"runId": payload.get("runId", "run-x"), "status": "running", "task": payload.get("task")}
                        await ws.send(json.dumps({"id": msg["id"], "ok": True, "result": result}))
            except Exception as exc:  # refused while the port changes hands, or closed by the server
                code = getattr(getattr(exc, "rcvd", None), "code", None)
                if code:
                    self.closes.append(code)
            await asyncio.sleep(0.05)

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process handling in this test")
def test_gateway_first_then_desktop_the_desktop_owns_the_bridge_and_the_gateway_relays(tmp_path):
    node = _node()
    if node is None:
        pytest.skip("needs Node.js >= 20 on PATH")
    pytest.importorskip("websockets")

    port = _free_port()
    webmate_dir = tmp_path / "webmate"
    (webmate_dir / "AgentX WebMate").mkdir(parents=True)
    (webmate_dir / "AgentX WebMate" / "manifest.json").write_text("{}", encoding="utf-8")
    pairing = webmate_dir / "pairing.json"
    pairing.write_text(json.dumps({"schema": 1, "token": TOKEN, "port": port, "installId": "t", "createdAt": None}), encoding="utf-8")
    pairing.chmod(0o600)
    state_file = webmate_dir / "state.json"

    def state() -> dict | None:
        try:
            return json.loads(state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    # The catalog's registration, with the bridge on a private port.
    config = {
        "command": node,
        "args": [str(BUNDLE)],
        "env": {
            "WEBMATE_DIR": str(webmate_dir),
            "WEBMATE_BRIDGE_PORT": str(port),
            "WEBMATE_CONNECT_GRACE_MS": "5000",
            "WEBMATE_HEARTBEAT_INTERVAL_MS": "0",
        },
        "connect_timeout": 60,
    }

    extension = _FakeExtension(port)
    gateway = _Host("gateway", config, tmp_path / "gateway-home")
    desktop = None
    try:
        gateway.expect("ready")
        _until(lambda: (s := state()) and s.get("host") == "gateway" and s.get("connected"),
               "the gateway's server holds the port with the extension attached")

        # The desktop app opens while that gateway keeps running.
        desktop = _Host("desktop", config, tmp_path / "desktop-home")
        desktop.expect("ready")
        owned = _until(
            lambda: (s := state()) and s.get("host") == "desktop" and s.get("connected") and s.get("standbys") and s,
            "state.json names the desktop's server, with the extension attached and the gateway relaying",
        )
        assert owned["priority"] == 100
        assert [s["host"] for s in owned["standbys"]] == ["gateway"]

        direct = desktop.tool("webmate_connection")
        assert direct["result"].startswith(f"Connected. Listening on ws://127.0.0.1:{port}/extension"), direct
        assert direct["structuredContent"]["route"] == "direct"

        relayed = gateway.tool("webmate_connection")
        assert relayed["result"].startswith(f"Connected. Relaying through the bridge on ws://127.0.0.1:{port}/extension"), relayed
        assert "(desktop) holds" in relayed["result"]
        assert relayed["structuredContent"]["route"] == "relay"

        run = gateway.tool("webmate_run", {"task": "read my inbox count", "mode": "ask", "wait": False})
        assert "error" not in run, run
        assert "Started in the background" in run["result"]
        _until(lambda: "read my inbox count" in extension.tasks, "the gateway's run reached the browser")

        # The app quits: the gateway's server takes the port back.
        desktop.quit()
        _until(lambda: (s := state()) and s.get("host") == "gateway" and s.get("connected"),
               "the gateway's server took the port back and the extension followed")
        again = gateway.tool("webmate_connection")
        assert again["structuredContent"]["route"] == "direct", again
    except AssertionError as error:
        logs = []
        for home in ("gateway-home", "desktop-home"):
            log = tmp_path / home / "logs" / "mcp-stderr.log"
            if log.exists():
                logs.append(f"--- {home}/logs/mcp-stderr.log ---\n{log.read_text(encoding='utf-8', errors='replace')}")
        raise AssertionError(f"{error}\nstate.json: {state()}\n" + "\n".join(logs)) from None
    finally:
        extension.stop()
        if desktop is not None:
            desktop.quit()
        gateway.quit()
