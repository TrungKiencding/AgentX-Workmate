"""``merge_message_display_metadata``: per-message presentation extras survive
next to reactions instead of overwriting them."""

import pytest

from hermes_state import SessionDB


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
    return SessionDB(db_path=tmp_path / "state.db")


@pytest.fixture
def session(db):
    key = db.create_session("merge-test", "test")
    db.append_message(key, "user", "make me a report")
    db.append_message(key, "assistant", "here it is")
    rows = [m["_row_id"] for m in db.get_messages_as_conversation(key, include_row_ids=True)]
    return key, rows


def _meta(db, key, row_id):
    for message in db.get_messages_as_conversation(key, include_row_ids=True):
        if message["_row_id"] == row_id:
            return message.get("display_metadata")
    raise AssertionError("row not found")


def test_patch_lands_on_the_row_and_rehydrates(session, db):
    key, rows = session
    files = [{"path": "/tmp/report.docx", "name": "report.docx", "size_bytes": 12}]

    assert db.merge_message_display_metadata(key, rows[1], {"files_created": files}) is True

    assert _meta(db, key, rows[1]) == {"files_created": files}


def test_existing_keys_are_kept(session, db):
    key, rows = session
    db.set_message_reaction(key, rows[1], "\U0001f44d", author="user")

    db.merge_message_display_metadata(key, rows[1], {"files_created": [{"path": "/tmp/a.pdf"}]})

    meta = _meta(db, key, rows[1])
    assert meta["files_created"] == [{"path": "/tmp/a.pdf"}]
    assert [r["emoji"] for r in meta["reactions"]] == ["\U0001f44d"]


def test_none_removes_a_key_and_empty_metadata_clears_the_column(session, db):
    key, rows = session
    db.merge_message_display_metadata(key, rows[1], {"files_created": [{"path": "/tmp/a.pdf"}]})

    assert db.merge_message_display_metadata(key, rows[1], {"files_created": None}) is True

    assert _meta(db, key, rows[1]) is None


def test_foreign_or_missing_rows_are_refused(session, db):
    key, rows = session
    other = db.create_session("other", "test")

    assert db.merge_message_display_metadata(other, rows[1], {"x": 1}) is False
    assert db.merge_message_display_metadata(key, 99999, {"x": 1}) is False
    assert db.merge_message_display_metadata("", rows[1], {"x": 1}) is False
    assert _meta(db, key, rows[1]) is None
