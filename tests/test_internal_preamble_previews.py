"""Session previews show the conversation, not AgentX's own preamble.

Pilot feedback 2026-11-10: on the Trợ lý page a routine's run was listed as
"[IMPORTANT: You are running as a scheduled cron job. DELIVER…" and assistants
as "[System: The active model for th…". Both are text AgentX writes into a
user turn; neither is something the person said.
"""

from __future__ import annotations

import pytest

from hermes_constants import CRON_HINT_PREFIX, MODEL_SWITCH_MARKER_PREFIX
from hermes_state import SessionDB
from hermes_state_common import _shape_preview, strip_internal_preamble


def _cron_prompt(task: str) -> str:
    """A prompt exactly as the scheduler builds it."""
    from cron.scheduler import _build_job_prompt

    return _build_job_prompt({"id": "job1", "name": "Bản tin", "prompt": task})


@pytest.fixture
def db(tmp_path):
    database = SessionDB(tmp_path / "state.db")
    yield database
    database.close()


def test_the_scheduler_builds_its_hint_from_the_shared_prefix():
    prompt = _cron_prompt("Tóm tắt tin tài chính hôm nay")
    assert prompt.startswith(CRON_HINT_PREFIX)
    assert prompt.endswith("Tóm tắt tin tài chính hôm nay")


@pytest.mark.parametrize("task", [
    "Tóm tắt tin tài chính hôm nay",
    "Dòng một\n\nDòng hai có [ngoặc] và ]\n\n nữa",
    "x" * 2000,
])
def test_strip_leaves_exactly_the_task(task):
    assert strip_internal_preamble(_cron_prompt(task)) == task


def test_strip_leaves_ordinary_text_untouched():
    for text in ("Xin chào", "[IMPORTANT] đọc kỹ nhé", "  thụt đầu dòng", ""):
        assert strip_internal_preamble(text) == text
    assert strip_internal_preamble(None) == ""


def test_a_model_switch_marker_is_not_a_message():
    marker = f"{MODEL_SWITCH_MARKER_PREFIX}deepseek-v4.1-flash via provider custom. From this point forward…]"
    assert strip_internal_preamble(marker) == ""
    assert _shape_preview(marker) == ""


def test_a_hint_cut_off_mid_way_yields_nothing_rather_than_the_hint():
    assert strip_internal_preamble(CRON_HINT_PREFIX + "DELIVERY: Your final") == ""


def test_session_list_preview_of_a_cron_run_is_the_task(db):
    db.create_session("cron_job1_1", source="cron")
    db.append_message("cron_job1_1", role="user", content=_cron_prompt("Tóm tắt tin tài chính hôm nay"))

    row = next(s for s in db.list_sessions_rich(limit=10) if s["id"] == "cron_job1_1")

    assert row["preview"] == "Tóm tắt tin tài chính hôm nay"


def test_session_list_preview_of_a_long_cron_task_is_its_opening(db):
    task = "Tìm hiểu thị trường tài chính trong nước và thế giới, theo dõi tin mới nhất về giá nhà, đất, vàng. " * 20
    db.create_session("cron_job1_2", source="cron")
    db.append_message("cron_job1_2", role="user", content=_cron_prompt(task))

    row = next(s for s in db.list_sessions_rich(limit=10) if s["id"] == "cron_job1_2")

    assert row["preview"].startswith("Tìm hiểu thị trường tài chính")
    assert "IMPORTANT" not in row["preview"]


def test_session_list_preview_of_an_ordinary_chat_is_unchanged(db):
    db.create_session("s1", source="desktop")
    db.append_message("s1", role="user", content="Viết giúp tôi email xin nghỉ phép")

    row = next(s for s in db.list_sessions_rich(limit=10) if s["id"] == "s1")

    assert row["preview"] == "Viết giúp tôi email xin nghỉ phép"
