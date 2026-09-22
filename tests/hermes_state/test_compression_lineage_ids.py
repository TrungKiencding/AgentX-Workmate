"""Every stored id of a rotated compression chain stays addressable.

A messaging gateway can compress a platform conversation again after a client
opened it, rotating its stored id root -> mid -> tip. The list only names the
root (``_lineage_root_id``) and the tip (``id``), so a client still holding the
middle id needs the whole ``[root, ..., tip]`` path to find its row again.
"""

import pytest

from hermes_state import SessionDB


@pytest.fixture
def db(tmp_path):
    database = SessionDB(tmp_path / "state.db")
    try:
        yield database
    finally:
        database.close()


def _started_at(db, sid, value):
    db._conn.execute("UPDATE sessions SET started_at=? WHERE id=?", (value, sid))
    db._conn.commit()


def _rotated_chain(db, t0=1_000_000.0):
    """telegram root-R -> mid-M -> tip-T, each rotation a compression."""
    db.create_session("root-R", "telegram", session_key="telegram:dm:peer")
    db.end_session("root-R", "compression")
    db.create_session(
        "mid-M", "telegram", session_key="telegram:dm:peer", parent_session_id="root-R"
    )
    db.end_session("mid-M", "compression")
    db.create_session(
        "tip-T", "telegram", session_key="telegram:dm:peer", parent_session_id="mid-M"
    )
    for offset, sid in enumerate(("root-R", "mid-M", "tip-T")):
        _started_at(db, sid, t0 + offset)


def _stale_sibling_chain(db, t0=1_000_000.0):
    """root-R2 has a stale closed sibling that started before the live tip."""
    db.create_session("root-R2", "telegram")
    db.end_session("root-R2", "compression")
    db.create_session("stale-S", "telegram", parent_session_id="root-R2")
    db.end_session("stale-S", "ws_orphan_reap")
    db.create_session("tip-T2", "telegram", parent_session_id="root-R2")
    for offset, sid in enumerate(("root-R2", "stale-S", "tip-T2")):
        _started_at(db, sid, t0 + offset)


def test_compression_path_walks_the_same_edges_as_the_tip(db):
    _rotated_chain(db)
    _stale_sibling_chain(db, t0=2_000_000.0)

    assert db.get_compression_path("root-R") == ["root-R", "mid-M", "tip-T"]
    assert db.get_compression_path("mid-M") == ["mid-M", "tip-T"]
    assert db.get_compression_path("tip-T") == ["tip-T"]
    # The live continuation wins over the older closed sibling, as for the tip.
    assert db.get_compression_path("root-R2") == ["root-R2", "tip-T2"]
    assert db.get_compression_tip("root-R2") == "tip-T2"
    assert db.get_compression_tip("root-R") == "tip-T"


@pytest.mark.parametrize("order_by_last_active", [False, True])
def test_projected_row_lists_every_id_it_folds_in(db, order_by_last_active):
    _rotated_chain(db)
    db.create_session("solo", "telegram")

    rows = db.list_sessions_rich(
        order_by_last_active=order_by_last_active, compact_rows=True
    )
    by_id = {row["id"]: row for row in rows}

    assert set(by_id) == {"tip-T", "solo"}
    assert by_id["tip-T"]["_lineage_root_id"] == "root-R"
    assert by_id["tip-T"]["_lineage_ids"] == ["root-R", "mid-M", "tip-T"]
    assert "_lineage_ids" not in by_id["solo"]


def test_pinned_backfill_row_lists_every_id_it_folds_in(db):
    _rotated_chain(db)
    db.create_session("fresh", "cli")
    _started_at(db, "fresh", 3_000_000.0)
    db.set_session_pinned("root-R", True)

    rows = db.list_sessions_rich(limit=1, include_pinned=True)

    assert [row["id"] for row in rows] == ["fresh", "tip-T"]
    assert rows[1]["_lineage_ids"] == ["root-R", "mid-M", "tip-T"]


def test_projected_lineage_maps_every_member_to_the_list_row(db):
    _rotated_chain(db)
    _stale_sibling_chain(db, t0=2_000_000.0)
    db.create_session("solo", "telegram")
    db.create_session(
        "branch",
        "cli",
        parent_session_id="mid-M",
        model_config={"_branched_from": "mid-M"},
    )

    for member in ("root-R", "mid-M", "tip-T"):
        assert db.get_projected_compression_lineage(member) == [
            "root-R",
            "mid-M",
            "tip-T",
        ]
    assert db.get_projected_compression_lineage("tip-T2") == ["root-R2", "tip-T2"]
    # Off the projected path: fall back to the one-child-per-hop lineage.
    assert db.get_projected_compression_lineage("stale-S") == ["root-R2", "stale-S"]
    # A branch is its own conversation, not a member of its parent's chain.
    assert db.get_projected_compression_lineage("branch") == ["branch"]
    assert db.get_projected_compression_lineage("solo") == ["solo"]
    assert db.get_projected_compression_lineage("missing") == []


def test_compression_family_keeps_stale_siblings_and_skips_forks(db):
    _stale_sibling_chain(db)
    db.create_session(
        "branch",
        "cli",
        parent_session_id="root-R2",
        model_config={"_branched_from": "root-R2"},
    )
    db.create_session(
        "delegate",
        "delegate",
        parent_session_id="root-R2",
        model_config={"_delegate_from": "root-R2"},
    )
    db.create_session("tool", "tool", parent_session_id="root-R2")

    expected = ["root-R2", "stale-S", "tip-T2"]
    assert db.get_compression_family("tip-T2") == expected
    assert db.get_compression_family("stale-S") == expected
    assert db.get_compression_family("root-R2") == expected
    assert db.get_compression_family("branch") == ["branch"]
    assert db.get_compression_family("missing") == []


def test_reset_continuation_stays_out_of_the_family_it_hangs_off(db):
    """A stale reset can leave its parent ended 'compression'; the reset child
    is still a separately listed conversation, not part of that chain."""
    _rotated_chain(db)
    db.create_session(
        "reset-C",
        "telegram",
        parent_session_id="root-R",
        model_config={"_reset_from": "root-R"},
    )
    _started_at(db, "reset-C", 1_000_010.0)

    listed = {row["id"] for row in db.list_sessions_rich(include_children=False)}
    assert {"reset-C", "tip-T"} <= listed

    assert db.get_compression_family("tip-T") == ["root-R", "mid-M", "tip-T"]
    assert db.get_compression_family("reset-C") == ["reset-C"]
    assert db.get_projected_compression_lineage("reset-C") == ["reset-C"]


def test_stale_sibling_started_after_the_tip_still_reports_its_root(db):
    """The race get_compression_tip documents: a sibling created after the
    live continuation. Its own ancestry still starts at the listed root."""
    db.create_session("root-R3", "telegram")
    db.end_session("root-R3", "compression")
    db.create_session("tip-T3", "telegram", parent_session_id="root-R3")
    db.create_session("late-S", "telegram", parent_session_id="root-R3")
    db.end_session("late-S", "ws_orphan_reap")
    for offset, sid in enumerate(("root-R3", "tip-T3", "late-S")):
        _started_at(db, sid, 3_000_000.0 + offset)

    assert db.get_compression_path("root-R3") == ["root-R3", "tip-T3"]
    assert db.get_projected_compression_lineage("late-S") == ["root-R3", "late-S"]
    assert db.get_compression_family("late-S") == ["root-R3", "tip-T3", "late-S"]
