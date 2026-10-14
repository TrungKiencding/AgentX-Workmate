"""v27: remove the empty ghosts deleted conversations left behind.

Before every delete was tombstoned, the auto-titler finishing after a delete
recreated the conversation: a bare ``'unknown'`` row with a title and the
titler's usage, but no message. Desktop reopened it as the last session and
showed an empty chat. The migration removes those rows and tombstones them;
any row holding content, or one a live writer may be filling, stays.
"""

import sqlite3
import time
from unittest.mock import patch

from hermes_state import SCHEMA_VERSION, SessionDB
from hermes_state_schema import SessionSchemaMixin

DAY_AGO = time.time() - 86400
GHOSTS = {"ghost", "untitled-ghost", "archived-ghost"}
KEPT = {
    "fresh-placeholder",
    "unknown-with-messages",
    "unknown-with-usage",
    "pinned-ghost",
    "gateway-placeholder",
    "unknown-parent",
    "branch",
    "empty-desktop",
}


def _insert(db, sid, *, source="unknown", started_at=DAY_AGO, **columns):
    row = {"id": sid, "source": source, "started_at": started_at, **columns}
    db._conn.execute(
        f"INSERT INTO sessions ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})",
        tuple(row.values()),
    )


def _seed_v26_store(path):
    """A v26 store holding ghosts, and lookalikes that must survive."""
    db = SessionDB(db_path=path)
    try:
        _insert(db, "ghost", title="Chào hỏi và đề nghị hỗ trợ")
        db._conn.execute(
            "INSERT INTO session_model_usage "
            "(session_id, model, task, api_call_count, input_tokens, output_tokens) "
            "VALUES ('ghost', 'title-model', 'title_generation', 1, 169, 12)"
        )
        _insert(db, "untitled-ghost")
        _insert(db, "archived-ghost", title="archived", archived=1)
        _insert(db, "fresh-placeholder", started_at=time.time())
        _insert(db, "unknown-with-messages")
        db.append_message("unknown-with-messages", "user", "a real conversation")
        _insert(db, "unknown-with-usage", api_call_count=1, input_tokens=10, output_tokens=2)
        _insert(db, "pinned-ghost", title="kept on purpose", pinned=1)
        _insert(db, "gateway-placeholder", session_key="agent:main:telegram:dm:1")
        _insert(db, "unknown-parent")
        _insert(db, "branch", source="desktop", parent_session_id="unknown-parent")
        _insert(db, "empty-desktop", source="desktop")
        db._conn.execute("UPDATE schema_version SET version = 26")
    finally:
        db.close()


def _session_ids(db):
    return {row[0] for row in db._conn.execute("SELECT id FROM sessions")}


def _schema_version(db):
    return db._conn.execute("SELECT version FROM schema_version").fetchone()[0]


def test_v27_removes_and_tombstones_the_ghosts(tmp_path):
    path = tmp_path / "state.db"
    _seed_v26_store(path)

    db = SessionDB(db_path=path)
    try:
        assert _session_ids(db) == KEPT
        assert all(db.is_deleted_session(sid) for sid in GHOSTS)
        assert not any(db.is_deleted_session(sid) for sid in KEPT)
        assert db._conn.execute(
            "SELECT COUNT(*) FROM session_model_usage WHERE session_id = 'ghost'"
        ).fetchone()[0] == 0
        assert _schema_version(db) == SCHEMA_VERSION == 27

        # And the auto-titler can't bring one back.
        db.record_auxiliary_usage("ghost", "title_generation", model="m", input_tokens=1)
        assert db.get_session("ghost") is None
    finally:
        db.close()


def test_v27_runs_once(tmp_path):
    path = tmp_path / "state.db"
    _seed_v26_store(path)
    SessionDB(db_path=path).close()

    db = SessionDB(db_path=path)
    try:
        _insert(db, "later-lookalike")
    finally:
        db.close()

    db = SessionDB(db_path=path)
    try:
        assert "later-lookalike" in _session_ids(db)
    finally:
        db.close()


def test_contention_defers_the_cleanup_and_holds_the_version(tmp_path):
    path = tmp_path / "state.db"
    _seed_v26_store(path)

    with patch.object(SessionSchemaMixin, "_prune_resurrected_sessions", return_value=False):
        db = SessionDB(db_path=path)
        try:
            assert GHOSTS <= _session_ids(db)
            assert _schema_version(db) == 26
        finally:
            db.close()

    db = SessionDB(db_path=path)
    try:
        assert _session_ids(db) == KEPT
        assert _schema_version(db) == SCHEMA_VERSION
    finally:
        db.close()


def test_the_cleanup_reports_a_held_write_lock_instead_of_raising(tmp_path):
    path = tmp_path / "state.db"
    db = SessionDB(db_path=path)
    holder = sqlite3.connect(str(path), isolation_level=None)
    try:
        _insert(db, "ghost")
        holder.execute("BEGIN IMMEDIATE")

        assert db._prune_resurrected_sessions(db._conn.cursor()) is False

        holder.execute("ROLLBACK")
        assert db.get_session("ghost") is not None
        assert db._prune_resurrected_sessions(db._conn.cursor()) is True
        assert db.get_session("ghost") is None
    finally:
        holder.close()
        db.close()
