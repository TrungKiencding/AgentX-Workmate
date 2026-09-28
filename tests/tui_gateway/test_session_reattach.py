"""A client that drops and comes back must be able to pick its sessions up again.

When a desktop WebSocket closes, every session bound to it is parked on the
``_detached_ws_transport`` drop sentinel: whatever it emits from then on is
discarded until a client re-attaches it (``session.activate`` /
``session.resume`` / ``prompt.submit``). The desktop re-attaches the chats it
shows, so the backend's side of the contract is:

* a session that was mid-turn at disconnect is watched until its turn ends,
  then reclaimed (with ``session.reclaimed``) if nobody came back for it —
  not parked for the hours-scale idle TTL;
* a re-attach that arrives on a socket which has itself closed never binds the
  session to that dead socket (the orphan reaper would never recognise it);
* the questions a session is blocked on (clarify / sudo / secret) come back in
  the re-attach payload, because their one-shot ``*.request`` events were
  discarded while nobody was listening.
"""

from __future__ import annotations

import threading
import types

import pytest

from tui_gateway import server
from tui_gateway.transport import bind_transport, reset_transport


def _session(**extra):
    return {
        "agent": types.SimpleNamespace(model="model-live"),
        "session_key": "stored-1",
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": False,
        "attached_images": [],
        "image_counter": 0,
        "cols": 80,
        "slash_worker": None,
        "show_reasoning": False,
        "tool_progress_mode": "all",
        **extra,
    }


class _Socket:
    """A WS transport stand-in; ``_closed`` is what the reaper inspects."""

    def __init__(self, closed: bool = False) -> None:
        self._closed = closed
        self.frames: list[dict] = []

    def write(self, obj: dict) -> bool:
        self.frames.append(obj)
        return not self._closed


class _ManualTimer:
    """Collects the orphan-reap callbacks so a test fires them on its own clock."""

    armed: list = []

    def __init__(self, _delay, callback):
        self.callback = callback
        _ManualTimer.armed.append(self)

    def start(self):
        return None


@pytest.fixture
def manual_timers(monkeypatch):
    _ManualTimer.armed = []
    monkeypatch.setattr(server, "_WS_ORPHAN_REAP_GRACE_S", 20.0)
    monkeypatch.setattr(server.threading, "Timer", _ManualTimer)
    return _ManualTimer.armed


@pytest.fixture
def registry(monkeypatch):
    sessions: dict[str, dict] = {}
    monkeypatch.setattr(server, "_sessions", sessions)
    monkeypatch.setattr(server, "_session_has_active_delegations", lambda *_a, **_k: False)
    return sessions


def _fire_next(timers: list) -> None:
    timer = timers.pop(0)
    timer.callback()


class TestOrphanReapFollowsTheTurn:
    def test_session_busy_at_the_deadline_is_reaped_once_its_turn_ends(
        self, manual_timers, registry, monkeypatch
    ):
        torn_down: list[tuple[dict, str]] = []
        monkeypatch.setattr(
            server,
            "_teardown_session",
            lambda session, *, end_reason="tui_close": torn_down.append((session, end_reason)),
        )
        registry["sid"] = _session(transport=server._detached_ws_transport, running=True)

        server._schedule_ws_orphan_reap("sid")
        _fire_next(manual_timers)

        # Mid-turn: spared, but still watched.
        assert "sid" in registry
        assert len(manual_timers) == 1

        registry["sid"]["running"] = False
        _fire_next(manual_timers)

        assert "sid" not in registry
        assert [reason for _s, reason in torn_down] == ["ws_orphan_reap"]
        assert manual_timers == []

    def test_watch_ends_when_a_client_reattaches_the_session(self, manual_timers, registry):
        registry["sid"] = _session(transport=server._detached_ws_transport, running=True)

        server._schedule_ws_orphan_reap("sid")
        registry["sid"]["transport"] = _Socket()
        _fire_next(manual_timers)

        assert "sid" in registry
        assert manual_timers == []

    def test_reclaim_of_a_finished_orphan_is_announced(self, manual_timers, registry, monkeypatch):
        announced: list[tuple[str, dict]] = []
        monkeypatch.setattr(server, "_finalize_session", lambda *_a, **_k: None)
        monkeypatch.setattr(
            server, "_broadcast_global_event", lambda event, payload=None: announced.append((event, payload))
        )
        registry["sid"] = _session(transport=server._detached_ws_transport, running=True)

        server._schedule_ws_orphan_reap("sid")
        _fire_next(manual_timers)
        registry["sid"]["running"] = False
        _fire_next(manual_timers)

        assert announced == [
            (
                "session.reclaimed",
                {"session_id": "sid", "stored_session_id": "stored-1", "reason": "ws_orphan_reap"},
            )
        ]


class TestReattachNeverBindsAClosedSocket:
    def test_activate_from_a_closed_socket_keeps_the_session_detached(self, registry):
        registry["sid"] = _session(transport=server._detached_ws_transport)

        payload = server._live_session_payload("sid", registry["sid"], transport=_Socket(closed=True))

        assert payload["session_id"] == "sid"
        assert registry["sid"]["transport"] is server._detached_ws_transport

    def test_activate_from_a_live_socket_rebinds(self, registry):
        registry["sid"] = _session(transport=server._detached_ws_transport)
        socket = _Socket()

        server._live_session_payload("sid", registry["sid"], transport=socket)

        assert registry["sid"]["transport"] is socket

    def test_prompt_submit_from_a_closed_socket_does_not_steal_the_binding(self, registry, monkeypatch):
        live = _Socket()
        registry["sid"] = _session(transport=live, running=True)
        monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_a: None)
        monkeypatch.setattr(server, "_session_uses_compute_host", lambda *_a: False)
        monkeypatch.setattr(server, "_load_dashboard_process_isolation_config", lambda: {})
        monkeypatch.setattr(
            server, "_handle_busy_submit", lambda rid, *_a, **_k: server._ok(rid, {"status": "queued"})
        )

        token = bind_transport(_Socket(closed=True))
        try:
            response = server.handle_request(
                {"id": "1", "method": "prompt.submit", "params": {"session_id": "sid", "text": "next"}}
            )
        finally:
            reset_transport(token)

        assert response["result"]["status"] == "queued"
        assert registry["sid"]["transport"] is live

    def test_queued_prompt_typed_on_a_socket_that_closed_keeps_the_current_one(self, registry):
        current = _Socket()
        session = _session(
            transport=current,
            queued_prompt={"text": "queued", "transport": _Socket(closed=True)},
        )

        assert server._bind_session_transport(session, session["queued_prompt"]["transport"]) is False
        assert session["transport"] is current

    def test_stdio_transport_is_never_treated_as_closed(self):
        session = _session(transport=server._detached_ws_transport)

        assert server._bind_session_transport(session, server._stdio_transport) is True
        assert session["transport"] is server._stdio_transport

    def test_session_stranded_on_a_closed_socket_is_handed_to_the_orphan_reaper(
        self, manual_timers, registry
    ):
        # A create/resume that was in flight when its socket dropped registers
        # against the dead socket after the disconnect sweep already ran.
        registry["stranded"] = _session(transport=_Socket(closed=True))
        registry["healthy"] = _session(transport=_Socket())
        registry["stdio"] = _session(transport=server._stdio_transport)

        server._detach_sessions_on_closed_sockets()

        assert registry["stranded"]["transport"] is server._detached_ws_transport
        assert registry["healthy"]["transport"] is not server._detached_ws_transport
        assert registry["stdio"]["transport"] is server._stdio_transport
        assert len(manual_timers) == 1


class TestPendingPromptsRideTheReattachPayload:
    @pytest.fixture
    def prompts(self, monkeypatch):
        pending: dict = {}
        payloads: dict = {}
        monkeypatch.setattr(server, "_pending", pending)
        monkeypatch.setattr(server, "_pending_prompt_payloads", payloads)

        def raise_prompt(rid: str, sid: str, event: str, payload: dict) -> None:
            pending[rid] = (sid, threading.Event())
            payloads[rid] = (event, {**payload, "request_id": rid})

        return raise_prompt

    def test_blocked_question_comes_back_on_activate(self, registry, prompts):
        registry["sid"] = _session(transport=server._detached_ws_transport, running=True)
        prompts("r-clarify", "sid", "clarify.request", {"question": "Pick one?", "choices": ["a", "b"]})

        activated = server.handle_request(
            {"id": "1", "method": "session.activate", "params": {"session_id": "sid", "omit_messages": True}}
        )

        assert activated["result"]["pending_prompts"] == [
            {
                "event": "clarify.request",
                "payload": {"question": "Pick one?", "choices": ["a", "b"], "request_id": "r-clarify"},
            }
        ]

    def test_only_questions_for_a_person_and_only_this_sessions(self, registry, prompts):
        registry["sid"] = _session(running=True)
        prompts("r-sudo", "sid", "sudo.request", {})
        prompts("r-term", "sid", "terminal.read.request", {"start": 0})
        prompts("r-other", "other-sid", "clarify.request", {"question": "not yours"})
        prompts("r-secret", "sid", "secret.request", {"env_var": "API_KEY", "prompt": "Key?"})

        payload = server._live_session_payload("sid", registry["sid"], omit_messages=True)

        assert [p["payload"]["request_id"] for p in payload["pending_prompts"]] == ["r-sudo", "r-secret"]

    def test_idle_session_payload_has_no_prompt_key(self, registry, prompts):
        registry["sid"] = _session()

        payload = server._live_session_payload("sid", registry["sid"], omit_messages=True)

        assert "pending_prompts" not in payload


class TestReattachReportsTheChatsOwnModel:
    """Desktop writes a re-attach's ``info.model``/``provider`` straight into the
    picker. A session whose agent is still being built must answer with the pick
    the chat made, or every reconnect flips that pick to the profile default."""

    @pytest.fixture(autouse=True)
    def profile_default(self, monkeypatch):
        monkeypatch.setattr(server, "_resolve_model", lambda: "profile-default")

    @pytest.mark.parametrize(
        ("extra", "expected"),
        [
            (
                {"model_override": {"model": "chat-pick", "provider": "chat-provider"}},
                ("chat-pick", "chat-provider"),
            ),
            (
                {
                    "model_override": {"model": "chat-pick", "provider": "chat-provider"},
                    "pending_model_switch": {"display_model": "next-pick", "display_provider": "next-provider"},
                },
                ("next-pick", "next-provider"),
            ),
            (
                {"_metadata_mirror": {"model": "host-model", "provider": "host-provider"}},
                ("host-model", "host-provider"),
            ),
        ],
        ids=["composer-override", "queued-switch", "compute-host-mirror"],
    )
    def test_lazy_session_reports_its_own_pick(self, registry, extra, expected):
        registry["sid"] = _session(agent=None, transport=server._detached_ws_transport, **extra)

        info = server._live_session_payload("sid", registry["sid"], omit_messages=True)["info"]

        assert (info["model"], info["provider"]) == expected
        assert info["lazy"] is True

    def test_lazy_session_without_a_pick_reports_the_default_and_no_provider(self, registry):
        registry["sid"] = _session(agent=None, transport=server._detached_ws_transport)

        info = server._live_session_payload("sid", registry["sid"], omit_messages=True)["info"]

        assert info["model"] == "profile-default"
        # Absent rather than "": the client keeps the provider it already shows.
        assert "provider" not in info
