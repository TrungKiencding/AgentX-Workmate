"""Booting the service, and the one invariant its whole design rests on.

Two halves.

**Configuration.** A deploy that cannot work must fail while the operator is
watching it, not during somebody's sign-in. Every missing setting is checked
here, and every message is checked for naming the variable that is missing —
an error that says "configuration error" teaches nobody anything.

**The change-feed cursor.** ``brain_put_document`` assigns ``seq`` from a
per-account counter inside the writing transaction, rather than from a global
sequence. The difference only shows up under genuine concurrency, which is why
these tests use real parallel transactions against a real Postgres: with a
global ``BIGSERIAL``, transaction 105 can commit after a reader has already
advanced past 106, and 105 is then invisible forever. That is the failure the
per-account counter exists to prevent, and this is where it is proved.
"""

from __future__ import annotations

import asyncio

import pytest

from second_brain.app import build_app
from second_brain.errors import BrainConfigError
from second_brain.settings import (
    DATABASE_URL_ENV_VAR,
    KEK_ENV_VAR,
    BrainSettings,
    decode_kek,
    load_settings,
)
from tests.second_brain.conftest import TEST_KEK, brain_client

pytestmark = pytest.mark.asyncio


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


class TestSettings:
    """Every refusal names the variable that would fix it."""

    async def test_missing_database_url_refuses_to_start(self):
        with pytest.raises(BrainConfigError) as excinfo:
            load_settings({KEK_ENV_VAR: TEST_KEK})

        assert DATABASE_URL_ENV_VAR in str(excinfo.value)

    async def test_missing_kek_refuses_to_start(self):
        with pytest.raises(BrainConfigError) as excinfo:
            load_settings({DATABASE_URL_ENV_VAR: "postgresql://x/y"})

        assert KEK_ENV_VAR in str(excinfo.value)
        # The operator should not have to look up how to make one.
        assert "openssl rand -base64 32" in str(excinfo.value)

    async def test_short_kek_is_rejected_with_its_length(self):
        with pytest.raises(BrainConfigError) as excinfo:
            decode_kek("c2hvcnQ=")  # b"short"

        assert "5 bytes" in str(excinfo.value)
        assert "32" in str(excinfo.value)

    async def test_kek_accepts_both_base64_alphabets(self):
        # Standard and URL-safe encodings of the same 32 bytes. An operator
        # pasting from a secrets manager must not get a different answer from
        # one pasting from openssl.
        raw = bytes(range(32))
        import base64

        standard = base64.b64encode(raw).decode()
        urlsafe = base64.urlsafe_b64encode(raw).decode()

        assert decode_kek(standard) == raw
        assert decode_kek(urlsafe) == raw

    async def test_unpadded_kek_is_accepted(self):
        import base64

        raw = bytes(range(32))
        assert decode_kek(base64.b64encode(raw).decode().rstrip("=")) == raw

    async def test_garbage_kek_is_rejected(self):
        with pytest.raises(BrainConfigError):
            decode_kek("not base64 at all !!")

    async def test_settings_resolve_when_everything_is_present(self):
        settings = load_settings(
            {
                DATABASE_URL_ENV_VAR: "postgresql://brain@db/brain",
                KEK_ENV_VAR: TEST_KEK,
                "AGENTX_BRAIN_LITELLM_BASE_URL": "https://proxy.test/v1",
                "AGENTX_LITELLM_ADMIN_KEY": "sk-admin",
            }
        )

        assert settings.database_url == "postgresql://brain@db/brain"
        assert len(settings.kek) == 32
        # ``/v1`` is where an operator's notes point; admin routes are at the
        # root, so the suffix is stripped exactly as the laptop-side client
        # strips it.
        assert settings.litellm_base_url == "https://proxy.test"
        assert settings.litellm_configured

    async def test_litellm_is_optional(self):
        settings = load_settings(
            {DATABASE_URL_ENV_VAR: "postgresql://brain@db/brain", KEK_ENV_VAR: TEST_KEK}
        )

        # The device registry mints nothing, so a Phase 1 deployment is
        # allowed to omit the proxy entirely.
        assert not settings.litellm_configured


class TestBuildApp:
    """The app refuses to exist rather than existing in a broken state."""

    async def test_missing_keycloak_refuses_to_build(self, brain_settings, store, monkeypatch):
        import plugins.dashboard_auth.keycloak as keycloak_plugin

        # A realm that declines to register is exactly what an unconfigured
        # server looks like.
        monkeypatch.setattr(keycloak_plugin, "register", lambda ctx: None)
        monkeypatch.setattr(
            keycloak_plugin, "LAST_SKIP_REASON", "keycloak base_url is not set"
        )

        with pytest.raises(BrainConfigError) as excinfo:
            build_app(settings=brain_settings, store=store)

        assert "keycloak base_url is not set" in str(excinfo.value)

    async def test_health_reports_each_dependency_separately(self, client):
        response = await client.get("/health")

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        assert body["postgres"]["status"] == "ok"
        # No proxy configured in the test app, and that is a report rather
        # than a failure: devices do not need one.
        assert body["litellm"]["status"] == "unconfigured"
        assert body["api"] == "/v1"

    async def test_health_needs_no_bearer(self, client):
        # A health check that requires a credential is a health check nobody's
        # load balancer can run.
        response = await client.get("/health")

        assert response.status_code == 200

    async def test_health_is_503_when_postgres_is_gone(self, build_brain, store):
        await store.close()

        async with brain_client(build_brain()) as client:
            response = await client.get("/health")

        assert response.status_code == 503
        assert response.json()["postgres"]["status"] == "unreachable"

    async def test_injected_store_is_not_closed_by_the_app(self, build_brain, store):
        async with brain_client(build_brain()) as client:
            assert (await client.get("/health")).status_code == 200

        # The suite owns this store; an app that closed it on shutdown would
        # break every test that ran after it.
        assert await store.ping()


# ---------------------------------------------------------------------------
# Migrations
# ---------------------------------------------------------------------------


class TestMigrations:
    async def test_fresh_database_gets_the_whole_schema(self, store, raw_pg):
        # `current_schema()`, not 'public': each test process migrates into a
        # schema of its own (see conftest), and hardcoding 'public' would
        # quietly assert against whatever some earlier run left there.
        tables = {
            record["tablename"]
            for record in await raw_pg.fetch(
                "SELECT tablename FROM pg_tables WHERE schemaname = current_schema()"
            )
        }

        assert {"accounts", "devices", "model_keys", "documents"} <= tables

    async def test_running_migrations_twice_applies_nothing_the_second_time(self, store):
        # The `store` fixture already migrated, so this call is the second.
        assert await store.migrate() == []

    async def test_a_second_instance_can_migrate_concurrently(self, brain_settings, store):
        # Two processes booting at once is normal during a rolling deploy. The
        # advisory lock is what stops both applying 0001.
        from second_brain.store.engine import Store

        others = [await Store.connect(brain_settings) for _ in range(3)]
        try:
            results = await asyncio.gather(*(other.migrate() for other in others))
        finally:
            for other in others:
                await other.close()

        assert all(applied == [] for applied in results)


# ---------------------------------------------------------------------------
# brain_put_document — the cursor decision
# ---------------------------------------------------------------------------


async def _account(store, subject: str) -> None:
    await store.ensure_account(subject, slug=f"slug-{subject}")


class TestPutDocument:
    async def test_seq_increases_strictly_within_an_account(self, store):
        await _account(store, "person-a")

        seqs = [
            await store.put_document(
                "person-a", kind="session", doc_id=f"s{index}", updated_at=1.0
            )
            for index in range(5)
        ]

        assert seqs == [1, 2, 3, 4, 5]

    async def test_two_accounts_have_independent_counters(self, store):
        await _account(store, "person-a")
        await _account(store, "person-b")

        a = await store.put_document("person-a", kind="session", doc_id="x", updated_at=1.0)
        b = await store.put_document("person-b", kind="session", doc_id="x", updated_at=1.0)

        # Not a shared sequence: one person's write rate must not push another
        # person's cursor forward.
        assert (a, b) == (1, 1)

    async def test_a_newer_write_wins_and_an_older_one_does_not(self, store):
        await _account(store, "person-a")

        await store.put_document(
            "person-a", kind="session", doc_id="s1", updated_at=100.0, payload={"title": "new"}
        )
        await store.put_document(
            "person-a", kind="session", doc_id="s1", updated_at=50.0, payload={"title": "old"}
        )

        document = await store.document("person-a", "session", "s1")
        assert document is not None
        assert document.payload == {"title": "new"}
        assert document.updated_at == 100.0

    async def test_a_rejected_write_still_consumes_a_seq(self, store):
        # Documented in 0001_init.sql and deliberately so: gaps are harmless
        # because a cursor must be monotonic, not contiguous. Asserted here so
        # nobody "fixes" it by moving the counter bump after the upsert, which
        # is what would reintroduce the skipped-record race.
        await _account(store, "person-a")

        await store.put_document("person-a", kind="session", doc_id="s1", updated_at=100.0)
        rejected = await store.put_document(
            "person-a", kind="session", doc_id="s1", updated_at=50.0
        )

        assert rejected == 2
        document = await store.document("person-a", "session", "s1")
        assert document is not None
        assert document.seq == 1

    async def test_an_equal_timestamp_reapplies(self, store):
        # Re-pushing an unchanged document is how a client recovers from a
        # dropped acknowledgement. It must be a no-op, not a rejection.
        await _account(store, "person-a")

        await store.put_document(
            "person-a", kind="session", doc_id="s1", updated_at=7.0, payload={"n": 1}
        )
        await store.put_document(
            "person-a", kind="session", doc_id="s1", updated_at=7.0, payload={"n": 2}
        )

        document = await store.document("person-a", "session", "s1")
        assert document is not None
        assert document.payload == {"n": 2}

    async def test_a_write_for_an_unknown_account_is_refused(self, store):
        import asyncpg

        # The account row is created when its owner's token is first verified,
        # so reaching this is a caller that skipped authentication.
        with pytest.raises(asyncpg.PostgresError):
            await store.put_document(
                "nobody", kind="session", doc_id="s1", updated_at=1.0
            )

    async def test_kind_is_opaque(self, store):
        # Adding a synced content type must not need a schema change on either
        # side (R8), so nothing here may know what a kind means.
        await _account(store, "person-a")

        await store.put_document(
            "person-a",
            kind="a-kind-invented-in-2027",
            doc_id="x",
            updated_at=1.0,
            payload={"anything": [1, {"nested": True}]},
        )

        document = await store.document("person-a", "a-kind-invented-in-2027", "x")
        assert document is not None
        assert document.payload == {"anything": [1, {"nested": True}]}

    async def test_a_tombstone_round_trips(self, store):
        await _account(store, "person-a")

        await store.put_document("person-a", kind="session", doc_id="s1", updated_at=1.0)
        await store.put_document(
            "person-a", kind="session", doc_id="s1", updated_at=2.0, deleted=True
        )

        document = await store.document("person-a", "session", "s1")
        assert document is not None
        assert document.deleted


class TestCursorUnderConcurrency:
    """R7: a reader consuming by cursor must never skip a record."""

    @pytest.mark.parametrize("round_index", range(8))
    async def test_concurrent_pushes_produce_a_gapless_feed(self, store, round_index):
        # Repeated, because a race that only shows up sometimes is exactly the
        # kind this design exists to remove — one pass proving nothing.
        await _account(store, "person-a")

        writers = 6
        per_writer = 5

        async def push(writer: int) -> list[int]:
            return [
                await store.put_document(
                    "person-a",
                    kind="session",
                    doc_id=f"w{writer}-d{index}",
                    updated_at=float(index),
                )
                for index in range(per_writer)
            ]

        assigned = await asyncio.gather(*(push(writer) for writer in range(writers)))
        flat = sorted(seq for seqs in assigned for seq in seqs)

        # Every push got its own position, and the positions are exactly the
        # ones consumed — no two writers were handed the same seq.
        assert flat == list(range(1, writers * per_writer + 1))

        # And a reader draining by cursor sees every record exactly once.
        seen: list[int] = []
        cursor = 0
        while True:
            page = await store.documents_since("person-a", cursor=cursor, limit=7)
            if not page:
                break
            seen.extend(document.seq for document in page)
            cursor = page[-1].seq

        assert seen == sorted(seen)
        assert len(seen) == writers * per_writer
        assert len(set(seen)) == len(seen)

    async def test_two_accounts_do_not_block_each_other(self, store, raw_pg):
        # The lock is per account precisely so one person's push cannot make
        # another person wait. If it were global, the second half of this
        # would serialise behind the first.
        await _account(store, "person-a")
        await _account(store, "person-b")

        started = asyncio.Event()
        release = asyncio.Event()

        async def slow_writer():
            # Hold the account row lock across an await, the way a real
            # transaction holds it across network round trips.
            async with raw_pg.transaction():
                await raw_pg.fetchval(
                    "SELECT brain_put_document($1,$2,$3,$4,$5,$6::jsonb,$7::uuid)",
                    "person-a", "session", "held", 1.0, False, "{}", None,
                )
                started.set()
                await release.wait()

        task = asyncio.create_task(slow_writer())
        await asyncio.wait_for(started.wait(), timeout=10)

        try:
            # person-b writes while person-a's transaction is still open. If
            # this times out, the counter is not per account.
            seq = await asyncio.wait_for(
                store.put_document("person-b", kind="session", doc_id="x", updated_at=1.0),
                timeout=5,
            )
            assert seq == 1
        finally:
            release.set()
            await task

    async def test_the_feed_can_be_filtered_by_kind(self, store):
        await _account(store, "person-a")
        await store.put_document("person-a", kind="session", doc_id="s", updated_at=1.0)
        await store.put_document("person-a", kind="memory", doc_id="m", updated_at=1.0)

        only_memories = await store.documents_since("person-a", kinds=("memory",))

        assert [document.doc_id for document in only_memories] == ["m"]

    async def test_the_feed_is_scoped_to_one_person(self, store):
        await _account(store, "person-a")
        await _account(store, "person-b")
        await store.put_document("person-a", kind="session", doc_id="mine", updated_at=1.0)
        await store.put_document("person-b", kind="session", doc_id="theirs", updated_at=1.0)

        assert [d.doc_id for d in await store.documents_since("person-a")] == ["mine"]
        assert [d.doc_id for d in await store.documents_since("person-b")] == ["theirs"]
