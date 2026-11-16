import asyncio
import time


class _FakeProc:
    def __init__(self, lines=None, returncode=0):
        self.stdout = iter(lines or [])
        self._returncode = returncode
        self.terminated = False
        self.killed = False
        self.pid = 12345

    def poll(self):
        return None if not self.terminated and not self.killed else self._returncode

    def wait(self, timeout=None):
        return self._returncode

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True








def test_apply_whatsapp_onboarding_saves_pairing_policy(monkeypatch):
    from hermes_cli import web_server as ws

    saved = {}
    removed = []
    enabled = []

    monkeypatch.setattr(ws, "save_env_value", lambda key, value: saved.setdefault(key, value))
    monkeypatch.setattr(ws, "remove_env_value", lambda key: removed.append(key))
    monkeypatch.setattr(ws, "_write_platform_enabled", lambda platform, value: enabled.append((platform, value)))
    monkeypatch.setattr(
        ws,
        "_restart_gateway_after_whatsapp_onboarding",
        lambda profile=None: {"restart_started": True, "restart_pid": 12345},
    )

    record = ws._WhatsAppOnboardingSession(
        proc=None,
        mode="bot",
        allowed_users="",
        session_path="/tmp/session",
        expires_at="2099-01-01T00:00:00Z",
        expires_at_ts=time.time() + 600,
        status="connected",
    )
    ws._whatsapp_onboarding_sessions.clear()
    ws._whatsapp_onboarding_sessions["pairing"] = record

    result = asyncio.run(
        ws.apply_whatsapp_onboarding(
            "pairing",
            ws.WhatsAppOnboardingApply(mode="bot", allowed_users=""),
        )
    )

    assert result["ok"] is True
    assert saved["WHATSAPP_MODE"] == "bot"
    assert saved["WHATSAPP_DM_POLICY"] == "pairing"
    assert saved["WHATSAPP_ENABLED"] == "true"
    assert "WHATSAPP_ALLOWED_USERS" not in removed
    assert enabled == [("whatsapp", True)]
    assert "pairing" not in ws._whatsapp_onboarding_sessions


def test_start_whatsapp_onboarding_existing_creds_returns_linked_account(monkeypatch, tmp_path):
    from hermes_cli import web_server as ws

    session_dir = tmp_path / "session"
    session_dir.mkdir()
    (session_dir / "creds.json").write_text(
        '{"me":{"id":"15551234567:1@s.whatsapp.net","name":"AgentX Bot"}}',
        encoding="utf-8",
    )

    old_proc = _FakeProc(returncode=1)
    old_record = ws._WhatsAppOnboardingSession(
        proc=old_proc,
        mode="bot",
        allowed_users="",
        session_path=str(session_dir),
        expires_at="2099-01-01T00:00:00Z",
        expires_at_ts=time.time() + 600,
    )
    ws._whatsapp_onboarding_sessions.clear()
    ws._whatsapp_onboarding_sessions["old"] = old_record
    monkeypatch.setattr(ws, "_whatsapp_session_path", lambda: session_dir)
    monkeypatch.setattr(ws.secrets, "token_urlsafe", lambda size: "existing-creds")

    result = asyncio.run(
        ws.start_whatsapp_onboarding(
            ws.WhatsAppOnboardingStart(mode="self-chat", allowed_users="")
        )
    )

    assert result["pairing_id"] == "existing-creds"
    assert result["status"] == "connected"
    assert result["qr_payload"] is None
    assert result["account_id"] == "15551234567:1@s.whatsapp.net"
    assert result["account_name"] == "AgentX Bot"
    assert result["account_phone"] == "15551234567"
    assert old_record.status == "cancelled"
    assert old_proc.terminated is True
    assert ws._whatsapp_onboarding_sessions["existing-creds"].account_phone == "15551234567"
    ws._whatsapp_onboarding_sessions.clear()






def _linked_session(tmp_path):
    session_dir = tmp_path / "session"
    session_dir.mkdir()
    (session_dir / "creds.json").write_text(
        '{"me":{"id":"84901234567:3@s.whatsapp.net","name":"Old Phone"}}',
        encoding="utf-8",
    )
    return session_dir


def test_start_whatsapp_onboarding_relink_sets_old_session_aside(monkeypatch, tmp_path):
    from hermes_cli import web_server as ws

    session_dir = _linked_session(tmp_path)
    previous = tmp_path / "session.previous"
    previous.mkdir()
    (previous / "creds.json").write_text("{}", encoding="utf-8")

    started = []
    monkeypatch.setattr(ws, "_whatsapp_session_path", lambda: session_dir)
    monkeypatch.setattr(ws, "_whatsapp_relink_blocker", lambda profile, path: None)
    monkeypatch.setattr(ws, "_run_whatsapp_pairing", lambda *args: started.append(args))
    monkeypatch.setattr(ws.secrets, "token_urlsafe", lambda size: "relink")
    ws._whatsapp_onboarding_sessions.clear()

    result = asyncio.run(
        ws.start_whatsapp_onboarding(ws.WhatsAppOnboardingStart(mode="bot", relink=True))
    )

    # A fresh QR pairing, not the "already linked" short-circuit.
    assert result["status"] == "starting"
    assert result["account_phone"] is None
    assert not session_dir.exists()
    # The previous login is kept (one copy), never deleted outright.
    assert "Old Phone" in (previous / "creds.json").read_text(encoding="utf-8")
    deadline = time.time() + 2
    while not started and time.time() < deadline:
        time.sleep(0.01)
    assert started and started[0][0] == "relink"
    ws._whatsapp_onboarding_sessions.clear()


def test_start_whatsapp_onboarding_relink_refuses_while_connected(monkeypatch, tmp_path):
    import pytest
    from fastapi import HTTPException

    from hermes_cli import web_server as ws

    session_dir = _linked_session(tmp_path)
    monkeypatch.setattr(ws, "_whatsapp_session_path", lambda: session_dir)
    monkeypatch.setattr(
        ws,
        "_whatsapp_relink_blocker",
        lambda profile, path: "WhatsApp is connected. Turn the connection off before linking again.",
    )
    ws._whatsapp_onboarding_sessions.clear()

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            ws.start_whatsapp_onboarding(ws.WhatsAppOnboardingStart(mode="bot", relink=True))
        )

    assert excinfo.value.status_code == 409
    assert (session_dir / "creds.json").exists()
    assert ws._whatsapp_onboarding_sessions == {}


def _dead_pid():
    import subprocess
    import sys

    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


def _runtime_with_whatsapp(state, writer_pid, writer_start=123):
    return {
        "pid": writer_pid,
        "gateway_state": "running",
        "platforms": {
            "whatsapp": {
                "state": state,
                "writer_pid": writer_pid,
                "writer_start_time": writer_start,
            }
        },
    }


def test_whatsapp_runtime_state_trusts_only_the_live_writer(monkeypatch):
    from hermes_cli import web_server as ws

    monkeypatch.setattr(
        ws, "read_runtime_status", lambda path=None: _runtime_with_whatsapp("connected", 4242)
    )
    monkeypatch.setattr(ws, "_profile_gateway_writer_identity", lambda home, runtime: (4242, 123))
    assert ws._whatsapp_runtime_state(None) == "connected"

    # A different live gateway (restarted without the WhatsApp adapter) does
    # not own the entry the old process left behind.
    monkeypatch.setattr(ws, "_profile_gateway_writer_identity", lambda home, runtime: (5151, 999))
    assert ws._whatsapp_runtime_state(None) is None

    monkeypatch.setattr(ws, "_profile_gateway_writer_identity", lambda home, runtime: None)
    assert ws._whatsapp_runtime_state(None) is None

    monkeypatch.setattr(ws, "read_runtime_status", lambda path=None: None)
    assert ws._whatsapp_runtime_state(None) is None


def test_relink_is_not_stuck_on_a_connected_state_left_by_a_dead_gateway(monkeypatch, tmp_path):
    """Regression: WhatsApp turned off, gateway restarted without the adapter,
    gateway_state.json still says "connected" from the dead process."""
    from hermes_cli import web_server as ws

    session_dir = _linked_session(tmp_path)
    dead = _dead_pid()
    monkeypatch.setattr(
        ws, "read_runtime_status", lambda path=None: _runtime_with_whatsapp("connected", dead)
    )
    monkeypatch.setattr(ws, "_whatsapp_session_path", lambda: session_dir)
    monkeypatch.setattr(ws, "_run_whatsapp_pairing", lambda *args: None)
    ws._whatsapp_onboarding_sessions.clear()

    result = asyncio.run(
        ws.start_whatsapp_onboarding(ws.WhatsAppOnboardingStart(mode="bot", relink=True))
    )

    assert result["status"] == "starting"
    assert not session_dir.exists()
    assert (tmp_path / "session.previous" / "creds.json").exists()
    ws._whatsapp_onboarding_sessions.clear()


def test_relink_refuses_while_the_live_adapter_is_reconnecting(monkeypatch, tmp_path):
    import pytest
    from fastapi import HTTPException

    from hermes_cli import web_server as ws

    session_dir = _linked_session(tmp_path)
    monkeypatch.setattr(ws, "_whatsapp_session_path", lambda: session_dir)
    monkeypatch.setattr(ws, "_profile_gateway_writer_identity", lambda home, runtime: (4242, 123))
    ws._whatsapp_onboarding_sessions.clear()

    for state in ("retrying", "paused", "connecting", "connected"):
        monkeypatch.setattr(
            ws, "read_runtime_status", lambda path=None, state=state: _runtime_with_whatsapp(state, 4242)
        )
        with pytest.raises(HTTPException) as excinfo:
            asyncio.run(
                ws.start_whatsapp_onboarding(ws.WhatsAppOnboardingStart(mode="bot", relink=True))
            )
        assert excinfo.value.status_code == 409, state
        assert "Turn the connection off" in excinfo.value.detail
        assert (session_dir / "creds.json").exists()
        assert ws._whatsapp_onboarding_sessions == {}


def test_relink_refuses_while_a_live_bridge_owns_the_session(monkeypatch, tmp_path):
    import os

    import pytest
    from fastapi import HTTPException

    from gateway.status import get_process_start_time
    from hermes_cli import web_server as ws

    session_dir = _linked_session(tmp_path)
    monkeypatch.setattr(ws, "read_runtime_status", lambda path=None: None)
    monkeypatch.setattr(ws, "_whatsapp_session_path", lambda: session_dir)
    monkeypatch.setattr(ws, "_run_whatsapp_pairing", lambda *args: None)
    # A gateway still runs somewhere (its bridge could be in use): the bridge
    # must not be stopped, only refused. The stand-in "bridge" is this test.
    monkeypatch.setattr(ws, "_any_gateway_process_running", lambda: True)
    ws._whatsapp_onboarding_sessions.clear()

    # The pidfile format the adapter writes: pid, then kernel start time.
    live_pid = os.getpid()
    start = get_process_start_time(live_pid)
    (session_dir / "bridge.pid").write_text(
        str(live_pid) if start is None else f"{live_pid}\n{start}", encoding="utf-8"
    )
    if start is None:
        pytest.skip("process start time unavailable on this platform")

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            ws.start_whatsapp_onboarding(ws.WhatsAppOnboardingStart(mode="bot", relink=True))
        )
    assert excinfo.value.status_code == 409
    assert (session_dir / "creds.json").exists()

    # A pidfile left by a bridge that has since died does not block.
    (session_dir / "bridge.pid").write_text(f"{_dead_pid()}\n{start}", encoding="utf-8")
    result = asyncio.run(
        ws.start_whatsapp_onboarding(ws.WhatsAppOnboardingStart(mode="bot", relink=True))
    )
    assert result["status"] == "starting"
    assert not session_dir.exists()
    ws._whatsapp_onboarding_sessions.clear()


def test_backend_shutdown_ends_live_pairing_runs():
    from hermes_cli import web_server as ws

    live = _FakeProc()
    record = ws._WhatsAppOnboardingSession(
        proc=live,
        mode="bot",
        allowed_users="",
        session_path="/tmp/session",
        expires_at="2099-01-01T00:00:00Z",
        expires_at_ts=time.time() + 600,
        status="waiting",
    )
    ws._whatsapp_onboarding_sessions.clear()
    ws._whatsapp_onboarding_sessions["live"] = record

    ws._shutdown_whatsapp_onboarding()

    assert live.terminated is True
    assert record.status == "cancelled"
    assert ws._whatsapp_onboarding_sessions == {}


def test_switching_whatsapp_off_also_clears_the_env_override(monkeypatch):
    """gateway/config.py honours WHATSAPP_ENABLED over config.yaml, and QR
    linking writes it as "true": the switch must update both or WhatsApp keeps
    running after the owner turned it off."""
    from hermes_cli import web_server as ws

    written = []
    saved = {}
    monkeypatch.setattr(ws, "write_platform_config_field", lambda pid, key, value: written.append((pid, key, value)))
    monkeypatch.setattr(ws, "save_env_value", lambda key, value: saved.__setitem__(key, value))

    ws._write_platform_enabled("whatsapp", False)
    assert written == [("whatsapp", "enabled", False)]
    assert saved == {"WHATSAPP_ENABLED": "false"}

    ws._write_platform_enabled("whatsapp", True)
    assert saved == {"WHATSAPP_ENABLED": "true"}

    saved.clear()
    ws._write_platform_enabled("telegram", False)
    assert saved == {}


def test_relink_stops_a_bridge_that_outlived_every_gateway(monkeypatch, tmp_path):
    """A bridge left running by a crashed gateway used to block relink forever.

    WhatsApp is off, no gateway runs anywhere, yet the old bridge still owns
    the session: nothing would ever stop it and every relink answered 409.
    The backend now stops that orphan (identity-checked) and re-pairs.
    """
    import os
    import subprocess
    import sys

    import pytest

    from gateway.status import get_process_start_time
    from hermes_cli import web_server as ws

    session_dir = _linked_session(tmp_path)
    monkeypatch.setattr(ws, "read_runtime_status", lambda path=None: None)
    monkeypatch.setattr(ws, "_whatsapp_session_path", lambda: session_dir)
    monkeypatch.setattr(ws, "_run_whatsapp_pairing", lambda *args: None)
    monkeypatch.setattr(ws, "_any_gateway_process_running", lambda: False)
    ws._whatsapp_onboarding_sessions.clear()

    orphan = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    try:
        start = None
        for _ in range(50):
            start = get_process_start_time(orphan.pid)
            if start is not None:
                break
            time.sleep(0.05)
        if start is None:
            pytest.skip("process start time unavailable on this platform")
        (session_dir / "bridge.pid").write_text(f"{orphan.pid}\n{start}", encoding="utf-8")

        result = asyncio.run(
            ws.start_whatsapp_onboarding(ws.WhatsAppOnboardingStart(mode="bot", relink=True))
        )

        assert result["status"] == "starting"
        assert orphan.wait(timeout=10) is not None
    finally:
        if orphan.poll() is None:
            orphan.kill()
            orphan.wait(timeout=10)
        ws._whatsapp_onboarding_sessions.clear()


def test_relink_never_stops_a_bridge_while_any_gateway_runs(monkeypatch, tmp_path):
    """A multiplexing gateway's per-profile state is not visible from this home;
    with any gateway running, the bridge is refused, never stopped."""
    import subprocess
    import sys

    import pytest
    from fastapi import HTTPException

    from gateway.status import get_process_start_time
    from hermes_cli import web_server as ws

    session_dir = _linked_session(tmp_path)
    monkeypatch.setattr(ws, "read_runtime_status", lambda path=None: None)
    monkeypatch.setattr(ws, "_whatsapp_session_path", lambda: session_dir)
    monkeypatch.setattr(ws, "_run_whatsapp_pairing", lambda *args: None)
    monkeypatch.setattr(ws, "_any_gateway_process_running", lambda: True)
    ws._whatsapp_onboarding_sessions.clear()

    bridge = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    try:
        start = None
        for _ in range(50):
            start = get_process_start_time(bridge.pid)
            if start is not None:
                break
            time.sleep(0.05)
        if start is None:
            pytest.skip("process start time unavailable on this platform")
        (session_dir / "bridge.pid").write_text(f"{bridge.pid}\n{start}", encoding="utf-8")

        with pytest.raises(HTTPException) as excinfo:
            asyncio.run(
                ws.start_whatsapp_onboarding(ws.WhatsAppOnboardingStart(mode="bot", relink=True))
            )
        assert excinfo.value.status_code == 409
        assert bridge.poll() is None
        assert (session_dir / "creds.json").exists()
    finally:
        bridge.kill()
        bridge.wait(timeout=10)
        ws._whatsapp_onboarding_sessions.clear()
