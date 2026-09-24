"""Gateway /export: the session transcript is delivered as a document.

The handler used to call the async session DB without awaiting it and a
``get_adapter`` the runner never had, so every messaging /export answered
"Error exporting session: …". It also joined the chat-supplied filename onto
its temp dir unchecked and deleted that path afterwards — ``/export md
/abs/path`` truncated and removed an arbitrary file on the gateway host.
"""

import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.platforms.base import MessageEvent
from gateway.session import SessionEntry, SessionSource, build_session_key
from hermes_state import AsyncSessionDB

_EXPORT = {
    "id": "sess-1",
    "source": "telegram",
    "messages": [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ],
}


def _make_source() -> SessionSource:
    return SessionSource(
        platform=Platform.TELEGRAM,
        user_id="u1",
        chat_id="c1",
        user_name="tester",
        chat_type="dm",
    )


def _make_event(text: str) -> MessageEvent:
    return MessageEvent(text=text, source=_make_source(), message_id="m1")


def _recording_adapter():
    """Adapter whose send_document snapshots the staged file before cleanup."""
    adapter = MagicMock()
    adapter.send = AsyncMock()
    sent: dict = {}

    async def _send_document(*, chat_id, file_path, caption, file_name):
        sent.update(
            chat_id=chat_id,
            file_name=file_name,
            path=Path(file_path),
            body=Path(file_path).read_text(encoding="utf-8"),
        )

    adapter.send_document = AsyncMock(side_effect=_send_document)
    return adapter, sent


def _make_runner(adapters: dict):
    from gateway.run import GatewayRunner

    session_entry = SessionEntry(
        session_key=build_session_key(_make_source()),
        session_id="sess-1",
        created_at=datetime.now(),
        updated_at=datetime.now(),
        platform=Platform.TELEGRAM,
        chat_type="dm",
    )
    runner = object.__new__(GatewayRunner)
    runner.config = GatewayConfig(
        platforms={Platform.TELEGRAM: PlatformConfig(enabled=True, token="***")}
    )
    runner.adapters = adapters
    runner._profile_adapters = {}
    runner._voice_mode = {}
    runner.hooks = SimpleNamespace(emit=AsyncMock(), loaded_hooks=False)
    runner.session_store = MagicMock()
    runner.session_store.get_or_create_session.return_value = session_entry
    runner.session_store.load_transcript.return_value = []
    runner.session_store.has_any_sessions.return_value = True
    runner._running_agents = {}
    runner._session_run_generation = {}
    runner._pending_messages = {}
    runner._pending_approvals = {}
    runner._session_db = AsyncSessionDB(MagicMock())
    runner._session_db._db.export_session.return_value = _EXPORT
    runner._reasoning_config = None
    runner._provider_routing = {}
    runner._fallback_model = None
    runner._agent_cache = {}
    runner._agent_cache_lock = MagicMock()
    runner._show_reasoning = False
    runner._is_user_authorized = lambda _source: True
    runner._set_session_env = lambda _context: None
    runner._should_send_voice_reply = lambda *_args, **_kwargs: False
    runner._send_voice_reply = AsyncMock()
    runner._capture_gateway_honcho_if_configured = lambda *args, **kwargs: None
    runner._emit_gateway_run_progress = AsyncMock()
    return runner


@pytest.mark.asyncio
async def test_export_is_dispatched_and_delivers_markdown_document():
    adapter, sent = _recording_adapter()
    runner = _make_runner({Platform.TELEGRAM: adapter})

    result = await runner._handle_message(_make_event("/export"))

    assert result == "Export complete."
    runner._session_db._db.export_session.assert_called_once_with("sess-1")
    assert (sent["chat_id"], sent["file_name"]) == ("c1", "session_sess-1.md")
    assert sent["body"].startswith("# Session Export: sess-1")
    assert "## Assistant\n\nhello" in sent["body"]
    # The staging dir is removed once the document is out.
    assert not sent["path"].parent.exists()


@pytest.mark.asyncio
async def test_export_json_delivers_the_raw_export():
    adapter, sent = _recording_adapter()
    runner = _make_runner({Platform.TELEGRAM: adapter})

    result = await runner._handle_export_command(_make_event("/export json"))

    assert result == "Export complete."
    assert sent["file_name"] == "session_sess-1.json"
    assert json.loads(sent["body"]) == _EXPORT


@pytest.mark.asyncio
async def test_export_keeps_the_typed_filename_case():
    adapter, sent = _recording_adapter()
    runner = _make_runner({Platform.TELEGRAM: adapter})

    await runner._handle_export_command(_make_event("/export Plan-Notes.md"))

    assert sent["file_name"] == "Plan-Notes.md"


@pytest.mark.asyncio
@pytest.mark.parametrize("target", ["absolute", "relative"])
async def test_export_filename_cannot_escape_the_staging_dir(tmp_path, target):
    victim = tmp_path / "keep.md"
    victim.write_text("important", encoding="utf-8")
    typed = str(victim) if target == "absolute" else f"../../../../../../..{victim}"
    adapter, sent = _recording_adapter()
    runner = _make_runner({Platform.TELEGRAM: adapter})

    result = await runner._handle_export_command(_make_event(f"/export md {typed}"))

    assert result == "Export complete."
    assert sent["file_name"] == "keep.md"
    assert sent["path"].parent != tmp_path
    assert victim.read_text(encoding="utf-8") == "important"


@pytest.mark.asyncio
async def test_export_without_live_adapter_reports_it_instead_of_crashing():
    runner = _make_runner({})

    result = await runner._handle_export_command(_make_event("/export"))

    assert result == "Platform adapter not found to send the document."
