"""The backend's three sync routes, and the credential path through them.

These exist because of one constraint, and the tests are mostly about it: the
backend holds no credential for the signed-in person and cannot mint one. The
bearer arrives on ``POST /api/sync/tick`` and nowhere else, which is why that
route is a delivery as well as a trigger, and why the mailbox it fills is what
lets the background loop work between ticks.

Driven through a minimal app with a middleware that sets
``request.state.session`` — the entire contract the dashboard auth gate
provides to these handlers. Standing up ``hermes_cli.web_server.app`` would
drag in the whole dashboard to test three handlers that read one attribute.
The 401 path is still real: it comes from the router's own ``_require_session``.
"""

from __future__ import annotations

import time

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from hermes_cli import sync_engine
from hermes_cli.dashboard_auth.base import Session
from hermes_cli.sync_engine import CredentialMailbox, SyncCredentials, SyncOutcome

DEVICE_ID = "11111111-2222-3333-4444-555555555555"


def _session(token: str = "tok-ada", expires_in: int = 3600) -> Session:
    return Session(
        user_id="kc-ada",
        email="ada@corp.test",
        display_name="Ada Lovelace",
        org_id="",
        provider="keycloak",
        expires_at=int(time.time()) + expires_in,
        access_token=token,
        refresh_token="",
    )


def _sync_app(session: Session | None) -> FastAPI:
    from hermes_cli.web_routers import sync as sync_routes

    app = FastAPI()

    @app.middleware("http")
    async def _attach_session(request: Request, call_next):
        if session is not None:
            request.state.session = session
        return await call_next(request)

    app.include_router(sync_routes.router)
    return app


class _FakeEngine:
    """Records what it was asked to do, and answers the shape a route expects."""

    def __init__(self, outcome: SyncOutcome | None = None) -> None:
        self.ticks = 0
        self.resets = 0
        self.outcome = outcome or SyncOutcome(status="ok", pushed=1, pulled=2)

    def tick(self) -> SyncOutcome:
        self.ticks += 1
        return self.outcome

    def status(self) -> dict:
        return {"configured": True, "cursor": 7, "enabled": True, "pending": 0}

    def reset_cursor(self) -> dict:
        self.resets += 1
        return {"cursor": 0, "pending": 0}


@pytest.fixture
def engine(monkeypatch) -> _FakeEngine:
    fake = _FakeEngine()
    monkeypatch.setattr(sync_engine, "engine", lambda: fake)
    return fake


@pytest.fixture
def mailbox(monkeypatch) -> CredentialMailbox:
    """A mailbox of this test's own, so one test cannot leak into another."""
    box = CredentialMailbox()
    monkeypatch.setattr(sync_engine, "mailbox", lambda: box)
    return box


HEADERS = {"X-AgentX-Device": DEVICE_ID, "X-AgentX-Device-Name": "Ada's laptop"}


class TestTick:
    def test_it_runs_a_tick_and_reports_the_outcome(self, engine, mailbox):
        client = TestClient(_sync_app(_session()))

        response = client.post("/api/sync/tick", headers=HEADERS, json={})

        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        assert engine.ticks == 1

    def test_it_leaves_the_bearer_where_the_background_loop_can_spend_it(
        self, engine, mailbox
    ):
        client = TestClient(_sync_app(_session(token="tok-ada")))

        client.post("/api/sync/tick", headers=HEADERS, json={})

        # This is the whole reason the route exists. Without it the loop has no
        # credential and synchronises nothing, ever.
        held = mailbox.current()
        assert held is not None
        assert held.bearer == "tok-ada"
        assert held.device_id == DEVICE_ID

    def test_an_unauthenticated_call_does_nothing_and_says_so(self, engine, mailbox):
        client = TestClient(_sync_app(None))

        response = client.post("/api/sync/tick", headers=HEADERS, json={})

        assert response.status_code == 200
        assert response.json()["status"] == "signed_out"
        assert engine.ticks == 0
        assert mailbox.current() is None

    def test_a_service_outage_is_answered_200_not_500(self, monkeypatch, mailbox):
        # A service outage is not a failed request from the app's point of
        # view, and an error dialog for one would be wrong every time.
        offline = _FakeEngine(SyncOutcome(status="offline", detail="unreachable"))
        monkeypatch.setattr(sync_engine, "engine", lambda: offline)
        client = TestClient(_sync_app(_session()))

        response = client.post("/api/sync/tick", headers=HEADERS, json={})

        assert response.status_code == 200
        assert response.json()["status"] == "offline"

    def test_a_backend_with_no_desktop_above_it_names_its_own_machine(
        self, engine, mailbox, monkeypatch, tmp_path
    ):
        monkeypatch.setattr(
            "hermes_cli.second_brain_client.install_device_identity",
            lambda root=None: ("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "ssh box"),
        )
        client = TestClient(_sync_app(_session()))

        # No device headers: a CLI sign-in, or a backend started by hand.
        response = client.post("/api/sync/tick", json={})

        assert response.status_code == 200
        assert mailbox.current().device_id == "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

    def test_an_expired_token_is_not_kept(self, engine, mailbox):
        client = TestClient(_sync_app(_session(expires_in=-60)))

        client.post("/api/sync/tick", headers=HEADERS, json={})

        # Spending a token we can see has expired earns a 401, and a 401 puts
        # the engine into its re-auth backoff — suspending synchronisation for
        # five minutes rather than simply waiting for the next tick.
        assert mailbox.current() is None


class TestStatus:
    def test_it_answers_without_a_credential(self, engine, mailbox):
        client = TestClient(_sync_app(None))

        response = client.get("/api/sync/status")

        # The route that has to work when everything else does not.
        assert response.status_code == 200
        assert response.json()["cursor"] == 7

    def test_it_makes_no_network_call_and_runs_no_tick(self, engine, mailbox):
        client = TestClient(_sync_app(_session()))

        client.get("/api/sync/status")

        assert engine.ticks == 0


class TestReset:
    def test_it_rewinds_the_cursor(self, engine, mailbox):
        client = TestClient(_sync_app(_session()))

        response = client.post("/api/sync/reset")

        assert response.status_code == 200
        assert response.json()["cursor"] == 0
        assert engine.resets == 1

    def test_an_unauthenticated_caller_cannot_schedule_the_work(self, engine, mailbox):
        client = TestClient(_sync_app(None))

        response = client.post("/api/sync/reset")

        assert response.status_code == 401
        assert engine.resets == 0


class TestMailbox:
    """The mechanism itself, apart from the routes that feed it."""

    def test_it_holds_the_most_recent_usable_credential(self):
        box = CredentialMailbox()

        box.remember(SyncCredentials(bearer="first", device_id=DEVICE_ID))
        box.remember(SyncCredentials(bearer="second", device_id=DEVICE_ID))

        assert box.current().bearer == "second"

    def test_an_unusable_credential_does_not_replace_a_working_one(self):
        box = CredentialMailbox()
        box.remember(SyncCredentials(bearer="good", device_id=DEVICE_ID))

        box.remember(SyncCredentials(bearer="", device_id=DEVICE_ID))
        box.remember(None)
        box.remember(SyncCredentials(bearer="no device", device_id=""))

        assert box.current().bearer == "good"

    def test_it_forgets_a_credential_once_it_expires(self):
        box = CredentialMailbox()
        box.remember(
            SyncCredentials(
                bearer="tok", device_id=DEVICE_ID, expires_at=time.time() + 60
            )
        )
        assert box.current() is not None

        box.remember(
            SyncCredentials(
                bearer="tok", device_id=DEVICE_ID, expires_at=time.time() - 1
            )
        )

        # The expired one was refused on the way in, and the held one is still
        # good, so it survives.
        assert box.current().bearer == "tok"

    def test_a_held_credential_stops_being_offered_when_it_expires(self):
        box = CredentialMailbox()
        held = SyncCredentials(bearer="tok", device_id=DEVICE_ID, expires_at=time.time() + 0.05)
        box.remember(held)

        time.sleep(0.1)

        assert box.current() is None

    def test_signing_out_clears_it(self):
        box = CredentialMailbox()
        box.remember(SyncCredentials(bearer="tok", device_id=DEVICE_ID))

        box.forget()

        assert box.current() is None

    def test_a_credential_with_no_expiry_is_usable(self):
        # Zero means "unknown". The service is the authority on whether a
        # token is good; refusing to try would be this process second-guessing
        # it.
        box = CredentialMailbox()
        box.remember(SyncCredentials(bearer="tok", device_id=DEVICE_ID, expires_at=0))

        assert box.current() is not None
