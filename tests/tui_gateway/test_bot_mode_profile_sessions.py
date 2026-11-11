"""Bot Mode sessions on other profiles: never resurrect a deleted profile,
create an assistant's main conversation without a fake first message, keep
group-room plumbing out of every list, and fail loudly on unknown profiles.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_state import SessionDB
from tui_gateway import server


@pytest.fixture
def profiles_root(tmp_path, monkeypatch):
    root = tmp_path / "profiles"
    root.mkdir()

    def profile_home(name):
        name = (name or "").strip()
        if not name or name == "default":
            return None
        home = root / name
        return home if home.exists() else None

    monkeypatch.setattr(server, "_profile_home", profile_home)
    monkeypatch.setattr(server, "_current_profile_name", lambda: "default")
    monkeypatch.setattr(server, "_start_agent_build", lambda *a, **k: None)
    monkeypatch.setattr(server, "_schedule_agent_build", lambda *a, **k: None)
    monkeypatch.setattr(server, "_completion_cwd", lambda params=None: str(tmp_path))
    return root


def _make_profile(root: Path, name: str) -> Path:
    home = root / name
    home.mkdir()
    return home


def _call(method: str, params: dict) -> dict:
    return server._methods[method]("r1", params)


# ── a deleted profile is never re-created ──────────────────────────────────


def test_open_profile_session_db_refuses_a_deleted_home(tmp_path):
    gone = tmp_path / "profiles" / "writer"

    with pytest.raises(server.ProfileHomeGone):
        server._open_profile_session_db(gone)

    assert not gone.exists()


def test_session_db_and_row_persist_never_mkdir_a_deleted_profile(tmp_path):
    gone = tmp_path / "profiles" / "writer"
    session = {"session_key": "k1", "profile_home": str(gone), "source": "bot-room"}

    with server._session_db(session) as db:
        assert db is None
    server._ensure_session_db_row(session)

    assert not gone.exists()
    assert not gone.parent.exists()


def test_close_sessions_for_profile_home_closes_only_that_profile(
    tmp_path, monkeypatch
):
    writer = tmp_path / "profiles" / "writer"
    closed: list[str] = []
    monkeypatch.setattr(
        server, "_close_session_by_id", lambda sid, **kw: closed.append(sid) or True
    )
    monkeypatch.setitem(server._sessions, "a", {"profile_home": str(writer)})
    monkeypatch.setitem(
        server._sessions, "b", {"profile_home": str(tmp_path / "profiles" / "other")}
    )
    monkeypatch.setitem(server._sessions, "c", {"profile_home": None})

    assert server.close_sessions_for_profile_home(writer) == 1
    assert closed == ["a"]


def test_delete_route_closes_live_sessions_before_removing_the_profile(
    tmp_path, monkeypatch
):
    from hermes_cli import profiles as profiles_mod
    from hermes_cli.web_routers import profiles as route

    home = tmp_path / "profiles" / "writer"
    seen: list[Path] = []
    order: list[str] = []
    monkeypatch.setattr(profiles_mod, "get_profile_dir", lambda name: home)
    monkeypatch.setattr(
        server,
        "close_sessions_for_profile_home",
        lambda path: seen.append(Path(path)) or order.append("close") or 0,
    )
    monkeypatch.setattr(
        profiles_mod,
        "delete_profile",
        lambda name, yes=False: order.append("delete") or home,
    )

    import asyncio

    result = asyncio.run(route.delete_profile_endpoint("writer"))

    assert result["ok"] is True
    assert seen == [home]
    assert order == ["close", "delete"]


# ── main conversation without a fake first message ─────────────────────────


def test_persist_only_creates_an_empty_titled_conversation_without_a_runtime(
    profiles_root,
):
    _make_profile(profiles_root, "writer")
    before = set(server._sessions)

    resp = _call(
        "session.create",
        {
            "profile": "writer",
            "title": "Bot Chat",
            "persist_only": True,
            "strict_profile": True,
        },
    )

    assert "result" in resp, resp
    stored = resp["result"]["stored_session_id"]
    assert set(server._sessions) == before  # no runtime, no agent build

    db = SessionDB(db_path=profiles_root / "writer" / "state.db")
    try:
        assert db.get_session(stored) is not None
        assert db.get_session_title(stored) == "Bot Chat"
    finally:
        db.close()

    listed = _call("session.list", {"profile": "writer", "strict_profile": True})[
        "result"
    ]["sessions"]
    row = next(row for row in listed if row["id"] == stored)
    assert row["title"] == "Bot Chat"
    assert row["last_active"] > 0


def test_persist_only_returns_the_existing_conversation_and_leaves_no_orphan(
    profiles_root,
):
    """Creating "Bot Chat" twice is one conversation, not an error + a stray row.

    The client creates it when its (windowed) list does not show one. If the
    list merely missed it, the unique-title index used to fail the create and
    leave an empty untitled row behind on every attempt.
    """
    _make_profile(profiles_root, "writer")
    params = {
        "profile": "writer",
        "title": "Bot Chat",
        "persist_only": True,
        "strict_profile": True,
    }

    first = _call("session.create", params)["result"]
    second = _call("session.create", params)["result"]

    assert second["stored_session_id"] == first["stored_session_id"]
    assert second["existing"] is True

    db = SessionDB(db_path=profiles_root / "writer" / "state.db")
    try:
        rows = db.list_sessions_rich(limit=50)
    finally:
        db.close()
    assert [row["id"] for row in rows] == [first["stored_session_id"]]


def test_session_list_can_leave_scheduled_runs_out_of_its_window(profiles_root):
    home = _make_profile(profiles_root, "writer")
    _seed(
        home / "state.db",
        [
            ("main", "desktop", "Bot Chat", "Bản nháp đây"),
            ("cron_j1_1", "cron", "Bản tin · 2026-11-10 21:00", "Tin hôm nay"),
        ],
    )

    def ids(extra):
        rows = _call("session.list", {"profile": "writer", **extra})["result"]["sessions"]
        return sorted(row["id"] for row in rows)

    assert ids({}) == ["cron_j1_1", "main"]
    assert ids({"exclude_sources": ["cron"]}) == ["main"]
    # A malformed value is ignored, not an error.
    assert ids({"exclude_sources": "cron"}) == ["cron_j1_1", "main"]


def test_strict_profile_refuses_an_unknown_profile_instead_of_using_the_main_one(
    profiles_root,
):
    created = _call(
        "session.create",
        {"profile": "ghost", "title": "Group: X", "strict_profile": True},
    )
    listed = _call("session.list", {"profile": "ghost", "strict_profile": True})

    assert created["error"]["code"] == 4044
    assert listed["error"]["code"] == 4044
    assert not (profiles_root / "ghost").exists()


# ── group-room plumbing stays out of every list ────────────────────────────


def _seed(db_path: Path, rows: list[tuple[str, str, str, str]]) -> None:
    db = SessionDB(db_path=db_path)
    try:
        for key, source, title, text in rows:
            db.create_session(key, source=source, model="m")
            if title:
                db.set_session_title(key, title)
            db.append_message(key, "user", "hỏi")
            db.append_message(key, "assistant", text)
    finally:
        db.close()


def test_session_list_and_roster_preview_skip_group_room_sessions(
    profiles_root, monkeypatch
):
    home = _make_profile(profiles_root, "writer")
    _seed(
        home / "state.db",
        [
            ("main", "desktop", "Bot Chat", "Bản nháp đây"),
            ("old-room", "desktop", "Group: Marketing", "(pass)"),
            ("room", "bot-room", "Group: Sales", "(pass)"),
        ],
    )

    listed = _call("session.list", {"profile": "writer"})["result"]["sessions"]
    assert [row["id"] for row in listed if row["id"] != "old-room"] == ["main"]
    assert all(row["source"] != "bot-room" for row in listed)

    from hermes_cli import profiles as profiles_mod

    monkeypatch.setattr(
        profiles_mod,
        "list_profiles",
        lambda: [
            SimpleNamespace(
                name="writer", path=home, is_default=False, model=None, provider=None
            )
        ],
    )
    roster = _call("profiles.list", {})["result"]["profiles"]

    assert roster[0]["last_session"]["id"] == "main"
    assert roster[0]["last_session"]["preview"] == "Bản nháp đây"


def _roster_preview(profiles_root, monkeypatch, name, build):
    home = _make_profile(profiles_root, name)
    db = SessionDB(db_path=home / "state.db")
    try:
        db.create_session("main", source="desktop", model="m")
        build(db)
    finally:
        db.close()

    from hermes_cli import profiles as profiles_mod

    monkeypatch.setattr(
        profiles_mod,
        "list_profiles",
        lambda: [
            SimpleNamespace(
                name=name, path=home, is_default=False, model=None, provider=None
            )
        ],
    )
    roster = _call("profiles.list", {})["result"]["profiles"]
    return roster[0]["last_session"]["preview"]


def test_roster_preview_skips_a_model_switch_marker(profiles_root, monkeypatch):
    """Pilot 2026-11-10: an assistant's row read "[System: The active model for th…"."""
    from hermes_constants import MODEL_SWITCH_MARKER_PREFIX

    def build(db):
        db.append_message("main", "user", "Giá vàng hôm nay thế nào?")
        db.append_message("main", "assistant", "Vàng SJC đang ở mức 92 triệu.")
        db.append_message(
            "main",
            "user",
            f"{MODEL_SWITCH_MARKER_PREFIX}deepseek-v4.1-flash. From this point forward…]",
            display_kind="model_switch",
        )

    assert _roster_preview(profiles_root, monkeypatch, "nghien-cuu", build) == "Vàng SJC đang ở mức 92 triệu."


def test_roster_preview_of_a_failed_cron_run_is_the_task_not_the_hint(
    profiles_root, monkeypatch
):
    """…and another read "[IMPORTANT: You are running as…"."""
    from cron.scheduler import _build_job_prompt

    def build(db):
        db.append_message(
            "main",
            "user",
            _build_job_prompt({"id": "j1", "name": "Bản tin", "prompt": "Tóm tắt tin tài chính hôm nay"}),
        )

    assert (
        _roster_preview(profiles_root, monkeypatch, "tai-chinh", build)
        == "Tóm tắt tin tài chính hôm nay"
    )


# ── titles land in the session's own db; old ghosts are swept ──────────────


def test_auto_title_db_is_the_sessions_own(monkeypatch):
    launch = object()
    own = object()
    monkeypatch.setattr(server, "_get_db", lambda: launch)

    assert (
        server._title_db_for({"profile_home": None}, SimpleNamespace(_session_db=own))
        is launch
    )
    assert (
        server._title_db_for(
            {"profile_home": "/p/writer"}, SimpleNamespace(_session_db=own)
        )
        is own
    )
    # No handle for that profile: no title beats a ghost in the main list.
    assert (
        server._title_db_for({"profile_home": "/p/writer"}, SimpleNamespace()) is None
    )


def test_delete_title_ghost_sessions_removes_only_the_ghost_shape(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        old = 1_000.0
        # The ghost: what accounting + a mis-routed title left behind.
        db.record_auxiliary_usage(
            "ghost", "title_generation", model="m", input_tokens=5
        )
        db.set_session_title("ghost", "Hội đồng chấm đồ án")
        # Look-alikes that must survive.
        db.create_session("real", source="desktop", model="m")
        db.set_session_title("real", "Bot Chat")  # empty main conversation
        db.record_auxiliary_usage("untitled", "title_generation", model="m")
        db.record_auxiliary_usage("talked", "title_generation", model="m")
        db.set_session_title("talked", "Có tin nhắn")
        db.append_message("talked", "user", "hi")
        db.record_auxiliary_usage("fresh", "title_generation", model="m")
        db.set_session_title("fresh", "Đang đặt tên")

        with db._lock:
            db._conn.execute(
                "UPDATE sessions SET started_at = ? WHERE id != 'fresh'", (old,)
            )
            db._conn.commit()

        assert db.delete_title_ghost_sessions(min_age_seconds=600) == 1
        assert db.get_session("ghost") is None
        for keep in ("real", "untitled", "talked", "fresh"):
            assert db.get_session(keep) is not None, keep
    finally:
        db.close()
