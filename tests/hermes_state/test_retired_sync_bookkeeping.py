"""Conversation sync is retired: its bookkeeping leaves state.db, nothing else does.

Until 1.1.1 every store carried a change queue (``sync_outbox``), a feed cursor
(``sync_state``), four triggers that queued one row per session or message
write, and three ``state_meta`` markers. None of it is user data, and with sync
off nothing drained the queue. Every open now drops it — sessions, messages and
every column they hold (``sessions.updated_at`` and ``messages.uuid``
included) stay exactly as they were.
"""

import sqlite3
from unittest.mock import patch

from hermes_state import SCHEMA_VERSION, SessionDB
from hermes_state_schema import SessionSchemaMixin
from tests.hermes_state import retired_sync_schema


def _rows(path, table):
    conn = sqlite3.connect(str(path))
    try:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")]
    finally:
        conn.close()


def _present(path):
    conn = sqlite3.connect(str(path))
    try:
        return retired_sync_schema.present(conn)
    finally:
        conn.close()


def _seed_1_1_0_store(path):
    """A store a 1.1.0 runtime wrote, through its sync triggers."""
    SessionDB(db_path=path).close()
    conn = sqlite3.connect(str(path))
    try:
        retired_sync_schema.install(conn)
    finally:
        conn.close()

    # Written by this code with the drop held off, so every write goes through
    # the triggers exactly as it did on 1.1.0.
    with patch.object(SessionSchemaMixin, "_drop_retired_sync_bookkeeping", return_value=True):
        db = SessionDB(db_path=path)
        try:
            db.create_session("kept", source="desktop", model="m")
            db.append_message("kept", "user", "xin chào, tìm giúp tôi báo cáo quý")
            db.append_message("kept", "assistant", "Đây là báo cáo quý của bạn.")
            db.set_session_title("kept", "Báo cáo quý")
            db.create_session("other", source="cli", model="m")
            db.append_message("other", "user", "second conversation")
            db.create_session("deleted", source="desktop")
            db.delete_session("deleted")
        finally:
            db.close()


def test_the_seed_looks_like_a_1_1_0_store(tmp_path):
    path = tmp_path / "state.db"
    _seed_1_1_0_store(path)

    assert _present(path) == set(
        retired_sync_schema.TRIGGERS + retired_sync_schema.TABLES + retired_sync_schema.META_KEYS
    )
    assert len(_rows(path, "sync_outbox")) > 0
    assert all(row["uuid"] for row in _rows(path, "messages"))
    assert next(row for row in _rows(path, "sessions") if row["id"] == "kept")["updated_at"]


def test_upgrading_drops_the_bookkeeping_and_keeps_every_session_and_message(tmp_path):
    path = tmp_path / "state.db"
    _seed_1_1_0_store(path)
    sessions = _rows(path, "sessions")
    messages = _rows(path, "messages")
    tombstones = _rows(path, "deleted_gateway_sessions")

    db = SessionDB(db_path=path)
    try:
        found = {row["session_id"] for row in db.search_messages("báo cáo")}
        version = db._conn.execute("SELECT version FROM schema_version").fetchone()[0]
    finally:
        db.close()

    assert _present(path) == set()
    assert _rows(path, "sessions") == sessions
    assert _rows(path, "messages") == messages
    assert _rows(path, "deleted_gateway_sessions") == tombstones
    assert found == {"kept"}
    assert version == SCHEMA_VERSION
    # The queue's AUTOINCREMENT counter went with it.
    assert [row["name"] for row in _rows(path, "sqlite_sequence")] == ["messages"]


def test_writes_after_the_upgrade_queue_nothing(tmp_path):
    path = tmp_path / "state.db"
    _seed_1_1_0_store(path)

    db = SessionDB(db_path=path)
    try:
        db.append_message("kept", "user", "one more")
        db.set_session_title("other", "Renamed")
    finally:
        db.close()

    assert _present(path) == set()
    newest = _rows(path, "messages")[-1]
    assert newest["content"] == "one more" and newest["uuid"] is None


def test_an_older_runtime_putting_it_back_is_undone_on_the_next_open(tmp_path):
    path = tmp_path / "state.db"
    _seed_1_1_0_store(path)
    SessionDB(db_path=path).close()

    # A 1.1.0 CLI sharing this state.db opens it and writes a message.
    conn = sqlite3.connect(str(path))
    try:
        retired_sync_schema.install(conn)
        conn.execute(
            "INSERT INTO messages (session_id, role, content, timestamp) "
            "VALUES ('other', 'assistant', 'from the older runtime', 1760000000.0)"
        )
        conn.commit()
    finally:
        conn.close()
    messages = _rows(path, "messages")

    SessionDB(db_path=path).close()

    assert _present(path) == set()
    assert _rows(path, "messages") == messages


def test_a_store_without_it_is_not_touched(tmp_path):
    path = tmp_path / "state.db"
    SessionDB(db_path=path).close()

    def schema_cookie():
        conn = sqlite3.connect(str(path))
        try:
            return conn.execute("PRAGMA schema_version").fetchone()[0]
        finally:
            conn.close()

    before = schema_cookie()
    SessionDB(db_path=path).close()

    assert schema_cookie() == before


def test_a_held_write_lock_defers_the_drop_instead_of_failing_the_open(tmp_path):
    path = tmp_path / "state.db"
    db = SessionDB(db_path=path)
    conn = sqlite3.connect(str(path))
    retired_sync_schema.install(conn)
    conn.close()
    holder = sqlite3.connect(str(path), isolation_level=None)
    try:
        holder.execute("BEGIN IMMEDIATE")

        assert db._drop_retired_sync_bookkeeping(db._conn.cursor()) is False

        holder.execute("ROLLBACK")

        assert db._drop_retired_sync_bookkeeping(db._conn.cursor()) is True
    finally:
        holder.close()
        db.close()

    assert _present(path) == set()
