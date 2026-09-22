"""Tombstones for gateway conversations the user deleted from Workmate.

A live gateway keeps its routing entry (session_key -> session_id) after the
user deletes the transcript, and several of its routine writers repair a
missing session row on sight: the gateway's own ``create_session``, the
lazy ``ensure_session`` / ``update_token_counts`` guards, and the per-turn
``record_gateway_session_peer`` self-heal (#82616). Without a tombstone the
next inbound platform message would bring the deleted conversation back.

Only rows that carry a ``session_key`` (the gateway host's copy) are
tombstoned; an ordinary session id stays reusable after deletion.
"""

import contextlib
import sqlite3

import pytest

from hermes_state import SessionDB

SESSION_KEY = "agent:main:telegram:dm:6308981865"


@pytest.fixture
def db(tmp_path):
    store = SessionDB(db_path=tmp_path / "state.db")
    yield store
    store.close()


def _deleted_gateway_session(db, session_id="tg-deleted"):
    db.create_session(
        session_id,
        "telegram",
        user_id="6308981865",
        session_key=SESSION_KEY,
        chat_id="6308981865",
        chat_type="dm",
    )
    db.append_message(session_id, "user", "delete me")
    assert db.delete_session(session_id)
    return session_id


def _recreate_with_create_session(db, session_id):
    db.create_session(
        session_id,
        "telegram",
        user_id="6308981865",
        session_key=SESSION_KEY,
        chat_id="6308981865",
        chat_type="dm",
    )


def _recreate_with_ensure_session(db, session_id):
    db.ensure_session(session_id, "telegram", model="gpt-test")


def _recreate_with_peer_refresh(db, session_id):
    db.record_gateway_session_peer(
        session_id,
        source="telegram",
        user_id="6308981865",
        session_key=SESSION_KEY,
        chat_id="6308981865",
        chat_type="dm",
    )


def _recreate_with_token_counts(db, session_id):
    # The row guard refuses to recreate the session, so the usage write that
    # follows has no parent row. Whether that surfaces as an error is the
    # caller's concern; the invariant here is only that nothing comes back.
    with contextlib.suppress(sqlite3.IntegrityError):
        db.update_token_counts(session_id, input_tokens=5, model="gpt-test")


@pytest.mark.parametrize(
    "recreate",
    [
        _recreate_with_create_session,
        _recreate_with_ensure_session,
        _recreate_with_peer_refresh,
        _recreate_with_token_counts,
    ],
    ids=[
        "create_session",
        "ensure_session",
        "record_gateway_session_peer",
        "update_token_counts",
    ],
)
def test_gateway_writers_do_not_recreate_a_deleted_gateway_session(db, recreate):
    session_id = _deleted_gateway_session(db)
    assert db.get_session(session_id) is None
    assert db.is_deleted_gateway_session(session_id)

    recreate(db, session_id)

    assert db.get_session(session_id) is None
    assert db.get_messages(session_id) == []
    assert db.is_deleted_gateway_session(session_id)


def test_bulk_delete_tombstones_only_gateway_rows(db):
    db.create_session("tg-bulk", "telegram", session_key=SESSION_KEY)
    db.create_session("cli-bulk", "cli")

    assert db.delete_sessions(["tg-bulk", "cli-bulk"]) == 2

    assert db.is_deleted_gateway_session("tg-bulk")
    assert not db.is_deleted_gateway_session("cli-bulk")
    _recreate_with_peer_refresh(db, "tg-bulk")
    assert db.get_session("tg-bulk") is None


def test_session_without_session_key_is_not_tombstoned(db):
    db.create_session("cli-session", "cli")
    db.append_message("cli-session", "user", "hello")
    assert db.delete_session("cli-session")

    assert not db.is_deleted_gateway_session("cli-session")

    db.create_session("cli-session", "cli")
    assert db.get_session("cli-session") is not None


def test_tombstone_does_not_block_a_fresh_gateway_session(db):
    """The gateway answers the next inbound message with a new session id;
    that one must be created and self-healed normally."""
    _deleted_gateway_session(db)

    _recreate_with_peer_refresh(db, "tg-replacement")

    replacement = db.get_session("tg-replacement")
    assert replacement is not None
    assert replacement["session_key"] == SESSION_KEY
    assert not db.is_deleted_gateway_session("tg-replacement")


def test_is_deleted_gateway_session_for_unknown_and_empty_ids(db):
    assert not db.is_deleted_gateway_session("never-existed")
    assert not db.is_deleted_gateway_session("")
    assert not db.is_deleted_gateway_session(None)


def test_is_deleted_gateway_session_on_a_store_without_the_table(tmp_path):
    """A read-only open of an older store skips schema reconciliation, so
    the table may be missing; that must read as "not deleted"."""
    path = tmp_path / "state.db"
    SessionDB(db_path=path).close()
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("DROP TABLE deleted_gateway_sessions")
        conn.commit()
    finally:
        conn.close()

    reader = SessionDB(db_path=path, read_only=True)
    try:
        assert not reader.is_deleted_gateway_session("tg-deleted")
    finally:
        reader.close()
