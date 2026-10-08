"""The desktop's speech routes refuse while the AgentX license is read-only.

Read-aloud, dictation and the voice conversation reach speech through
``/api/audio/transcribe``, ``/api/audio/speak`` and the ``speak-stream``
socket. While read-only they answer 403 with the reason as ``detail`` — what
any client shows — and the refusal code and license beside it, before the
upload is decoded or an engine runs. The socket reports no streamer, so the
desktop falls back to ``/api/audio/speak`` and hears the same refusal.
"""

from __future__ import annotations

import base64
from urllib.parse import urlencode

import pytest
from starlette.testclient import TestClient

from hermes_cli import web_server
from hermes_cli.account_license import READ_ONLY_CODE, read_only_message, remember_license

_EXPIRED = {
    "state": "expired",
    "access": "read_only",
    "enforced": True,
    "notice": "read_only",
    "plan": {"slug": "pilot-2026", "name": "Pilot 2026"},
    "last_day": "2026-12-31",
    "read_only_from": "2027-01-08",
    "contact": "it@astralx.com.vn",
    "warn_days": [14, 7, 1],
    "server_time": "2027-01-09T09:00:00+07:00",
}

_AUDIO = {"data_url": "data:audio/webm;base64," + base64.b64encode(b"\x00fakeaudio").decode("ascii")}


@pytest.fixture
def client(_isolate_hermes_home):
    previous = getattr(web_server.app.state, "auth_required", None)
    web_server.app.state.auth_required = False
    test_client = TestClient(web_server.app)
    test_client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    try:
        yield test_client
    finally:
        test_client.close()
        if previous is None:
            if hasattr(web_server.app.state, "auth_required"):
                delattr(web_server.app.state, "auth_required")
        else:
            web_server.app.state.auth_required = previous


def _never(*_args, **_kwargs):
    raise AssertionError("a refused request must not reach an engine")


def _assert_refused(response):
    assert response.status_code == 403
    body = response.json()
    assert body["detail"] == read_only_message(_EXPIRED)
    assert body["code"] == READ_ONLY_CODE
    assert body["license"]["state"] == "expired"
    # `detail` first: the desktop's generic error toast pulls it out of the text.
    assert next(iter(body)) == "detail"


def test_transcription_is_refused_before_the_upload_is_decoded(client, monkeypatch):
    remember_license(_EXPIRED)
    monkeypatch.setattr("tools.voice_mode.transcribe_recording", _never)

    _assert_refused(client.post("/api/audio/transcribe", json={"data_url": "not even audio"}))


def test_synthesis_is_refused(client, monkeypatch):
    remember_license(_EXPIRED)
    monkeypatch.setattr("tools.tts_tool.text_to_speech_tool", _never)

    _assert_refused(client.post("/api/audio/speak", json={"text": "Xin chào"}))


def test_a_license_that_turned_read_only_mid_request_is_still_a_refusal(client, monkeypatch):
    # The route let the request through; the engine's own check refused it.
    refused = {
        "success": False,
        "transcript": "",
        "error": read_only_message(_EXPIRED),
        "code": READ_ONLY_CODE,
        "license": _EXPIRED,
    }
    monkeypatch.setattr("tools.voice_mode.transcribe_recording", lambda path: refused)

    _assert_refused(client.post("/api/audio/transcribe", json=_AUDIO))


def test_the_stream_reports_no_streamer_and_the_fallback_is_refused(client, monkeypatch):
    remember_license(_EXPIRED)
    url = f"/api/audio/speak-stream?{urlencode({'token': web_server._SESSION_TOKEN})}"

    with client.websocket_connect(url) as conn:
        assert conn.receive_json() == {"type": "fallback"}

    monkeypatch.setattr("tools.tts_tool.text_to_speech_tool", _never)
    _assert_refused(client.post("/api/audio/speak", json={"text": "Hello"}))


def test_speech_runs_while_the_license_covers_ai(client, monkeypatch):
    monkeypatch.setattr(
        "tools.voice_mode.transcribe_recording",
        lambda path: {"success": True, "transcript": "xin chào", "provider": "fake"},
    )

    response = client.post("/api/audio/transcribe", json=_AUDIO)

    assert response.status_code == 200
    assert response.json()["transcript"] == "xin chào"
