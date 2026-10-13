"""Tombstones for sessions the user deleted.

Writers can outlive a delete. The auto-titler finishes seconds after the turn
and records its usage before it sets the title; a turn can still be running;
a live gateway keeps its routing entry (session_key -> session_id). Several of
those writers repair a missing session row on sight: the gateway's own
``create_session``, the lazy ``ensure_session`` / ``update_token_counts`` /
``record_auxiliary_usage`` guards, and the per-turn
``record_gateway_session_peer`` self-heal (#82616). Without a tombstone they
recreated the deleted conversation — a desktop chat came back as an empty row
with a title, which the app then reopened as the last session.
"""

import sqlite3
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from agent.auxiliary_client import _validate_llm_response
from agent.title_generator import auto_title_session
from hermes_state import SessionDB

SESSION_KEY = "agent:main:telegram:dm:6308981865"
TITLE = "Chào hỏi và đề nghị hỗ trợ"


@pytest.fixture
def db(tmp_path):
    store = SessionDB(db_path=tmp_path / "state.db")
    yield store
    store.close()


def _usage_rows(db, session_id):
    return db._conn.execute(
        "SELECT COUNT(*) FROM session_model_usage WHERE session_id = ?", (session_id,)
    ).fetchone()[0]


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


def _deleted_desktop_session(db, session_id="desktop-deleted"):
    db.create_session(session_id, "desktop", model="gpt-test")
    db.append_message(session_id, "user", "xin chào")
    db.append_message(session_id, "assistant", "Chào bạn!")
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
    # A turn that outlived the delete accounts its last API call.
    db.update_token_counts(
        session_id,
        input_tokens=5,
        output_tokens=3,
        model="gpt-test",
        billing_provider="custom",
        api_call_count=1,
    )


def _recreate_with_aux_usage(db, session_id):
    # The auto-titler's call, accounted before the title is written.
    db.record_auxiliary_usage(
        session_id, "title_generation", model="gpt-test", input_tokens=169, output_tokens=12
    )


def _title_response(text):
    return SimpleNamespace(
        model="title-model",
        choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
        usage=SimpleNamespace(prompt_tokens=169, completion_tokens=12, total_tokens=181),
    )


def _run_auto_titler(db, session_id, titles):
    def fake_call_llm(**kwargs):
        # The real auxiliary client runs every response through this
        # chokepoint, which records the call's usage on the session.
        return _validate_llm_response(_title_response(TITLE), kwargs["task"])

    with patch("agent.title_generator.call_llm", side_effect=fake_call_llm):
        auto_title_session(db, session_id, "xin chào", "Chào bạn!", title_callback=titles.append)


@pytest.mark.parametrize(
    "deleted",
    [_deleted_gateway_session, _deleted_desktop_session],
    ids=["gateway", "desktop"],
)
@pytest.mark.parametrize(
    "recreate",
    [
        _recreate_with_create_session,
        _recreate_with_ensure_session,
        _recreate_with_peer_refresh,
        _recreate_with_token_counts,
        _recreate_with_aux_usage,
    ],
    ids=[
        "create_session",
        "ensure_session",
        "record_gateway_session_peer",
        "update_token_counts",
        "record_auxiliary_usage",
    ],
)
def test_late_writers_do_not_recreate_a_deleted_session(db, deleted, recreate):
    session_id = deleted(db)
    assert db.get_session(session_id) is None
    assert db.is_deleted_session(session_id)

    recreate(db, session_id)

    assert db.get_session(session_id) is None
    assert db.get_messages(session_id) == []
    assert _usage_rows(db, session_id) == 0
    assert db.is_deleted_session(session_id)


def test_the_auto_titler_finishing_after_a_delete_does_not_bring_the_chat_back(db):
    """The reported bug: delete a chat right after its first reply."""
    session_id = _deleted_desktop_session(db, "20261013_163916_71cdb6")
    titles = []

    _run_auto_titler(db, session_id, titles)

    assert db.get_session(session_id) is None
    assert _usage_rows(db, session_id) == 0
    assert titles == []


def test_the_auto_titler_still_titles_and_bills_a_live_chat(db):
    db.create_session("live", "desktop", model="gpt-test")
    db.append_message("live", "user", "xin chào")
    db.append_message("live", "assistant", "Chào bạn!")
    titles = []

    _run_auto_titler(db, "live", titles)

    assert db.get_session_title("live") == TITLE
    assert titles == [TITLE]
    assert _usage_rows(db, "live") == 1


def test_delete_tombstones_the_delegate_children_it_cascades(db):
    db.create_session("parent", "desktop")
    db.create_session(
        "delegate", "desktop", parent_session_id="parent", model_config={"_delegate_from": "parent"}
    )

    assert db.delete_session("parent")

    assert db.is_deleted_session("parent")
    assert db.is_deleted_session("delegate")
    _recreate_with_aux_usage(db, "delegate")
    assert db.get_session("delegate") is None


def test_bulk_delete_tombstones_every_row(db):
    db.create_session("tg-bulk", "telegram", session_key=SESSION_KEY)
    db.create_session("desktop-bulk", "desktop")

    assert db.delete_sessions(["tg-bulk", "desktop-bulk"]) == 2

    assert db.is_deleted_session("tg-bulk")
    assert db.is_deleted_session("desktop-bulk")
    _recreate_with_peer_refresh(db, "tg-bulk")
    _recreate_with_aux_usage(db, "desktop-bulk")
    assert db.get_session("tg-bulk") is None
    assert db.get_session("desktop-bulk") is None


def test_a_branch_child_survives_its_deleted_parent_untombstoned(db):
    """Deletion orphans branch children; only removed rows are tombstoned."""
    db.create_session("root", "desktop")
    db.create_session("branch", "desktop", parent_session_id="root")

    assert db.delete_session("root")

    assert db.get_session("branch")["parent_session_id"] is None
    assert not db.is_deleted_session("branch")


def test_tombstone_does_not_block_a_fresh_session(db):
    """The next chat — or the gateway's answer to the next inbound message —
    gets a new id; that one is created and accounted normally."""
    _deleted_gateway_session(db)
    _deleted_desktop_session(db)

    _recreate_with_peer_refresh(db, "tg-replacement")
    db.create_session("desktop-replacement", "desktop")
    _recreate_with_aux_usage(db, "desktop-replacement")

    replacement = db.get_session("tg-replacement")
    assert replacement is not None
    assert replacement["session_key"] == SESSION_KEY
    assert not db.is_deleted_session("tg-replacement")
    assert db.get_session("desktop-replacement")["source"] == "desktop"
    assert _usage_rows(db, "desktop-replacement") == 1


def test_importing_a_deleted_session_restores_it(db):
    """An explicit import is the one way back, and it clears the tombstone."""
    db.create_session("restored", "desktop", model="gpt-test")
    db.append_message("restored", "user", "xin chào")
    exported = db.export_session("restored")
    assert db.delete_session("restored")

    result = db.import_sessions([exported])

    assert result["imported"] == 1
    assert not db.is_deleted_session("restored")
    assert [m["content"] for m in db.get_messages("restored")] == ["xin chào"]
    _recreate_with_aux_usage(db, "restored")
    assert _usage_rows(db, "restored") == 1


def test_is_deleted_session_for_unknown_and_empty_ids(db):
    assert not db.is_deleted_session("never-existed")
    assert not db.is_deleted_session("")
    assert not db.is_deleted_session(None)


def test_is_deleted_session_on_a_store_without_the_table(tmp_path):
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
        assert not reader.is_deleted_session("tg-deleted")
    finally:
        reader.close()
