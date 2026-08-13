"""The device registry, driven through the real routes with real headers.

Two devices on one subject is the shape that matters: it is the situation the
whole project exists for, and it is the situation in which every interesting
mistake lives — one device seeing another's rows, a revocation that misses,
a revocation that takes the account with it.

The last-device rule is enforced here rather than by hiding a button, and the
test says so: any client can call the API.
"""

from __future__ import annotations

import pytest

from tests.second_brain.conftest import auth_headers, new_device_id

pytestmark = pytest.mark.asyncio


@pytest.fixture
def two_devices(realm):
    """One person, two machines, and the headers for each."""
    realm.add("tok-a", subject="person-a", email="a@test", display_name="Person A")
    laptop = new_device_id()
    desktop = new_device_id()
    return {
        "laptop": auth_headers("tok-a", laptop, "MacBook Pro"),
        "desktop": auth_headers("tok-a", desktop, "Windows desktop"),
        "laptop_id": laptop,
        "desktop_id": desktop,
    }


class TestHeartbeat:
    async def test_it_records_what_only_the_client_knows(self, client, two_devices):
        response = await client.post(
            "/v1/devices/heartbeat",
            headers=two_devices["laptop"],
            json={"platform": "darwin", "app_version": "0.18.0"},
        )

        assert response.status_code == 200
        device = response.json()["device"]
        assert device["platform"] == "darwin"
        assert device["app_version"] == "0.18.0"
        assert device["name"] == "MacBook Pro"
        assert device["current"] is True

    async def test_an_empty_heartbeat_keeps_what_was_already_known(
        self, client, two_devices
    ):
        await client.post(
            "/v1/devices/heartbeat",
            headers=two_devices["laptop"],
            json={"platform": "darwin", "app_version": "0.18.0"},
        )

        response = await client.post(
            "/v1/devices/heartbeat", headers=two_devices["laptop"], json={}
        )

        # An ordinary request carries only the headers; it must not erase what
        # a heartbeat learned.
        assert response.json()["device"]["platform"] == "darwin"

    async def test_free_text_fields_are_bounded(self, client, two_devices):
        response = await client.post(
            "/v1/devices/heartbeat",
            headers=two_devices["laptop"],
            json={"platform": "x" * 500, "app_version": "y" * 500},
        )

        device = response.json()["device"]
        assert len(device["platform"]) == 64
        assert len(device["app_version"]) == 64

    async def test_it_works_with_no_body_at_all(self, client, two_devices):
        response = await client.post("/v1/devices/heartbeat", headers=two_devices["laptop"])

        assert response.status_code == 200


class TestListing:
    async def test_two_devices_produce_two_rows_with_one_current_each(
        self, client, two_devices
    ):
        await client.post("/v1/devices/heartbeat", headers=two_devices["laptop"], json={})
        await client.post("/v1/devices/heartbeat", headers=two_devices["desktop"], json={})

        from_laptop = (await client.get("/v1/devices", headers=two_devices["laptop"])).json()
        from_desktop = (await client.get("/v1/devices", headers=two_devices["desktop"])).json()

        assert len(from_laptop["devices"]) == 2
        assert len(from_desktop["devices"]) == 2

        # "Current" is a property of the caller, not of the row.
        assert [d["id"] for d in from_laptop["devices"] if d["current"]] == [
            two_devices["laptop_id"]
        ]
        assert [d["id"] for d in from_desktop["devices"] if d["current"]] == [
            two_devices["desktop_id"]
        ]

    async def test_one_person_never_sees_another_persons_devices(self, client, realm):
        realm.add("tok-a", subject="person-a")
        realm.add("tok-b", subject="person-b")
        await client.get("/v1/me", headers=auth_headers("tok-a", new_device_id()))
        await client.get("/v1/me", headers=auth_headers("tok-b", new_device_id()))

        mine = (
            await client.get("/v1/devices", headers=auth_headers("tok-a", new_device_id()))
        ).json()

        # Two devices: person-a's first one and the one asking. Never
        # person-b's, whatever the request says.
        assert len(mine["devices"]) == 2

    async def test_revoked_devices_stay_in_the_list_marked(self, client, two_devices):
        await client.get("/v1/me", headers=two_devices["desktop"])
        await client.delete(
            f"/v1/devices/{two_devices['desktop_id']}", headers=two_devices["laptop"]
        )

        body = (await client.get("/v1/devices", headers=two_devices["laptop"])).json()

        # "Which machine did I cut off, and when" is exactly the question
        # somebody asks after cutting one off.
        revoked = [d for d in body["devices"] if d["revoked"]]
        assert [d["id"] for d in revoked] == [two_devices["desktop_id"]]
        assert revoked[0]["revoked_at"]


class TestRevocation:
    async def test_revoking_the_other_device_leaves_this_one_working(
        self, client, two_devices
    ):
        await client.get("/v1/me", headers=two_devices["desktop"])

        response = await client.delete(
            f"/v1/devices/{two_devices['desktop_id']}", headers=two_devices["laptop"]
        )

        assert response.status_code == 200
        assert response.json()["device"]["revoked"] is True

        # B is out.
        assert (await client.get("/v1/me", headers=two_devices["desktop"])).status_code == 403
        # A is untouched.
        assert (await client.get("/v1/me", headers=two_devices["laptop"])).status_code == 200

    async def test_revoking_another_persons_device_gets_404_not_403(self, client, realm):
        realm.add("tok-a", subject="person-a")
        realm.add("tok-b", subject="person-b")
        theirs = new_device_id()
        await client.get("/v1/me", headers=auth_headers("tok-b", theirs))

        response = await client.delete(
            f"/v1/devices/{theirs}", headers=auth_headers("tok-a", new_device_id())
        )

        # 403 would confirm that somebody else's device id exists, which is
        # not a question this endpoint has any business answering.
        assert response.status_code == 404
        assert response.json()["error"] == "device_not_found"

    async def test_the_other_persons_device_still_works(self, client, realm):
        realm.add("tok-a", subject="person-a")
        realm.add("tok-b", subject="person-b")
        theirs = new_device_id()
        await client.get("/v1/me", headers=auth_headers("tok-b", theirs))

        await client.delete(
            f"/v1/devices/{theirs}", headers=auth_headers("tok-a", new_device_id())
        )

        assert (await client.get("/v1/me", headers=auth_headers("tok-b", theirs))).status_code == 200

    async def test_an_unknown_device_id_gets_404(self, client, two_devices):
        response = await client.delete(
            f"/v1/devices/{new_device_id()}", headers=two_devices["laptop"]
        )

        assert response.status_code == 404

    async def test_a_malformed_device_id_in_the_path_gets_404(self, client, two_devices):
        response = await client.delete("/v1/devices/not-a-uuid", headers=two_devices["laptop"])

        # Not a 500 from Postgres refusing the cast: an id that cannot exist
        # is an id that does not exist.
        assert response.status_code == 404

    async def test_revoking_twice_keeps_the_first_timestamp(self, client, two_devices):
        await client.get("/v1/me", headers=two_devices["desktop"])
        first = await client.delete(
            f"/v1/devices/{two_devices['desktop_id']}", headers=two_devices["laptop"]
        )
        second = await client.delete(
            f"/v1/devices/{two_devices['desktop_id']}", headers=two_devices["laptop"]
        )

        assert second.status_code == 200
        # The audit trail says when access actually ended, not when somebody
        # last clicked the button.
        assert second.json()["device"]["revoked_at"] == first.json()["device"]["revoked_at"]

    async def test_revoking_yourself_is_allowed(self, client, two_devices):
        await client.get("/v1/me", headers=two_devices["desktop"])

        response = await client.delete(
            f"/v1/devices/{two_devices['laptop_id']}", headers=two_devices["laptop"]
        )

        assert response.status_code == 200
        assert (await client.get("/v1/me", headers=two_devices["laptop"])).status_code == 403


class TestLastDevice:
    async def test_revoking_the_only_device_with_rotation_gets_409(self, client, two_devices):
        response = await client.delete(
            f"/v1/devices/{two_devices['laptop_id']}?rotate_key=true",
            headers=two_devices["laptop"],
        )

        # Rotating while cutting off the last machine leaves the new key with
        # nowhere to go. Enforced in the service, because any client can call
        # the API — hiding the button is not enforcement.
        assert response.status_code == 409
        assert response.json()["error"] == "cannot_revoke_last_device"

        # And nothing happened: the device is still live.
        listed = (await client.get("/v1/devices", headers=two_devices["laptop"])).json()
        assert listed["devices"][0]["revoked"] is False

    async def test_revoking_the_only_device_without_rotation_succeeds(
        self, client, two_devices
    ):
        response = await client.delete(
            f"/v1/devices/{two_devices['laptop_id']}", headers=two_devices["laptop"]
        )

        assert response.status_code == 200

    async def test_revoking_with_rotation_is_fine_while_a_second_device_lives(
        self, client, two_devices
    ):
        await client.get("/v1/me", headers=two_devices["desktop"])

        response = await client.delete(
            f"/v1/devices/{two_devices['desktop_id']}?rotate_key=true",
            headers=two_devices["laptop"],
        )

        assert response.status_code == 200

    async def test_an_already_revoked_last_device_can_be_revoked_again_with_rotation(
        self, client, two_devices
    ):
        await client.get("/v1/me", headers=two_devices["desktop"])
        await client.delete(
            f"/v1/devices/{two_devices['desktop_id']}", headers=two_devices["laptop"]
        )

        # The desktop is already out, so this changes nothing about who can
        # collect a new key — the laptop is still here. Refusing would be a
        # rule applied to the wrong situation.
        response = await client.delete(
            f"/v1/devices/{two_devices['desktop_id']}?rotate_key=true",
            headers=two_devices["laptop"],
        )

        assert response.status_code == 200


class TestKeyRotationHook:
    """Rotation is Phase 2. What Phase 1 must not do is *claim* it rotated."""

    async def test_without_the_vault_it_reports_unsupported(self, client, two_devices):
        await client.get("/v1/me", headers=two_devices["desktop"])

        body = (
            await client.delete(
                f"/v1/devices/{two_devices['desktop_id']}?rotate_key=true",
                headers=two_devices["laptop"],
            )
        ).json()

        # Telling somebody who just revoked a stolen laptop that its model
        # access is gone, when it is not, is worse than telling them nothing.
        assert body["key_rotated"] is False
        assert body["key_rotation"] == "unsupported"

    async def test_without_rotation_requested_it_says_so(self, client, two_devices):
        await client.get("/v1/me", headers=two_devices["desktop"])

        body = (
            await client.delete(
                f"/v1/devices/{two_devices['desktop_id']}", headers=two_devices["laptop"]
            )
        ).json()

        assert body["key_rotation"] == "not_requested"

    async def test_a_wired_hook_is_called_with_the_subject(
        self, build_brain, two_devices, realm
    ):
        from tests.second_brain.conftest import brain_client

        rotated: list[str] = []

        async def rotate(subject: str) -> None:
            rotated.append(subject)

        async with brain_client(build_brain(rotate_key=rotate)) as client:
            await client.get("/v1/me", headers=two_devices["desktop"])
            body = (
                await client.delete(
                    f"/v1/devices/{two_devices['desktop_id']}?rotate_key=true",
                    headers=two_devices["laptop"],
                )
            ).json()

        assert rotated == ["person-a"]
        assert body["key_rotated"] is True
        assert body["key_rotation"] == "rotated"

    async def test_a_failing_rotation_does_not_undo_the_revocation(
        self, build_brain, two_devices
    ):
        from tests.second_brain.conftest import brain_client

        async def rotate(subject: str) -> None:
            raise RuntimeError("LiteLLM refused")

        async with brain_client(build_brain(rotate_key=rotate)) as client:
            await client.get("/v1/me", headers=two_devices["desktop"])
            response = await client.delete(
                f"/v1/devices/{two_devices['desktop_id']}?rotate_key=true",
                headers=two_devices["laptop"],
            )

            assert response.status_code == 200
            assert response.json()["key_rotation"] == "failed"
            # The machine is still out. A failed rotation must not readmit it.
            assert (
                await client.get("/v1/me", headers=two_devices["desktop"])
            ).status_code == 403
