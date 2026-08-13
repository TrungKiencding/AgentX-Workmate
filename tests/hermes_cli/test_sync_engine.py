"""The sync engine: what one tick does, and what it does when things go wrong.

Two real ``state.db`` files and a fake service standing in for the network.
The service is fake here on purpose — these tests are about the engine's
contract with a database and with failure, and the real routes have their own
suite. The two are joined for real in ``tests/second_brain/test_convergence.py``,
which runs this engine against the actual service on actual Postgres.

Almost every test here is about a failure, because the engine's whole reason
to exist as a separate object is that it must never turn one into an
exception: it runs in a background loop and behind a status route, and neither
has anywhere useful to put a traceback. The properties being pinned are the
ones a retry cannot repair — an outbox row cleared before it was acknowledged
is a record nobody has any more.
"""

import pytest

from hermes_cli.second_brain_client import SecondBrainError
from hermes_cli.sync_engine import SyncCredentials, SyncEngine, SyncSettings
from hermes_state import SessionDB


@pytest.fixture
def laptop(tmp_path):
    database = SessionDB(tmp_path / "laptop" / "state.db")
    try:
        yield database
    finally:
        database.close()


@pytest.fixture
def desktop(tmp_path):
    database = SessionDB(tmp_path / "desktop" / "state.db")
    try:
        yield database
    finally:
        database.close()


CREDENTIALS = SyncCredentials(
    bearer="tok", device_id="11111111-2222-3333-4444-555555555555", device_name="laptop"
)

SETTINGS = SyncSettings(base_url="https://brain.test", enabled=True)


class FakeBrain:
    """A change feed in a dict, with the failure modes the engine must survive.

    Assigns ``seq`` the way the real service does — one per accepted document,
    from a counter — because the engine's cursor arithmetic is only correct if
    the numbers behave like the real ones.
    """

    def __init__(self):
        self.documents = {}
        self.seq = 0
        self.pushes = []
        self.push_error = None
        self.changes_error = None
        self.reject = set()
        self.page_size = None

    # -- the client surface the engine uses ------------------------------

    def push_documents(self, documents, *, bearer, device_id, device_name=""):
        self.pushes.append(list(documents))
        if self.push_error is not None:
            error, self.push_error = self.push_error, None
            raise error

        results = []
        accepted = rejected = 0
        for document in documents:
            key = (document["kind"], document["doc_id"])
            if document["doc_id"] in self.reject:
                rejected += 1
                results.append({"ok": False, **_identity(document), "error": "nope"})
                continue
            self.seq += 1
            stored = self.documents.get(key)
            if stored is None or stored["updated_at"] <= document["updated_at"]:
                self.documents[key] = {**document, "seq": self.seq, "device_id": device_id}
            accepted += 1
            results.append({"ok": True, **_identity(document), "seq": self.seq})
        return {
            "accepted": accepted,
            "rejected": rejected,
            "cursor": self.seq,
            "results": results,
        }

    def changes(self, *, bearer, device_id, device_name="", since=0, limit=200, kinds=()):
        if self.changes_error is not None:
            error, self.changes_error = self.changes_error, None
            raise error

        window = self.page_size or limit
        ordered = sorted(
            (row for row in self.documents.values() if row["seq"] > since),
            key=lambda row: row["seq"],
        )
        page = ordered[:window]
        return {
            "documents": [_wire(row) for row in page],
            "cursor": page[-1]["seq"] if page else since,
            "has_more": len(ordered) > len(page),
        }


def _identity(document):
    return {"kind": document["kind"], "doc_id": document["doc_id"]}


def _wire(row):
    return {
        "kind": row["kind"],
        "doc_id": row["doc_id"],
        "seq": row["seq"],
        "updated_at": row["updated_at"],
        "deleted": bool(row.get("deleted")),
        "payload": row.get("payload"),
        "device_id": row.get("device_id"),
    }


def engine_for(database, brain, **overrides):
    settings = SETTINGS
    if overrides:
        import dataclasses

        settings = dataclasses.replace(SETTINGS, **overrides)
    return SyncEngine(
        credentials=lambda: CREDENTIALS,
        settings=settings,
        open_db=lambda: database,
        client=brain,
        # Explicitly none. Left out, the engine resolves the file-backed kinds
        # from the real AgentX home, and this suite would push whatever
        # memories the person running it happens to have.
        sources=[],
    )


def seed_session(database, session_id="s1", messages=("hello", "hi there")):
    database.create_session(session_id, "cli", model="m1")
    for index, text in enumerate(messages):
        database.append_message(
            session_id, "user" if index % 2 == 0 else "assistant", text
        )
    return session_id


class TestTick:
    def test_a_tick_pushes_the_outbox_and_clears_it(self, laptop):
        seed_session(laptop)
        brain = FakeBrain()

        outcome = engine_for(laptop, brain).tick()

        assert outcome.status == "ok"
        assert outcome.pushed >= 3  # one session plus its messages
        assert laptop.outbox_pending_count() == 0

    def test_what_one_device_pushes_another_pulls(self, laptop, desktop):
        seed_session(laptop, "s1", ("first", "second"))
        brain = FakeBrain()
        engine_for(laptop, brain).tick()

        engine_for(desktop, brain).tick()

        assert desktop.get_session("s1") is not None
        assert len(desktop.get_messages("s1")) == 2

    def test_applying_a_pulled_page_does_not_queue_it_straight_back(
        self, laptop, desktop
    ):
        seed_session(laptop)
        brain = FakeBrain()
        engine_for(laptop, brain).tick()

        engine_for(desktop, brain).tick()

        # Two devices trading the same document forever is the failure this
        # prevents, and it is invisible until the traffic bill arrives.
        assert desktop.outbox_pending_count() == 0

    def test_a_second_tick_with_nothing_to_do_pushes_nothing(self, laptop):
        seed_session(laptop)
        brain = FakeBrain()
        engine = engine_for(laptop, brain)
        engine.tick()
        pushes_after_first = len(brain.pushes)

        outcome = engine.tick()

        assert outcome.status == "ok"
        assert outcome.pushed == 0
        assert len(brain.pushes) == pushes_after_first

    def test_the_cursor_advances_and_survives_a_reopen(self, laptop, desktop, tmp_path):
        seed_session(laptop)
        brain = FakeBrain()
        engine_for(laptop, brain).tick()
        engine_for(desktop, brain).tick()
        advanced = desktop.sync_cursor()
        desktop.close()

        reopened = SessionDB(tmp_path / "desktop" / "state.db")
        try:
            assert reopened.sync_cursor() == advanced > 0
        finally:
            reopened.close()

    def test_an_idle_tick_still_records_that_the_service_was_reached(self, laptop):
        brain = FakeBrain()

        engine_for(laptop, brain).tick()

        # "Last synchronised" has to mean "we reached the service", not
        # "something happened to change".
        assert laptop.sync_status()["last_pull_at"] is not None


class TestPushDurability:
    def test_a_failure_mid_push_leaves_the_outbox_intact(self, laptop):
        seed_session(laptop)
        pending = laptop.outbox_pending_count()
        brain = FakeBrain()
        brain.push_error = SecondBrainError("connection reset")

        outcome = engine_for(laptop, brain).tick()

        assert outcome.status == "offline"
        # Nothing was acknowledged, so nothing may be dropped.
        assert laptop.outbox_pending_count() == pending

    def test_the_next_tick_recovers_everything(self, laptop):
        seed_session(laptop)
        brain = FakeBrain()
        brain.push_error = SecondBrainError("connection reset")
        engine = engine_for(laptop, brain)
        engine.tick()

        outcome = engine.tick()

        assert outcome.status == "ok"
        assert laptop.outbox_pending_count() == 0

    def test_a_document_the_service_will_never_store_is_not_retried_forever(
        self, laptop
    ):
        session_id = seed_session(laptop)
        brain = FakeBrain()
        brain.reject = {session_id}

        outcome = engine_for(laptop, brain).tick()

        assert outcome.rejected == 1
        assert any(entry["doc_id"] == session_id for entry in outcome.errors)
        # Cleared, loudly. Left queued, it would be resent on every tick for
        # the life of the install and block everything behind it.
        assert laptop.outbox_pending_count() == 0

    def test_a_large_backlog_is_pushed_in_batches(self, laptop):
        for index in range(30):
            seed_session(laptop, f"s{index}", ("only message",))
        brain = FakeBrain()

        engine = SyncEngine(
            credentials=lambda: CREDENTIALS,
            settings=SETTINGS,
            open_db=lambda: laptop,
            client=brain,
            sources=[],
        )
        outcome = engine.tick()

        assert outcome.status == "ok"
        assert laptop.outbox_pending_count() == 0
        # 60 documents at 200 per batch is one request; the point being pinned
        # is that batching happened at all rather than one document per call.
        assert len(brain.pushes) < 60


class TestPullDurability:
    def test_a_crash_mid_pull_resumes_from_the_last_committed_cursor(
        self, laptop, desktop
    ):
        for index in range(5):
            seed_session(laptop, f"s{index}", ("hello",))
        brain = FakeBrain()
        engine_for(laptop, brain).tick()

        # One small page, then the connection dies.
        brain.page_size = 2
        pulling = engine_for(desktop, brain)
        original = brain.changes
        calls = {"n": 0}

        def flaky(**kwargs):
            calls["n"] += 1
            if calls["n"] == 2:
                raise SecondBrainError("connection reset")
            return original(**kwargs)

        brain.changes = flaky
        first = pulling.tick()
        assert first.status == "offline"
        partial = desktop.sync_cursor()
        assert partial > 0

        brain.changes = original
        second = pulling.tick()

        assert second.status == "ok"
        assert desktop.sync_cursor() > partial
        assert all(desktop.get_session(f"s{index}") for index in range(5))

    def test_pulling_the_same_page_twice_changes_nothing(self, laptop, desktop):
        seed_session(laptop, "s1", ("hello", "there"))
        brain = FakeBrain()
        engine_for(laptop, brain).tick()
        engine_for(desktop, brain).tick()

        # What a crash between applying a page and recording its cursor costs.
        desktop.set_sync_cursor(0)
        engine_for(desktop, brain).tick()

        assert len(desktop.get_messages("s1")) == 2

    def test_a_first_sync_pages_rather_than_asking_for_everything_at_once(
        self, laptop, desktop
    ):
        for index in range(12):
            seed_session(laptop, f"s{index}", ("hello",))
        brain = FakeBrain()
        engine_for(laptop, brain).tick()
        brain.page_size = 3

        outcome = engine_for(desktop, brain).tick()

        assert outcome.status == "ok"
        # Twelve sessions across four-document pages: the drain has to keep
        # going while `has_more` is true rather than stopping at one page.
        assert all(desktop.get_session(f"s{index}") for index in range(12))

    def test_resetting_the_cursor_re_pulls_the_whole_feed(self, laptop, desktop):
        seed_session(laptop, "s1", ("hello",))
        brain = FakeBrain()
        engine_for(laptop, brain).tick()
        engine = engine_for(desktop, brain)
        engine.tick()

        status = engine.reset_cursor()

        assert status["cursor"] == 0
        # Safe because applying is idempotent — the documented recovery from a
        # service restored to an earlier point.
        assert engine.tick().status == "ok"
        assert len(desktop.get_messages("s1")) == 1


class TestDegradation:
    def test_the_service_being_down_is_not_an_error_the_person_sees(self, laptop):
        brain = FakeBrain()
        brain.changes_error = SecondBrainError("could not reach the second brain")

        outcome = engine_for(laptop, brain).tick()

        assert outcome.status == "offline"
        assert "keeps working" in outcome.detail

    def test_a_revoked_device_asks_for_re_authentication_and_backs_off(self, laptop):
        brain = FakeBrain()
        brain.changes_error = SecondBrainError(
            "revoked", status_code=403, code="device_revoked"
        )

        engine = engine_for(laptop, brain)
        first = engine.tick()
        brain.changes_error = None
        second = engine.tick()

        assert first.status == "reauth"
        # Backed off rather than hammering a service that is correctly saying
        # no — retrying does not fix a revocation, signing in again does.
        assert second.status == "reauth"

    def test_a_rejected_token_backs_off_the_same_way(self, laptop):
        brain = FakeBrain()
        brain.changes_error = SecondBrainError("nope", status_code=401, code="invalid_token")

        assert engine_for(laptop, brain).tick().status == "reauth"

    def test_a_refusal_is_recorded_where_support_can_read_it(self, laptop):
        brain = FakeBrain()
        brain.changes_error = SecondBrainError(
            "boom", status_code=500, code="store_unavailable"
        )

        engine_for(laptop, brain).tick()

        assert "boom" in (laptop.sync_status()["last_error"] or "")

    def test_a_successful_tick_clears_the_last_error(self, laptop):
        brain = FakeBrain()
        brain.changes_error = SecondBrainError("boom", status_code=500)
        engine = engine_for(laptop, brain)
        engine.tick()

        engine.tick()

        assert laptop.sync_status()["last_error"] is None

    def test_no_service_configured_does_nothing_quietly(self, laptop):
        outcome = engine_for(laptop, FakeBrain(), base_url="").tick()

        assert outcome.status == "unconfigured"

    def test_switched_off_does_nothing_quietly(self, laptop):
        outcome = engine_for(laptop, FakeBrain(), enabled=False).tick()

        assert outcome.status == "disabled"

    def test_nobody_signed_in_does_nothing_quietly(self, laptop):
        engine = SyncEngine(
            credentials=lambda: None,
            settings=SETTINGS,
            open_db=lambda: laptop,
            client=FakeBrain(),
            sources=[],
        )

        assert engine.tick().status == "signed_out"

    def test_a_credentials_supplier_that_raises_is_not_a_crash(self, laptop):
        def broken():
            raise RuntimeError("keychain locked")

        engine = SyncEngine(
            credentials=broken,
            settings=SETTINGS,
            open_db=lambda: laptop,
            client=FakeBrain(),
            sources=[],
        )

        assert engine.tick().status == "signed_out"

    def test_a_database_that_will_not_open_is_reported_not_raised(self):
        def broken():
            raise OSError("state.db is gone")

        engine = SyncEngine(
            credentials=lambda: CREDENTIALS,
            settings=SETTINGS,
            open_db=broken,
            client=FakeBrain(),
            sources=[],
        )

        outcome = engine.tick()

        assert outcome.status == "error"
        assert "state.db" in outcome.detail


class TestFileBackedSources:
    """Kinds that do not live in state.db, driven through the same tick.

    The engine knows nothing about what these contain — that is the point of
    the boundary. What it owes them is that they are drained on every tick and
    routed back by kind, which is what these check.
    """

    class Source:
        """A source in a dict, with the surface the engine calls."""

        def __init__(self, kind="memory"):
            self.kind = kind
            self.queued = []
            self.acknowledged = []
            self.applied = []

        @property
        def kinds(self):
            return (self.kind,)

        def pending(self, limit=200):
            return self.queued[:limit]

        def acknowledge(self, documents):
            self.acknowledged.extend(documents)
            for document in documents:
                if document in self.queued:
                    self.queued.remove(document)

        def apply(self, documents):
            self.applied.extend(documents)
            return {"applied": len(documents), "deleted": 0, "errors": [], "skipped": 0}

    def engine_with(self, database, brain, *sources):
        return SyncEngine(
            credentials=lambda: CREDENTIALS,
            settings=SETTINGS,
            open_db=lambda: database,
            client=brain,
            sources=list(sources),
        )

    def document(self, doc_id="MEMORY.md", kind="memory"):
        return {
            "kind": kind,
            "doc_id": doc_id,
            "updated_at": 100.0,
            "deleted": False,
            "payload": {"text": "a memory"},
            "_manifest": {"mtime": 100.0, "size": 8},
        }

    def test_a_file_kind_is_pushed_even_when_the_outbox_is_empty(self, laptop):
        # A memory edited while no session changed is the COMMON case. An
        # early return once the outbox came back empty would make it the one
        # case that never syncs.
        source = self.Source()
        source.queued.append(self.document())
        brain = FakeBrain()

        outcome = self.engine_with(laptop, brain, source).tick()

        assert outcome.status == "ok"
        assert outcome.pushed == 1
        assert brain.documents[('memory', 'MEMORY.md')]['payload'] == {'text': 'a memory'}

    def test_bookkeeping_never_reaches_the_wire(self, laptop):
        source = self.Source()
        source.queued.append(self.document())
        brain = FakeBrain()

        self.engine_with(laptop, brain, source).tick()

        # `_manifest` is this side's own record. Sent, the service would store
        # it and hand it to every other device.
        assert '_manifest' not in brain.pushes[0][0]

    def test_a_source_is_acknowledged_only_after_the_service_answers(self, laptop):
        source = self.Source()
        source.queued.append(self.document())
        brain = FakeBrain()
        brain.push_error = SecondBrainError("connection reset")

        self.engine_with(laptop, brain, source).tick()

        assert source.acknowledged == []
        assert len(source.queued) == 1

    def test_a_pulled_document_is_routed_to_the_source_that_owns_its_kind(
        self, laptop, desktop
    ):
        origin = self.Source()
        origin.queued.append(self.document())
        brain = FakeBrain()
        self.engine_with(laptop, brain, origin).tick()

        receiver = self.Source()
        self.engine_with(desktop, brain, receiver).tick()

        assert [d["doc_id"] for d in receiver.applied] == ["MEMORY.md"]

    def test_sessions_and_file_kinds_are_split_out_of_one_page(self, laptop, desktop):
        seed_session(laptop, "s1", ("hello",))
        origin = self.Source()
        origin.queued.append(self.document())
        brain = FakeBrain()
        self.engine_with(laptop, brain, origin).tick()

        receiver = self.Source()
        self.engine_with(desktop, brain, receiver).tick()

        assert desktop.get_session("s1") is not None
        assert [d["doc_id"] for d in receiver.applied] == ["MEMORY.md"]

    def test_two_sources_do_not_receive_each_others_kinds(self, laptop, desktop):
        memories, plans = self.Source("memory"), self.Source("plan")
        memories.queued.append(self.document("MEMORY.md", "memory"))
        plans.queued.append(self.document("rollout.md", "plan"))
        brain = FakeBrain()
        self.engine_with(laptop, brain, memories, plans).tick()

        got_memories, got_plans = self.Source("memory"), self.Source("plan")
        self.engine_with(desktop, brain, got_memories, got_plans).tick()

        assert [d["doc_id"] for d in got_memories.applied] == ["MEMORY.md"]
        assert [d["doc_id"] for d in got_plans.applied] == ["rollout.md"]

    def test_a_source_that_raises_does_not_stop_the_others(self, laptop):
        class Broken(self.Source):
            def pending(self, limit=200):
                raise OSError("permission denied")

        broken, working = Broken("plan"), self.Source("memory")
        working.queued.append(self.document())
        brain = FakeBrain()

        outcome = self.engine_with(laptop, brain, broken, working).tick()

        # A permissions problem on one directory must not silently stop
        # conversation history from converging.
        assert outcome.status == "ok"
        assert outcome.pushed == 1
        assert any(entry.get("kind") == "plan" for entry in outcome.errors)

    def test_a_source_that_raises_while_applying_does_not_lose_the_page(
        self, laptop, desktop
    ):
        origin = self.Source()
        origin.queued.append(self.document())
        seed_session(laptop, "s1", ("hello",))
        brain = FakeBrain()
        self.engine_with(laptop, brain, origin).tick()

        class Broken(self.Source):
            def apply(self, documents):
                raise OSError("read-only filesystem")

        # A second device, so its cursor is still at the start of the feed and
        # the page genuinely reaches the broken source.
        outcome = self.engine_with(desktop, brain, Broken()).tick()

        assert outcome.status == "ok"
        assert outcome.errors
        # The session half of the same page still landed.
        assert desktop.get_session("s1") is not None


class TestStatus:
    def test_status_answers_without_a_network_call(self, laptop):
        seed_session(laptop)
        brain = FakeBrain()
        engine = engine_for(laptop, brain)
        pushes_before = len(brain.pushes)

        status = engine.status()

        assert status["configured"] is True
        assert status["pending"] > 0
        assert len(brain.pushes) == pushes_before

    def test_status_reports_the_backlog_and_the_position(self, laptop, desktop):
        seed_session(laptop, "s1", ("hello",))
        brain = FakeBrain()
        engine_for(laptop, brain).tick()
        engine = engine_for(desktop, brain)
        engine.tick()

        status = engine.status()

        assert status["pending"] == 0
        assert status["cursor"] > 0
        assert status["last"]["status"] == "ok"

    def test_status_on_an_unconfigured_machine_says_so_without_touching_state(self):
        engine = SyncEngine(
            credentials=lambda: CREDENTIALS,
            settings=SyncSettings(base_url=""),
            open_db=lambda: pytest.fail("status must not open state.db when unconfigured"),
            sources=[],
        )

        assert engine.status()["configured"] is False


class TestRealtime:
    """The change socket: a shortcut in front of polling, never a replacement.

    Everything here is about that distinction. A socket that fails, drops, or
    never opens must cost latency and never correctness, which is why the
    tests are mostly about what happens when it does not work.
    """

    def test_a_base_url_becomes_a_websocket_url(self):
        assert (
            SyncSettings(base_url="https://brain.test").stream_url
            == "wss://brain.test/v1/sync/stream"
        )
        assert (
            SyncSettings(base_url="http://localhost:8811").stream_url
            == "ws://localhost:8811/v1/sync/stream"
        )

    def test_a_url_with_no_scheme_yields_no_stream_rather_than_a_bad_one(self):
        # Connecting to a guess would produce a confusing failure every five
        # seconds forever. Not streaming is the honest answer.
        assert SyncSettings(base_url="brain.test").stream_url == ""
        assert SyncSettings(base_url="").stream_url == ""

    @pytest.mark.asyncio
    async def test_a_change_frame_triggers_a_tick(self, laptop):
        import asyncio
        import json

        import websockets

        received = asyncio.Event()

        async def serve(socket):
            await socket.send(json.dumps({"type": "hello"}))
            await socket.send(json.dumps({"type": "changed"}))
            await received.wait()

        async with websockets.serve(serve, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            engine = SyncEngine(
                credentials=lambda: CREDENTIALS,
                settings=SyncSettings(base_url=f"http://127.0.0.1:{port}"),
                open_db=lambda: laptop,
                client=FakeBrain(),
                sources=[],
            )
            engine._wake = asyncio.Event()
            engine._loop = asyncio.get_running_loop()

            watcher = asyncio.create_task(engine._watch_stream())
            try:
                await asyncio.wait_for(engine._wake.wait(), timeout=10)
            finally:
                received.set()
                watcher.cancel()

        # The frame carried "go and look", and the tick loop is what looks.
        assert engine._wake.is_set()

    @pytest.mark.asyncio
    async def test_a_ping_frame_does_not_trigger_a_tick(self, laptop):
        import asyncio
        import json

        import websockets

        done = asyncio.Event()

        async def serve(socket):
            await socket.send(json.dumps({"type": "hello"}))
            await socket.send(json.dumps({"type": "ping"}))
            await done.wait()

        async with websockets.serve(serve, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            engine = SyncEngine(
                credentials=lambda: CREDENTIALS,
                settings=SyncSettings(base_url=f"http://127.0.0.1:{port}"),
                open_db=lambda: laptop,
                client=FakeBrain(),
                sources=[],
            )
            engine._wake = asyncio.Event()
            engine._loop = asyncio.get_running_loop()

            watcher = asyncio.create_task(engine._watch_stream())
            try:
                await asyncio.sleep(0.5)
            finally:
                done.set()
                watcher.cancel()

        # A keepalive is not a change. Ticking on one would turn an idle
        # fleet into a poll every forty-five seconds for no reason.
        assert not engine._wake.is_set()

    @pytest.mark.asyncio
    async def test_a_service_with_no_stream_does_not_stop_the_engine(self, laptop):
        import asyncio

        engine = SyncEngine(
            credentials=lambda: CREDENTIALS,
            # Nothing listening on this port.
            settings=SyncSettings(base_url="http://127.0.0.1:1"),
            open_db=lambda: laptop,
            client=FakeBrain(),
            sources=[],
        )
        engine._wake = asyncio.Event()
        engine._loop = asyncio.get_running_loop()

        watcher = asyncio.create_task(engine._watch_stream())
        await asyncio.sleep(0.2)
        watcher.cancel()

        # Retrying quietly, and the tick loop is untouched — an old service,
        # a proxy that drops upgrades, or a network that only passes HTTP all
        # land here and all still converge on the polling interval.
        assert not watcher.done() or watcher.cancelled()
        assert engine.tick().status == "ok"

    @pytest.mark.asyncio
    async def test_it_waits_rather_than_connecting_without_credentials(self, laptop):
        import asyncio

        engine = SyncEngine(
            credentials=lambda: None,
            settings=SyncSettings(base_url="http://127.0.0.1:1", interval_seconds=0.05),
            open_db=lambda: laptop,
            client=FakeBrain(),
            sources=[],
        )
        engine._wake = asyncio.Event()
        engine._loop = asyncio.get_running_loop()

        watcher = asyncio.create_task(engine._watch_stream())
        await asyncio.sleep(0.2)
        watcher.cancel()

        # Opening an unauthenticated socket would earn a 4401 and a reconnect
        # loop against a service that is correctly refusing it.
        assert not engine._wake.is_set()

    @pytest.mark.asyncio
    async def test_no_stream_url_ends_the_watcher_instead_of_spinning(self, laptop):
        import asyncio

        engine = SyncEngine(
            credentials=lambda: CREDENTIALS,
            settings=SyncSettings(base_url="brain.test"),
            open_db=lambda: laptop,
            client=FakeBrain(),
            sources=[],
        )
        engine._wake = asyncio.Event()
        engine._loop = asyncio.get_running_loop()

        await asyncio.wait_for(engine._watch_stream(), timeout=2)

    def test_realtime_can_be_switched_off_in_the_field(self):
        settings = _settings_from(
            {"base_url": "https://brain.test", "sync": {"realtime": False}}
        )

        assert settings.realtime is False
        assert settings.enabled is True

    def test_realtime_is_on_by_default(self):
        assert _settings_from({"base_url": "https://brain.test"}).realtime is True


class TestSettings:
    def test_a_missing_sync_block_leaves_synchronisation_on(self):
        from hermes_cli.sync_engine import DEFAULT_INTERVAL_SECONDS

        settings = _settings_from({"base_url": "https://brain.test"})

        # Every install that already has a service configured starts syncing
        # on update, without anybody editing config.yaml.
        assert settings.enabled is True
        assert settings.interval_seconds == DEFAULT_INTERVAL_SECONDS

    def test_it_can_be_switched_off_in_the_field(self):
        settings = _settings_from(
            {"base_url": "https://brain.test", "sync": {"enabled": False}}
        )

        assert settings.enabled is False

    def test_a_nonsense_interval_falls_back_to_the_default(self):
        from hermes_cli.sync_engine import DEFAULT_INTERVAL_SECONDS

        settings = _settings_from(
            {"base_url": "https://brain.test", "sync": {"interval_seconds": "soon"}}
        )

        assert settings.interval_seconds == DEFAULT_INTERVAL_SECONDS

    def test_a_zero_interval_falls_back_rather_than_spinning(self):
        from hermes_cli.sync_engine import DEFAULT_INTERVAL_SECONDS

        settings = _settings_from(
            {"base_url": "https://brain.test", "sync": {"interval_seconds": 0}}
        )

        assert settings.interval_seconds == DEFAULT_INTERVAL_SECONDS


def _settings_from(section):
    """Load settings from an ``accounts.second_brain`` block, with no config file.

    Patches the machine-config read rather than writing a config.yaml, so the
    test says which block it is exercising instead of hiding it in a fixture
    directory.
    """
    from unittest.mock import patch

    from hermes_cli.sync_engine import load_sync_settings

    with patch(
        "hermes_cli.account_provisioning.load_machine_config",
        return_value={"accounts": {"second_brain": section}},
    ):
        return load_sync_settings()
