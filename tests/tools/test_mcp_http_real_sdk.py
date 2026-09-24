"""Workmate's HTTP MCP client against a real server of the SDK it pins.

The transport tests elsewhere fake ``streamable_http_client``. Their fakes
yielded ``(read, write, get_session_id)`` — the shape of mcp 1.x — while
mcp 2.0 yields ``(read, write)``, so every Streamable HTTP server failed to
connect ("not enough values to unpack") and no test noticed. And the
``MCP-Protocol-Version`` Workmate seeds in front of ``initialize`` became
``2026-07-28`` with mcp 2.0 (``LATEST_PROTOCOL_VERSION``), which sends an
mcp 2.x server down its stateless path, where the handshake is refused.

Nothing of the SDK is faked here: a low-level ``Server`` behind
``StreamableHTTPSessionManager`` (both eras on one endpoint, as every mcp 2.x
server is) runs on the loopback, and ``_connect_server`` connects to it the
way a profile's ``mcp_servers`` entry does, in each ``protocol`` mode.
"""

from __future__ import annotations

import asyncio
import contextlib
import socket

import pytest

pytest.importorskip("mcp.server.streamable_http_manager")

import mcp_types as types  # noqa: E402
import uvicorn  # noqa: E402
from mcp.server.lowlevel.server import Server  # noqa: E402
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager  # noqa: E402
from mcp_types.version import HANDSHAKE_PROTOCOL_VERSIONS, LATEST_HANDSHAKE_VERSION  # noqa: E402
from sse_starlette.sse import AppStatus  # noqa: E402

from tools import mcp_tool  # noqa: E402

TOOL = {"name": "echo", "description": "Say it back.", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}}


def _server() -> Server:
    async def list_tools(ctx, params):
        return types.ListToolsResult.model_validate({"tools": [TOOL]})

    async def call_tool(ctx, params):
        return types.CallToolResult.model_validate({"content": [{"type": "text", "text": f"echo: {(params.arguments or {}).get('text')}"}]})

    return Server("real-sdk", version="1.0.0", on_list_tools=list_tools, on_call_tool=call_tool)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@contextlib.asynccontextmanager
async def _served(seen: list[dict]):
    """The server on the loopback; *seen* gets the method, headers and body of every request."""
    manager = StreamableHTTPSessionManager(app=_server())

    async def app(scope, receive, send):
        if scope["type"] == "lifespan":
            message = await receive()
            async with manager.run():
                await send({"type": "lifespan.startup.complete"})
                while message["type"] != "lifespan.shutdown":
                    message = await receive()
            await send({"type": "lifespan.shutdown.complete"})
            return
        chunks, more = [], True
        while more and scope["method"] == "POST":
            message = await receive()
            chunks.append(message.get("body", b""))
            more = message.get("more_body", False)
        body = b"".join(chunks)
        seen.append({"method": scope["method"], "headers": {k.decode().lower(): v.decode() for k, v in scope["headers"]}, "body": body})
        replay = [{"type": "http.request", "body": body, "more_body": False}]

        async def again():
            return replay.pop(0) if replay else await receive()

        await manager.handle_request(scope, again if scope["method"] == "POST" else receive, send)

    # sse_starlette ends every event stream of the process once it has seen a
    # uvicorn stop, and never forgets it (a class attribute): drain by hand.
    AppStatus.disable_automatic_graceful_drain()
    AppStatus.should_exit = False
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on", ws="none"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        if task.done():
            task.result()
        await asyncio.sleep(0.02)
    try:
        yield f"http://127.0.0.1:{port}/mcp"
    finally:
        server.should_exit = True
        AppStatus.should_exit = True
        try:
            await asyncio.wait_for(task, timeout=10)
        finally:
            AppStatus.should_exit = False
            AppStatus.enable_automatic_graceful_drain_mode()


def _opening(seen: list[dict]) -> dict:
    return next(request for request in seen if b'"method":"initialize"' in request["body"].replace(b" ", b""))


def _connect_and_call(protocol: str | None) -> tuple[object, list[str], str, list[dict]]:
    seen: list[dict] = []

    async def drive():
        async with _served(seen) as url:
            config = {"url": url, "timeout": 20, "connect_timeout": 20}
            if protocol is not None:
                config["protocol"] = protocol
            server = await mcp_tool._connect_server("real-sdk", config)
            try:
                tools = [tool.name for tool in server._tools]
                result = await server.session.call_tool("echo", {"text": "hi"})
                return server.initialize_result, tools, result.content[0].text
            finally:
                await server.shutdown()

    opened, tools, text = asyncio.run(drive())
    return opened, tools, text, seen


@pytest.mark.parametrize("protocol", [None, "auto", "legacy"])
def test_the_handshake_connects_to_a_real_sdk_server(protocol):
    opened, tools, text, seen = _connect_and_call(protocol)
    assert opened.protocol_version == LATEST_HANDSHAKE_VERSION
    assert tools == ["echo"] and text == "echo: hi"
    # `initialize` went out under a handshake revision, not the stateless one.
    assert _opening(seen)["headers"]["mcp-protocol-version"] == LATEST_HANDSHAKE_VERSION


def test_stateless_mode_discovers_a_real_sdk_server():
    opened, tools, text, seen = _connect_and_call("stateless")
    assert type(opened).__name__ == "DiscoverResult"
    assert tools == ["echo"] and text == "echo: hi"
    # Every request of the stateless era names it; nothing opened a handshake.
    assert all(request["headers"].get("mcp-protocol-version") == "2026-07-28" for request in seen if request["method"] == "POST")
    assert not any(b'"initialize"' in request["body"] for request in seen)


def test_the_opening_revision_is_a_handshake_revision():
    mcp_tool._ensure_mcp_sdk()
    assert mcp_tool.HANDSHAKE_PROTOCOL_VERSION in HANDSHAKE_PROTOCOL_VERSIONS
