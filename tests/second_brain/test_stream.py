"""The realtime stream: who may open one, and what wakes it.

Driven through Starlette's ``TestClient`` rather than the ASGI transport the
rest of the suite uses, because that transport does not speak WebSocket.
``TestClient`` runs the app in a private event loop on its own thread, which
is exactly what breaks a shared asyncpg pool — so these tests let the app own
its store, opened inside that loop, instead of borrowing the session's.

Two things are being pinned.

**The socket is authenticated like every other route.** It has to be: a stream
that told a revoked machine when its old account changed would make the device
list a lie.

**A notification is a nudge, never a delivery.** Nothing here asserts that a
document arrives over the socket, because none ever should — a woken client
re-reads the feed from its own cursor. That is what keeps this an optimisation
in front of polling rather than a second delivery path that can disagree with
it.
"""

from __future__ import annotations

import dataclasses
import json

import pytest

from tests.second_brain.conftest import auth_headers, new_device_id


@pytest.fixture
def realm_with_alice(realm):
    realm.add("tok-alice", subject="alice", email="alice@test", display_name="Alice")
    realm.add("tok-bob", subject="bob", email="bob@test", display_name="Bob")
    return realm


@pytest.fixture
def streaming_app(brain_settings, realm_with_alice):
    """An app that owns its store, so the pool lands in TestClient's loop.

    Deliberately NOT the ``store`` fixture: that pool belongs to the test's
    own event loop, and asyncpg refuses to be shared across two.
    """
    from second_brain.app import build_app

    return build_app(
        # A short keepalive is not wanted here; the default is fine and the
        # tests never wait for one.
        settings=dataclasses.replace(brain_settings),
        provider=realm_with_alice,
        litellm=None,
    )


@pytest.fixture
def streaming_client(streaming_app):
    from starlette.testclient import TestClient

    with TestClient(streaming_app) as client:
        yield client


ALICE_DEVICE = new_device_id()


def alice_headers(device_id=None):
    return auth_headers("tok-alice", device_id or ALICE_DEVICE, "Alice laptop")


class TestHandshake:
    def test_a_verified_device_gets_a_socket_and_a_hello(self, streaming_client):
        with streaming_client.websocket_connect(
            "/v1/sync/stream", headers=alice_headers()
        ) as socket:
            hello = socket.receive_json()

        assert hello["type"] == "hello"
        assert hello["device"] == ALICE_DEVICE

    def test_an_unauthenticated_socket_is_refused(self, streaming_client):
        from starlette.testclient import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect) as refused:
            with streaming_client.websocket_connect(
                "/v1/sync/stream", headers={"X-AgentX-Device": ALICE_DEVICE}
            ) as socket:
                socket.receive_json()

        assert refused.value.code == 4401

    def test_a_socket_with_no_device_header_is_refused(self, streaming_client):
        from starlette.testclient import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect) as refused:
            with streaming_client.websocket_connect(
                "/v1/sync/stream", headers={"Authorization": "Bearer tok-alice"}
            ) as socket:
                socket.receive_json()

        assert refused.value.code == 4400

    def test_a_revoked_device_is_refused_with_a_code_it_can_act_on(
        self, streaming_client
    ):
        from starlette.testclient import WebSocketDisconnect

        doomed = new_device_id()
        streaming_client.post(
            "/v1/devices/heartbeat", headers=alice_headers(doomed), json={}
        )
        streaming_client.delete(f"/v1/devices/{doomed}", headers=alice_headers())

        with pytest.raises(WebSocketDisconnect) as refused:
            with streaming_client.websocket_connect(
                "/v1/sync/stream", headers=alice_headers(doomed)
            ) as socket:
                socket.receive_json()

        # A stream that told a revoked machine when its old account changed
        # would make the device list a lie.
        assert refused.value.code == 4403

    def test_an_identity_outage_does_not_look_like_a_revocation(
        self, streaming_client, realm_with_alice
    ):
        from starlette.testclient import WebSocketDisconnect

        realm_with_alice.outage_tokens.add("tok-alice")

        with pytest.raises(WebSocketDisconnect) as refused:
            with streaming_client.websocket_connect(
                "/v1/sync/stream", headers=alice_headers()
            ) as socket:
                socket.receive_json()

        # Not 4401 and not 4403: a laptop reads either as "your credentials
        # are dead". 503 maps to the generic code, which says "try again".
        assert refused.value.code == 1011


class TestWaking:
    def test_a_push_wakes_a_listening_device(self, streaming_client):
        with streaming_client.websocket_connect(
            "/v1/sync/stream", headers=alice_headers()
        ) as socket:
            assert socket.receive_json()["type"] == "hello"

            streaming_client.post(
                "/v1/sync/push",
                headers=alice_headers(new_device_id()),
                json={
                    "documents": [
                        {
                            "kind": "session",
                            "doc_id": "s1",
                            "updated_at": 100.0,
                            "payload": {"title": "from the other machine"},
                        }
                    ]
                },
            )

            message = socket.receive_json()

        assert message["type"] == "changed"
        # A nudge, never a delivery. The client re-reads the feed from its own
        # cursor, which is what keeps this from being a second delivery path.
        assert "payload" not in message
        assert "documents" not in message

    def test_one_persons_push_does_not_wake_another_persons_device(
        self, streaming_client
    ):
        with streaming_client.websocket_connect(
            "/v1/sync/stream", headers=alice_headers()
        ) as socket:
            socket.receive_json()

            streaming_client.post(
                "/v1/sync/push",
                headers=auth_headers("tok-bob", new_device_id(), "Bob laptop"),
                json={
                    "documents": [
                        {"kind": "session", "doc_id": "b1", "updated_at": 1.0, "payload": {}}
                    ]
                },
            )
            # Alice's own push, so there IS something to receive — and if
            # Bob's had leaked through, this would be the second message
            # rather than the first.
            streaming_client.post(
                "/v1/sync/push",
                headers=alice_headers(new_device_id()),
                json={
                    "documents": [
                        {
                            "kind": "session",
                            "doc_id": "a1",
                            "updated_at": 1.0,
                            "payload": {"who": "alice"},
                        }
                    ]
                },
            )

            first = socket.receive_json()

        assert first["type"] == "changed"

    def test_health_reports_realtime_separately(self, streaming_client):
        body = streaming_client.get("/health").json()

        assert body["realtime"]["status"] in ("ok", "polling")
        assert "accounts_watching" in body["realtime"]


class TestNotifier:
    """The fan-out itself, without a socket in the way."""

    def test_it_wakes_only_the_subject_that_changed(self):
        import asyncio

        from second_brain.stream import DocumentNotifier

        async def run():
            notifier = DocumentNotifier()
            notifier._loop = asyncio.get_running_loop()
            alice = notifier.subscribe("alice")
            bob = notifier.subscribe("bob")

            notifier._wake("alice")
            await asyncio.sleep(0)

            return alice.is_set(), bob.is_set()

        assert asyncio.run(run()) == (True, False)

    def test_every_device_on_one_account_is_woken(self):
        import asyncio

        from second_brain.stream import DocumentNotifier

        async def run():
            notifier = DocumentNotifier()
            notifier._loop = asyncio.get_running_loop()
            first = notifier.subscribe("alice")
            second = notifier.subscribe("alice")

            notifier._wake("alice")
            await asyncio.sleep(0)

            return first.is_set(), second.is_set()

        assert asyncio.run(run()) == (True, True)

    def test_unsubscribing_the_last_device_drops_the_account(self):
        import asyncio

        from second_brain.stream import DocumentNotifier

        async def run():
            notifier = DocumentNotifier()
            notifier._loop = asyncio.get_running_loop()
            event = notifier.subscribe("alice")
            assert notifier.subjects == 1

            notifier.unsubscribe("alice", event)
            return notifier.subjects

        # Otherwise a service up for months holds an empty set per person who
        # ever connected.
        assert asyncio.run(run()) == 0

    def test_a_notification_with_nobody_listening_is_harmless(self):
        import asyncio

        from second_brain.stream import DocumentNotifier

        async def run():
            notifier = DocumentNotifier()
            notifier._loop = asyncio.get_running_loop()
            notifier._wake("nobody")
            return True

        assert asyncio.run(run()) is True

    def test_a_handler_that_raises_does_not_kill_the_listener(self):
        import asyncio

        from second_brain.stream import DocumentNotifier

        async def run():
            notifier = DocumentNotifier()
            notifier._loop = asyncio.get_running_loop()

            # asyncpg calls this from its own connection handling; an
            # exception escaping would take the listener down with it and
            # every device would silently fall back to polling.
            notifier._on_notify("alice")
            return True

        assert asyncio.run(run()) is True
