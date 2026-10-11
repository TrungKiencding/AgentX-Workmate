"""Desktop account routes → real HTTP → device service → real Postgres.

Only the identity provider is a test realm. The service URL is resolved from a
real temporary AGENTX_HOME, and every device call uses the production client.
"""

from __future__ import annotations

import asyncio
import socket

import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from hermes_cli.dashboard_auth.base import Session
from hermes_cli.web_routers.accounts import router

pytestmark = pytest.mark.asyncio


async def test_device_lifecycle_through_the_desktop_proxy(
    build_brain, two_devices_for_proxy, tmp_path, monkeypatch
):
    headers, other_headers, other_id = two_devices_for_proxy
    attempts = 0

    async def rotate(_subject):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("temporary model service failure")
        return "rotated"

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    service = build_brain(rotate_key=rotate)
    server = uvicorn.Server(uvicorn.Config(service, log_level="error", lifespan="on"))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    home = tmp_path / "agentx-home"
    home.mkdir()
    (home / "config.yaml").write_text(
        f"accounts:\n  second_brain:\n    base_url: http://127.0.0.1:{port}\n    timeout: 1\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("AGENTX_HOME", str(home))
    backend = FastAPI()

    @backend.middleware("http")
    async def identity(request: Request, call_next):
        # The account proxy requires the verified session provided by its gate.
        request.state.session = Session(
            user_id="person-a",
            email="a@test",
            display_name="Person A",
            org_id="",
            provider="keycloak",
            expires_at=0,
            access_token="tok-a",
            refresh_token="",
        )
        return await call_next(request)

    backend.include_router(router)

    async def call(method, path, **kwargs):
        def send():
            with TestClient(backend) as client:
                return client.request(method, path, **kwargs)

        return await asyncio.to_thread(send)

    try:
        async with asyncio.timeout(10):
            while not server.started:
                if task.done():
                    await task
                    raise AssertionError("service stopped before startup")
                await asyncio.sleep(0.01)
        registered = await call(
            "POST",
            "/api/account/devices/heartbeat",
            headers=other_headers,
            json={
                "platform": "darwin",
                "app_version": "1.0.10",
                "client_name": "AgentX Workmate",
            },
        )
        assert registered.json()["status"] == "ok"
        renamed = await call(
            "PATCH",
            f"/api/account/devices/{other_id}",
            headers=headers,
            json={"display_name": "Máy làm việc"},
        )
        assert renamed.json()["device"]["display_name"] == "Máy làm việc"
        await call(
            "POST",
            "/api/account/devices/heartbeat",
            headers=other_headers,
            json={"app_version": "1.0.11"},
        )
        listed = (await call("GET", "/api/account/devices", headers=headers)).json()
        assert listed["status"] == "ok"
        assert listed["can_rename"] is True
        other = next(row for row in listed["devices"] if row["id"] == other_id)
        assert other["display_name"] == "Máy làm việc"
        assert other["client_name"] == "AgentX Workmate"
        assert other["app_version"] == "1.0.11"
        failed = (
            await call(
                "DELETE",
                f"/api/account/devices/{other_id}?rotate_key=true",
                headers=headers,
            )
        ).json()
        assert failed["status"] == "ok"
        assert failed["key_rotation"] == "failed"
        assert failed["device"]["revoked"] is True
        rejected = (
            await call("GET", "/api/account/devices", headers=other_headers)
        ).json()
        assert rejected["status"] == "revoked"
        retried = (
            await call(
                "DELETE",
                f"/api/account/devices/{other_id}?rotate_key=true",
                headers=headers,
            )
        ).json()
        assert retried["key_rotated"] is True
        assert retried["device"]["revoked_at"] == failed["device"]["revoked_at"]
        assert attempts == 2
        server.should_exit = True
        await asyncio.wait_for(task, 10)
        offline = (await call("GET", "/api/account/devices", headers=headers)).json()
        assert offline["status"] == "offline"
    finally:
        server.should_exit = True
        if not task.done():
            await asyncio.wait_for(task, 10)
        sock.close()


@pytest.fixture
def two_devices_for_proxy(realm):
    from tests.second_brain.conftest import auth_headers, new_device_id

    realm.add("tok-a", subject="person-a", email="a@test", display_name="Person A")
    current, other = new_device_id(), new_device_id()
    return (
        auth_headers("tok-a", current, "same-host"),
        auth_headers("tok-a", other, "same-host"),
        other,
    )
