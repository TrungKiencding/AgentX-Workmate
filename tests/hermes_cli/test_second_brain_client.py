"""The laptop's half of the device list: the client, and the routes over it.

Everything runs in-process. The second-brain service is an
``httpx.MockTransport`` — the convention the LiteLLM admin client's tests
already follow — so the failure modes that matter can be produced on demand:
a service that is down, a service that says this device is revoked, and a
service that refuses to strand somebody by revoking their last machine.

What is really under test is the offline contract. Settings must degrade to a
sentence when the service is unreachable, and the app must sign out when the
service says this device is gone. Those are opposite responses to two
failures that look alike from a distance, which is exactly why the client
distinguishes them and why every one of them is asserted here.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import httpx
import pytest
import yaml
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from hermes_cli.dashboard_auth.base import Session
from hermes_cli.second_brain_client import SecondBrainClient, SecondBrainError

_BRAIN_URL = "https://brain.internal.test"
_DEVICE_A = "8f2b1c3d-0000-4000-8000-000000000001"
_DEVICE_B = "8f2b1c3d-0000-4000-8000-000000000002"


# ---------------------------------------------------------------------------
# A second brain, in memory
# ---------------------------------------------------------------------------


class _FakeBrain:
    """Just enough of the service to drive the client and the routes."""

    def __init__(self) -> None:
        self.devices: dict[str, dict] = {}
        self.revoked_calls: list[tuple[str, str]] = []
        self.key_calls: list[tuple[str, str]] = []
        self.issued_key = ""
        self.unreachable = False
        self.caller_is_revoked = False
        self.refuse_last_device = False
        self.requests: list[httpx.Request] = []

    def add(self, device_id: str, name: str = "", revoked: bool = False) -> None:
        self.devices[device_id] = {
            "id": device_id,
            "name": name,
            "platform": "",
            "app_version": "",
            "created_at": "2026-08-13T00:00:00+00:00",
            "last_seen_at": "2026-08-13T00:00:00+00:00",
            "revoked_at": "2026-08-13T01:00:00+00:00" if revoked else None,
            "revoked": revoked,
            "current": False,
        }

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)

        if self.unreachable:
            raise httpx.ConnectError("connection refused", request=request)

        if not request.headers.get("X-AgentX-Device"):
            return httpx.Response(
                400, json={"error": "device_header_missing", "detail": "no device"}
            )
        if not request.headers.get("Authorization", "").startswith("Bearer "):
            return httpx.Response(
                401, json={"error": "missing_bearer", "detail": "no bearer"}
            )
        if self.caller_is_revoked:
            return httpx.Response(
                403, json={"error": "device_revoked", "detail": "this device is revoked"}
            )

        caller = request.headers["X-AgentX-Device"]
        path = request.url.path

        if path == "/v1/devices" and request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "devices": [
                        {**row, "current": row["id"] == caller}
                        for row in self.devices.values()
                    ],
                    "current": caller,
                },
            )

        if path == "/v1/devices/heartbeat":
            self.add(caller, name=request.headers.get("X-AgentX-Device-Name", ""))
            return httpx.Response(200, json={"device": self.devices[caller]})

        if path == "/v1/model-key":
            import json

            rotate = bool(json.loads(request.content or b"{}").get("rotate"))
            self.key_calls.append((caller, "rotate" if rotate else "fetch"))
            if rotate or not self.issued_key:
                self.issued_key = f"sk-{len(self.key_calls)}"
            return httpx.Response(
                200,
                json={
                    "key": self.issued_key,
                    "token": f"hash-of-{self.issued_key}",
                    "key_alias": "agentx-workmate-someone",
                    "base_url": "https://litellm.internal.test",
                    "models": [],
                    "status": "rotated" if rotate else "issued",
                },
            )

        if request.method == "DELETE" and path.startswith("/v1/devices/"):
            target = path.rsplit("/", 1)[-1]
            rotate = request.url.params.get("rotate_key") == "true"
            self.revoked_calls.append((target, "rotate" if rotate else "no-rotate"))
            if target not in self.devices:
                return httpx.Response(
                    404, json={"error": "device_not_found", "detail": "no such device"}
                )
            if rotate and self.refuse_last_device:
                return httpx.Response(
                    409,
                    json={
                        "error": "cannot_revoke_last_device",
                        "detail": "this is the only device left",
                    },
                )
            self.devices[target]["revoked"] = True
            self.devices[target]["revoked_at"] = "2026-08-13T02:00:00+00:00"
            return httpx.Response(
                200,
                json={
                    "device": self.devices[target],
                    "key_rotated": False,
                    "key_rotation": "rotated" if rotate else "not_requested",
                },
            )

        return httpx.Response(404, json={"error": "not_found", "detail": path})


@pytest.fixture
def brain() -> _FakeBrain:
    return _FakeBrain()


@pytest.fixture
def client(brain) -> SecondBrainClient:
    return SecondBrainClient(
        _BRAIN_URL, transport=brain.transport, sleep=lambda _seconds: None
    )


# ---------------------------------------------------------------------------
# The client
# ---------------------------------------------------------------------------


class TestClientCalls:
    def test_listing_sends_both_device_headers(self, client, brain):
        client.list_devices(bearer="tok", device_id=_DEVICE_A, device_name="MacBook")

        sent = brain.requests[-1]
        assert sent.headers["X-AgentX-Device"] == _DEVICE_A
        assert sent.headers["X-AgentX-Device-Name"] == "MacBook"
        assert sent.headers["Authorization"] == "Bearer tok"

    def test_listing_marks_the_calling_device(self, client, brain):
        brain.add(_DEVICE_A, "MacBook")
        brain.add(_DEVICE_B, "Desktop")

        body = client.list_devices(bearer="tok", device_id=_DEVICE_A)

        current = [row["id"] for row in body["devices"] if row["current"]]
        assert current == [_DEVICE_A]

    def test_revoking_passes_the_rotation_flag(self, client, brain):
        brain.add(_DEVICE_B)

        client.revoke_device(_DEVICE_B, bearer="tok", device_id=_DEVICE_A, rotate_key=True)

        assert brain.revoked_calls == [(_DEVICE_B, "rotate")]

    def test_not_rotating_is_the_default(self, client, brain):
        brain.add(_DEVICE_B)

        client.revoke_device(_DEVICE_B, bearer="tok", device_id=_DEVICE_A)

        assert brain.revoked_calls == [(_DEVICE_B, "no-rotate")]

    def test_the_model_key_call_defaults_to_fetching_not_rotating(self, client, brain):
        body = client.model_key(bearer="tok", device_id=_DEVICE_A)

        # The default has to be "give me the key you hold". A client whose
        # default rotated would recreate the fault the service exists to fix,
        # one launch at a time.
        assert brain.key_calls == [(_DEVICE_A, "fetch")]
        assert body["key"] == "sk-1"

    def test_two_devices_are_handed_the_same_key(self, client, brain):
        first = client.model_key(bearer="tok", device_id=_DEVICE_A)
        second = client.model_key(bearer="tok", device_id=_DEVICE_B)

        assert first["key"] == second["key"]

    def test_rotation_is_explicit(self, client, brain):
        first = client.model_key(bearer="tok", device_id=_DEVICE_A)

        rotated = client.model_key(bearer="tok", device_id=_DEVICE_A, rotate=True)

        assert brain.key_calls[-1] == (_DEVICE_A, "rotate")
        assert rotated["key"] != first["key"]

    def test_a_revoked_device_asking_for_the_key_is_told_so(self, client, brain):
        brain.caller_is_revoked = True

        with pytest.raises(SecondBrainError) as raised:
            client.model_key(bearer="tok", device_id=_DEVICE_A)

        assert raised.value.revoked is True
        assert raised.value.unreachable is False

    def test_an_unreachable_service_is_not_a_revocation(self, client, brain):
        brain.unreachable = True

        with pytest.raises(SecondBrainError) as raised:
            client.model_key(bearer="tok", device_id=_DEVICE_A)

        assert raised.value.unreachable is True
        assert raised.value.revoked is False

    def test_heartbeat_carries_what_only_the_app_knows(self, client, brain):
        client.heartbeat(
            bearer="tok",
            device_id=_DEVICE_A,
            device_name="MacBook",
            platform="darwin",
            app_version="0.18.0",
        )

        import json

        body = json.loads(brain.requests[-1].content)
        assert body == {
            "name": "MacBook",
            "platform": "darwin",
            "app_version": "0.18.0",
        }


class TestClientFailures:
    def test_an_unreachable_service_is_unreachable_not_refused(self, client, brain):
        brain.unreachable = True

        with pytest.raises(SecondBrainError) as excinfo:
            client.list_devices(bearer="tok", device_id=_DEVICE_A)

        # The distinction the whole file exists for: a caller must be able to
        # tell "keep working, try later" from "you have been cut off".
        assert excinfo.value.unreachable
        assert not excinfo.value.revoked

    def test_a_revoked_device_is_recognised_by_code_not_by_prose(self, client, brain):
        brain.caller_is_revoked = True

        with pytest.raises(SecondBrainError) as excinfo:
            client.list_devices(bearer="tok", device_id=_DEVICE_A)

        assert excinfo.value.revoked
        assert excinfo.value.status_code == 403
        assert excinfo.value.code == "device_revoked"

    def test_the_last_device_refusal_keeps_its_code(self, client, brain):
        brain.add(_DEVICE_A)
        brain.refuse_last_device = True

        with pytest.raises(SecondBrainError) as excinfo:
            client.revoke_device(
                _DEVICE_A, bearer="tok", device_id=_DEVICE_A, rotate_key=True
            )

        assert excinfo.value.code == "cannot_revoke_last_device"
        assert excinfo.value.status_code == 409

    def test_a_5xx_is_retried_once(self, brain):
        seen: list[int] = []

        def _flaky(request: httpx.Request) -> httpx.Response:
            seen.append(1)
            if len(seen) == 1:
                return httpx.Response(503, json={"error": "busy", "detail": "later"})
            return httpx.Response(200, json={"devices": [], "current": _DEVICE_A})

        client = SecondBrainClient(
            _BRAIN_URL, transport=httpx.MockTransport(_flaky), sleep=lambda _s: None
        )

        assert client.list_devices(bearer="tok", device_id=_DEVICE_A)["devices"] == []
        assert len(seen) == 2

    def test_an_empty_base_url_is_refused_at_construction(self):
        # Better here than as a mysterious request to "/v1/devices".
        with pytest.raises(SecondBrainError):
            SecondBrainClient("")


# ---------------------------------------------------------------------------
# The routes the desktop actually calls
# ---------------------------------------------------------------------------
#
# Mounted the same way the existing account-route tests mount them: a minimal
# app with a middleware that sets ``request.state.session``, which is the
# entire contract the dashboard auth gate provides to these handlers.


def _session() -> Session:
    return Session(
        user_id="person-a",
        email="a@test",
        display_name="Person A",
        org_id="",
        provider="keycloak",
        expires_at=0,
        access_token="tok-a",
        refresh_token="",
    )


def _routes_app(session: Session | None = None) -> FastAPI:
    from hermes_cli.web_routers import accounts as accounts_routes

    app = FastAPI()

    @app.middleware("http")
    async def _attach_session(request: Request, call_next):
        if session is not None:
            request.state.session = session
        return await call_next(request)

    app.include_router(accounts_routes.router)
    return app


def _configure(monkeypatch, home: Path, base_url: str) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(
        yaml.safe_dump({"accounts": {"second_brain": {"base_url": base_url}}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("AGENTX_HOME", str(home))


def _route_client_to(monkeypatch, brain: _FakeBrain) -> None:
    """Point every client the routes build at the fake service."""
    from hermes_cli import second_brain_client as module

    real = module.SecondBrainClient

    def _factory(base_url, **kwargs):
        kwargs.setdefault("transport", brain.transport)
        kwargs.setdefault("sleep", lambda _seconds: None)
        return real(base_url, **kwargs)

    monkeypatch.setattr(module, "SecondBrainClient", _factory)


_HEADERS = {"X-AgentX-Device": _DEVICE_A, "X-AgentX-Device-Name": "MacBook"}


class TestDeviceRoutes:
    def test_listing_returns_the_service_answer(self, monkeypatch, tmp_path, brain):
        _configure(monkeypatch, tmp_path / "home", _BRAIN_URL)
        _route_client_to(monkeypatch, brain)
        brain.add(_DEVICE_A, "MacBook")
        brain.add(_DEVICE_B, "Desktop")

        with TestClient(_routes_app(_session())) as client:
            body = client.get("/api/account/devices", headers=_HEADERS).json()

        assert body["status"] == "ok"
        assert {row["id"] for row in body["devices"]} == {_DEVICE_A, _DEVICE_B}
        assert body["current"] == _DEVICE_A

    def test_an_unauthenticated_caller_gets_401(self, monkeypatch, tmp_path, brain):
        _configure(monkeypatch, tmp_path / "home", _BRAIN_URL)

        with TestClient(_routes_app(None)) as client:
            response = client.get("/api/account/devices", headers=_HEADERS)

        assert response.status_code == 401

    def test_no_service_configured_degrades_rather_than_failing(
        self, monkeypatch, tmp_path
    ):
        _configure(monkeypatch, tmp_path / "home", "")

        with TestClient(_routes_app(_session())) as client:
            response = client.get("/api/account/devices", headers=_HEADERS)

        # An install with no service deployed has no device list. That is a
        # sentence in Settings, not a broken app.
        assert response.status_code == 200
        assert response.json()["status"] == "unconfigured"

    def test_an_unreachable_service_reports_offline(self, monkeypatch, tmp_path, brain):
        _configure(monkeypatch, tmp_path / "home", _BRAIN_URL)
        _route_client_to(monkeypatch, brain)
        brain.unreachable = True

        with TestClient(_routes_app(_session())) as client:
            response = client.get("/api/account/devices", headers=_HEADERS)

        # Never an error status: an outage the user cannot act on must not
        # produce a dialog asking them to act on it.
        assert response.status_code == 200
        assert response.json()["status"] == "offline"

    def test_a_revoked_device_is_reported_as_such(self, monkeypatch, tmp_path, brain):
        _configure(monkeypatch, tmp_path / "home", _BRAIN_URL)
        _route_client_to(monkeypatch, brain)
        brain.caller_is_revoked = True

        with TestClient(_routes_app(_session())) as client:
            body = client.get("/api/account/devices", headers=_HEADERS).json()

        # Distinct from `offline` on purpose: this one means sign in again.
        assert body["status"] == "revoked"
        assert body["error"] == "device_revoked"

    def test_a_missing_device_header_says_so(self, monkeypatch, tmp_path, brain):
        _configure(monkeypatch, tmp_path / "home", _BRAIN_URL)
        _route_client_to(monkeypatch, brain)

        with TestClient(_routes_app(_session())) as client:
            body = client.get("/api/account/devices").json()

        assert body["status"] == "no_device_id"

    def test_revoking_forwards_the_rotation_flag(self, monkeypatch, tmp_path, brain):
        _configure(monkeypatch, tmp_path / "home", _BRAIN_URL)
        _route_client_to(monkeypatch, brain)
        brain.add(_DEVICE_B, "Desktop")

        with TestClient(_routes_app(_session())) as client:
            body = client.delete(
                f"/api/account/devices/{_DEVICE_B}?rotate_key=true", headers=_HEADERS
            ).json()

        assert brain.revoked_calls == [(_DEVICE_B, "rotate")]
        assert body["status"] == "ok"
        assert body["device"]["revoked"] is True

    def test_the_last_device_refusal_reaches_the_ui_with_its_code(
        self, monkeypatch, tmp_path, brain
    ):
        _configure(monkeypatch, tmp_path / "home", _BRAIN_URL)
        _route_client_to(monkeypatch, brain)
        brain.add(_DEVICE_A, "MacBook")
        brain.refuse_last_device = True

        with TestClient(_routes_app(_session())) as client:
            body = client.delete(
                f"/api/account/devices/{_DEVICE_A}?rotate_key=true", headers=_HEADERS
            ).json()

        # The UI explains this one in its own words, so it needs the code
        # rather than the service's sentence.
        assert body["status"] == "error"
        assert body["error"] == "cannot_revoke_last_device"
        assert body["status_code"] == 409

    def test_the_heartbeat_registers_this_machine(self, monkeypatch, tmp_path, brain):
        _configure(monkeypatch, tmp_path / "home", _BRAIN_URL)
        _route_client_to(monkeypatch, brain)

        with TestClient(_routes_app(_session())) as client:
            body = client.post(
                "/api/account/devices/heartbeat",
                headers=_HEADERS,
                json={"platform": "darwin", "app_version": "0.18.0"},
            ).json()

        assert body["status"] == "ok"
        assert _DEVICE_A in brain.devices

    def test_the_bearer_forwarded_is_the_session_token(
        self, monkeypatch, tmp_path, brain
    ):
        _configure(monkeypatch, tmp_path / "home", _BRAIN_URL)
        _route_client_to(monkeypatch, brain)

        with TestClient(_routes_app(_session())) as client:
            client.get("/api/account/devices", headers=_HEADERS)

        # The token decides the account on the service side, so forwarding the
        # wrong one would list somebody else's devices.
        assert brain.requests[-1].headers["Authorization"] == "Bearer tok-a"


# ---------------------------------------------------------------------------
# Which machine is this?
# ---------------------------------------------------------------------------


class TestInstallDeviceIdentity:
    """A backend with no desktop above it still has to name its machine.

    The service refuses a request that will not — a device list that cannot
    name the current device is a device list nobody can safely revoke from —
    so a CLI sign-in keeps an id of its own at the install root.
    """

    def test_the_first_read_generates_and_persists_an_id(self, tmp_path):
        from hermes_cli.second_brain_client import (
            DEVICE_FILENAME,
            install_device_identity,
        )

        device_id, name = install_device_identity(tmp_path)

        assert uuid.UUID(device_id)
        assert name
        assert json.loads((tmp_path / DEVICE_FILENAME).read_text())["id"] == device_id

    def test_it_is_the_same_machine_next_time(self, tmp_path):
        from hermes_cli.second_brain_client import install_device_identity

        first, _name = install_device_identity(tmp_path)
        second, _again = install_device_identity(tmp_path)

        # Two ids would be two rows in somebody's device list for one laptop.
        assert first == second

    @pytest.mark.parametrize(
        "content",
        ["", "{", "null", "[]", '{"id": ""}', '{"id": "not-a-uuid"}', '{"id": 7}'],
    )
    def test_an_unusable_file_yields_a_fresh_id_rather_than_raising(
        self, tmp_path, content
    ):
        from hermes_cli.second_brain_client import (
            DEVICE_FILENAME,
            install_device_identity,
        )

        (tmp_path / DEVICE_FILENAME).write_text(content)

        device_id, _name = install_device_identity(tmp_path)

        # This runs on the sign-in path: an unreadable file costs one stale
        # row somebody can delete, where an exception costs them their key.
        assert uuid.UUID(device_id)

    def test_an_unwritable_root_still_answers(self, tmp_path):
        from hermes_cli.second_brain_client import install_device_identity

        blocked = tmp_path / "not-a-directory"
        blocked.write_text("this is a file")

        device_id, _name = install_device_identity(blocked)

        assert uuid.UUID(device_id)

    def test_the_id_matches_the_shape_the_service_accepts(self, tmp_path):
        from second_brain.auth import is_device_id
        from hermes_cli.second_brain_client import install_device_identity

        device_id, _name = install_device_identity(tmp_path)

        assert is_device_id(device_id)

    @pytest.mark.parametrize(
        "hostname,expected",
        [
            ("Kien-MacBook-Pro.local", "Kien-MacBook-Pro.local"),
            ("máy-của-kiên", "m y-c a-ki n"),
            ("laptop\r\nX-Injected: 1", "laptop X-Injected 1"),
            ("   ", "unknown device"),
            ("", "unknown device"),
            ("x" * 200, "x" * 64),
        ],
    )
    def test_the_name_is_safe_to_put_in_a_header(self, hostname, expected):
        from hermes_cli.second_brain_client import device_name_from

        # A machine name is whatever its owner typed, and it reaches a header.
        assert device_name_from(hostname) == expected

    def test_it_agrees_with_the_desktop_on_the_name(self):
        """The same rule as ``deviceNameFrom`` in device-id.ts.

        Both write into the same header and the service normalises it again on
        arrival; three implementations that disagree is three chances for one
        machine to appear under three names.
        """
        from hermes_cli.second_brain_client import device_name_from
        from second_brain.auth import normalize_device_name

        for hostname in ("Kien-MacBook-Pro.local", "desk top", "a_b-c.d"):
            assert normalize_device_name(hostname) == device_name_from(hostname)
