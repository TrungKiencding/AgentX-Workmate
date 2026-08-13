"""Schema v26: the columns, tables and triggers synchronisation needs.

Phase 0 of the second-brain plan ships dark — nothing user-visible changes
and no network call is added — so the whole risk is in the migration and in
the trigger set. These tests pin both: that a pre-v26 database gains the new
shape without losing a row, and that the outbox triggers fire exactly where
intended and nowhere else.

"Nowhere else" is the load-bearing half. ``sessions`` is rewritten on nearly
every turn for token and cost counters, and ``update_token_counts`` writes
``model`` in the same statement as those counters — so a trigger that watched
only the column list, without the value guard, would enqueue a change record
per API call for the rest of the product's life.
"""

import re
import sqlite3

import pytest

from hermes_state import SessionDB
from hermes_state_common import SCHEMA_VERSION, _SYNC_TRIGGERS


UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


# A genuinely pre-v26 shape: no ``messages.uuid``, no ``sessions.updated_at``,
# no sync tables, no sync triggers. Deliberately narrower than the real v25
# DDL — every other column arrives through ``_reconcile_columns``, and an
# older-than-v25 database is the harder case, not an unrealistic one.
LEGACY_SQL = """
CREATE TABLE schema_version (version INTEGER NOT NULL);

CREATE TABLE system_prompts (
    hash TEXT PRIMARY KEY,
    prompt TEXT NOT NULL
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    model TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    message_count INTEGER DEFAULT 0,
    title TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT,
    -- Present since v11 and referenced by an index declared inline in
    -- SCHEMA_SQL, so a legacy fixture cannot omit it.
    tool_name TEXT,
    tool_calls TEXT,
    timestamp REAL NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
);
"""


def _make_legacy_db(tmp_path, sessions=2, messages_per_session=3):
    """Write a pre-v26 state.db with real rows and return its path."""
    db_path = tmp_path / "state.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(LEGACY_SQL)
        conn.execute("INSERT INTO schema_version (version) VALUES (25)")
        for s in range(sessions):
            conn.execute(
                "INSERT INTO sessions (id, source, started_at, title) "
                "VALUES (?, 'cli', ?, ?)",
                (f"legacy-{s}", 1000.0 + s, f"legacy title {s}"),
            )
            conn.executemany(
                "INSERT INTO messages (session_id, role, content, timestamp) "
                "VALUES (?, 'user', ?, ?)",
                [
                    (f"legacy-{s}", f"message {s}.{m}", 1000.0 + s + m / 10)
                    for m in range(messages_per_session)
                ],
            )
        conn.commit()
    finally:
        conn.close()
    return db_path


def _uuid_rows(db_path):
    """Every (id, uuid) pair, read without going through SessionDB."""
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute("SELECT id, uuid FROM messages ORDER BY id").fetchall()
    finally:
        conn.close()


def _backfill_markers(db_path):
    """The (progress, high_water) pair the resumable pass publishes."""
    conn = sqlite3.connect(db_path)
    try:
        stored = dict(
            conn.execute(
                "SELECT key, value FROM state_meta "
                "WHERE key LIKE 'sync_uuid_backfill%'"
            ).fetchall()
        )
    finally:
        conn.close()
    return (
        int(stored.get("sync_uuid_backfill_progress", -1)),
        int(stored.get("sync_uuid_backfill_high_water", -1)),
    )


def _open_until_backfilled(db_path, max_opens=64):
    """Reopen until the backfill has no work left; return the open count.

    Each open runs exactly the production path, bounded exactly as it is in
    production — "finished" is reached by launching again, which is what a
    user's machine does.
    """
    for opened in range(1, max_opens + 1):
        SessionDB(db_path).close()
        progress, high_water = _backfill_markers(db_path)
        if progress >= high_water:
            return opened
    raise AssertionError(f"backfill did not finish within {max_opens} opens")


@pytest.fixture
def db(tmp_path):
    database = SessionDB(tmp_path / "state.db")
    try:
        yield database
    finally:
        database.close()


def _outbox(database):
    return [
        dict(row)
        for row in database._conn.execute(
            "SELECT id, kind, doc_id, op, queued_at FROM sync_outbox ORDER BY id"
        )
    ]


def _drain(database):
    """Clear the outbox so the next assertion sees only what it caused."""
    database._conn.execute("DELETE FROM sync_outbox")
    database._conn.commit()


class TestMigration:
    def test_v25_database_gains_the_v26_shape_without_losing_rows(self, tmp_path):
        db_path = _make_legacy_db(tmp_path)
        database = SessionDB(db_path)
        try:
            version = database._conn.execute(
                "SELECT version FROM schema_version"
            ).fetchone()[0]
            assert version == SCHEMA_VERSION == 26

            session_cols = {
                row["name"]
                for row in database._conn.execute('PRAGMA table_info("sessions")')
            }
            message_cols = {
                row["name"]
                for row in database._conn.execute('PRAGMA table_info("messages")')
            }
            assert "updated_at" in session_cols
            assert "uuid" in message_cols

            tables = {
                row["name"]
                for row in database._conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            assert {"sync_outbox", "sync_state"} <= tables

            triggers = {
                row["name"]
                for row in database._conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'trigger'"
                )
            }
            assert set(_SYNC_TRIGGERS) <= triggers

            # Nothing was lost, and nothing was renumbered.
            assert database._conn.execute(
                "SELECT COUNT(*) FROM sessions"
            ).fetchone()[0] == 2
            assert database._conn.execute(
                "SELECT COUNT(*) FROM messages"
            ).fetchone()[0] == 6
            assert [
                row["id"] for row in database._conn.execute(
                    "SELECT id FROM messages ORDER BY id"
                )
            ] == [1, 2, 3, 4, 5, 6]
            assert database.get_session("legacy-0")["title"] == "legacy title 0"

            # History without a portable identity can never be synchronised,
            # so the backfill is part of the migration, not a follow-up.
            uuids = [
                row["uuid"] for row in database._conn.execute(
                    "SELECT uuid FROM messages ORDER BY id"
                )
            ]
            assert all(u and UUID4_RE.match(u) for u in uuids)
            assert len(set(uuids)) == 6
        finally:
            database.close()

    def test_migrating_does_not_enqueue_the_existing_history(self, tmp_path):
        """Opening at v26 must not mistake a whole local history for a change.

        The outbox is a delta log. Seeding it with every pre-existing row
        would make the first sync push the entire database through the
        change feed one document at a time.
        """
        db_path = _make_legacy_db(tmp_path, sessions=3, messages_per_session=4)
        database = SessionDB(db_path)
        try:
            assert _outbox(database) == []
        finally:
            database.close()

    def test_reopening_a_v26_database_is_idempotent(self, tmp_path):
        db_path = tmp_path / "state.db"
        first = SessionDB(db_path)
        first.create_session("s1", "cli")
        first.append_message("s1", "user", "hi")
        uuids_before = [
            row["uuid"] for row in first._conn.execute(
                "SELECT uuid FROM messages ORDER BY id"
            )
        ]
        first.close()

        second = SessionDB(db_path)
        try:
            _drain(second)
            # Reopening must not re-stamp identities or re-enqueue anything.
            assert [
                row["uuid"] for row in second._conn.execute(
                    "SELECT uuid FROM messages ORDER BY id"
                )
            ] == uuids_before
            assert _outbox(second) == []
        finally:
            second.close()


class TestUuidBackfill:
    def test_a_large_history_ends_fully_and_distinctly_identified(self, tmp_path):
        db_path = _make_legacy_db(tmp_path, sessions=5, messages_per_session=1000)

        _open_until_backfilled(db_path)

        rows = _uuid_rows(db_path)
        assert len(rows) == 5000
        uuids = [uuid for _, uuid in rows]
        assert all(uuid and UUID4_RE.match(uuid) for uuid in uuids)
        assert len(set(uuids)) == 5000

    def test_message_ids_are_untouched(self, tmp_path):
        """The backfill adds an identity; it must not renumber the transcript.

        ``messages.id`` is the insertion order every transcript loader reads
        by, and it is referenced by the FTS rowids.
        """
        db_path = _make_legacy_db(tmp_path, sessions=2, messages_per_session=50)
        conn = sqlite3.connect(db_path)
        before = [row[0] for row in conn.execute("SELECT id FROM messages ORDER BY id")]
        conn.close()

        _open_until_backfilled(db_path)

        assert [row_id for row_id, _ in _uuid_rows(db_path)] == before

    def test_interrupting_resumes_instead_of_restarting(self, tmp_path, monkeypatch):
        """Progress is durable, so a launch that stops early loses nothing.

        A pass that restarted would never finish on the database that needs
        it most: the one big enough to exhaust the budget every time.
        """
        db_path = _make_legacy_db(tmp_path, sessions=1, messages_per_session=25)
        # One batch per open: a zero budget breaks the loop after the first.
        monkeypatch.setattr(SessionDB, "_UUID_BACKFILL_BATCH_ROWS", 10)
        monkeypatch.setattr(SessionDB, "_UUID_BACKFILL_BUDGET_S", 0.0)

        SessionDB(db_path).close()
        first_pass = _uuid_rows(db_path)
        assert _backfill_markers(db_path) == (10, 25)
        assert all(uuid for _, uuid in first_pass[:10])
        assert all(uuid is None for _, uuid in first_pass[10:])

        SessionDB(db_path).close()
        second_pass = _uuid_rows(db_path)
        assert _backfill_markers(db_path) == (20, 25)
        # The already-covered rows kept the identity they were given — proof
        # the pass resumed at 10 rather than starting over.
        assert second_pass[:10] == first_pass[:10]
        assert all(uuid for _, uuid in second_pass[10:20])
        assert all(uuid is None for _, uuid in second_pass[20:])

        opens = _open_until_backfilled(db_path)
        assert opens == 1  # 20 -> 25 finishes the range
        assert all(uuid for _, uuid in _uuid_rows(db_path))

    def test_a_finished_database_writes_nothing_on_the_next_open(self, tmp_path):
        db_path = _make_legacy_db(tmp_path, sessions=1, messages_per_session=40)
        _open_until_backfilled(db_path)

        database = SessionDB(db_path)
        try:
            before = database._conn.total_changes
            assert database._backfill_message_uuids(database._conn.cursor()) is False
            assert database._conn.total_changes == before
        finally:
            database.close()

    def test_rows_deleted_mid_pass_do_not_stall_it(self, tmp_path, monkeypatch):
        """Batches claim an id RANGE, not a row count.

        Pruned history leaves gaps in ``messages.id``; a batch sized by rows
        would keep re-reading an empty window and never advance.
        """
        db_path = _make_legacy_db(tmp_path, sessions=1, messages_per_session=60)
        conn = sqlite3.connect(db_path)
        conn.execute("DELETE FROM messages WHERE id BETWEEN 11 AND 50")
        conn.commit()
        conn.close()

        monkeypatch.setattr(SessionDB, "_UUID_BACKFILL_BATCH_ROWS", 5)
        monkeypatch.setattr(SessionDB, "_UUID_BACKFILL_BUDGET_S", 0.0)

        opens = _open_until_backfilled(db_path)

        rows = _uuid_rows(db_path)
        assert len(rows) == 20
        assert all(uuid for _, uuid in rows)
        # 60 ids in batches of 5, one batch per open — the gap costs opens,
        # never progress.
        assert opens == 12

    def test_new_rows_are_stamped_by_the_trigger_not_the_backfill(self, tmp_path,
                                                                  monkeypatch):
        """The high water bounds the pass to history that existed at v26.

        Anything written from here on gets its uuid at INSERT, so chasing
        MAX(id) would only rescan rows that are already done.
        """
        db_path = _make_legacy_db(tmp_path, sessions=1, messages_per_session=20)
        monkeypatch.setattr(SessionDB, "_UUID_BACKFILL_BATCH_ROWS", 5)
        monkeypatch.setattr(SessionDB, "_UUID_BACKFILL_BUDGET_S", 0.0)

        database = SessionDB(db_path)
        try:
            assert _backfill_markers(db_path) == (5, 20)
            database.append_message("legacy-0", "user", "written after the upgrade")
            fresh = database._conn.execute(
                "SELECT uuid FROM messages WHERE id = 21"
            ).fetchone()["uuid"]
            assert UUID4_RE.match(fresh)
        finally:
            database.close()

        _open_until_backfilled(db_path)
        assert _backfill_markers(db_path)[1] == 20
        assert all(uuid for _, uuid in _uuid_rows(db_path))

    def test_a_corrupt_progress_marker_reseeds_instead_of_failing(self, tmp_path):
        db_path = _make_legacy_db(tmp_path, sessions=1, messages_per_session=10)
        _open_until_backfilled(db_path)

        conn = sqlite3.connect(db_path)
        conn.execute(
            "UPDATE state_meta SET value = 'not a number' "
            "WHERE key = 'sync_uuid_backfill_progress'"
        )
        conn.commit()
        conn.close()

        SessionDB(db_path).close()

        assert _backfill_markers(db_path) == (10, 10)
        assert all(uuid for _, uuid in _uuid_rows(db_path))


class TestMessageTriggers:
    def test_insert_stamps_a_uuid_and_enqueues_exactly_that_id(self, db):
        db.create_session("s1", "cli")
        _drain(db)

        db.append_message("s1", "user", "hello")

        uuid = db._conn.execute("SELECT uuid FROM messages").fetchone()["uuid"]
        assert UUID4_RE.match(uuid), uuid

        rows = _outbox(db)
        assert len(rows) == 1
        assert rows[0]["kind"] == "message"
        assert rows[0]["doc_id"] == uuid
        assert rows[0]["op"] == "upsert"
        assert rows[0]["queued_at"] > 0

    def test_messages_in_one_transaction_get_distinct_uuids(self, db):
        db.create_session("s1", "cli")
        _drain(db)

        db.append_messages_batch(
            "s1",
            [
                {"role": "user", "content": "one"},
                {"role": "assistant", "content": "two"},
                {"role": "user", "content": "three"},
            ],
        )

        uuids = [
            row["uuid"] for row in db._conn.execute(
                "SELECT uuid FROM messages ORDER BY id"
            )
        ]
        assert len(uuids) == 3
        assert len(set(uuids)) == 3
        assert all(UUID4_RE.match(u) for u in uuids)
        assert [row["doc_id"] for row in _outbox(db)] == uuids

    def test_a_writer_supplied_uuid_is_kept(self, db):
        """The fill is a safety net, not an override.

        Session recovery copies message rows between databases; if the
        trigger re-stamped them the recovered device would look like it had
        an entirely new history.
        """
        db.create_session("s1", "cli")
        _drain(db)

        def _do(conn):
            conn.execute(
                "INSERT INTO messages (session_id, role, content, timestamp, uuid) "
                "VALUES ('s1', 'user', 'carried over', 1000.0, ?)",
                ("11111111-2222-4333-8444-555555555555",),
            )

        db._execute_write(_do)

        assert db._conn.execute("SELECT uuid FROM messages").fetchone()["uuid"] == (
            "11111111-2222-4333-8444-555555555555"
        )
        assert [row["doc_id"] for row in _outbox(db)] == [
            "11111111-2222-4333-8444-555555555555"
        ]

    def test_uuid_is_unique_across_messages(self, db):
        db.create_session("s1", "cli")
        db.append_message("s1", "user", "one")

        def _do(conn):
            conn.execute(
                "INSERT INTO messages (session_id, role, content, timestamp, uuid) "
                "SELECT 's1', 'user', 'clone', 1000.0, uuid FROM messages LIMIT 1"
            )

        with pytest.raises(sqlite3.IntegrityError):
            db._execute_write(_do)

    def test_deleting_a_message_does_not_flood_the_outbox(self, db):
        """A session delete cascades through its messages first.

        A per-message tombstone trigger would turn one session delete into
        one outbox row per message; the session tombstone already covers the
        cascade. See SYNC_TRIGGER_SQL for why this is a Phase 3 decision.
        """
        db.create_session("s1", "cli")
        db.append_messages_batch(
            "s1", [{"role": "user", "content": f"m{i}"} for i in range(5)]
        )
        _drain(db)

        db.delete_session("s1")

        rows = _outbox(db)
        assert [(r["kind"], r["op"]) for r in rows] == [("session", "delete")]


class TestSessionTriggers:
    def test_creating_a_session_enqueues_an_upsert(self, db):
        db.create_session("s1", "cli")

        rows = _outbox(db)
        assert len(rows) == 1
        assert (rows[0]["kind"], rows[0]["doc_id"], rows[0]["op"]) == (
            "session", "s1", "upsert",
        )

    def test_title_change_enqueues_once_and_advances_updated_at(self, db):
        db.create_session("s1", "cli")
        _drain(db)
        before = db._conn.execute(
            "SELECT updated_at, started_at FROM sessions WHERE id = 's1'"
        ).fetchone()
        assert before["updated_at"] is None  # never edited since creation

        db.set_session_title("s1", "renamed")

        rows = _outbox(db)
        assert len(rows) == 1
        assert (rows[0]["kind"], rows[0]["doc_id"], rows[0]["op"]) == (
            "session", "s1", "upsert",
        )
        after = db._conn.execute(
            "SELECT updated_at, started_at FROM sessions WHERE id = 's1'"
        ).fetchone()
        assert after["updated_at"] is not None
        assert after["updated_at"] > after["started_at"]

    def test_the_stamp_only_ever_moves_forward(self, db):
        """A rename in the same millisecond as the create must still win.

        SQLite's ``'now'`` truncates to the millisecond while ``started_at``
        comes from ``time.time()`` at microsecond resolution, so a plain
        "set it to now" stamps EARLIER than the session started. Last-writer-
        wins compares against ``COALESCE(updated_at, started_at)``, so the
        other device would read that rename as stale and drop it.
        """
        db.create_session("s1", "cli")
        started_at = db._conn.execute(
            "SELECT started_at FROM sessions WHERE id = 's1'"
        ).fetchone()["started_at"]

        stamps = []
        for index in range(5):
            db.set_session_title("s1", f"rename {index}")
            stamps.append(
                db._conn.execute(
                    "SELECT updated_at FROM sessions WHERE id = 's1'"
                ).fetchone()["updated_at"]
            )

        assert stamps[0] > started_at
        assert stamps == sorted(stamps)
        assert len(set(stamps)) == len(stamps)

    def test_token_counter_writes_enqueue_nothing(self, db):
        """The regression this trigger set exists to avoid.

        ``update_token_counts`` writes ``model`` in the same statement as the
        counters, so ``AFTER UPDATE OF`` alone still fires on every API call.
        """
        db.create_session("s1", "cli")
        db.update_token_counts("s1", input_tokens=1, model="m1")
        db.flush_token_counts()
        _drain(db)

        for _ in range(10):
            db.update_token_counts(
                "s1",
                input_tokens=100,
                output_tokens=50,
                model="m1",
                estimated_cost_usd=0.01,
                api_call_count=1,
            )
        db.flush_token_counts()

        assert _outbox(db) == []

    def test_activity_heartbeat_enqueues_nothing(self, db):
        db.create_session("s1", "cli")
        _drain(db)

        db._conn.execute(
            "UPDATE sessions SET last_activity_at = 1234.5, "
            "last_activity_description = 'working' WHERE id = 's1'"
        )
        db._conn.commit()

        assert _outbox(db) == []

    def test_rewriting_a_watched_column_with_the_same_value_enqueues_nothing(self, db):
        db.create_session("s1", "cli")
        db.set_session_pinned("s1", True)
        _drain(db)

        db.set_session_pinned("s1", True)

        assert _outbox(db) == []

    def test_archiving_and_pinning_each_enqueue_once(self, db):
        db.create_session("s1", "cli")
        _drain(db)

        db.set_session_archived("s1", True)
        db.set_session_pinned("s1", True)

        assert [(r["kind"], r["op"]) for r in _outbox(db)] == [
            ("session", "upsert"),
            ("session", "upsert"),
        ]

    def test_deleting_a_session_enqueues_a_tombstone(self, db):
        db.create_session("s1", "cli")
        _drain(db)

        db.delete_session("s1")

        rows = _outbox(db)
        assert len(rows) == 1
        assert (rows[0]["kind"], rows[0]["doc_id"], rows[0]["op"]) == (
            "session", "s1", "delete",
        )

    def test_orphaning_a_child_enqueues_the_child(self, db):
        """delete_session detaches branch children rather than deleting them.

        That detach is a real change another device has to see, or the child
        keeps pointing at a parent that no longer exists there.
        """
        db.create_session("parent", "cli")
        db.create_session("child", "cli", parent_session_id="parent")
        db.append_message("child", "user", "keep me")
        db._conn.execute(
            "UPDATE sessions SET model_config = json_object('_branched_from', 'parent') "
            "WHERE id = 'child'"
        )
        db._conn.commit()
        _drain(db)

        db.delete_session("parent")

        enqueued = {(r["doc_id"], r["op"]) for r in _outbox(db)}
        assert ("parent", "delete") in enqueued
        assert ("child", "upsert") in enqueued


class TestTriggerReconciliation:
    def test_a_changed_ddl_replaces_the_live_triggers(self, tmp_path):
        """CREATE TRIGGER IF NOT EXISTS cannot rewrite an existing trigger.

        Without the fingerprint check, editing SYNC_TRIGGER_SQL would leave
        every already-opened database running the old definition forever —
        the trap ``_migrate_broad_fts_update_triggers`` had to be written to
        clean up after, one schema version too late.
        """
        db_path = tmp_path / "state.db"
        database = SessionDB(db_path)
        database.close()

        # Regress one trigger to a stale definition, exactly as a shipped
        # older build would have left it.
        conn = sqlite3.connect(db_path)
        conn.execute("DROP TRIGGER sync_sessions_update")
        conn.execute(
            "CREATE TRIGGER sync_sessions_update AFTER UPDATE ON sessions "
            "BEGIN INSERT INTO sync_outbox (kind, doc_id, op, queued_at) "
            "VALUES ('stale', new.id, 'upsert', 0); END"
        )
        conn.execute(
            "UPDATE state_meta SET value = 'stale-digest' "
            "WHERE key = 'sync_trigger_fingerprint'"
        )
        conn.commit()
        conn.close()

        database = SessionDB(db_path)
        try:
            sql = database._conn.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'trigger' "
                "AND name = 'sync_sessions_update'"
            ).fetchone()["sql"]
            assert "AFTER UPDATE OF" in sql
            assert "'stale'" not in sql

            database.create_session("s1", "cli")
            _drain(database)
            database.set_session_title("s1", "renamed")
            assert [r["kind"] for r in _outbox(database)] == ["session"]
        finally:
            database.close()

    def test_an_unchanged_ddl_does_not_rewrite_anything(self, tmp_path):
        db_path = tmp_path / "state.db"
        database = SessionDB(db_path)
        fingerprint = database.get_meta("sync_trigger_fingerprint")
        database.close()
        assert fingerprint

        database = SessionDB(db_path)
        try:
            cursor = database._conn.cursor()
            assert database._ensure_sync_triggers(cursor) is False
            assert database.get_meta("sync_trigger_fingerprint") == fingerprint
        finally:
            database.close()

    def test_missing_triggers_are_restored_on_open(self, tmp_path):
        db_path = tmp_path / "state.db"
        database = SessionDB(db_path)
        database.close()

        conn = sqlite3.connect(db_path)
        for name in _SYNC_TRIGGERS:
            conn.execute(f"DROP TRIGGER {name}")
        conn.commit()
        conn.close()

        database = SessionDB(db_path)
        try:
            live = {
                row["name"]
                for row in database._conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'trigger'"
                )
            }
            assert set(_SYNC_TRIGGERS) <= live
        finally:
            database.close()
