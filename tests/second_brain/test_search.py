"""Search over the store, and the isolation that makes it safe to have.

The test that matters most here is :meth:`TestIsolation.test_search_never
_crosses_accounts`. Everything else is behaviour; that one is the reason
search is allowed to exist at all. A route that ranks documents across a
whole table is one filter away from being the worst bug this service could
have, and the filter is in the store rather than in the handler precisely so
that it cannot be forgotten by the next route that wants to search.

Search is also the first real test of the kind-agnostic claim: the index reads
string values out of JSONB and has no idea whether it is looking at a session
title or a memory, so a kind invented on a client is searchable without a
migration.
"""

from __future__ import annotations

import pytest

from tests.second_brain.conftest import auth_headers, new_device_id

pytestmark = pytest.mark.asyncio


@pytest.fixture
def alice(realm):
    realm.add("tok-alice", subject="alice", email="alice@test", display_name="Alice")
    return auth_headers("tok-alice", new_device_id(), "Alice laptop")


@pytest.fixture
def bob(realm):
    realm.add("tok-bob", subject="bob", email="bob@test", display_name="Bob")
    return auth_headers("tok-bob", new_device_id(), "Bob laptop")


async def push(client, headers, *documents):
    response = await client.post(
        "/v1/sync/push", headers=headers, json={"documents": list(documents)}
    )
    assert response.status_code == 200, response.text
    return response.json()


def document(doc_id, *, kind="session", updated_at=100.0, deleted=False, **payload):
    return {
        "kind": kind,
        "doc_id": doc_id,
        "updated_at": updated_at,
        "deleted": deleted,
        "payload": payload,
    }


async def search(client, headers, query, **params):
    response = await client.get(
        "/v1/search", headers=headers, params={"q": query, **params}
    )
    assert response.status_code == 200, response.text
    return response.json()


class TestSearching:
    async def test_it_finds_a_document_by_a_word_in_its_payload(self, client, alice):
        await push(
            client,
            alice,
            document("s1", title="Quarterly planning for the warehouse"),
            document("s2", title="Lunch"),
        )

        found = await search(client, alice, "warehouse")

        assert [row["doc_id"] for row in found["results"]] == ["s1"]

    async def test_it_searches_nested_string_values(self, client, alice):
        await push(
            client,
            alice,
            document("s1", messages=[{"role": "user", "content": "deploy the migration"}]),
        )

        found = await search(client, alice, "migration")

        assert [row["doc_id"] for row in found["results"]] == ["s1"]

    async def test_a_kind_the_service_has_never_heard_of_is_searchable(
        self, client, alice
    ):
        # R8, made concrete. No migration, no branch in the service — the
        # index reads strings out of JSONB and does not care what they mean.
        await push(client, alice, document("k1", kind="kanban", card="repaint the shed"))

        found = await search(client, alice, "repaint")

        assert found["results"][0]["kind"] == "kanban"

    async def test_results_can_be_narrowed_to_one_kind(self, client, alice):
        await push(
            client,
            alice,
            document("s1", kind="session", title="rollout notes"),
            document("m1", kind="memory", text="rollout notes"),
        )

        found = await search(client, alice, "rollout", kinds="memory")

        assert [row["doc_id"] for row in found["results"]] == ["m1"]

    async def test_a_tombstone_never_matches(self, client, alice):
        await push(client, alice, document("s1", title="warehouse plans"))
        await push(
            client,
            alice,
            document("s1", updated_at=200.0, deleted=True),
        )

        found = await search(client, alice, "warehouse")

        # Retained so other devices learn about the delete, not so it keeps
        # turning up in somebody's results.
        assert found["results"] == []

    async def test_results_are_ranked_rather_than_returned_in_storage_order(
        self, client, alice
    ):
        await push(
            client,
            alice,
            document("weak", title="a passing mention of warehouse"),
            document("strong", title="warehouse warehouse warehouse", body="warehouse"),
        )

        found = await search(client, alice, "warehouse")

        assert found["results"][0]["doc_id"] == "strong"
        assert found["results"][0]["rank"] >= found["results"][1]["rank"]

    async def test_several_words_narrow_the_result(self, client, alice):
        await push(
            client,
            alice,
            document("s1", title="warehouse rollout"),
            document("s2", title="warehouse lunch"),
        )

        found = await search(client, alice, "warehouse rollout")

        assert [row["doc_id"] for row in found["results"]] == ["s1"]

    async def test_a_quoted_phrase_is_honoured(self, client, alice):
        await push(
            client,
            alice,
            document("s1", title="the warehouse rollout is planned"),
            document("s2", title="the rollout of the warehouse"),
        )

        found = await search(client, alice, '"warehouse rollout"')

        assert [row["doc_id"] for row in found["results"]] == ["s1"]

    async def test_the_page_size_can_be_asked_for_and_is_bounded(self, client, alice):
        await push(
            client,
            alice,
            *[document(f"s{index}", title="warehouse") for index in range(5)],
        )

        assert len(await search(client, alice, "warehouse", limit=2)) > 0
        assert len((await search(client, alice, "warehouse", limit=2))["results"]) == 2
        # Clamped, not refused.
        assert len((await search(client, alice, "warehouse", limit=999))["results"]) == 5


class TestRefusals:
    async def test_an_empty_query_returns_nothing_rather_than_everything(
        self, client, alice
    ):
        await push(client, alice, document("s1", title="warehouse"))

        found = await search(client, alice, "")

        # "Everything" is a feed read. Answering it here would let a blank
        # search box page a whole account through a route that does not
        # paginate.
        assert found["results"] == []
        assert found["count"] == 0

    async def test_punctuation_a_person_typed_does_not_produce_a_500(
        self, client, alice
    ):
        await push(client, alice, document("s1", title="warehouse"))

        # `to_tsquery` raises a syntax error on every one of these.
        for query in ('"unbalanced', "a & b |", "!!!", "(((", "a:*"):
            response = await client.get("/v1/search", headers=alice, params={"q": query})
            assert response.status_code == 200, f"{query!r} -> {response.text}"

    async def test_an_absurdly_long_query_is_refused(self, client, alice):
        response = await client.get(
            "/v1/search", headers=alice, params={"q": "x" * 5000}
        )

        assert response.status_code == 400
        assert response.json()["error"] == "invalid_cursor"

    async def test_a_bad_limit_gets_this_services_error_shape(self, client, alice):
        response = await client.get(
            "/v1/search", headers=alice, params={"q": "x", "limit": "lots"}
        )

        assert response.status_code == 400
        assert response.json()["error"] == "invalid_cursor"

    async def test_search_needs_a_bearer(self, client, alice):
        response = await client.get(
            "/v1/search",
            headers={"X-AgentX-Device": alice["X-AgentX-Device"]},
            params={"q": "x"},
        )

        assert response.status_code == 401

    async def test_a_revoked_device_cannot_search(self, client, alice, realm):
        other = auth_headers("tok-alice", new_device_id(), "second machine")
        await client.post("/v1/devices/heartbeat", headers=other, json={})
        await client.delete(
            f"/v1/devices/{other['X-AgentX-Device']}", headers=alice
        )

        response = await client.get("/v1/search", headers=other, params={"q": "x"})

        assert response.status_code == 403
        assert response.json()["error"] == "device_revoked"


class TestIsolation:
    async def test_search_never_crosses_accounts(self, client, alice, bob):
        await push(client, alice, document("secret", title="alice warehouse figures"))
        await push(client, bob, document("mine", title="bob warehouse figures"))

        found = await search(client, bob, "warehouse")

        # The one bug this route could have that would matter more than every
        # other bug in the service combined.
        assert [row["doc_id"] for row in found["results"]] == ["mine"]
        assert all("alice" not in str(row["payload"]) for row in found["results"])

    async def test_an_empty_account_finds_nothing_rather_than_everything(
        self, client, alice, bob
    ):
        await push(client, alice, document("s1", title="warehouse"))

        found = await search(client, bob, "warehouse")

        assert found["results"] == []
