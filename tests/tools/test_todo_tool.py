"""Tests for the todo tool module."""

import json

from tools.todo_tool import TodoStore, todo_tool


class TestWriteAndRead:
    def test_write_replaces_list(self):
        store = TodoStore()
        items = [
            {"id": "1", "content": "First task", "status": "pending"},
            {"id": "2", "content": "Second task", "status": "in_progress"},
        ]
        result = store.write(items)
        assert len(result) == 2
        assert result[0]["id"] == "2"
        assert result[0]["status"] == "in_progress"
        assert result[1]["id"] == "1"


    def test_write_deduplicates_duplicate_ids(self):
        store = TodoStore()
        result = store.write([
            {"id": "1", "content": "First version", "status": "pending"},
            {"id": "2", "content": "Other task", "status": "pending"},
            {"id": "1", "content": "Latest version", "status": "in_progress"},
        ])
        assert result == [
            {"id": "1", "content": "Latest version", "status": "in_progress"},
            {"id": "2", "content": "Other task", "status": "pending"},
        ]

    def test_write_moves_active_item_before_earlier_pending_step(self):
        store = TodoStore()
        result = store.write([
            {"id": "1", "content": "Already done", "status": "completed"},
            {"id": "2", "content": "Verify freed space", "status": "pending"},
            {"id": "3", "content": "Move archives to Trash", "status": "in_progress"},
        ])
        assert result == [
            {"id": "1", "content": "Already done", "status": "completed"},
            {"id": "3", "content": "Move archives to Trash", "status": "in_progress"},
            {"id": "2", "content": "Verify freed space", "status": "pending"},
        ]


class TestHasItems:
    def test_empty_store(self):
        store = TodoStore()
        assert store.has_items() is False

    def test_non_empty_store(self):
        store = TodoStore()
        store.write([{"id": "1", "content": "x", "status": "pending"}])
        assert store.has_items() is True


class TestFormatForInjection:
    def test_empty_returns_none(self):
        store = TodoStore()
        assert store.format_for_injection() is None

    def test_non_empty_has_markers(self):
        store = TodoStore()
        store.write([
            {"id": "1", "content": "Do thing", "status": "completed"},
            {"id": "2", "content": "Next", "status": "pending"},
            {"id": "3", "content": "Working", "status": "in_progress"},
        ])
        text = store.format_for_injection()
        # Completed items are filtered out of injection
        assert "[x]" not in text
        assert "Do thing" not in text
        # Active items are included
        assert "[ ]" in text
        assert "[>]" in text
        assert "Next" in text
        assert "Working" in text
        assert "context compression" in text.lower()


class TestMergeMode:
    def test_update_existing_by_id(self):
        store = TodoStore()
        store.write([
            {"id": "1", "content": "Original", "status": "pending"},
        ])
        store.write(
            [{"id": "1", "status": "completed"}],
            merge=True,
        )
        items = store.read()
        assert len(items) == 1
        assert items[0]["status"] == "completed"
        assert items[0]["content"] == "Original"

    def test_merge_appends_new(self):
        store = TodoStore()
        store.write([{"id": "1", "content": "First", "status": "pending"}])
        store.write(
            [{"id": "2", "content": "Second", "status": "pending"}],
            merge=True,
        )
        items = store.read()
        assert len(items) == 2

    def test_merge_reorders_active_item_ahead_of_earlier_pending_step(self):
        store = TodoStore()
        store.write([
            {"id": "1", "content": "Completed", "status": "completed"},
            {"id": "2", "content": "Verify freed space", "status": "pending"},
            {"id": "3", "content": "Move archives to Trash", "status": "pending"},
        ])
        result = store.write(
            [{"id": "3", "status": "in_progress"}],
            merge=True,
        )
        assert result == [
            {"id": "1", "content": "Completed", "status": "completed"},
            {"id": "3", "content": "Move archives to Trash", "status": "in_progress"},
            {"id": "2", "content": "Verify freed space", "status": "pending"},
        ]


class TestStatusOnlyUpdates:
    """A write that carries no content only flips statuses — some models send
    it as `{id, status}` items with no `merge` flag. It must never wipe the
    descriptions or drop the items it didn't mention."""

    PLAN = [
        {"id": "1", "content": "Shrink the CTA", "status": "in_progress"},
        {"id": "2", "content": "Drop the nav item", "status": "pending"},
        {"id": "3", "content": "Scroll spy", "status": "pending"},
    ]

    def _store(self):
        store = TodoStore()
        store.write(self.PLAN)
        return store

    def test_status_only_list_without_merge_keeps_descriptions(self):
        store = self._store()
        result = json.loads(todo_tool(
            todos=[
                {"id": "1", "status": "completed"},
                {"id": "2", "status": "completed"},
                {"id": "3", "status": "completed"},
            ],
            store=store,
        ))
        assert result["todos"] == [
            {"id": "1", "content": "Shrink the CTA", "status": "completed"},
            {"id": "2", "content": "Drop the nav item", "status": "completed"},
            {"id": "3", "content": "Scroll spy", "status": "completed"},
        ]

    def test_partial_status_update_without_merge_keeps_other_items(self):
        store = self._store()
        result = json.loads(todo_tool(
            todos=[
                {"id": "1", "status": "completed"},
                {"id": "2", "status": "in_progress"},
            ],
            store=store,
        ))
        assert result["todos"] == [
            {"id": "1", "content": "Shrink the CTA", "status": "completed"},
            {"id": "2", "content": "Drop the nav item", "status": "in_progress"},
            {"id": "3", "content": "Scroll spy", "status": "pending"},
        ]
        assert result["summary"]["completed"] == 1

    def test_null_content_counts_as_missing(self):
        store = self._store()
        result = store.write([
            {"id": "1", "content": None, "status": "completed"},
            {"id": "2", "content": "Drop the nav item", "status": "in_progress"},
        ])
        assert result[0] == {
            "id": "1", "content": "Shrink the CTA", "status": "completed",
        }

    def test_replace_keeps_description_of_listed_item_sent_without_one(self):
        store = self._store()
        result = store.write([
            {"id": "1", "status": "completed"},
            {"id": "4", "content": "Revised step", "status": "in_progress"},
        ])
        assert result == [
            {"id": "1", "content": "Shrink the CTA", "status": "completed"},
            {"id": "4", "content": "Revised step", "status": "in_progress"},
        ]

    def test_empty_list_still_clears(self):
        store = self._store()
        result = json.loads(todo_tool(todos=[], store=store))
        assert result["todos"] == []


class TestUndescribedNewItems:
    """A new item with no content has nothing to show but a placeholder, so
    the call is refused (and changes nothing) instead of storing one."""

    def test_new_item_without_content_is_rejected(self):
        store = TodoStore()
        store.write([{"id": "1", "content": "Shrink the CTA", "status": "pending"}])
        before = store.read()
        result = json.loads(todo_tool(
            todos=[
                {"id": "1", "status": "completed"},
                {"id": "2", "status": "in_progress"},
            ],
            merge=True,
            store=store,
        ))
        assert "error" in result
        assert "'2'" in result["error"]
        assert "'1'" not in result["error"]
        assert store.read() == before

    def test_status_only_write_to_empty_list_is_rejected(self):
        store = TodoStore()
        result = json.loads(todo_tool(
            todos=[{"id": "1", "status": "completed"}],
            store=store,
        ))
        assert "error" in result
        assert store.read() == []

    def test_described_new_item_is_accepted(self):
        store = TodoStore()
        result = json.loads(todo_tool(
            todos=[{"id": "1", "content": "Shrink the CTA", "status": "pending"}],
            store=store,
        ))
        assert "error" not in result
        assert result["todos"][0]["content"] == "Shrink the CTA"


class TestNextStepReminder:
    """While an item is open the result says what the list needs next, so a
    model that read the schema once still ticks items off as it goes."""

    def _write(self, statuses):
        store = TodoStore()
        return json.loads(todo_tool(
            todos=[
                {"id": str(i), "content": f"step {i}", "status": status}
                for i, status in enumerate(statuses, 1)
            ],
            store=store,
        ))

    def test_active_item_with_more_to_come(self):
        result = self._write(["completed", "in_progress", "pending"])
        assert result["next"].startswith("Item 2 is in progress.")
        assert "next item in_progress" in result["next"]

    def test_active_last_item_only_needs_completing(self):
        result = self._write(["completed", "in_progress"])
        assert result["next"].startswith("Item 2 is in progress.")
        assert "next item" not in result["next"]

    def test_pending_items_without_an_active_one(self):
        result = self._write(["completed", "pending"])
        assert result["next"] == "Mark the next item in_progress before you start on it."

    def test_finished_list_has_no_reminder(self):
        result = self._write(["completed", "cancelled"])
        assert "next" not in result


class TestTodoToolFunction:
    def test_read_mode(self):
        store = TodoStore()
        store.write([{"id": "1", "content": "Task", "status": "pending"}])
        result = json.loads(todo_tool(store=store))
        assert result["summary"]["total"] == 1
        assert result["summary"]["pending"] == 1


    def test_no_store_returns_error(self):
        result = json.loads(todo_tool())
        assert "error" in result


class TestTodoStoreBounds:
    """Bounds on persisted todo state (GHSA-5g4g-6jrg-mw3g hardening).

    The todo list is re-injected into context after every compression event,
    so an unbounded item — whether authored by the model or replayed from
    caller-supplied history on the API server's _hydrate_todo_store path —
    would defeat the compression it rides through. These pin the caps.
    Not a security boundary (the API surface is authenticated and the caller
    supplies their own history); this is footgun containment / parity.
    """

    def test_oversized_content_is_truncated(self):
        from tools.todo_tool import MAX_TODO_CONTENT_CHARS
        store = TodoStore()
        store.write([{"id": "1", "content": "A" * 50001, "status": "pending"}])
        item = store.read()[0]
        assert len(item["content"]) <= MAX_TODO_CONTENT_CHARS
        assert item["content"].endswith("… [truncated]")

    def test_injection_block_is_bounded(self):
        from tools.todo_tool import MAX_TODO_CONTENT_CHARS
        store = TodoStore()
        store.write([{"id": "1", "content": "A" * 50001, "status": "pending"}])
        inj = store.format_for_injection()
        # Before the fix this was ~50085 chars; now it tracks the cap.
        assert len(inj) < MAX_TODO_CONTENT_CHARS + 200


    def test_item_count_is_bounded(self):
        from tools.todo_tool import MAX_TODO_ITEMS
        store = TodoStore()
        store.write([
            {"id": str(i), "content": f"task {i}", "status": "pending"}
            for i in range(5000)
        ])
        assert len(store.read()) == MAX_TODO_ITEMS

    def test_normal_list_is_unchanged(self):
        """No regression: ordinary plans pass through untouched (no marker,
        same content, same order)."""
        store = TodoStore()
        store.write([
            {"id": "1", "content": "write the report", "status": "in_progress"},
            {"id": "2", "content": "review PR", "status": "pending"},
        ])
        items = store.read()
        assert [i["content"] for i in items] == ["write the report", "review PR"]
        assert "[truncated]" not in items[0]["content"]
