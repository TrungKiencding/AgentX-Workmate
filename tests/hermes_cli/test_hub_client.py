"""The laptop's client for the AgentX Skill Hub: headers, retries, the
offline-versus-refused distinction, and the SSE reader — all driven through
``httpx.MockTransport`` with no network."""

from __future__ import annotations

import json

import httpx
import pytest

from hermes_cli.hub_client import HubClient, HubError

HUB = "https://hub.test"
DEVICE = "8f2b1c3d-0000-4000-8000-000000000001"


class _FakeHub:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.unreachable = False
        self.flaky_once = False
        self.installs: list[dict] = []
        self.reports: list[dict] = []

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.unreachable:
            raise httpx.ConnectError("connection refused", request=request)
        if self.flaky_once:
            self.flaky_once = False
            return httpx.Response(503, json={"code": "store_unavailable", "message": "db hiccup", "detail": None})
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return httpx.Response(401, json={"code": "missing_bearer", "message": "no bearer", "detail": None})
        if auth == "Bearer stale":
            return httpx.Response(401, json={"code": "invalid_token", "message": "That token is not valid here.", "detail": None})
        path = request.url.path
        if path == "/v1/me":
            return httpx.Response(200, json={"subject": "kc-ada", "device_id": request.headers.get("X-AgentX-Device")})
        if path == "/v1/me/changes":
            return httpx.Response(200, json={"cursor": 42, "product": request.url.params.get("product"), "device_id": request.url.params.get("device_id"),
                                             "events": [], "installs": [], "updates": [], "org": None})
        if path == "/v1/installs" and request.method == "POST":
            body = json.loads(request.content)
            self.installs.append(body)
            return httpx.Response(201, json={"id": "inst-1", **body, "desired_state": "installed", "reported_state": "pending"})
        if path.endswith("/report"):
            body = json.loads(request.content)
            self.reports.append(body)
            return httpx.Response(200, json={"id": "inst-1", "reported_state": body["state"]})
        if path == "/v1/validate":
            return httpx.Response(200, json={"ok": True, "package": {"name": "x"}})
        if path == "/v1/skills" and request.method == "POST":
            body = json.loads(request.content)
            return httpx.Response(202, json={"skill": {"slug": "x", "visibility": body.get("visibility")}, "version": {"version": "1.0.0"}, "scan_id": "scan-1", "created": True})
        if path == "/v1/skills/x":
            return httpx.Response(200, json={"slug": "x"})
        if path == "/v1/events":
            frames = (
                "retry: 3000\n\n"
                ": connected cursor=7 product=workmate\n\n"
                "id: 8\nevent: install.desired\ndata: {\"id\": 8, \"type\": \"install.desired\", \"payload\": {\"slug\": \"demo\"}}\n\n"
                ": keepalive\n\n"
                "id: 9\nevent: catalog.updated\ndata: {\"type\": \"catalog.updated\",\ndata:  \"payload\": {}}\n\n"
            )
            return httpx.Response(200, content=frames.encode(), headers={"content-type": "text/event-stream"})
        return httpx.Response(404, json={"code": "not_found", "message": path, "detail": None})


@pytest.fixture
def hub() -> _FakeHub:
    return _FakeHub()


@pytest.fixture
def client(hub) -> HubClient:
    return HubClient(HUB, transport=hub.transport, sleep=lambda _s: None)


class TestCalls:
    def test_every_request_carries_bearer_and_device(self, client, hub):
        body = client.me(bearer="tok", device_id=DEVICE, device_name="Ada's laptop")
        assert body["subject"] == "kc-ada" and body["device_id"] == DEVICE
        sent = hub.requests[-1]
        assert sent.headers["Authorization"] == "Bearer tok"
        assert sent.headers["X-AgentX-Device"] == DEVICE and sent.headers["X-AgentX-Device-Name"] == "Ada's laptop"

    def test_changes_asks_for_the_product_and_device(self, client, hub):
        page = client.changes(bearer="tok", device_id=DEVICE, product="workmate", cursor=None)
        assert page["cursor"] == 42 and page["product"] == "workmate" and page["device_id"] == DEVICE
        assert "cursor" not in hub.requests[-1].url.params
        client.changes(bearer="tok", device_id=DEVICE, cursor=41)
        assert hub.requests[-1].url.params["cursor"] == "41"

    def test_install_and_report(self, client, hub):
        row = client.create_install("demo-core", bearer="tok", device_id=DEVICE, version="1.0.0", reason="org mirror")
        assert row["id"] == "inst-1" and hub.installs[-1] == {"slug": "demo-core", "product": "workmate", "version": "1.0.0", "reason": "org mirror"}
        client.report_install("inst-1", "installed", bearer="tok", device_id=DEVICE, device_name="Ada's laptop", version="1.0.0")
        assert hub.reports[-1] == {"state": "installed", "version": "1.0.0", "device_name": "Ada's laptop"}
        client.report_install("inst-1", "failed", bearer="tok", error="x" * 3000)
        assert len(hub.reports[-1]["error"]) == 2000

    def test_validate_and_publish(self, client, hub):
        assert client.validate({"SKILL.md": "# x"}, kind="core")["ok"] is True
        assert json.loads(hub.requests[-1].content) == {"files": {"SKILL.md": "# x"}, "kind": "core"}
        published = client.publish({"SKILL.md": "# x", "assets/a.bin": {"base64": "AAE="}}, bearer="tok", visibility="org", targets=["hermes"])
        assert published["skill"]["visibility"] == "org" and published["scan_id"] == "scan-1"
        assert json.loads(hub.requests[-1].content)["targets"] == ["hermes"]

    def test_one_retry_on_a_transient_answer(self, client, hub):
        hub.flaky_once = True
        assert client.skill("x", bearer="tok")["slug"] == "x"
        assert len(hub.requests) == 2


class TestFailures:
    def test_unreachable_is_distinct_from_refused(self, client, hub):
        hub.unreachable = True
        with pytest.raises(HubError) as unreachable:
            client.me(bearer="tok", device_id=DEVICE)
        assert unreachable.value.unreachable is True and unreachable.value.reauth is False and unreachable.value.status_code is None

    def test_a_refused_token_asks_for_reauth(self, client):
        with pytest.raises(HubError) as refused:
            client.me(bearer="stale", device_id=DEVICE)
        assert refused.value.reauth is True and refused.value.code == "invalid_token" and refused.value.status_code == 401
        assert refused.value.unreachable is False

    def test_identity_unavailable_keeps_credentials(self):
        def handler(request):
            return httpx.Response(503, json={"code": "identity_unavailable", "message": "realm down", "detail": None})

        client = HubClient(HUB, transport=httpx.MockTransport(handler), sleep=lambda _s: None)
        with pytest.raises(HubError) as exc:
            client.me(bearer="tok", device_id=DEVICE)
        assert exc.value.identity_unavailable is True and exc.value.reauth is False and exc.value.status_code == 503

    def test_empty_base_url_is_refused(self):
        with pytest.raises(HubError):
            HubClient("  ")


@pytest.mark.asyncio
class TestEventStream:
    async def test_frames_become_events_and_comments_are_skipped(self, client, hub):
        events = [e async for e in client.aiter_events(bearer="tok", device_id=DEVICE, cursor=7)]
        assert [e["type"] for e in events] == ["install.desired", "catalog.updated"]
        assert events[0]["id"] == 8 and events[0]["payload"]["slug"] == "demo"
        assert events[1]["id"] == 9  # taken from the id: line when the body carries none
        sent = hub.requests[-1]
        assert sent.headers["Last-Event-ID"] == "7" and sent.headers["Accept"] == "text/event-stream"
        assert sent.url.params["product"] == "workmate"

    async def test_a_refused_stream_raises(self, client):
        with pytest.raises(HubError) as refused:
            async for _ in client.aiter_events(bearer="stale", device_id=DEVICE):
                pass
        assert refused.value.reauth is True
