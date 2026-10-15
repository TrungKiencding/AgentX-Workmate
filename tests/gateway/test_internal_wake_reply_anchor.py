"""An internal (synthetic) wake never reply-anchors to its ``message_id``."""

from gateway.config import Platform
from gateway.platforms.base import MessageEvent, _reply_anchor_for_event
from gateway.session import SessionSource

PRODUCER_IDENTITY = '["completion","proc_0123456789ab",1760000000.0]'


def _telegram_dm_event(*, internal):
    source = SessionSource(platform=Platform.TELEGRAM, chat_id="42", user_id="u1", chat_type="dm")
    return MessageEvent(text="[process completed]", source=source, message_id=PRODUCER_IDENTITY,
                        internal=internal)


def test_internal_wake_on_telegram_dm_has_no_reply_anchor():
    assert _reply_anchor_for_event(_telegram_dm_event(internal=True)) is None


def test_user_message_on_telegram_dm_still_anchors_to_its_message_id():
    assert _reply_anchor_for_event(_telegram_dm_event(internal=False)) == PRODUCER_IDENTITY
