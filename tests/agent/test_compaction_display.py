"""Transcript-UI projection of compacted sessions (agent/compaction_display.py).

In-place compaction archives every live row and re-inserts head copies, the
summary handoff and tail copies. The display projection must show each
original turn once, a single divider where the context was summarized, and
tell the client how many model-history user turns sit behind that divider so
rewind/edit ordinals still line up with prompt.submit.
"""

from pathlib import Path

import pytest

from agent.compaction_display import fold_compaction_display
from agent.context_compressor import (
    SUMMARY_PREFIX,
    _MERGED_PRIOR_CONTEXT_HEADER,
    _MERGED_SUMMARY_DELIMITER,
    _PRUNED_TOOL_PLACEHOLDER,
    _SUMMARY_END_MARKER,
    split_compaction_summary,
)

BODY = "## Goal\nBuild the slide deck.\n\n## Completed Actions\n- Wrote slide 1"


def _summary(body: str = BODY) -> str:
    return f"{SUMMARY_PREFIX}\n{body}\n\n{_SUMMARY_END_MARKER}"


def _msg(role, content, ts, **extra):
    return {"role": role, "content": content, "timestamp": ts, **extra}


def _original_transcript():
    call = {"id": "call_1", "type": "function", "function": {"name": "terminal", "arguments": "{}"}}
    return [
        _msg("user", "make me a deck", 1.0),
        _msg("assistant", "on it", 2.0),
        _msg("user", "add slide 2", 3.0),
        _msg("assistant", "", 4.0, tool_calls=[call]),
        _msg("tool", "x" * 500, 5.0, tool_call_id="call_1"),
        _msg("assistant", "slide 2 done", 6.0),
    ]


def _archived(rows):
    return [dict(r, _archived=True) for r in rows]


def _compacted_block(originals, *, summary_role="user"):
    """head = first exchange, tail = last tool round, as compress() keeps them."""
    head = [dict(m) for m in originals[:2]]
    tail = [dict(m) for m in originals[3:]]
    tail[1]["content"] = _PRUNED_TOOL_PLACEHOLDER  # the compactor pruned it
    return head + [{"role": summary_role, "content": _summary(), "timestamp": 99.0}] + tail


def _user_ordinal(history, text):
    users = [m for m in history if m.get("role") == "user" and not m.get("display_kind")]
    return next(i for i, m in enumerate(users) if m["content"] == text)


class TestSplit:
    def test_standalone_summary(self):
        assert split_compaction_summary(_summary()) == (BODY, "")

    def test_forced_user_leading_keeps_live_request(self):
        content = f"{_summary()}\n\nnow do slide 3"
        assert split_compaction_summary(content) == (BODY, "now do slide 3")

    def test_merged_into_tail_keeps_prior_content(self):
        content = (
            f"{_MERGED_PRIOR_CONTEXT_HEADER}\nslide 2 done\n\n{_MERGED_SUMMARY_DELIMITER}\n\n"
            f"{_summary()}"
        )
        assert split_compaction_summary(content) == (BODY, "slide 2 done")

    def test_plain_message(self):
        assert split_compaction_summary("hello") is None


class TestFold:
    def test_restores_originals_and_drops_copies(self):
        originals = _original_transcript()
        live = _compacted_block(originals) + [
            _msg("user", "now do slide 3", 100.0),
            _msg("assistant", "slide 3 done", 101.0),
        ]
        out = fold_compaction_display(_archived(originals) + live)

        assert [m["content"] for m in out[:6]] == [m["content"] for m in originals]
        divider = out[6]
        assert divider["display_kind"] == "compaction"
        assert divider["content"] == BODY
        assert [m["content"] for m in out[7:]] == ["now do slide 3", "slide 3 done"]

        # Ordinal contract: offset + the client's own count after the divider
        # is the prompt.submit ordinal of the same turn.
        offset = divider["display_metadata"]["compaction"]["user_turns_before"]
        assert offset + 0 == _user_ordinal(live, "now do slide 3")

    def test_assistant_summary_is_not_a_user_turn(self):
        originals = _original_transcript()
        live = _compacted_block(originals, summary_role="assistant") + [
            _msg("user", "next", 100.0)
        ]
        out = fold_compaction_display(_archived(originals) + live)
        divider = next(m for m in out if m.get("display_kind") == "compaction")
        assert divider["display_metadata"]["compaction"]["user_turns_before"] == _user_ordinal(live, "next")

    def test_live_only_history_keeps_every_row(self):
        originals = _original_transcript()
        live = _compacted_block(originals) + [_msg("user", "next", 100.0)]
        out = fold_compaction_display(live)

        assert len(out) == len(live)
        divider = out[2]
        assert divider["display_kind"] == "compaction"
        # Head copies are shown before the divider, so they are behind it too.
        offset = divider["display_metadata"]["compaction"]["user_turns_before"]
        shown_after = [m for m in out[3:] if m["role"] == "user"]
        assert offset + shown_after.index(out[-1]) == _user_ordinal(live, "next")

    def test_without_timestamps_falls_back_to_content(self):
        originals = [{k: v for k, v in m.items() if k != "timestamp"} for m in _original_transcript()]
        live = [{k: v for k, v in m.items() if k != "timestamp"} for m in _compacted_block(originals)]
        live.append({"role": "user", "content": "next"})
        out = fold_compaction_display(_archived(originals) + live)
        assert [m["content"] for m in out[:6]] == [m["content"] for m in originals]
        assert out[6]["display_kind"] == "compaction"
        assert [m["content"] for m in out[7:]] == ["next"]

    def test_new_request_carried_by_the_summary_is_shown(self):
        # Forced user-leading: the summary was prepended to the current turn's
        # request, which was never persisted before the compaction.
        originals = _original_transcript()
        head = [dict(m) for m in originals[:2]]
        carrier = _msg("user", f"{_summary()}\n\nnow do slide 3", 100.0)
        live = head + [carrier]
        out = fold_compaction_display(_archived(originals) + live)

        assert [m.get("display_kind") for m in out[6:]] == ["compaction", None]
        assert out[7]["content"] == "now do slide 3"
        offset = out[6]["display_metadata"]["compaction"]["user_turns_before"]
        assert offset == _user_ordinal(live, carrier["content"])

    def test_merged_carrier_of_a_copied_row_is_not_repeated(self):
        originals = _original_transcript()
        head = [dict(m) for m in originals[:2]]
        carrier = dict(originals[5])
        carrier["content"] = (
            f"{_MERGED_PRIOR_CONTEXT_HEADER}\nslide 2 done\n\n{_MERGED_SUMMARY_DELIMITER}\n\n{_summary()}"
        )
        live = head + [carrier, _msg("user", "next", 100.0)]
        out = fold_compaction_display(_archived(originals) + live)

        assert [m["content"] for m in out[:6]] == [m["content"] for m in originals]
        assert out[6]["display_kind"] == "compaction"
        assert [m["content"] for m in out[7:]] == ["next"]

    def test_two_compactions_show_two_dividers(self):
        originals = _original_transcript()
        block1 = _compacted_block(originals) + [
            _msg("user", "slide 3", 100.0),
            _msg("assistant", "slide 3 done", 101.0),
        ]
        head = [dict(m) for m in originals[:2]]
        tail = [dict(block1[-2]), dict(block1[-1])]
        block2 = head + [{"role": "user", "content": _summary("second body"), "timestamp": 200.0}] + tail
        block2.append(_msg("user", "slide 4", 201.0))

        out = fold_compaction_display(_archived(originals) + _archived(block1) + block2)
        contents = [m["content"] for m in out]
        assert contents == [m["content"] for m in originals] + [
            BODY,
            "slide 3",
            "slide 3 done",
            "second body",
            "slide 4",
        ]
        last = out[-2]
        assert last["display_metadata"]["compaction"]["user_turns_before"] == _user_ordinal(block2, "slide 4")

    def test_untouched_without_summary(self):
        rows = _original_transcript()
        assert fold_compaction_display(rows) is rows

    def test_idempotent(self):
        originals = _original_transcript()
        once = fold_compaction_display(_archived(originals) + _compacted_block(originals))
        assert fold_compaction_display(once) == once


class TestSessionDB:
    @pytest.fixture()
    def db(self, tmp_path: Path):
        from hermes_state import SessionDB

        db = SessionDB(db_path=tmp_path / "state.db")
        yield db
        db.close()

    def _seed_and_compact(self, db):
        sid = "s1"
        db.create_session(sid, "desktop", model="m")
        originals = _original_transcript()
        for m in originals:
            db.append_message(session_id=sid, **{k: v for k, v in m.items()})
        loaded = db.get_messages_as_conversation(sid)
        db.archive_and_compact(sid, _compacted_block(loaded))
        db.append_message(session_id=sid, role="user", content="now do slide 3", timestamp=100.0)
        return sid, originals

    def test_resume_display_restores_history_model_stays_compacted(self, db):
        sid, originals = self._seed_and_compact(db)

        model, display = db.get_resume_conversations(sid, include_compacted=True)
        assert [m["content"] for m in model][2].startswith(SUMMARY_PREFIX)
        assert [m["content"] for m in display] == [m["content"] for m in originals] + [
            BODY,
            "now do slide 3",
        ]
        divider = display[6]
        assert divider["display_metadata"]["compaction"]["user_turns_before"] == _user_ordinal(
            model, "now do slide 3"
        )
        assert all(m.get("_row_id") for m in display)

        # The default projection is unchanged.
        _, plain = db.get_resume_conversations(sid)
        assert [m["content"] for m in plain] == [m["content"] for m in model]

    def test_conversation_and_raw_reads_agree(self, db):
        sid, originals = self._seed_and_compact(db)
        conversation = db.get_messages_as_conversation(
            sid, include_ancestors=True, include_row_ids=True, include_compacted=True
        )
        raw = db.get_messages(sid, include_compacted=True)
        assert [m["content"] for m in conversation] == [m["content"] for m in raw]
        assert raw[6]["display_kind"] == "compaction"
        assert db.get_messages(sid, include_compacted=True, limit=2, offset=6)[0]["content"] == BODY


class TestGatewayProjection:
    def test_live_only_handoff_renders_as_divider(self):
        from tui_gateway.server import _history_to_messages

        live = _compacted_block(_original_transcript()) + [_msg("user", "next", 100.0)]
        rows = _history_to_messages(live)

        kinds = [(r["role"], r.get("display_kind")) for r in rows]
        assert ("user", "compaction") in kinds
        divider = next(r for r in rows if r.get("display_kind") == "compaction")
        assert divider["text"] == BODY
        assert divider["display_metadata"]["compaction"]["user_turns_before"] == _user_ordinal(live, "next")
        assert not any(SUMMARY_PREFIX in (r.get("text") or "") for r in rows)


class TestRewindAfterCompaction:
    def test_rewind_keeps_the_turns_above_the_divider(self, tmp_path: Path):
        """prompt.submit's truncation rewrites live rows only, so a rewind or
        edit after the divider leaves the archived turns on screen."""
        from hermes_state import SessionDB

        db = SessionDB(db_path=tmp_path / "state.db")
        try:
            sid, originals = TestSessionDB()._seed_and_compact(db)
            model = db.get_messages_as_conversation(sid)
            db.replace_messages(sid, model[:-1], active_only=True)  # rewind the last turn
            db.append_message(session_id=sid, role="user", content="edited request", timestamp=300.0)

            _, display = db.get_resume_conversations(sid, include_compacted=True)
            assert [m["content"] for m in display] == [m["content"] for m in originals] + [
                BODY,
                "edited request",
            ]
        finally:
            db.close()
