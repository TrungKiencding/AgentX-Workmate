"""The change feed, against real Postgres and genuinely concurrent writers.

The test that earns this file is :class:`TestCursorUnderConcurrency`. Every
other property here — pagination, tombstones, last-writer-wins — would survive
being tested against a mock. The cursor guarantee would not: it is a claim
about what one transaction can observe while another is still uncommitted, and
the only thing that can answer it is a database doing real MVCC. Simulating
that would be testing the simulation.

Two subjects appear throughout rather than one, because "this person's feed"
is a claim that is only checked by a second person existing.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from tests.second_brain.conftest import auth_headers, brain_client, new_device_id

pytestmark = pytest.mark.asyncio


@pytest.fixture
def alice(realm):
    """One person on two machines, and the headers for each."""
    realm.add("tok-alice", subject="alice", email="alice@test", display_name="Alice")
    laptop, desktop = new_device_id(), new_device_id()
    return {
        "laptop": auth_headers("tok-alice", laptop, "Alice laptop"),
        "desktop": auth_headers("tok-alice", desktop, "Alice desktop"),
        "laptop_id": laptop,
        "desktop_id": desktop,
    }


@pytest.fixture
def bob(realm):
    """Somebody else entirely, so isolation is a fact rather than a hope."""
    realm.add("tok-bob", subject="bob", email="bob@test", display_name="Bob")
    return auth_headers("tok-bob", new_device_id(), "Bob laptop")


@pytest.fixture
def tiny_cap_app(brain_settings, store, realm):
    """The same app with a 256-byte push cap, to exercise the refusal.

    A deployment-level setting rather than a monkeypatched constant, because
    the cap being configurable is part of what is being checked: an operator
    who lowers it must get a 413 and not a truncated document.
    """
    import dataclasses

    from second_brain.app import build_app

    return build_app(
        settings=dataclasses.replace(brain_settings, max_push_bytes=256),
        provider=realm,
        store=store,
        litellm=None,
    )


def document(doc_id: str, *, kind: str = "session", updated_at: float = 100.0, **payload):
    return {
        "kind": kind,
        "doc_id": doc_id,
        "updated_at": updated_at,
        "deleted": False,
        "payload": payload or {"title": doc_id},
    }


async def push(client, headers, *documents):
    response = await client.post(
        "/v1/sync/push", headers=headers, json={"documents": list(documents)}
    )
    assert response.status_code == 200, response.text
    return response.json()


async def changes(client, headers, **params):
    response = await client.get("/v1/sync/changes", headers=headers, params=params)
    assert response.status_code == 200, response.text
    return response.json()


class TestPush:
    async def test_a_pushed_document_comes_back_from_the_feed(self, client, alice):
        await push(client, alice["laptop"], document("s1", title="Planning"))

        feed = await changes(client, alice["laptop"])

        assert len(feed["documents"]) == 1
        stored = feed["documents"][0]
        assert stored["kind"] == "session"
        assert stored["doc_id"] == "s1"
        assert stored["payload"] == {"title": "Planning"}
        assert stored["device_id"] == alice["laptop_id"]

    async def test_each_document_is_answered_with_where_it_landed(self, client, alice):
        result = await push(
            client, alice["laptop"], document("s1"), document("s2"), document("s3")
        )

        assert result["accepted"] == 3
        assert result["rejected"] == 0
        seqs = [entry["seq"] for entry in result["results"]]
        assert seqs == sorted(seqs), "documents keep the order they were sent in"
        assert result["cursor"] == max(seqs)

    async def test_one_device_cannot_see_another_persons_documents(
        self, client, alice, bob
    ):
        await push(client, alice["laptop"], document("s1"))
        await push(client, bob, document("s1"))

        feed = await changes(client, bob)

        assert [entry["doc_id"] for entry in feed["documents"]] == ["s1"]
        assert feed["documents"][0]["device_id"] == bob["X-AgentX-Device"]

    async def test_both_of_a_persons_devices_read_one_feed(self, client, alice):
        await push(client, alice["laptop"], document("from-laptop"))
        await push(client, alice["desktop"], document("from-desktop"))

        seen = await changes(client, alice["desktop"])

        assert {entry["doc_id"] for entry in seen["documents"]} == {
            "from-laptop",
            "from-desktop",
        }

    async def test_re_pushing_an_unchanged_document_is_a_no_op(self, client, alice):
        await push(client, alice["laptop"], document("s1", updated_at=100.0))

        # Exactly how a client recovers from an acknowledgement it never saw.
        again = await push(client, alice["laptop"], document("s1", updated_at=100.0))

        assert again["accepted"] == 1
        feed = await changes(client, alice["laptop"])
        assert len(feed["documents"]) == 1

    async def test_an_unknown_kind_round_trips_unchanged(self, client, alice):
        # R8: adding a synced content type must be a client-side change. The
        # service is not allowed to have an opinion about what a 'kanban' is.
        await push(
            client,
            alice["laptop"],
            document("k1", kind="kanban", columns=["todo", "doing"]),
        )

        feed = await changes(client, alice["laptop"])

        assert feed["documents"][0]["kind"] == "kanban"
        assert feed["documents"][0]["payload"] == {"columns": ["todo", "doing"]}


class TestLastWriterWins:
    async def test_a_newer_stamp_replaces_an_older_one(self, client, alice):
        await push(client, alice["laptop"], document("s1", updated_at=100.0, title="old"))
        await push(client, alice["desktop"], document("s1", updated_at=200.0, title="new"))

        feed = await changes(client, alice["laptop"])

        assert feed["documents"][0]["payload"] == {"title": "new"}

    async def test_an_older_stamp_does_not_overwrite_a_newer_one(self, client, alice):
        await push(client, alice["laptop"], document("s1", updated_at=200.0, title="new"))
        await push(client, alice["desktop"], document("s1", updated_at=100.0, title="old"))

        feed = await changes(client, alice["laptop"])

        assert feed["documents"][0]["payload"] == {"title": "new"}

    async def test_a_rejected_write_still_consumed_a_seq(self, client, alice):
        first = await push(client, alice["laptop"], document("s1", updated_at=200.0))
        second = await push(client, alice["desktop"], document("s1", updated_at=100.0))

        # Gaps in the sequence are intended: the cursor must be monotonic, not
        # contiguous. A "fix" that made it contiguous would reintroduce the
        # skipped-record race the per-account counter exists to prevent.
        assert second["cursor"] > first["cursor"]

    async def test_a_wildly_future_stamp_is_clamped(self, client, alice):
        import time

        await push(
            client,
            alice["laptop"],
            document("s1", updated_at=time.time() + 86_400, title="fast clock"),
        )

        feed = await changes(client, alice["laptop"])

        # A laptop a day ahead would otherwise win every contest for a day.
        assert feed["documents"][0]["updated_at"] <= time.time() + 600

    async def test_an_unreadable_stamp_loses_every_tie(self, client, alice):
        await push(client, alice["laptop"], document("s1", updated_at=50.0, title="real"))
        await push(
            client,
            alice["desktop"],
            {
                "kind": "session",
                "doc_id": "s1",
                "updated_at": "not a number",
                "payload": {"title": "clockless"},
            },
        )

        feed = await changes(client, alice["laptop"])

        assert feed["documents"][0]["payload"] == {"title": "real"}


class TestTombstones:
    async def test_a_delete_is_returned_by_the_feed(self, client, alice):
        await push(client, alice["laptop"], document("s1"))
        await push(
            client,
            alice["laptop"],
            {"kind": "session", "doc_id": "s1", "updated_at": 200.0, "deleted": True},
        )

        feed = await changes(client, alice["laptop"])

        assert len(feed["documents"]) == 1
        assert feed["documents"][0]["deleted"] is True

    async def test_a_tombstone_suppresses_a_stale_re_push(self, client, alice):
        await push(client, alice["laptop"], document("s1", updated_at=100.0))
        await push(
            client,
            alice["laptop"],
            {"kind": "session", "doc_id": "s1", "updated_at": 200.0, "deleted": True},
        )

        # A device that was offline when the delete happened pushes the row
        # back on its next tick. Without the tombstone it would resurrect.
        await push(client, alice["desktop"], document("s1", updated_at=100.0))

        feed = await changes(client, alice["laptop"])
        assert feed["documents"][0]["deleted"] is True

    async def test_a_tombstone_carries_no_payload(self, client, alice):
        await push(
            client,
            alice["laptop"],
            {
                "kind": "session",
                "doc_id": "s1",
                "updated_at": 200.0,
                "deleted": True,
                "payload": {"secret": "x" * 1000},
            },
        )

        feed = await changes(client, alice["laptop"])

        # Retained for the whole window and handed to every device that reads
        # the feed — the delete itself is the entire message.
        assert feed["documents"][0]["payload"] == {}

    async def test_the_sweeper_drops_expired_tombstones_and_keeps_live_rows(
        self, client, alice, store, raw_pg
    ):
        await push(client, alice["laptop"], document("live"))
        await push(
            client,
            alice["laptop"],
            {"kind": "session", "doc_id": "old", "updated_at": 1.0, "deleted": True},
        )
        await push(
            client,
            alice["laptop"],
            {"kind": "session", "doc_id": "recent", "updated_at": 1.0, "deleted": True},
        )
        await raw_pg.execute(
            "UPDATE documents SET stored_at = now() - interval '200 days' "
            "WHERE doc_id = 'old'"
        )

        swept = await store.sweep_tombstones(older_than_days=90)

        assert swept == 1
        feed = await changes(client, alice["laptop"])
        assert {entry["doc_id"] for entry in feed["documents"]} == {"live", "recent"}

    async def test_sweeping_an_empty_window_removes_nothing(self, client, alice, store):
        await push(client, alice["laptop"], document("s1"))

        assert await store.sweep_tombstones(older_than_days=90) == 0


class TestPagination:
    async def test_every_record_is_returned_exactly_once_across_pages(
        self, client, alice
    ):
        for start in range(0, 25, 5):
            await push(
                client,
                alice["laptop"],
                *[document(f"s{index}") for index in range(start, start + 5)],
            )

        seen: list[str] = []
        cursor = 0
        for _ in range(20):
            page = await changes(client, alice["laptop"], since=cursor, limit=7)
            seen.extend(entry["doc_id"] for entry in page["documents"])
            cursor = page["cursor"]
            if not page["has_more"]:
                break

        assert len(seen) == 25
        assert len(set(seen)) == 25

    async def test_has_more_is_observed_rather_than_inferred_from_a_full_page(
        self, client, alice
    ):
        await push(client, alice["laptop"], *[document(f"s{index}") for index in range(4)])

        exact = await changes(client, alice["laptop"], since=0, limit=4)

        # A full page is not the same thing as more pages, and a client that
        # believed it was would make one wasted round trip per drain.
        assert len(exact["documents"]) == 4
        assert exact["has_more"] is False

    async def test_an_empty_page_leaves_the_cursor_where_it_was(self, client, alice):
        await push(client, alice["laptop"], document("s1"))
        first = await changes(client, alice["laptop"])

        idle = await changes(client, alice["laptop"], since=first["cursor"])

        assert idle["documents"] == []
        assert idle["cursor"] == first["cursor"]
        assert idle["has_more"] is False

    async def test_a_kinds_filter_selects_and_does_not_step_over_the_rest(
        self, client, alice
    ):
        await push(
            client,
            alice["laptop"],
            document("m1", kind="memory"),
            document("s1", kind="session"),
            document("m2", kind="memory"),
        )

        filtered = await changes(client, alice["laptop"], kinds="memory")

        assert [entry["doc_id"] for entry in filtered["documents"]] == ["m1", "m2"]
        # The cursor stopped on m2, so a client that later widens its filter
        # still sees s1 rather than having silently passed it.
        widened = await changes(client, alice["laptop"], since=0)
        assert [entry["doc_id"] for entry in widened["documents"]] == ["m1", "s1", "m2"]

    async def test_several_kinds_can_be_named_at_once(self, client, alice):
        await push(
            client,
            alice["laptop"],
            document("m1", kind="memory"),
            document("s1", kind="session"),
            document("p1", kind="plan"),
        )

        both = await changes(client, alice["laptop"], kinds="memory,plan")

        assert [entry["doc_id"] for entry in both["documents"]] == ["m1", "p1"]

    async def test_an_over_large_limit_is_clamped_rather_than_refused(
        self, client, alice
    ):
        await push(client, alice["laptop"], document("s1"))

        page = await changes(client, alice["laptop"], limit=999_999)

        assert page["documents"]


class TestRefusals:
    async def test_a_body_within_the_cap_is_accepted(self, client, alice):
        # The shipped cap is 8 MB, comfortably above one session and all its
        # messages — the largest single document the client produces.
        result = await push(client, alice["laptop"], document("s1", body="x" * 200_000))

        assert result["accepted"] == 1

    async def test_a_body_above_this_deployments_cap_gets_413(
        self, tiny_cap_app, alice
    ):
        async with brain_client(tiny_cap_app) as client:
            response = await client.post(
                "/v1/sync/push",
                headers=alice["laptop"],
                json={"documents": [document("s1", body="x" * 5_000)]},
            )

            assert response.status_code == 413
            assert response.json()["error"] == "payload_too_large"

            # Nothing was stored: the client still holds every record.
            feed = await client.get("/v1/sync/changes", headers=alice["laptop"])
            assert feed.json()["documents"] == []

    async def test_a_body_that_declares_no_length_is_still_cut_off(
        self, tiny_cap_app, alice
    ):
        async def oversized_chunks():
            for _ in range(10):
                yield b"x" * 100

        async with brain_client(tiny_cap_app) as client:
            response = await client.post(
                "/v1/sync/push",
                headers={**alice["laptop"], "Content-Type": "application/json"},
                content=oversized_chunks(),
            )

        # Chunked, so nothing declared a length. The stream is measured as it
        # is read rather than trusted.
        assert response.status_code == 413

    async def test_a_malformed_document_is_rejected_without_failing_the_batch(
        self, client, alice
    ):
        # The client's outbox only clears what the service acknowledged, so
        # refusing the whole push would wedge this device permanently on a
        # record that will never become valid.
        result = await push(
            client,
            alice["laptop"],
            document("good-1"),
            {"kind": "session", "updated_at": 1.0},  # no doc_id
            document("good-2"),
        )

        assert result["accepted"] == 2
        assert result["rejected"] == 1
        assert result["results"][1]["ok"] is False
        assert "doc_id" in result["results"][1]["error"]

        feed = await changes(client, alice["laptop"])
        assert {entry["doc_id"] for entry in feed["documents"]} == {"good-1", "good-2"}

    async def test_a_document_without_a_kind_is_rejected(self, client, alice):
        result = await push(client, alice["laptop"], {"doc_id": "s1", "updated_at": 1.0})

        assert result["rejected"] == 1
        assert result["accepted"] == 0

    async def test_an_over_long_identifier_is_rejected(self, client, alice):
        result = await push(
            client, alice["laptop"], document("x" * 500), document("k", kind="y" * 200)
        )

        assert result["rejected"] == 2

    async def test_a_non_object_payload_is_rejected(self, client, alice):
        result = await push(
            client,
            alice["laptop"],
            {"kind": "session", "doc_id": "s1", "updated_at": 1.0, "payload": [1, 2, 3]},
        )

        assert result["rejected"] == 1

    async def test_a_body_that_is_not_a_push_at_all_is_a_400(self, client, alice):
        response = await client.post(
            "/v1/sync/push", headers=alice["laptop"], json={"nope": []}
        )

        assert response.status_code == 400
        assert response.json()["error"] == "invalid_push"

    async def test_a_non_json_body_is_a_400(self, client, alice):
        response = await client.post(
            "/v1/sync/push",
            headers={**alice["laptop"], "Content-Type": "application/json"},
            content=b"{not json",
        )

        assert response.status_code == 400
        assert response.json()["error"] == "invalid_push"

    async def test_too_many_documents_in_one_push_is_refused(self, client, alice):
        response = await client.post(
            "/v1/sync/push",
            headers=alice["laptop"],
            json={"documents": [document(f"s{index}") for index in range(501)]},
        )

        assert response.status_code == 400
        assert response.json()["error"] == "invalid_push"

    async def test_a_bad_cursor_gets_this_services_error_shape(self, client, alice):
        response = await client.get(
            "/v1/sync/changes", headers=alice["laptop"], params={"since": "yesterday"}
        )

        assert response.status_code == 400
        # Not FastAPI's 422 validation shape, which a client switching on
        # `error` cannot read.
        assert response.json()["error"] == "invalid_cursor"

    async def test_a_negative_cursor_is_refused(self, client, alice):
        response = await client.get(
            "/v1/sync/changes", headers=alice["laptop"], params={"since": "-1"}
        )

        assert response.status_code == 400


class TestAuthorization:
    async def test_sync_needs_a_bearer_like_every_other_route(self, client, alice):
        response = await client.post(
            "/v1/sync/push",
            headers={"X-AgentX-Device": alice["laptop_id"]},
            json={"documents": []},
        )

        assert response.status_code == 401

    async def test_sync_needs_a_device_header_like_every_other_route(
        self, client, alice
    ):
        response = await client.get(
            "/v1/sync/changes", headers={"Authorization": "Bearer tok-alice"}
        )

        assert response.status_code == 400
        assert response.json()["error"] == "device_header_missing"

    async def test_a_revoked_device_cannot_push_or_pull(self, client, alice):
        await client.post("/v1/devices/heartbeat", headers=alice["desktop"], json={})
        await client.delete(
            f"/v1/devices/{alice['desktop_id']}", headers=alice["laptop"]
        )

        pushed = await client.post(
            "/v1/sync/push", headers=alice["desktop"], json={"documents": [document("s1")]}
        )
        pulled = await client.get("/v1/sync/changes", headers=alice["desktop"])

        assert pushed.status_code == 403
        assert pulled.status_code == 403
        assert pushed.json()["error"] == "device_revoked"


class TestCursorUnderConcurrency:
    """R7: a reader consuming by cursor must never skip a committed record.

    This is the test the per-account counter exists for. With a global
    ``BIGSERIAL``, transaction 105 can commit *after* a reader has already
    advanced past 106 — and 105 is then invisible to that reader forever, with
    nothing anywhere reporting a loss. Assigning ``seq`` from a counter on the
    account row takes a lock that serialises the two writers, so a reader that
    can see 106 is guaranteed 105 has already committed.

    Run over many rounds because it is a race: a single round proves nothing,
    and a flaky pass here is a silent data-loss bug in production.
    """

    async def test_a_reader_consuming_by_cursor_sees_every_concurrent_write(
        self, client, alice
    ):
        rounds = 10
        writers = 6
        per_writer = 4

        async def write(round_index: int, writer: int) -> None:
            headers = alice["laptop"] if writer % 2 else alice["desktop"]
            for index in range(per_writer):
                await push(
                    client, headers, document(f"r{round_index}-w{writer}-d{index}")
                )

        expected: set[str] = set()
        seen: set[str] = set()
        cursor = 0

        for round_index in range(rounds):
            # Fresh ids every round, so a record the reader missed cannot be
            # covered up by a later round pushing the same doc_id again.
            expected |= {
                f"r{round_index}-w{writer}-d{index}"
                for writer in range(writers)
                for index in range(per_writer)
            }

            pushes = asyncio.gather(
                *(write(round_index, writer) for writer in range(writers))
            )

            # Read while the writes are in flight, which is the only moment
            # the race this guards against can be observed at all.
            while not pushes.done():
                page = await changes(client, alice["laptop"], since=cursor, limit=3)
                seen.update(entry["doc_id"] for entry in page["documents"])
                cursor = page["cursor"]
                await asyncio.sleep(0)

            await pushes

            # Drain whatever committed after the last read of the round.
            while True:
                page = await changes(client, alice["laptop"], since=cursor, limit=3)
                seen.update(entry["doc_id"] for entry in page["documents"])
                cursor = page["cursor"]
                if not page["documents"]:
                    break

        missing = expected - seen
        assert not missing, (
            f"the reader skipped {len(missing)} of {len(expected)} record(s) — "
            f"the cursor is not a watermark: {sorted(missing)[:10]}"
        )

    async def test_concurrent_writers_never_share_a_seq(self, client, alice, store):
        await asyncio.gather(
            *(push(client, alice["laptop"], document(f"c{index}")) for index in range(24))
        )

        rows = await store.documents_since("alice", cursor=0, limit=1000)

        seqs = [row.seq for row in rows]
        assert len(seqs) == len(set(seqs)) == 24
        assert seqs == sorted(seqs)

    async def test_a_push_waits_on_another_push_for_the_same_person(
        self, store, raw_pg
    ):
        """The serialisation is real, and this is what proves it.

        ``brain_put_document`` bumps ``accounts.doc_seq``, which takes that
        row's lock until the transaction commits. Holding the row from an
        outside connection must therefore stall a push for the same person —
        if it does not, seq assignment is not serialised and the watermark
        guarantee above is an accident rather than a property.
        """
        await store.ensure_account("alice", slug="alice")

        async with raw_pg.transaction():
            await raw_pg.execute(
                "UPDATE accounts SET doc_seq = doc_seq + 1 WHERE subject = 'alice'"
            )

            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(
                    store.put_document(
                        "alice", kind="session", doc_id="blocked", updated_at=1.0
                    ),
                    timeout=1.0,
                )

    async def test_one_persons_pushes_do_not_block_anothers(self, store, raw_pg):
        """Locking per account is what keeps that serialisation cheap.

        Two people never wait on each other, so a fleet's throughput is not
        bounded by whoever is pushing the largest batch.
        """
        for subject in ("alice", "bob"):
            await store.ensure_account(subject, slug=subject)

        async with raw_pg.transaction():
            await raw_pg.execute(
                "UPDATE accounts SET doc_seq = doc_seq + 1 WHERE subject = 'alice'"
            )

            await asyncio.wait_for(
                store.put_document("bob", kind="session", doc_id="free", updated_at=1.0),
                timeout=5.0,
            )

        assert await store.document("bob", "session", "free") is not None
