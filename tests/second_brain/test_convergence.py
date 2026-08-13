"""Two devices, one service, and a fixed script of edits dealt between them.

This is the acceptance test for R2. Everything else in the two suites checks a
component in isolation; this checks the only thing anybody actually asked for —
that a conversation edited on one machine is the same conversation on the
other.

Nothing here is a double. Two real ``SessionDB`` files on two temporary
directories, the real ``SessionSyncMixin`` producing and applying documents,
the real ``SyncEngine`` driving them, the real ``SecondBrainClient`` speaking
HTTP, and the real service on real Postgres. The only artificial part is the
transport, which carries ASGI calls into the service's event loop instead of
over a socket.

**Fixed seeds, always.** A convergence test that cannot reproduce its own
failure is worthless: the failure it is built to catch is a race, and a race
you cannot replay is a race you cannot fix. Every operation list here comes
from ``random.Random(seed)`` with the seed written down.

Why the service runs on its own thread: an asyncpg pool belongs to exactly one
event loop, and the engine is synchronous by design (every outbound HTTP path
in the CLI is). So the service gets a loop of its own on a background thread,
and the sync client's transport marshals each call into it. That is closer to
production than running the engine inside the test's own loop would be.
"""

from __future__ import annotations

import asyncio
import random
import threading

import pytest

from hermes_cli.sync_engine import SyncCredentials, SyncEngine, SyncSettings
from hermes_state import SessionDB
from tests.second_brain.conftest import new_device_id

#: Headers the transport strips: the inner client recomputes them, and passing
#: the outer request's values through produces a body length that disagrees
#: with the body.
_HOP_BY_HOP = {"host", "content-length", "transfer-encoding", "connection"}


class ThreadedBrain:
    """The real service, on a private event loop, callable from sync code.

    Exists because of a genuine constraint rather than convenience: an asyncpg
    pool is bound to the loop that created it, and the sync engine is
    synchronous. Giving the service a thread of its own lets both be real.
    """

    def __init__(self, settings, realm):
        self._settings = settings
        self._realm = realm
        self._loop = None
        self._thread = None
        self._store = None
        self._app = None
        self._lifespan = None
        self._http = None

    def __enter__(self):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._loop.run_forever, daemon=True, name="second-brain"
        )
        self._thread.start()
        self._submit(self._start()).result(timeout=120)
        return self

    def __exit__(self, *_exc):
        try:
            self._submit(self._stop()).result(timeout=60)
        finally:
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join(timeout=30)
            self._loop.close()

    def _submit(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    async def _start(self):
        import asyncpg
        import httpx

        from second_brain.app import build_app
        from second_brain.store.engine import Store

        self._store = await Store.connect(self._settings)
        await self._store.migrate()

        scrub = await asyncpg.connect(self._settings.database_url)
        try:
            await scrub.execute("TRUNCATE accounts CASCADE")
        finally:
            await scrub.close()

        self._app = build_app(
            settings=self._settings,
            provider=self._realm,
            store=self._store,
            litellm=None,
        )
        self._lifespan = self._app.router.lifespan_context(self._app)
        await self._lifespan.__aenter__()
        self._http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self._app),
            base_url="http://second-brain.test",
        )

    async def _stop(self):
        await self._http.aclose()
        await self._lifespan.__aexit__(None, None, None)
        # Ours to close: build_app leaves an injected store to its owner.
        await self._store.close()

    @property
    def transport(self):
        """A synchronous httpx transport that dispatches into the service."""
        import httpx

        def handle(request: httpx.Request) -> httpx.Response:
            headers = {
                name: value
                for name, value in request.headers.items()
                if name.lower() not in _HOP_BY_HOP
            }

            async def call():
                return await self._http.request(
                    request.method,
                    str(request.url),
                    content=request.content,
                    headers=headers,
                )

            answer = self._submit(call()).result(timeout=120)
            return httpx.Response(
                answer.status_code,
                content=answer.content,
                headers={
                    "content-type": answer.headers.get("content-type", "application/json")
                },
            )

        return httpx.MockTransport(handle)


@pytest.fixture
def brain(brain_settings, realm):
    realm.add("tok", subject="one-person", email="p@test", display_name="One Person")
    with ThreadedBrain(brain_settings, realm) as running:
        yield running


class Device:
    """One machine: its ``state.db``, its device id, and its engine."""

    def __init__(self, name, path, brain, sources=None):
        self.name = name
        self.db = SessionDB(path / name / "state.db")
        self.device_id = new_device_id()
        self.home = None
        self.engine = SyncEngine(
            credentials=lambda: SyncCredentials(
                bearer="tok", device_id=self.device_id, device_name=name
            ),
            settings=SyncSettings(base_url="https://second-brain.test", enabled=True),
            open_db=lambda: self.db,
            transport=brain.transport,
            # Explicitly none by default: resolved from the environment, this
            # suite would carry whatever memories the person running it has.
            sources=list(sources or []),
        )

    def tick(self):
        outcome = self.engine.tick()
        assert outcome.status == "ok", f"{self.name}: {outcome.status} {outcome.detail}"
        return outcome

    def drain(self, rounds=6):
        """Tick until nothing is left to send or receive.

        More than one tick because convergence is two-sided: a device has to
        push before the other can pull, and the second device's pull can
        itself produce nothing new only once the first has finished.
        """
        for _ in range(rounds):
            self.tick()

    def close(self):
        self.db.close()


@pytest.fixture
def devices(tmp_path, brain):
    laptop = Device("laptop", tmp_path, brain)
    desktop = Device("desktop", tmp_path, brain)
    try:
        yield laptop, desktop
    finally:
        laptop.close()
        desktop.close()


def snapshot(database):
    """Everything about a device that must match the other device.

    Session ids, message uuids, and the metadata a person would notice. Token
    counters and costs are excluded deliberately — they are per-machine
    accounting, they change on nearly every turn, and the trigger set does not
    carry them precisely so that they do not.
    """
    with database._read_ctx() as conn:
        sessions = {
            row["id"]: {
                "title": row["title"],
                "display_name": row["display_name"],
                "archived": row["archived"],
                "pinned": row["pinned"],
                "model": row["model"],
            }
            for row in conn.execute(
                "SELECT id, title, display_name, archived, pinned, model FROM sessions"
            ).fetchall()
        }
        messages = {
            row["uuid"]: (row["session_id"], row["role"], row["content"])
            for row in conn.execute(
                "SELECT uuid, session_id, role, content FROM messages "
                "WHERE uuid IS NOT NULL"
            ).fetchall()
        }
    return sessions, messages


def converge(laptop, desktop):
    """Run both devices until neither has anything left to exchange."""
    for _ in range(8):
        laptop.tick()
        desktop.tick()
    laptop.tick()
    desktop.tick()


class TestConvergence:
    def test_a_session_created_on_one_device_appears_on_the_other(self, devices):
        laptop, desktop = devices
        laptop.db.create_session("s1", "cli", model="m1")
        laptop.db.append_message("s1", "user", "hello from the laptop")

        converge(laptop, desktop)

        assert desktop.db.get_session("s1") is not None
        assert [m["content"] for m in desktop.db.get_messages("s1")] == [
            "hello from the laptop"
        ]

    def test_edits_made_on_both_devices_converge_in_both_directions(self, devices):
        laptop, desktop = devices
        laptop.db.create_session("from-laptop", "cli", model="m1")
        laptop.db.append_message("from-laptop", "user", "one")
        desktop.db.create_session("from-desktop", "cli", model="m2")
        desktop.db.append_message("from-desktop", "user", "two")

        converge(laptop, desktop)

        assert snapshot(laptop.db) == snapshot(desktop.db)

    def test_a_rename_on_one_device_reaches_the_other(self, devices):
        laptop, desktop = devices
        laptop.db.create_session("s1", "cli", model="m1")
        converge(laptop, desktop)

        laptop.db.set_session_title("s1", "Quarterly planning")
        converge(laptop, desktop)

        assert desktop.db.get_session("s1")["title"] == "Quarterly planning"

    def test_a_delete_on_one_device_removes_it_from_the_other(self, devices):
        laptop, desktop = devices
        laptop.db.create_session("s1", "cli", model="m1")
        laptop.db.append_message("s1", "user", "hello")
        converge(laptop, desktop)
        assert desktop.db.get_session("s1") is not None

        laptop.db.delete_session("s1")
        converge(laptop, desktop)

        assert desktop.db.get_session("s1") is None

    def test_a_deleted_session_is_not_resurrected_by_the_other_device(self, devices):
        laptop, desktop = devices
        laptop.db.create_session("s1", "cli", model="m1")
        converge(laptop, desktop)
        laptop.db.delete_session("s1")
        converge(laptop, desktop)

        # The tombstone is what stops the desktop's own copy of the row from
        # being pushed straight back the next time it syncs.
        desktop.drain()
        laptop.drain()

        assert laptop.db.get_session("s1") is None
        assert desktop.db.get_session("s1") is None

    def test_nothing_ping_pongs_once_both_devices_are_in_step(self, devices):
        laptop, desktop = devices
        laptop.db.create_session("s1", "cli", model="m1")
        laptop.db.append_message("s1", "user", "hello")
        converge(laptop, desktop)

        quiet = desktop.tick()

        # Applying a remote document must not queue it back for pushing, or
        # two devices trade the same records forever and nothing ever reports
        # it except a traffic bill.
        assert quiet.pushed == 0
        assert desktop.db.outbox_pending_count() == 0
        assert laptop.db.outbox_pending_count() == 0

    @pytest.mark.parametrize("seed", [1, 7, 42, 1337])
    def test_an_interleaved_script_of_edits_leaves_both_devices_identical(
        self, devices, seed
    ):
        """The real test. A fixed script, dealt between two machines.

        Ticks land at varying points rather than after every edit, so a change
        made while a device was behind is exercised as well as one made while
        it was up to date.
        """
        laptop, desktop = devices
        rng = random.Random(seed)
        both = (laptop, desktop)
        created: list[str] = []

        for step in range(40):
            device = both[rng.randrange(2)]
            choice = rng.random()

            if choice < 0.30 or not created:
                session_id = f"s{step}"
                device.db.create_session(session_id, "cli", model=f"m{step % 3}")
                created.append(session_id)
            elif choice < 0.60:
                session_id = rng.choice(created)
                if device.db.get_session(session_id) is not None:
                    device.db.append_message(session_id, "user", f"message {step}")
            elif choice < 0.75:
                session_id = rng.choice(created)
                if device.db.get_session(session_id) is not None:
                    device.db.set_session_title(session_id, f"renamed at {step}")
            elif choice < 0.85:
                session_id = rng.choice(created)
                if device.db.get_session(session_id) is not None:
                    device.db.set_session_archived(session_id, True)
            elif choice < 0.95:
                session_id = rng.choice(created)
                if device.db.get_session(session_id) is not None:
                    device.db.set_session_pinned(session_id, True)
            else:
                session_id = rng.choice(created)
                if device.db.get_session(session_id) is not None:
                    device.db.delete_session(session_id)
                    created.remove(session_id)

            # Not after every edit: a device that is behind when the next edit
            # lands is the interesting case, not the synchronised one.
            if rng.random() < 0.35:
                device.tick()

        converge(laptop, desktop)

        laptop_sessions, laptop_messages = snapshot(laptop.db)
        desktop_sessions, desktop_messages = snapshot(desktop.db)

        assert laptop_sessions.keys() == desktop_sessions.keys(), (
            f"seed {seed}: session sets differ — "
            f"only on laptop {sorted(laptop_sessions.keys() - desktop_sessions.keys())}, "
            f"only on desktop {sorted(desktop_sessions.keys() - laptop_sessions.keys())}"
        )
        assert laptop_messages == desktop_messages, f"seed {seed}: message sets differ"
        assert laptop_sessions == desktop_sessions, f"seed {seed}: metadata differs"


class TestOfflineAndRecovery:
    def test_a_device_that_was_offline_catches_up(self, devices):
        laptop, desktop = devices
        for index in range(6):
            laptop.db.create_session(f"s{index}", "cli", model="m1")
            laptop.db.append_message(f"s{index}", "user", f"message {index}")
        laptop.drain()

        # The desktop has not ticked once until now.
        desktop.drain()

        assert all(desktop.db.get_session(f"s{index}") for index in range(6))

    def test_a_cursor_reset_re_pulls_everything_and_changes_nothing(self, devices):
        laptop, desktop = devices
        laptop.db.create_session("s1", "cli", model="m1")
        laptop.db.append_message("s1", "user", "hello")
        converge(laptop, desktop)
        before = snapshot(desktop.db)

        desktop.engine.reset_cursor()
        desktop.drain()

        # The documented recovery after a service is restored to an earlier
        # point. Safe precisely because applying is idempotent.
        assert snapshot(desktop.db) == before

    def test_the_service_being_unreachable_leaves_both_devices_working(
        self, devices, brain
    ):
        import httpx

        laptop, desktop = devices
        laptop.db.create_session("s1", "cli", model="m1")

        def refuse(_request):
            raise httpx.ConnectError("the service is down")

        laptop.engine._client = None
        laptop.engine._transport = httpx.MockTransport(refuse)
        outcome = laptop.engine.tick()

        assert outcome.status == "offline"
        # Nothing acknowledged, so nothing dropped: the records are still here.
        assert laptop.db.outbox_pending_count() > 0

        laptop.engine._client = None
        laptop.engine._transport = brain.transport
        laptop.drain()
        desktop.drain()

        assert desktop.db.get_session("s1") is not None


class TestFileBackedKinds:
    """U14: memories and plans travel with conversation history.

    The result being checked is partly an absence. These documents go through
    the same two routes, the same table and the same function as a session —
    nothing in ``second_brain/`` knows what a memory is, and adding one
    required no migration and no server-side branch. If that ever stops being
    true, the boundary Phase 1 drew was drawn in the wrong place.
    """

    @pytest.fixture
    def paired(self, tmp_path, brain):
        from hermes_cli.sync_sources import default_sources

        made = []
        for name in ("laptop", "desktop"):
            home = tmp_path / f"{name}-home"
            (home / "memories").mkdir(parents=True, exist_ok=True)
            (home / "plans").mkdir(parents=True, exist_ok=True)
            device = Device(name, tmp_path, brain, sources=default_sources(home))
            device.home = home
            made.append(device)
        try:
            yield made[0], made[1]
        finally:
            for device in made:
                device.close()

    def test_a_memory_written_on_one_device_appears_on_the_other(self, paired):
        laptop, desktop = paired
        (laptop.home / "memories" / "MEMORY.md").write_text(
            "- prefers tabs over spaces", encoding="utf-8"
        )

        converge(laptop, desktop)

        assert (desktop.home / "memories" / "MEMORY.md").read_text(encoding="utf-8") == (
            "- prefers tabs over spaces"
        )

    def test_a_plan_travels_the_same_way(self, paired):
        laptop, desktop = paired
        (laptop.home / "plans" / "rollout.md").write_text("# Rollout", encoding="utf-8")

        converge(laptop, desktop)

        assert (desktop.home / "plans" / "rollout.md").exists()

    def test_deleting_a_memory_removes_it_everywhere(self, paired):
        laptop, desktop = paired
        (laptop.home / "memories" / "MEMORY.md").write_text("temporary", encoding="utf-8")
        converge(laptop, desktop)
        assert (desktop.home / "memories" / "MEMORY.md").exists()

        (laptop.home / "memories" / "MEMORY.md").unlink()
        converge(laptop, desktop)

        assert not (desktop.home / "memories" / "MEMORY.md").exists()

    def test_memories_and_sessions_converge_in_the_same_tick(self, paired):
        laptop, desktop = paired
        laptop.db.create_session("s1", "cli", model="m1")
        laptop.db.append_message("s1", "user", "hello")
        (laptop.home / "memories" / "MEMORY.md").write_text("a memory", encoding="utf-8")
        (laptop.home / "plans" / "p.md").write_text("a plan", encoding="utf-8")

        converge(laptop, desktop)

        assert desktop.db.get_session("s1") is not None
        assert (desktop.home / "memories" / "MEMORY.md").exists()
        assert (desktop.home / "plans" / "p.md").exists()

    def test_nothing_ping_pongs_once_the_files_are_in_step(self, paired):
        laptop, desktop = paired
        (laptop.home / "memories" / "MEMORY.md").write_text("settled", encoding="utf-8")
        converge(laptop, desktop)

        quiet = desktop.tick()

        assert quiet.pushed == 0

    def test_the_service_stores_the_kind_it_was_given_and_nothing_else(self, paired):
        laptop, _desktop = paired
        (laptop.home / "memories" / "MEMORY.md").write_text("opaque", encoding="utf-8")
        laptop.drain()

        page = laptop.engine._session_client().changes(
            bearer="tok", device_id=laptop.device_id, since=0, limit=100
        )

        kinds = {document["kind"] for document in page["documents"]}
        assert "memory" in kinds
        # Round-tripped verbatim: the service has no opinion about what a
        # memory is, which is exactly what R8 asks of it.
        memory = next(d for d in page["documents"] if d["kind"] == "memory")
        assert memory["payload"] == {"path": "MEMORY.md", "text": "opaque"}


class TestIsolation:
    def test_another_persons_history_never_arrives(
        self, brain_settings, realm, tmp_path
    ):
        realm.add("tok", subject="one-person", display_name="One Person")
        realm.add("tok-other", subject="somebody-else", display_name="Somebody Else")

        with ThreadedBrain(brain_settings, realm) as running:
            mine = Device("mine", tmp_path, running)
            theirs = Device("theirs", tmp_path, running)
            theirs.engine._credentials = lambda: SyncCredentials(
                bearer="tok-other", device_id=theirs.device_id, device_name="theirs"
            )
            try:
                mine.db.create_session("private", "cli", model="m1")
                mine.db.append_message("private", "user", "something confidential")
                mine.drain()
                theirs.drain()

                assert theirs.db.get_session("private") is None
            finally:
                mine.close()
                theirs.close()
