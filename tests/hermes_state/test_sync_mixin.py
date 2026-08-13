"""SessionSyncMixin: the local half of synchronisation.

Two real databases on two temporary directories stand in for two machines.
There is no service and no socket in Phase 0 — the engine that carries
documents between them lands in Phase 3 — so these tests hand documents from
one database to the other by hand, which is exactly what that engine will do.

The properties being pinned are the ones a sync engine cannot repair if the
store gets them wrong: applying is idempotent (so a cursor reset is a safe
recovery), applying does not re-enqueue (so two devices do not trade the same
document forever), and a stale document cannot overwrite a fresher local one.
"""

import pytest

from hermes_state import SessionDB


@pytest.fixture
def alice(tmp_path):
    database = SessionDB(tmp_path / "alice" / "state.db")
    try:
        yield database
    finally:
        database.close()


@pytest.fixture
def bob(tmp_path):
    database = SessionDB(tmp_path / "bob" / "state.db")
    try:
        yield database
    finally:
        database.close()


def _push(source, target, limit=None):
    """Drain source's outbox into target the way the sync engine will.

    Returns the apply result so a test can assert on what landed.
    """
    batch = source.next_outbox_batch(limit)
    documents = []
    for entry in batch:
        if entry["op"] == "delete":
            documents.append(source.export_tombstone(entry["kind"], entry["doc_id"]))
            continue
        document = source.export_document(entry["kind"], entry["doc_id"])
        if document is not None:
            documents.append(document)
    result = target.apply_remote_documents(documents)
    source.mark_outbox_done(batch)
    return result


def _seed_session(database, session_id="s1", messages=("hello", "hi there")):
    database.create_session(session_id, "cli", model="m1")
    for index, text in enumerate(messages):
        database.append_message(
            session_id, "user" if index % 2 == 0 else "assistant", text
        )
    return session_id


def _comparable(database, session_id):
    session = database.get_session(session_id)
    messages = database.get_messages(session_id)
    return (
        {
            key: session[key]
            for key in ("id", "source", "model", "title", "archived", "pinned")
        },
        [(m["role"], m["content"], m["uuid"]) for m in messages],
    )


class TestOutbox:
    def test_a_batch_coalesces_repeated_edits_to_one_document(self, alice):
        _seed_session(alice, messages=())
        alice.set_session_title("s1", "first")
        alice.set_session_pinned("s1", True)
        alice.set_session_archived("s1", True)

        batch = alice.next_outbox_batch()

        assert len(batch) == 1
        entry = batch[0]
        assert (entry["kind"], entry["doc_id"], entry["op"]) == (
            "session", "s1", "upsert",
        )
        # Every row the entry stands for comes back, so acknowledging the
        # document clears all four rather than leaving three behind.
        assert len(entry["row_ids"]) == 4
        assert alice.outbox_pending_count() == 4

    def test_the_last_operation_on_a_document_wins(self, alice):
        _seed_session(alice, messages=())
        alice.set_session_title("s1", "renamed")
        alice.delete_session("s1")

        batch = alice.next_outbox_batch()

        assert [(e["doc_id"], e["op"]) for e in batch] == [("s1", "delete")]

    def test_marking_done_clears_only_the_acknowledged_rows(self, alice):
        _seed_session(alice, messages=("one", "two", "three"))
        batch = alice.next_outbox_batch(limit=2)
        assert alice.outbox_pending_count() == 4

        removed = alice.mark_outbox_done(batch)

        assert removed == 2
        assert alice.outbox_pending_count() == 2
        assert alice.sync_status()["last_push_at"] is not None

    def test_an_unacknowledged_batch_is_offered_again(self, alice):
        """A push that never reaches the service must not lose the change."""
        _seed_session(alice, messages=("one",))
        first = alice.next_outbox_batch()

        # No mark_outbox_done — the connection dropped.
        second = alice.next_outbox_batch()

        assert [e["doc_id"] for e in second] == [e["doc_id"] for e in first]

    def test_marking_done_accepts_bare_row_ids(self, alice):
        _seed_session(alice, messages=("one",))
        ids = [i for e in alice.next_outbox_batch() for i in e["row_ids"]]

        assert alice.mark_outbox_done(ids) == len(ids)
        assert alice.outbox_pending_count() == 0

    def test_marking_nothing_done_is_a_no_op(self, alice):
        _seed_session(alice, messages=("one",))
        assert alice.mark_outbox_done([]) == 0
        assert alice.outbox_pending_count() == 2


class TestDocuments:
    def test_a_session_round_trip_reproduces_it_exactly(self, alice, bob):
        _seed_session(alice)
        alice.set_session_title("s1", "a chat")

        _push(alice, bob)

        assert _comparable(bob, "s1") == _comparable(alice, "s1")

    def test_message_identity_survives_the_round_trip(self, alice, bob):
        """Identity is the uuid, not the local row number.

        ``messages.id`` is AUTOINCREMENT and means nothing on another
        machine; if the uuid changed in transit, every subsequent apply
        would insert a duplicate instead of recognising the message.
        """
        _seed_session(alice, messages=("one", "two", "three"))
        _push(alice, bob)

        assert [m["uuid"] for m in bob.get_messages("s1")] == [
            m["uuid"] for m in alice.get_messages("s1")
        ]

    def test_exporting_a_document_that_is_gone_returns_none(self, alice):
        _seed_session(alice, messages=())
        alice.delete_session("s1")

        assert alice.export_document("session", "s1") is None
        assert alice.export_document("message", "no-such-uuid") is None

    def test_an_unknown_kind_is_not_serializable_here(self, alice):
        assert alice.export_document("memory", "whatever") is None

    def test_a_session_document_carries_its_messages(self, alice):
        _seed_session(alice, messages=("one", "two"))

        document = alice.export_document("session", "s1")

        assert document["kind"] == "session"
        assert document["deleted"] is False
        assert [m["content"] for m in document["payload"]["messages"]] == ["one", "two"]

    def test_a_never_edited_session_stamps_from_started_at(self, alice):
        """``updated_at`` is NULL until the first edit and cannot be backfilled."""
        _seed_session(alice, messages=())

        document = alice.export_document("session", "s1")

        assert document["updated_at"] == alice.get_session("s1")["started_at"]


class TestApply:
    def test_applying_twice_changes_nothing_the_second_time(self, alice, bob):
        """What makes resetting a cursor to 0 a safe recovery.

        Idempotence is about the DATA, not about the counters. A re-applied
        session document is counted as applied rather than skipped, because a
        document whose stamp ties with the local row is applied on purpose —
        the server accepts ties and this side has to agree with it, or two
        devices settle on different rows and neither ever budges. Writing the
        same values a second time changes nothing, which is the property that
        actually matters here.
        """
        _seed_session(alice, messages=("one", "two"))
        batch = alice.next_outbox_batch()
        documents = [
            alice.export_document(e["kind"], e["doc_id"]) for e in batch
        ]

        first = bob.apply_remote_documents(documents)
        before = _comparable(bob, "s1")
        second = bob.apply_remote_documents(documents)

        assert first["applied"] >= 1
        assert not second["errors"]
        assert _comparable(bob, "s1") == before
        # And nothing was queued for pushing back, twice over.
        assert bob.outbox_pending_count() == 0

    def test_a_document_older_than_the_local_row_is_skipped(self, alice, bob):
        """The strict half of the rule: older loses, and is counted as such."""
        _seed_session(alice, messages=("one",))
        document = alice.export_document("session", "s1")
        bob.apply_remote_documents([document])
        bob.set_session_title("s1", "bob edited this later")

        result = bob.apply_remote_documents([document])

        assert result["skipped"] == 1
        assert bob.get_session("s1")["title"] == "bob edited this later"

    def test_a_tie_follows_the_feed_rather_than_the_local_copy(self, alice, bob):
        """Ties apply, because the server accepts them and both sides must agree.

        ``updated_at`` comes from ``julianday('now')``, which resolves to about
        a millisecond, so two devices editing one session moments apart land on
        the same stamp routinely. If this side kept its own copy on a tie while
        the server kept the other device's, the two would differ forever with
        nothing reporting a conflict.
        """
        _seed_session(alice, messages=("one",))
        document = alice.export_document("session", "s1")
        bob.apply_remote_documents([document])

        # Exactly the local stamp — the tie, constructed rather than raced for.
        tied = {**document, "payload": {**document["payload"], "title": "from the feed"}}
        tied["updated_at"] = bob.get_session("s1")["updated_at"]

        bob.apply_remote_documents([tied])

        assert bob.get_session("s1")["title"] == "from the feed"

    def test_applying_does_not_enqueue_the_applied_documents(self, alice, bob):
        """Otherwise two devices push each other's changes back forever."""
        _seed_session(alice, messages=("one", "two", "three"))

        _push(alice, bob)

        assert bob.outbox_pending_count() == 0
        assert bob.next_outbox_batch() == []

    def test_applying_preserves_unrelated_pending_local_changes(self, alice, bob):
        """The suppression is a watermark, not a truncation.

        A flag in ``state_meta`` was the alternative, and this is what it
        would have broken: work this device queued BEFORE the apply — or a
        sibling process's — is not ours to discard.
        """
        _seed_session(bob, session_id="local", messages=("mine",))
        pending_before = bob.outbox_pending_count()
        assert pending_before == 2

        _seed_session(alice, messages=("theirs",))
        _push(alice, bob)

        assert bob.outbox_pending_count() == pending_before
        assert {e["doc_id"] for e in bob.next_outbox_batch()} == {
            "local", *(m["uuid"] for m in bob.get_messages("local"))
        }

    def test_a_newer_remote_edit_updates_an_existing_session(self, alice, bob):
        _seed_session(alice, messages=("one",))
        _push(alice, bob)

        alice.set_session_title("s1", "renamed on alice")
        alice.set_session_pinned("s1", True)
        _push(alice, bob)

        assert bob.get_session("s1")["title"] == "renamed on alice"
        assert bob.get_session("s1")["pinned"] == 1

    def test_an_edit_made_right_after_creation_still_lands(self, alice, bob):
        """Regression: the LWW comparison is against started_at, not zero.

        A session whose stamp came out below its own ``started_at`` — which a
        millisecond-resolution clock will do to any rename that follows the
        create closely enough — reads as stale on arrival and is dropped
        without a trace.
        """
        alice.create_session("s1", "cli")
        alice.set_session_title("s1", "named immediately")
        _push(alice, bob)

        assert bob.get_session("s1")["title"] == "named immediately"

    def test_an_older_document_does_not_overwrite_a_newer_local_session(
        self, alice, bob
    ):
        _seed_session(alice, messages=("one",))
        _push(alice, bob)
        stale = alice.export_document("session", "s1")

        bob.set_session_title("s1", "renamed on bob")
        result = bob.apply_remote_documents([stale])

        assert result["skipped"] == 1
        assert result["applied"] == 0
        assert bob.get_session("s1")["title"] == "renamed on bob"

    def test_a_newer_session_document_merges_only_missing_messages(
        self, alice, bob
    ):
        _seed_session(alice, messages=("one", "two"))
        _push(alice, bob)

        alice.append_message("s1", "user", "three")
        alice.set_session_title("s1", "grew")
        _push(alice, bob)

        assert [m["content"] for m in bob.get_messages("s1")] == [
            "one", "two", "three",
        ]
        assert bob.get_session("s1")["message_count"] == 3

    def test_a_message_document_appends_to_a_known_session(self, alice, bob):
        _seed_session(alice, messages=("one",))
        _push(alice, bob)

        alice.append_message("s1", "assistant", "a later turn")
        _push(alice, bob)

        assert [m["content"] for m in bob.get_messages("s1")] == [
            "one", "a later turn",
        ]
        assert bob.get_session("s1")["message_count"] == 2

    def test_a_message_for_an_unknown_session_is_skipped_not_fatal(self, alice, bob):
        """A foreign key violation here would take the whole page down."""
        _seed_session(alice, messages=("one",))
        orphan = alice.export_document(
            "message", alice.get_messages("s1")[0]["uuid"]
        )

        result = bob.apply_remote_documents([orphan])

        assert result == {
            "ok": True, "applied": 0, "skipped": 1, "deleted": 0, "errors": [],
        }

    def test_a_tombstone_deletes_the_session_and_its_messages(self, alice, bob):
        _seed_session(alice, messages=("one", "two"))
        _push(alice, bob)

        alice.delete_session("s1")
        _push(alice, bob)

        assert bob.get_session("s1") is None
        assert bob.get_messages("s1") == []
        assert bob.outbox_pending_count() == 0

    def test_a_tombstone_for_an_unknown_session_is_a_no_op(self, alice, bob):
        result = bob.apply_remote_documents(
            [alice.export_tombstone("session", "never-seen")]
        )

        assert result["skipped"] == 1
        assert result["deleted"] == 0

    def test_a_tombstone_detaches_children_rather_than_deleting_them(
        self, alice, bob
    ):
        """The origin's cascade already produced a tombstone per deleted row.

        Re-deriving it here would delete sessions the feed never condemned.
        """
        bob.create_session("parent", "cli")
        bob.create_session("child", "cli", parent_session_id="parent")

        bob.apply_remote_documents(
            [alice.export_tombstone("session", "parent")]
        )

        assert bob.get_session("parent") is None
        assert bob.get_session("child") is not None
        assert bob.get_session("child")["parent_session_id"] is None

    def test_an_unknown_kind_is_skipped_not_rejected(self, bob):
        """``kind`` is opaque end to end so new types need no schema change."""
        result = bob.apply_remote_documents(
            [
                {
                    "kind": "memory",
                    "doc_id": "m1",
                    "updated_at": 1.0,
                    "deleted": False,
                    "payload": {"anything": True},
                }
            ]
        )

        assert result == {
            "ok": True, "applied": 0, "skipped": 1, "deleted": 0, "errors": [],
        }

    def test_a_malformed_document_does_not_abort_the_page(self, alice, bob):
        _seed_session(alice, messages=("one",))
        good = alice.export_document("session", "s1")

        result = bob.apply_remote_documents(
            [
                {"kind": "session", "doc_id": "broken", "payload": "not an object"},
                good,
            ]
        )

        assert result["applied"] == 1
        assert len(result["errors"]) == 1
        assert result["errors"][0]["doc_id"] == "broken"
        assert bob.get_session("s1") is not None

    def test_an_empty_page_is_accepted(self, bob):
        assert bob.apply_remote_documents([]) == {
            "ok": True, "applied": 0, "skipped": 0, "deleted": 0, "errors": [],
        }

    def test_documents_must_be_a_list(self, bob):
        with pytest.raises(ValueError):
            bob.apply_remote_documents({"kind": "session"})


class TestConvergence:
    def test_interleaved_edits_on_two_devices_converge(self, alice, bob):
        """The Phase 3 acceptance shape, driven by hand.

        Fixed inputs and a fixed order: a convergence test that cannot
        reproduce its own failure is worthless.
        """
        _seed_session(alice, session_id="from-alice", messages=("a1", "a2"))
        _seed_session(bob, session_id="from-bob", messages=("b1",))

        _push(alice, bob)
        _push(bob, alice)

        alice.append_message("from-bob", "assistant", "alice replies")
        bob.set_session_title("from-alice", "bob renames")

        _push(alice, bob)
        _push(bob, alice)

        for session_id in ("from-alice", "from-bob"):
            assert _comparable(alice, session_id) == _comparable(bob, session_id)
        assert alice.get_session("from-alice")["title"] == "bob renames"
        assert [m["content"] for m in alice.get_messages("from-bob")] == [
            "b1", "alice replies",
        ]

    def test_converged_devices_stop_talking(self, alice, bob):
        """Steady state is silence, not an echo."""
        _seed_session(alice, messages=("one", "two"))
        _push(alice, bob)
        _push(bob, alice)

        assert alice.outbox_pending_count() == 0
        assert bob.outbox_pending_count() == 0

    def test_an_applied_session_carries_the_stamp_it_arrived_with(self, alice, bob):
        """The receiving device must not claim it made the change itself.

        The apply touches columns ``sync_sessions_update`` watches, so that
        trigger fires and would stamp ``updated_at`` with the LOCAL clock —
        overwriting the value the same statement set. It is restamped
        separately for that reason.
        """
        _seed_session(alice, messages=("one",))
        _push(alice, bob)
        alice.set_session_title("s1", "renamed on alice")
        document = alice.export_document("session", "s1")

        bob.apply_remote_documents([document])

        with bob._read_ctx() as conn:
            stamp = conn.execute(
                "SELECT updated_at FROM sessions WHERE id = 's1'"
            ).fetchone()["updated_at"]
        assert stamp == document["updated_at"]

    def test_a_device_applying_a_late_document_still_accepts_the_ones_after_it(
        self, alice, bob
    ):
        """What the stamp above actually protects, stated as behaviour.

        Bob is offline while Alice makes two edits. He applies the first one
        long after she made it. If applying had stamped his row with his own
        clock, his copy would look newer than Alice's second edit and he would
        reject it forever — two devices holding different rows, permanently,
        with nothing reporting it.
        """
        _seed_session(alice, messages=("one",))
        _push(alice, bob)

        alice.set_session_title("s1", "first edit")
        first = alice.export_document("session", "s1")
        alice.set_session_title("s1", "second edit")
        second = alice.export_document("session", "s1")
        alice.mark_outbox_done(alice.next_outbox_batch())

        # Bob has been away; both documents land now, oldest first.
        bob.apply_remote_documents([first])
        bob.apply_remote_documents([second])

        assert bob.get_session("s1")["title"] == "second edit"


class TestCursorAndStatus:
    def test_the_cursor_starts_at_zero(self, alice):
        assert alice.sync_cursor() == 0

    def test_the_cursor_survives_a_reopen(self, tmp_path):
        db_path = tmp_path / "state.db"
        database = SessionDB(db_path)
        database.set_sync_cursor(1234)
        database.close()

        database = SessionDB(db_path)
        try:
            assert database.sync_cursor() == 1234
        finally:
            database.close()

    def test_a_negative_cursor_is_refused(self, alice):
        with pytest.raises(ValueError):
            alice.set_sync_cursor(-1)

    def test_advancing_the_cursor_records_a_successful_pull(self, alice):
        alice.set_sync_error("service unreachable")
        assert alice.sync_status()["last_error"] == "service unreachable"

        alice.set_sync_cursor(7)

        status = alice.sync_status()
        assert status["cursor"] == 7
        assert status["last_pull_at"] is not None
        # Reaching a new cursor means the service answered.
        assert status["last_error"] is None

    def test_status_reports_the_backlog(self, alice):
        _seed_session(alice, messages=("one", "two"))

        status = alice.sync_status()

        assert status["pending"] == alice.outbox_pending_count() == 3
        assert status["cursor"] == 0
        assert status["last_push_at"] is None

    def test_an_error_can_be_recorded_and_cleared(self, alice):
        alice.set_sync_error("boom")
        assert alice.sync_status()["last_error"] == "boom"

        alice.set_sync_error(None)
        assert alice.sync_status()["last_error"] is None
