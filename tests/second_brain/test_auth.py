"""The security boundary: who may call, and what a failure is allowed to mean.

The realm is a fake, injected. That is not a shortcut — it is the only way to
exercise the case that matters most, an identity provider that is *down*. A
suite that could only test "valid token" and "invalid token" would leave the
one decision with a blast radius (503 versus 401) untested, and that decision
is the difference between a laptop waiting out an outage and a laptop throwing
away credentials it will need when the outage ends.

Postgres is real, because "is this device revoked" is a question about a row.
"""

from __future__ import annotations

import pytest

from hermes_cli.accounts import account_slug_for_identity
from second_brain.auth import bearer_from, normalize_device_name
from tests.second_brain.conftest import auth_headers, new_device_id

pytestmark = pytest.mark.asyncio


# ---------------------------------------------------------------------------
# Header parsing — small, and worth pinning
# ---------------------------------------------------------------------------


class TestHeaderParsing:
    @pytest.mark.parametrize(
        "header,expected",
        [
            ("Bearer abc", "abc"),
            ("bearer abc", "abc"),
            ("BEARER   abc  ", "abc"),
            ("", ""),
            ("abc", ""),
            ("Basic abc", ""),
            # A scheme that merely starts with the right letters is not the
            # right scheme.
            ("Bearerabc", ""),
        ],
    )
    async def test_bearer_extraction(self, header, expected):
        assert bearer_from(header) == expected

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("Kien's MacBook Pro", "Kien s MacBook Pro"),
            ("  spaced   out  ", "spaced out"),
            # A header value cannot carry CR/LF, and the name is
            # user-controlled: somebody's laptop can be called anything.
            ("evil\r\nX-Injected: 1", "evil X-Injected 1"),
            ("máy-của-tôi", "m y-c a-t i"),
            ("", ""),
        ],
    )
    async def test_device_name_normalisation(self, raw, expected):
        assert normalize_device_name(raw) == expected

    async def test_device_name_is_bounded(self):
        assert len(normalize_device_name("x" * 500)) == 64


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------


class TestIdentity:
    async def test_a_valid_token_resolves_to_the_slug_the_cli_computes(
        self, client, realm
    ):
        realm.add(
            "tok-a",
            subject="8f2b1c3d-0000-4000-8000-000000000001",
            email="kien@agentx.test",
            display_name="Kien",
        )

        response = await client.get(
            "/v1/me", headers=auth_headers("tok-a", new_device_id())
        )

        assert response.status_code == 200
        body = response.json()
        assert body["subject"] == "8f2b1c3d-0000-4000-8000-000000000001"
        # The same derivation the laptop performs, so one person's slug is the
        # same string on the server, in `agentx account list`, and in the path
        # of their home directory.
        assert body["account"] == account_slug_for_identity(
            "8f2b1c3d-0000-4000-8000-000000000001",
            username="Kien",
            email="kien@agentx.test",
        )
        assert body["email"] == "kien@agentx.test"

    async def test_an_unknown_token_gets_401(self, client):
        response = await client.get(
            "/v1/me", headers=auth_headers("never-issued", new_device_id())
        )

        assert response.status_code == 401
        assert response.json()["error"] == "invalid_token"

    async def test_a_missing_bearer_gets_401(self, client):
        response = await client.get(
            "/v1/me", headers={"X-AgentX-Device": new_device_id()}
        )

        assert response.status_code == 401
        assert response.json()["error"] == "missing_bearer"

    async def test_an_identity_outage_gets_503_and_never_401(self, client, realm):
        realm.add("tok-a", subject="person-a")
        realm.outage_tokens.add("tok-a")

        response = await client.get(
            "/v1/me", headers=auth_headers("tok-a", new_device_id())
        )

        # The whole point. A 401 here would tell the laptop its credentials
        # are dead and make it discard a key that is perfectly good.
        assert response.status_code == 503
        assert response.json()["error"] == "identity_unavailable"

    async def test_a_token_with_no_subject_gets_401(self, client, realm):
        realm.add("tok-empty", subject="")

        response = await client.get(
            "/v1/me", headers=auth_headers("tok-empty", new_device_id())
        )

        assert response.status_code == 401

    async def test_the_account_row_is_created_from_the_verified_claims(
        self, client, realm, store, raw_pg
    ):
        realm.add("tok-a", subject="person-a", email="a@test", display_name="Person A")

        await client.get("/v1/me", headers=auth_headers("tok-a", new_device_id()))

        row = await raw_pg.fetchrow("SELECT * FROM accounts WHERE subject = 'person-a'")
        assert row is not None
        assert row["email"] == "a@test"
        assert row["display_name"] == "Person A"
        assert row["issuer"] == "fake-realm"

    async def test_a_renamed_person_updates_in_place(self, client, realm, raw_pg):
        realm.add("tok-a", subject="person-a", email="old@test", display_name="Old")
        device = new_device_id()
        await client.get("/v1/me", headers=auth_headers("tok-a", device))

        realm.add("tok-a", subject="person-a", email="new@test", display_name="New")
        await client.get("/v1/me", headers=auth_headers("tok-a", device))

        rows = await raw_pg.fetch("SELECT * FROM accounts WHERE subject = 'person-a'")
        # One person, one row — a changed email must not fork the account.
        assert len(rows) == 1
        assert rows[0]["email"] == "new@test"


# ---------------------------------------------------------------------------
# Device headers
# ---------------------------------------------------------------------------


class TestDeviceHeader:
    async def test_a_missing_device_header_gets_400(self, client, realm):
        realm.add("tok-a", subject="person-a")

        response = await client.get("/v1/me", headers={"Authorization": "Bearer tok-a"})

        assert response.status_code == 400
        assert response.json()["error"] == "device_header_missing"

    @pytest.mark.parametrize(
        "value", ["not-a-uuid", "12345", "", "   ", "8f2b1c3d-0000-4000-8000"]
    )
    async def test_a_malformed_device_header_gets_400(self, client, realm, value):
        realm.add("tok-a", subject="person-a")

        response = await client.get(
            "/v1/me",
            headers={"Authorization": "Bearer tok-a", "X-AgentX-Device": value},
        )

        assert response.status_code == 400
        assert response.json()["error"] in {
            "device_header_missing",
            "device_header_invalid",
        }

    async def test_an_uppercase_device_id_is_the_same_device(self, client, realm, store):
        realm.add("tok-a", subject="person-a")
        device = new_device_id()

        await client.get("/v1/me", headers=auth_headers("tok-a", device))
        await client.get("/v1/me", headers=auth_headers("tok-a", device.upper()))

        # Two spellings of one id must not become two devices in somebody's
        # device list.
        assert len(await store.list_devices("person-a")) == 1

    async def test_the_calling_device_is_registered_without_a_heartbeat(
        self, client, realm, store
    ):
        realm.add("tok-a", subject="person-a")
        device = new_device_id()

        await client.get("/v1/me", headers=auth_headers("tok-a", device, "Laptop"))

        # A device that can call the service but is missing from the registry
        # is a device nobody can revoke.
        devices = await store.list_devices("person-a")
        assert [d.id for d in devices] == [device]
        assert devices[0].name == "Laptop"

    async def test_the_same_install_can_serve_two_people(self, client, realm, store):
        # `device.json` lives in userData, not in an account home, so two
        # people sharing one laptop legitimately present the same device id.
        realm.add("tok-a", subject="person-a")
        realm.add("tok-b", subject="person-b")
        device = new_device_id()

        first = await client.get("/v1/me", headers=auth_headers("tok-a", device))
        second = await client.get("/v1/me", headers=auth_headers("tok-b", device))

        assert first.status_code == 200
        assert second.status_code == 200
        assert len(await store.list_devices("person-a")) == 1
        assert len(await store.list_devices("person-b")) == 1


# ---------------------------------------------------------------------------
# Revocation
# ---------------------------------------------------------------------------


class TestRevokedDevice:
    async def test_a_revoked_device_gets_403_on_every_route(self, client, realm, store):
        realm.add("tok-a", subject="person-a")
        device = new_device_id()
        await client.get("/v1/me", headers=auth_headers("tok-a", device))

        await store.revoke_device("person-a", device)

        headers = auth_headers("tok-a", device)
        for method, path in (
            ("GET", "/v1/me"),
            ("GET", "/v1/devices"),
            ("POST", "/v1/devices/heartbeat"),
            ("DELETE", f"/v1/devices/{device}"),
        ):
            response = await client.request(method, path, headers=headers)
            assert response.status_code == 403, f"{method} {path}"
            assert response.json()["error"] == "device_revoked"

    async def test_revocation_survives_the_device_calling_again(
        self, client, realm, store
    ):
        realm.add("tok-a", subject="person-a")
        device = new_device_id()
        await client.get("/v1/me", headers=auth_headers("tok-a", device))
        revoked = await store.revoke_device("person-a", device)
        assert revoked is not None

        for _ in range(3):
            await client.get("/v1/me", headers=auth_headers("tok-a", device))

        # A revoked device must not be able to un-revoke itself by retrying,
        # and its last-seen must keep meaning "last really used".
        after = await store.device("person-a", device)
        assert after is not None
        assert after.revoked_at == revoked.revoked_at

    async def test_one_person_revoked_device_does_not_affect_another(
        self, client, realm, store
    ):
        realm.add("tok-a", subject="person-a")
        realm.add("tok-b", subject="person-b")
        shared_install = new_device_id()
        await client.get("/v1/me", headers=auth_headers("tok-a", shared_install))
        await client.get("/v1/me", headers=auth_headers("tok-b", shared_install))

        await store.revoke_device("person-a", shared_install)

        mine = await client.get("/v1/me", headers=auth_headers("tok-a", shared_install))
        theirs = await client.get("/v1/me", headers=auth_headers("tok-b", shared_install))

        assert mine.status_code == 403
        assert theirs.status_code == 200


# ---------------------------------------------------------------------------
# Store outage
# ---------------------------------------------------------------------------


class TestStoreOutage:
    async def test_an_unreachable_store_gets_503_not_500(self, client, realm, store):
        realm.add("tok-a", subject="person-a")
        await store.close()

        response = await client.get(
            "/v1/me", headers=auth_headers("tok-a", new_device_id())
        )

        # Same reasoning as the identity outage: nothing is wrong with the
        # request, so the answer must not look like the caller's fault.
        assert response.status_code == 503
        assert response.json()["error"] == "store_unavailable"
