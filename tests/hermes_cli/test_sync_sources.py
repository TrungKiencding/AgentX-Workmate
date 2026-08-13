"""File-backed document kinds: memories and plans.

Two real directories stand in for two machines, and documents are handed
between them the way the engine hands them — which is what these tests are
actually pinning: that a directory can play the part ``sync_outbox`` plays for
``state.db``, without triggers.

The security test in :class:`TestPathSafety` is not a corner case. A ``doc_id``
is a filename another machine chose, and the feed is authenticated but not
trusted: a device somebody else controls, or one that has been tampered with,
can put any string in it. Writing outside the account home on the strength of
that string would turn synchronisation into arbitrary file write.
"""

from __future__ import annotations

import os
import time

import pytest

from hermes_cli.sync_sources import (
    SYNC_KIND_MEMORY,
    SYNC_KIND_PLAN,
    FileTreeSource,
    JsonManifest,
    default_sources,
)


def source_at(root, kind=SYNC_KIND_MEMORY, **kwargs):
    root.mkdir(parents=True, exist_ok=True)
    return FileTreeSource(
        kind, root, JsonManifest(root.parent / f"{kind}-manifest.json"), **kwargs
    )


@pytest.fixture
def laptop(tmp_path):
    return source_at(tmp_path / "laptop" / "memories")


@pytest.fixture
def desktop(tmp_path):
    return source_at(tmp_path / "desktop" / "memories")


def write(source, name, text, *, mtime=None):
    path = source.root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def push(origin, target):
    """Move everything pending from one source to the other, as the engine does."""
    documents = origin.pending()
    result = target.apply(
        [{k: v for k, v in doc.items() if k != "_manifest"} for doc in documents]
    )
    origin.acknowledge(documents)
    return result


class TestDetectingChanges:
    def test_a_new_file_is_pending(self, laptop):
        write(laptop, "MEMORY.md", "the user prefers tabs")

        documents = laptop.pending()

        assert len(documents) == 1
        assert documents[0]["kind"] == SYNC_KIND_MEMORY
        assert documents[0]["doc_id"] == "MEMORY.md"
        assert documents[0]["payload"]["text"] == "the user prefers tabs"

    def test_an_acknowledged_file_stops_being_pending(self, laptop):
        write(laptop, "MEMORY.md", "one")

        laptop.acknowledge(laptop.pending())

        assert laptop.pending() == []

    def test_an_edited_file_becomes_pending_again(self, laptop):
        write(laptop, "MEMORY.md", "one")
        laptop.acknowledge(laptop.pending())

        write(laptop, "MEMORY.md", "one, then two", mtime=time.time() + 5)

        assert [d["doc_id"] for d in laptop.pending()] == ["MEMORY.md"]

    def test_a_deleted_file_becomes_a_tombstone(self, laptop):
        write(laptop, "MEMORY.md", "one")
        laptop.acknowledge(laptop.pending())

        (laptop.root / "MEMORY.md").unlink()

        documents = laptop.pending()
        assert len(documents) == 1
        assert documents[0]["deleted"] is True
        # A tombstone carries no payload: the delete is the whole message.
        assert documents[0]["payload"] is None

    def test_nested_directories_are_walked(self, laptop):
        write(laptop, "projects/agentx/notes.md", "nested")

        assert [d["doc_id"] for d in laptop.pending()] == ["projects/agentx/notes.md"]

    def test_a_failed_push_leaves_everything_pending(self, laptop):
        write(laptop, "MEMORY.md", "one")

        # The engine acknowledges only after the service answers; a dropped
        # connection never gets here.
        assert len(laptop.pending()) == 1
        assert len(laptop.pending()) == 1

    def test_lock_and_hidden_files_are_never_carried(self, laptop):
        write(laptop, "MEMORY.md", "real")
        write(laptop, "MEMORY.md.lock", "")
        write(laptop, ".DS_Store", "junk")
        write(laptop, "notes.txt", "not markdown")

        assert [d["doc_id"] for d in laptop.pending()] == ["MEMORY.md"]

    def test_an_oversized_file_is_skipped(self, tmp_path):
        source = source_at(tmp_path / "memories", max_bytes=64)
        write(source, "huge.md", "x" * 500)
        write(source, "small.md", "fine")

        assert [d["doc_id"] for d in source.pending()] == ["small.md"]

    def test_a_batch_is_bounded(self, laptop):
        for index in range(10):
            write(laptop, f"m{index}.md", str(index))

        assert len(laptop.pending(limit=4)) == 4


class TestApplying:
    def test_a_document_lands_as_a_file(self, laptop, desktop):
        write(laptop, "MEMORY.md", "carried across")

        push(laptop, desktop)

        assert (desktop.root / "MEMORY.md").read_text(encoding="utf-8") == "carried across"

    def test_applying_does_not_queue_the_file_straight_back(self, laptop, desktop):
        write(laptop, "MEMORY.md", "carried across")

        push(laptop, desktop)

        # Writing a file moves its mtime, and without recording that the next
        # scan reads it as a local edit — two devices trading one memory
        # forever.
        assert desktop.pending() == []

    def test_applying_the_same_document_twice_changes_nothing(self, laptop, desktop):
        write(laptop, "MEMORY.md", "carried across")
        documents = laptop.pending()
        clean = [{k: v for k, v in d.items() if k != "_manifest"} for d in documents]

        desktop.apply(clean)
        first = (desktop.root / "MEMORY.md").stat().st_mtime
        desktop.apply(clean)

        assert (desktop.root / "MEMORY.md").stat().st_mtime == first
        assert desktop.pending() == []

    def test_a_newer_local_file_is_not_overwritten(self, laptop, desktop):
        write(laptop, "MEMORY.md", "from the laptop", mtime=time.time() - 100)
        write(desktop, "MEMORY.md", "edited here more recently")
        desktop.acknowledge(desktop.pending())

        push(laptop, desktop)

        assert (desktop.root / "MEMORY.md").read_text(encoding="utf-8") == (
            "edited here more recently"
        )

    def test_a_newer_remote_file_wins(self, laptop, desktop):
        write(desktop, "MEMORY.md", "stale", mtime=time.time() - 100)
        desktop.acknowledge(desktop.pending())
        write(laptop, "MEMORY.md", "fresher")

        push(laptop, desktop)

        assert (desktop.root / "MEMORY.md").read_text(encoding="utf-8") == "fresher"

    def test_a_tombstone_removes_the_file(self, laptop, desktop):
        write(laptop, "MEMORY.md", "here for now")
        push(laptop, desktop)
        (laptop.root / "MEMORY.md").unlink()

        result = push(laptop, desktop)

        assert result["deleted"] == 1
        assert not (desktop.root / "MEMORY.md").exists()

    def test_a_tombstone_for_something_already_gone_is_harmless(self, laptop, desktop):
        result = desktop.apply(
            [{"kind": SYNC_KIND_MEMORY, "doc_id": "never-existed.md", "deleted": True}]
        )

        assert result["deleted"] == 0
        assert result["skipped"] == 1
        assert not result["errors"]

    def test_a_deletion_does_not_come_back_as_a_local_change(self, laptop, desktop):
        write(laptop, "MEMORY.md", "here for now")
        push(laptop, desktop)
        (laptop.root / "MEMORY.md").unlink()
        push(laptop, desktop)

        # The tombstone cleared the manifest row too, so the desktop does not
        # now announce a deletion the feed already carries.
        assert desktop.pending() == []

    def test_nested_paths_are_created_as_needed(self, laptop, desktop):
        write(laptop, "projects/agentx/notes.md", "deep")

        push(laptop, desktop)

        assert (desktop.root / "projects/agentx/notes.md").exists()

    def test_a_document_with_no_text_is_reported_not_written(self, desktop):
        result = desktop.apply(
            [{"kind": SYNC_KIND_MEMORY, "doc_id": "m.md", "payload": {"path": "m.md"}}]
        )

        assert result["applied"] == 0
        assert result["errors"]

    def test_a_document_with_a_non_object_payload_is_reported(self, desktop):
        result = desktop.apply(
            [{"kind": SYNC_KIND_MEMORY, "doc_id": "m.md", "payload": "just a string"}]
        )

        assert result["applied"] == 0
        assert result["errors"]


class TestPathSafety:
    """A doc_id is a filename another machine chose. It is never trusted."""

    @pytest.mark.parametrize(
        "doc_id",
        [
            "../escaped.md",
            "../../.ssh/authorized_keys.md",
            "notes/../../escaped.md",
            "/etc/passwd.md",
            "\\\\server\\share\\x.md",
            "C:/Windows/x.md",
            "",
            "   ",
            "notes//..//escaped.md",
        ],
    )
    def test_a_path_that_escapes_the_root_resolves_to_nothing(self, laptop, doc_id):
        assert laptop.resolve(doc_id) is None

    def test_an_escaping_document_is_refused_and_writes_nothing(self, tmp_path, laptop):
        outside = tmp_path / "laptop" / "stolen.md"

        result = laptop.apply(
            [
                {
                    "kind": SYNC_KIND_MEMORY,
                    "doc_id": "../stolen.md",
                    "payload": {"text": "should never land"},
                    "updated_at": time.time(),
                }
            ]
        )

        assert not outside.exists()
        assert result["applied"] == 0
        assert result["errors"]

    def test_a_file_of_the_wrong_kind_is_refused(self, laptop):
        # Only the suffixes this source carries. Otherwise a document could
        # drop an executable or a shell profile into the account home.
        assert laptop.resolve("payload.sh") is None
        assert laptop.resolve("MEMORY.md") is not None

    def test_an_ordinary_nested_path_still_resolves(self, laptop):
        assert laptop.resolve("projects/agentx/notes.md") is not None


class TestManifest:
    def test_a_missing_manifest_reads_as_empty(self, tmp_path):
        assert JsonManifest(tmp_path / "nope.json").read() == {}

    def test_a_corrupt_manifest_reads_as_empty_rather_than_raising(self, tmp_path):
        path = tmp_path / "manifest.json"
        path.write_text("{not json", encoding="utf-8")

        # This runs on a background tick. An unreadable file must cost a
        # redundant push, never a stopped engine.
        assert JsonManifest(path).read() == {}

    def test_a_manifest_survives_a_round_trip(self, tmp_path):
        manifest = JsonManifest(tmp_path / "manifest.json")

        manifest.write({"MEMORY.md": {"mtime": 1.5, "size": 12}})

        assert JsonManifest(tmp_path / "manifest.json").read() == {
            "MEMORY.md": {"mtime": 1.5, "size": 12}
        }

    def test_losing_the_manifest_costs_a_re_push_and_nothing_else(self, laptop, desktop):
        write(laptop, "MEMORY.md", "carried across")
        push(laptop, desktop)
        laptop.manifest.path.unlink()

        # Every file looks new again — and re-pushing is a no-op the far side
        # settles by last-writer-wins.
        assert [d["doc_id"] for d in laptop.pending()] == ["MEMORY.md"]
        push(laptop, desktop)
        assert (desktop.root / "MEMORY.md").read_text(encoding="utf-8") == "carried across"

    def test_an_unwritable_manifest_does_not_raise(self, tmp_path, monkeypatch):
        manifest = JsonManifest(tmp_path / "manifest.json")

        def refuse(*_args, **_kwargs):
            raise OSError("read-only filesystem")

        monkeypatch.setattr("pathlib.Path.write_text", refuse)

        manifest.write({"a.md": {"mtime": 1, "size": 1}})


class TestDefaults:
    def test_it_carries_memories_and_plans(self, tmp_path):
        kinds = {kind for source in default_sources(tmp_path) for kind in source.kinds}

        assert kinds == {SYNC_KIND_MEMORY, SYNC_KIND_PLAN}

    def test_the_roots_are_the_account_homes_own_directories(self, tmp_path):
        roots = {source.kind: source.root for source in default_sources(tmp_path)}

        assert roots[SYNC_KIND_MEMORY] == tmp_path / "memories"
        assert roots[SYNC_KIND_PLAN] == tmp_path / "plans"

    def test_manifests_live_beside_the_account_state_not_in_the_synced_tree(
        self, tmp_path
    ):
        for source in default_sources(tmp_path):
            # A manifest inside `memories/` would be scanned as a memory, and
            # would change on every push — a document that rewrites itself.
            assert source.manifest.path.parent == tmp_path / "sync"

    def test_the_kanban_board_is_deliberately_not_synced(self, tmp_path):
        kinds = {kind for source in default_sources(tmp_path) for kind in source.kinds}

        # A task's status is what a dispatcher compare-and-swaps to claim it,
        # and last-writer-wins across devices would let two machines claim one
        # task and both start work. It needs per-device claim leases, which is
        # a conflict rule this phase did not design.
        assert "kanban" not in kinds

    def test_a_missing_directory_is_not_an_error(self, tmp_path):
        # An account home created before these kinds existed, or one where
        # somebody removed a directory.
        for source in default_sources(tmp_path):
            assert source.pending() == []


class TestPlans:
    def test_plans_travel_the_same_way_memories_do(self, tmp_path):
        origin = source_at(tmp_path / "a" / "plans", SYNC_KIND_PLAN)
        target = source_at(tmp_path / "b" / "plans", SYNC_KIND_PLAN)
        write(origin, "2026-08-13-rollout.md", "# Rollout\n\nstep one")

        push(origin, target)

        assert (target.root / "2026-08-13-rollout.md").exists()
        assert target.pending() == []

    def test_a_source_only_claims_its_own_kind(self, tmp_path):
        plans = source_at(tmp_path / "plans", SYNC_KIND_PLAN)

        assert plans.kinds == (SYNC_KIND_PLAN,)
