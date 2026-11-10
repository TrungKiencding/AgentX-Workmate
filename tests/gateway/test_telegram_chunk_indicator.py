"""Chunked Telegram sends must fit 4096 UTF-16 units once the indicator is escaped.

``truncate_message()`` appends a raw `` (N/M)`` suffix, which the Telegram
MarkdownV2 path escapes to `` \\(N/M\\)``: two units longer. With 100+ chunks and
a hard split inside a code fence, a reserve sized for the raw two-digit form
let chunks reach 4097-4098 units and Telegram rejected them as too long.
"""

from types import SimpleNamespace

import pytest

from gateway.config import PlatformConfig
from gateway.platforms.base import utf16_len
from plugins.platforms.telegram.adapter import TelegramAdapter


@pytest.mark.asyncio
async def test_hundred_plus_escaped_chunks_each_fit_the_limit():
    adapter = TelegramAdapter(PlatformConfig(enabled=True, token="fake-token"))
    sent = []

    async def send_message(**kwargs):
        sent.append(kwargs["text"])
        return SimpleNamespace(message_id=len(sent))

    adapter._bot = SimpleNamespace(send_message=send_message)
    # A fenced block with no newline or space to split at: every chunk is cut at
    # the full budget and closed with a fence, and the indicators run to three digits.
    message = "```\n" + "a" * 420_000 + "\n```"

    result = await adapter.send(chat_id="123", content=message)

    assert result.success is True
    assert len(sent) >= 100, f"Expected 100+ chunks, got {len(sent)}"
    for idx, text in enumerate(sent):
        assert utf16_len(text) <= 4096, f"Chunk {idx} is {utf16_len(text)} UTF-16 units"
