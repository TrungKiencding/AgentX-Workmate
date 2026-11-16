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
    monkeypatch.setattr(ws, "_whatsapp_runtime_connected", lambda profile: False)
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
    monkeypatch.setattr(ws, "_whatsapp_runtime_connected", lambda profile: True)
    ws._whatsapp_onboarding_sessions.clear()

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            ws.start_whatsapp_onboarding(ws.WhatsAppOnboardingStart(mode="bot", relink=True))
        )

    assert excinfo.value.status_code == 409
    assert (session_dir / "creds.json").exists()
    assert ws._whatsapp_onboarding_sessions == {}


def test_whatsapp_runtime_connected_reads_platform_state(monkeypatch):
    from hermes_cli import web_server as ws

    monkeypatch.setattr(
        ws, "read_runtime_status", lambda path=None: {"platforms": {"whatsapp": {"state": "connected"}}}
    )
    assert ws._whatsapp_runtime_connected(None) is True

    monkeypatch.setattr(
        ws, "read_runtime_status", lambda path=None: {"platforms": {"whatsapp": {"state": "fatal"}}}
    )
    assert ws._whatsapp_runtime_connected(None) is False

    monkeypatch.setattr(ws, "read_runtime_status", lambda path=None: None)
    assert ws._whatsapp_runtime_connected(None) is False


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
