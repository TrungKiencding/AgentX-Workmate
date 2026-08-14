"""The key vault, driven through the real route from two real devices.

This file is where the bug the whole project exists for gets its regression
test. The shape that matters is one person on two machines: device A asks for
a key, device B asks for a key, and **both hold the same one afterwards**.
Everything else here is a way of making sure that stays true — that the second
call mints nothing, that rotation cuts exactly one key and not the caller's,
and that every failure mode leaves the caller with the key they already had.

The proxy is the same ``FakeLiteLLM`` the provisioning tests drive, imported
rather than reimplemented. Its two faithful details are the ones this module's
correctness rests on: a minted key's plaintext comes back exactly once, and
``/key/list`` never returns it. A second fake would be a second set of
assumptions about LiteLLM, and the day they drifted apart one of the two
suites would be green about nothing.
"""

from __future__ import annotations

import pytest
import pytest_asyncio

from hermes_cli.litellm_admin import LiteLLMAdminClient
from second_brain.keys import decrypt_key, encrypt_key
from tests.hermes_cli.test_account_provisioning import FakeLiteLLM
from tests.second_brain.conftest import auth_headers, brain_client, new_device_id

pytestmark = pytest.mark.asyncio

PROXY_URL = "https://litellm.test"


@pytest.fixture
def proxy() -> FakeLiteLLM:
    return FakeLiteLLM()


@pytest.fixture
def admin_client(proxy) -> LiteLLMAdminClient:
    """An admin client wired to the fake, with the retry sleep taken out."""
    return LiteLLMAdminClient(
        PROXY_URL,
        proxy.admin_key,
        transport=proxy.transport,
        sleep=lambda _delay: None,
    )


@pytest.fixture
def vault_settings(brain_settings, proxy):
    """The session's settings, pointed at the proxy the fake stands in for.

    Named here rather than only on the injected client because the *settings*
    are the authority on where LiteLLM lives — it is what the service records
    on the row and hands to the laptop, so that moving the proxy is a change
    on one server rather than a config push to every machine.
    """
    import dataclasses

    return dataclasses.replace(
        brain_settings,
        litellm_base_url=PROXY_URL,
        litellm_admin_key=proxy.admin_key,
    )


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


@pytest_asyncio.fixture
async def vault(build_brain, admin_client, vault_settings):
    """An app whose LiteLLM is the fake, with the rotation hook wired."""
    async with brain_client(
        build_brain(litellm=admin_client, settings=vault_settings)
    ) as connected:
        yield connected


# ===========================================================================
# The bug this project exists for
# ===========================================================================


class TestOneKeyPerPerson:
    async def test_two_devices_get_the_same_key_and_litellm_mints_once(
        self, vault, proxy, two_devices
    ):
        first = await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})
        second = await vault.post("/v1/model-key", headers=two_devices["desktop"], json={})

        assert first.status_code == 200
        assert second.status_code == 200

        # THE assertion. Before the vault, the second sign-in deleted the
        # first machine's key and minted a different one.
        assert first.json()["key"] == second.json()["key"]
        assert first.json()["key"].startswith("sk-")

        assert proxy.paths_hit("/key/generate") == 1
        assert first.json()["status"] == "issued"
        assert second.json()["status"] == "reused"

    async def test_the_second_call_touches_the_proxy_not_at_all(
        self, vault, proxy, two_devices
    ):
        await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})
        proxy.requests.clear()

        await vault.post("/v1/model-key", headers=two_devices["desktop"], json={})

        # Not "mints nothing" — makes no request whatsoever. A liveness probe
        # here would put the proxy back on the path of every launch.
        assert proxy.requests == []

    async def test_nothing_is_ever_deleted_by_alias(self, vault, proxy, two_devices):
        await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})
        await vault.post("/v1/model-key", headers=two_devices["desktop"], json={})
        await vault.post("/v1/model-key", headers=two_devices["laptop"], json={"rotate": True})

        # Looking a key up by alias is the first half of delete-by-alias, and
        # delete-by-alias is the defect. The vault has no reason to ask.
        assert proxy.paths_hit("/key/list") == 0

    async def test_one_person_never_receives_anothers_key(self, vault, realm):
        realm.add("tok-a", subject="person-a")
        realm.add("tok-b", subject="person-b")

        mine = await vault.post(
            "/v1/model-key", headers=auth_headers("tok-a", new_device_id()), json={}
        )
        theirs = await vault.post(
            "/v1/model-key", headers=auth_headers("tok-b", new_device_id()), json={}
        )

        assert mine.json()["key"] != theirs.json()["key"]
        assert mine.json()["key_alias"] != theirs.json()["key_alias"]

    async def test_the_alias_and_account_match_what_the_laptop_derives(
        self, vault, two_devices
    ):
        from hermes_cli.account_provisioning import LiteLLMAccountSettings
        from hermes_cli.accounts import account_slug_for_identity

        body = (
            await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})
        ).json()

        slug = account_slug_for_identity(
            "person-a", username="Person A", email="a@test"
        )
        assert body["account"] == slug
        # Nothing depends on the two agreeing, but an operator reading the
        # proxy's console is entitled to one naming scheme rather than two.
        assert body["key_alias"] == LiteLLMAccountSettings().alias_for(slug)

    async def test_the_response_carries_what_the_laptop_records(self, vault, two_devices):
        body = (
            await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})
        ).json()

        assert body["base_url"] == PROXY_URL
        assert body["token"]
        assert body["rotated_at"] is None
        assert body["created_at"]

    async def test_a_missing_body_is_the_same_as_an_empty_one(self, vault, two_devices):
        response = await vault.post("/v1/model-key", headers=two_devices["laptop"])

        assert response.status_code == 200
        assert response.json()["status"] == "issued"


# ===========================================================================
# Concurrency
# ===========================================================================


class TestConcurrentIssuance:
    @pytest.mark.parametrize("attempt", range(4))
    async def test_devices_arriving_together_still_mint_exactly_one_key(
        self, vault, proxy, two_devices, attempt
    ):
        """Two first calls at once must not become two keys.

        The loser of that race would leave a key alive in LiteLLM that nobody
        holds — billable, countable against the person's budget, and invisible
        to the only client that could have used it. Repeated, because a race
        that is tested once is a race that is tested on a good day.
        """
        import asyncio

        first, second = await asyncio.gather(
            vault.post("/v1/model-key", headers=two_devices["laptop"], json={}),
            vault.post("/v1/model-key", headers=two_devices["desktop"], json={}),
        )

        assert first.status_code == 200
        assert second.status_code == 200
        assert first.json()["key"] == second.json()["key"]
        assert proxy.paths_hit("/key/generate") == 1
        assert len(proxy.records) == 1

    async def test_two_people_do_not_wait_on_each_other(self, vault, realm, proxy):
        """The lock is per subject, so two first-time sign-ins run at once."""
        import asyncio

        realm.add("tok-a", subject="person-a")
        realm.add("tok-b", subject="person-b")

        mine, theirs = await asyncio.gather(
            vault.post(
                "/v1/model-key", headers=auth_headers("tok-a", new_device_id()), json={}
            ),
            vault.post(
                "/v1/model-key", headers=auth_headers("tok-b", new_device_id()), json={}
            ),
        )

        assert mine.status_code == 200
        assert theirs.status_code == 200
        assert proxy.paths_hit("/key/generate") == 2


# ===========================================================================
# Rotation
# ===========================================================================


class TestRotation:
    async def test_rotation_replaces_the_key_and_retires_exactly_the_old_one(
        self, vault, proxy, two_devices
    ):
        first = (
            await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})
        ).json()

        rotated = (
            await vault.post(
                "/v1/model-key", headers=two_devices["laptop"], json={"rotate": True}
            )
        ).json()

        assert rotated["key"] != first["key"]
        assert rotated["status"] == "rotated"
        assert rotated["rotated_at"]

        # Exactly the previously stored token, and nothing else.
        assert not proxy.holds_token(first["token"])
        assert proxy.holds_token(rotated["token"])
        assert len(proxy.records) == 1

    async def test_the_other_device_collects_the_new_key_on_its_next_call(
        self, vault, two_devices
    ):
        before = (
            await vault.post("/v1/model-key", headers=two_devices["desktop"], json={})
        ).json()
        rotated = (
            await vault.post(
                "/v1/model-key", headers=two_devices["laptop"], json={"rotate": True}
            )
        ).json()

        after = (
            await vault.post("/v1/model-key", headers=two_devices["desktop"], json={})
        ).json()

        # Self-healing: the other machine is not broken by a rotation, it is
        # one call behind it.
        assert before["key"] != after["key"]
        assert after["key"] == rotated["key"]
        assert after["status"] == "reused"

    async def test_rotating_before_anything_was_issued_just_issues(
        self, vault, proxy, two_devices
    ):
        body = (
            await vault.post(
                "/v1/model-key", headers=two_devices["laptop"], json={"rotate": True}
            )
        ).json()

        assert body["status"] == "issued"
        assert body["rotated_at"] is None
        assert proxy.paths_hit("/key/delete") == 0

    async def test_the_alias_survives_rotation(self, vault, two_devices):
        first = (
            await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})
        ).json()
        rotated = (
            await vault.post(
                "/v1/model-key", headers=two_devices["laptop"], json={"rotate": True}
            )
        ).json()

        assert rotated["key_alias"] == first["key_alias"]

    async def test_a_proxy_that_cannot_delete_still_completes_the_rotation(
        self, build_brain, proxy, vault_settings, two_devices
    ):
        """The replacement is already stored, so a failed delete is a leak to
        clean up, not a rotation to fail."""

        class _RefusesDelete(LiteLLMAdminClient):
            def delete_keys(self, tokens):
                raise RuntimeError("the proxy dropped the connection")

        client = _RefusesDelete(
            PROXY_URL, proxy.admin_key, transport=proxy.transport, sleep=lambda _d: None
        )

        async with brain_client(
            build_brain(litellm=client, settings=vault_settings)
        ) as vault:
            first = (
                await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})
            ).json()
            rotated = await vault.post(
                "/v1/model-key", headers=two_devices["laptop"], json={"rotate": True}
            )

            assert rotated.status_code == 200
            assert rotated.json()["key"] != first["key"]

            # And the new key is what everybody gets from now on.
            again = await vault.post(
                "/v1/model-key", headers=two_devices["desktop"], json={}
            )
            assert again.json()["key"] == rotated.json()["key"]


class TestRotationFromRevocation:
    """``DELETE /v1/devices/{id}?rotate_key=true`` is what actually cuts a
    revoked machine's model access. One key per person means revoking alone
    cannot."""

    async def test_revoking_with_rotation_issues_a_new_key(
        self, vault, proxy, two_devices
    ):
        held = (
            await vault.post("/v1/model-key", headers=two_devices["desktop"], json={})
        ).json()

        revoked = await vault.delete(
            f"/v1/devices/{two_devices['desktop_id']}?rotate_key=true",
            headers=two_devices["laptop"],
        )

        assert revoked.status_code == 200
        assert revoked.json()["key_rotation"] == "rotated"
        assert revoked.json()["key_rotated"] is True

        # The revoked machine's key is dead at the proxy, which is the point.
        assert not proxy.holds_token(held["token"])

        # And the machine that stays gets the replacement.
        after = await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})
        assert after.json()["key"] != held["key"]

    async def test_revoking_someone_who_never_had_a_key_says_so(
        self, vault, two_devices
    ):
        await vault.get("/v1/me", headers=two_devices["desktop"])

        body = (
            await vault.delete(
                f"/v1/devices/{two_devices['desktop_id']}?rotate_key=true",
                headers=two_devices["laptop"],
            )
        ).json()

        # "There was no key to rotate" is not the same event as "the key was
        # rotated", and reporting it as one would tell somebody their stolen
        # laptop lost access it never had.
        assert body["key_rotation"] == "no_key"
        assert body["key_rotated"] is False

    async def test_a_deploy_with_no_proxy_still_reports_unsupported(
        self, client, two_devices
    ):
        # `client` is built with litellm=None: nothing to rotate against, so
        # the hook is absent rather than silently failing.
        await client.get("/v1/me", headers=two_devices["desktop"])

        body = (
            await client.delete(
                f"/v1/devices/{two_devices['desktop_id']}?rotate_key=true",
                headers=two_devices["laptop"],
            )
        ).json()

        assert body["key_rotation"] == "unsupported"


# ===========================================================================
# The envelope
# ===========================================================================


class TestEnvelope:
    async def test_a_round_trip_returns_the_key(self):
        kek = bytes(range(32))

        ciphertext, nonce = encrypt_key("sk-secret", kek=kek, subject="person-a")

        assert decrypt_key(ciphertext, nonce, kek=kek, subject="person-a") == "sk-secret"

    async def test_the_plaintext_is_nowhere_in_the_ciphertext(self):
        ciphertext, _nonce = encrypt_key("sk-secret", kek=bytes(range(32)), subject="a")

        assert b"sk-secret" not in ciphertext

    async def test_another_subject_cannot_open_it(self):
        from cryptography.exceptions import InvalidTag

        kek = bytes(range(32))
        ciphertext, nonce = encrypt_key("sk-secret", kek=kek, subject="person-a")

        # A row lifted from a dump and relabelled as somebody else's does not
        # open. That is what binding the subject as AAD buys.
        with pytest.raises(InvalidTag):
            decrypt_key(ciphertext, nonce, kek=kek, subject="person-b")

    async def test_another_kek_cannot_open_it(self):
        from cryptography.exceptions import InvalidTag

        ciphertext, nonce = encrypt_key("sk-secret", kek=bytes(range(32)), subject="a")

        with pytest.raises(InvalidTag):
            decrypt_key(ciphertext, nonce, kek=bytes(32), subject="a")

    async def test_an_edited_ciphertext_does_not_open(self):
        from cryptography.exceptions import InvalidTag

        kek = bytes(range(32))
        ciphertext, nonce = encrypt_key("sk-secret", kek=kek, subject="a")
        tampered = bytes([ciphertext[0] ^ 0x01]) + ciphertext[1:]

        with pytest.raises(InvalidTag):
            decrypt_key(tampered, nonce, kek=kek, subject="a")

    async def test_two_encryptions_of_one_key_differ(self):
        kek = bytes(range(32))

        first, first_nonce = encrypt_key("sk-secret", kek=kek, subject="a")
        second, second_nonce = encrypt_key("sk-secret", kek=kek, subject="a")

        # A fresh nonce per write. Reusing one under AES-GCM is the failure
        # that loses the key, not merely the confidentiality of one message.
        assert first_nonce != second_nonce
        assert first != second


class TestStorageIsWrapped:
    async def test_the_stored_row_holds_no_plaintext(
        self, vault, store, two_devices
    ):
        body = (
            await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})
        ).json()

        row = await store.model_key("person-a")

        assert row is not None
        assert body["key"].encode("utf-8") not in bytes(row.ciphertext)
        assert row.kek_id == "test"
        assert row.litellm_token == body["token"]


# ===========================================================================
# Rolling the KEK
# ===========================================================================


class TestKekRotation:
    """A KEK roll must be a background job, not a maintenance window. The
    README promises rows are re-wrapped as they are read; this is that."""

    def _rolled(self, settings, new_kek: bytes):
        import dataclasses

        return dataclasses.replace(
            settings,
            kek=new_kek,
            kek_id="test-2",
            previous_kek=settings.kek,
            previous_kek_id=settings.kek_id,
        )

    async def test_a_row_written_under_the_old_kek_still_opens(
        self, build_brain, vault_settings, admin_client, two_devices
    ):
        async with brain_client(
            build_brain(litellm=admin_client, settings=vault_settings)
        ) as vault:
            before = (
                await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})
            ).json()

        rolled = self._rolled(vault_settings, bytes(range(32)))
        async with brain_client(
            build_brain(litellm=admin_client, settings=rolled)
        ) as vault:
            after = await vault.post(
                "/v1/model-key", headers=two_devices["laptop"], json={}
            )

        assert after.status_code == 200
        assert after.json()["key"] == before["key"]

    async def test_reading_it_moves_it_onto_the_new_kek(
        self, build_brain, vault_settings, admin_client, store, two_devices
    ):
        async with brain_client(
            build_brain(litellm=admin_client, settings=vault_settings)
        ) as vault:
            await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})

        rolled = self._rolled(vault_settings, bytes(range(32)))
        async with brain_client(
            build_brain(litellm=admin_client, settings=rolled)
        ) as vault:
            await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})

        row = await store.model_key("person-a")
        # The roll finishes itself, one person at a time, with no job to run
        # and no window to schedule.
        assert row.kek_id == "test-2"
        # And it is not recorded as a rotation: the person's key did not
        # change, only the wrapping did.
        assert row.rotated_at is None

    async def test_a_kek_that_was_dropped_too_early_is_503_not_500(
        self, build_brain, vault_settings, admin_client, two_devices
    ):
        import dataclasses

        async with brain_client(
            build_brain(litellm=admin_client, settings=vault_settings)
        ) as vault:
            await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})

        # Rolled without keeping the old KEK around — the mistake the README
        # warns about.
        orphaned = dataclasses.replace(
            vault_settings, kek=bytes(range(32)), kek_id="test-2"
        )
        async with brain_client(
            build_brain(litellm=admin_client, settings=orphaned)
        ) as vault:
            response = await vault.post(
                "/v1/model-key", headers=two_devices["laptop"], json={}
            )

        # 503, so the laptop keeps the key it holds while somebody restores
        # the KEK. A 401 or a fresh mint would both be worse than waiting.
        assert response.status_code == 503
        assert response.json()["error"] == "key_unreadable"
        assert "key" not in response.json()


# ===========================================================================
# Degradation
# ===========================================================================


class TestDegradation:
    async def test_an_unreachable_proxy_is_503_and_stores_nothing(
        self, vault, proxy, store, two_devices
    ):
        proxy.fault = "connect"

        response = await vault.post(
            "/v1/model-key", headers=two_devices["laptop"], json={}
        )

        assert response.status_code == 503
        assert response.json()["error"] == "litellm_unavailable"
        # Nothing half-written: the next attempt is a first issuance, not a
        # recovery.
        assert await store.model_key("person-a") is None

    async def test_a_proxy_that_refuses_is_502_not_503(
        self, build_brain, proxy, vault_settings, store, two_devices
    ):
        # An admin key the fake does not recognise: the proxy answers, and
        # says no. That is not an outage and must not be reported as one.
        client = LiteLLMAdminClient(
            PROXY_URL, "sk-wrong-admin", transport=proxy.transport, sleep=lambda _d: None
        )

        async with brain_client(
            build_brain(litellm=client, settings=vault_settings)
        ) as vault:
            response = await vault.post(
                "/v1/model-key", headers=two_devices["laptop"], json={}
            )

        assert response.status_code == 502
        assert response.json()["error"] == "litellm_refused"
        assert await store.model_key("person-a") is None

    async def test_a_deploy_with_no_proxy_answers_503_and_names_the_problem(
        self, client, store, two_devices
    ):
        response = await client.post(
            "/v1/model-key", headers=two_devices["laptop"], json={}
        )

        assert response.status_code == 503
        assert response.json()["error"] == "litellm_unconfigured"
        assert await store.model_key("person-a") is None

    async def test_a_stored_key_still_serves_while_the_proxy_is_down(
        self, vault, proxy, two_devices
    ):
        issued = (
            await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})
        ).json()

        proxy.fault = "connect"
        response = await vault.post(
            "/v1/model-key", headers=two_devices["desktop"], json={}
        )

        # The reason the reuse path makes no proxy call at all: a LiteLLM
        # outage must not stop a second device from being handed a key that
        # is sitting in the database.
        assert response.status_code == 200
        assert response.json()["key"] == issued["key"]

    async def test_a_rotation_that_cannot_mint_leaves_the_old_key_alone(
        self, vault, proxy, two_devices
    ):
        issued = (
            await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})
        ).json()

        proxy.fault = "connect"
        failed = await vault.post(
            "/v1/model-key", headers=two_devices["laptop"], json={"rotate": True}
        )
        proxy.fault = None

        assert failed.status_code == 503
        # A rotation that could not mint must not have deleted anything: the
        # person still has a working key.
        assert proxy.holds_token(issued["token"])
        again = await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})
        assert again.json()["key"] == issued["key"]


# ===========================================================================
# Authorization
# ===========================================================================


class TestAuthorization:
    async def test_a_revoked_device_cannot_fetch_the_key(self, vault, two_devices):
        await vault.post("/v1/model-key", headers=two_devices["laptop"], json={})
        await vault.get("/v1/me", headers=two_devices["desktop"])
        await vault.delete(
            f"/v1/devices/{two_devices['desktop_id']}", headers=two_devices["laptop"]
        )

        response = await vault.post(
            "/v1/model-key", headers=two_devices["desktop"], json={}
        )

        assert response.status_code == 403
        assert response.json()["error"] == "device_revoked"
        assert "key" not in response.json()

    async def test_an_unauthenticated_caller_gets_401(self, vault):
        response = await vault.post(
            "/v1/model-key", headers={"X-AgentX-Device": new_device_id()}, json={}
        )

        assert response.status_code == 401

    async def test_a_request_without_a_device_header_gets_400(self, vault, realm):
        realm.add("tok-a", subject="person-a")

        response = await vault.post(
            "/v1/model-key", headers={"Authorization": "Bearer tok-a"}, json={}
        )

        assert response.status_code == 400
        assert response.json()["error"] == "device_header_missing"

    async def test_an_identity_outage_is_503_and_never_401(self, vault, realm):
        realm.add("tok-a", subject="person-a")
        realm.outage_tokens.add("tok-a")

        response = await vault.post(
            "/v1/model-key", headers=auth_headers("tok-a", new_device_id()), json={}
        )

        # A 401 tells the laptop to discard what it holds. A JWKS blip must
        # never do that.
        assert response.status_code == 503
        assert response.json()["error"] == "identity_unavailable"


# ---------------------------------------------------------------------------
# What a key is allowed to reach, and what an account opens on
# ---------------------------------------------------------------------------


MIXED_CATALOG = {
    "Qwen/Qwen3.6-35B-A3B-FP8": "chat",
    "BAAI/bge-m3": "embedding",
    "MiniMax/MiniMax-M3": "chat",
    "BAAI/bge-reranker-v2-m3": "rerank",
    "dall-e-3": "image_generation",
}


@pytest.fixture
def mixed_proxy() -> FakeLiteLLM:
    """A proxy serving what a real one serves: chat next to embeddings."""
    return FakeLiteLLM(catalog=tuple(MIXED_CATALOG), modes=MIXED_CATALOG)


@pytest_asyncio.fixture
async def mixed_vault(build_brain, brain_settings, mixed_proxy):
    import dataclasses

    client = LiteLLMAdminClient(
        PROXY_URL, mixed_proxy.admin_key, transport=mixed_proxy.transport, sleep=lambda _s: None
    )
    settings = dataclasses.replace(
        brain_settings,
        litellm_base_url=PROXY_URL,
        litellm_admin_key=mixed_proxy.admin_key,
    )
    async with brain_client(build_brain(litellm=client, settings=settings)) as c:
        yield c


class TestGrantedModels:
    async def test_embedding_and_rerank_models_are_never_granted(
        self, mixed_vault, mixed_proxy, two_devices
    ):
        response = await mixed_vault.post(
            "/v1/model-key", headers=two_devices["laptop"], json={}
        )

        assert response.status_code == 200
        granted = response.json()["models"]

        # The defect this prevents is not a security one. An embedding model
        # in the picker looks like a model; choosing it fails mid-conversation
        # and reads like a broken proxy.
        assert "BAAI/bge-m3" not in granted
        assert "BAAI/bge-reranker-v2-m3" not in granted
        assert set(granted) == {
            "Qwen/Qwen3.6-35B-A3B-FP8",
            "MiniMax/MiniMax-M3",
            "dall-e-3",
        }

    async def test_the_key_itself_carries_the_restriction(
        self, mixed_vault, mixed_proxy, two_devices
    ):
        await mixed_vault.post("/v1/model-key", headers=two_devices["laptop"], json={})

        # Enforced by LiteLLM against the key, not by the client against a
        # list it could ignore.
        minted = [r for r in mixed_proxy.records.values()]
        assert len(minted) == 1
        assert "BAAI/bge-m3" not in minted[0]["models"]

    async def test_the_default_model_is_a_chat_model_from_the_key(
        self, mixed_vault, two_devices
    ):
        response = await mixed_vault.post(
            "/v1/model-key", headers=two_devices["laptop"], json={}
        )

        body = response.json()

        # Chat leads because `key_model_modes` puts it first, and the laptop
        # pins whatever leads. No model id is written down on the laptop, so
        # the proxy retiring a model cannot leave an installer pinning it.
        assert body["default_model"] == "Qwen/Qwen3.6-35B-A3B-FP8"
        assert body["default_model"] == body["models"][0]

    async def test_the_second_device_gets_the_same_default(
        self, mixed_vault, two_devices
    ):
        first = await mixed_vault.post(
            "/v1/model-key", headers=two_devices["laptop"], json={}
        )
        second = await mixed_vault.post(
            "/v1/model-key", headers=two_devices["desktop"], json={}
        )

        assert first.json()["default_model"] == second.json()["default_model"]

    async def test_a_proxy_that_serves_nothing_grantable_refuses_to_mint(
        self, build_brain, brain_settings, two_devices
    ):
        import dataclasses

        only_embeddings = FakeLiteLLM(
            catalog=("BAAI/bge-m3",), modes={"BAAI/bge-m3": "embedding"}
        )
        client = LiteLLMAdminClient(
            PROXY_URL,
            only_embeddings.admin_key,
            transport=only_embeddings.transport,
            sleep=lambda _s: None,
        )
        settings = dataclasses.replace(
            brain_settings,
            litellm_base_url=PROXY_URL,
            litellm_admin_key=only_embeddings.admin_key,
        )

        async with brain_client(build_brain(litellm=client, settings=settings)) as vault:
            response = await vault.post(
                "/v1/model-key", headers=two_devices["laptop"], json={}
            )

        # Refusing beats minting an unrestricted key. Falling back is how the
        # admin key came to travel inside every installer.
        assert response.status_code == 502
        assert response.json()["error"] == "no_grantable_models"
        assert only_embeddings.paths_hit("/key/generate") == 0
