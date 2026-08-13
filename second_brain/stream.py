"""Tell a connected device that something changed, without it having to ask.

Polling every thirty seconds is fine and this is not a replacement for it —
it is a shortcut in front of it. The socket carries a nudge and never a
document: a client that is woken re-reads ``/v1/sync/changes`` from its own
cursor, exactly as it would have on its next tick.

That is the whole design, and everything else follows from it:

**A lost notification costs nothing.** The next poll finds the change anyway.
So this layer is allowed to be best-effort — no acknowledgements, no replay,
no per-client queue to overflow — which is what keeps it from becoming a
second delivery mechanism that can disagree with the first.

**A duplicate notification costs nothing either.** So the fan-out does not
deduplicate, and ``brain_put_document`` notifies whether or not its
last-writer-wins guard applied the row. A spurious wake-up is one wasted read;
a missed one is a change that waits for the next poll.

**Notifications come from Postgres, not from this process.** ``pg_notify`` in
``brain_put_document`` fires on COMMIT, so a device pushing through one
instance wakes a device listening on another. An in-process broadcast would
work perfectly on a single instance and silently stop working the day somebody
runs two — which is the worst kind of thing to get wrong, because the
behaviour that breaks is invisible until then.

The socket is authenticated exactly like every other route. A revoked device
is refused here as it is everywhere else, and an unauthenticated one never
gets past the handshake.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any, Dict, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from second_brain import API_PREFIX
from second_brain.auth import resolve_principal
from second_brain.errors import BrainHTTPError

if TYPE_CHECKING:  # pragma: no cover - typing only
    from second_brain.app import BrainContext

logger = logging.getLogger(__name__)

#: How often the server pings an idle socket. Long enough to be nearly free,
#: short enough to be inside the idle timeout of every proxy anybody puts in
#: front of this — Caddy's default is two minutes.
KEEPALIVE_SECONDS = 45.0

#: Closed with this when the device is cut off mid-connection. 4403 rather
#: than 1008 so a client can tell "you are revoked" from "the server did not
#: like that frame"; the 4000 range is reserved for exactly this.
CLOSE_DEVICE_REVOKED = 4403

router = APIRouter(prefix=f"{API_PREFIX}/sync")


class DocumentNotifier:
    """Fans Postgres notifications out to the sockets watching one account.

    Subscribers are held per subject, so waking one person's devices never
    touches another's. Each subscriber is an ``asyncio.Event`` rather than a
    queue: the message is "something changed", it does not accumulate, and an
    event that is already set is a client that has not yet acted on the
    previous nudge — which needs no second one.
    """

    def __init__(self) -> None:
        self._subscribers: Dict[str, Set[asyncio.Event]] = {}
        self._connection: Any | None = None
        self._loop: Any | None = None

    async def start(self, store: Any) -> None:
        """Open the listening connection. Safe to call more than once."""
        if self._connection is not None:
            return
        self._loop = asyncio.get_running_loop()
        self._connection = await store.listen_for_documents(self._on_notify)

    async def stop(self) -> None:
        connection, self._connection = self._connection, None
        self._loop = None
        if connection is None:
            return
        try:
            await connection.close()
        except Exception as exc:  # noqa: BLE001 - shutdown must not raise
            logger.debug("second_brain: closing the listener failed: %s", exc)

    def _on_notify(self, subject: str) -> None:
        """Wake everybody watching *subject*.

        asyncpg delivers on the loop that owns the listening connection, so
        this is already on the right loop and setting an Event is safe. It is
        still routed through ``call_soon_threadsafe`` when a loop is recorded,
        because that is correct in both cases and costs one scheduling hop.
        """
        loop = self._loop
        if loop is None:
            return
        try:
            loop.call_soon_threadsafe(self._wake, subject)
        except RuntimeError:  # pragma: no cover - the loop is closing
            pass

    def _wake(self, subject: str) -> None:
        for event in tuple(self._subscribers.get(subject, ())):
            event.set()

    def subscribe(self, subject: str) -> asyncio.Event:
        event = asyncio.Event()
        self._subscribers.setdefault(subject, set()).add(event)
        return event

    def unsubscribe(self, subject: str, event: asyncio.Event) -> None:
        watchers = self._subscribers.get(subject)
        if not watchers:
            return
        watchers.discard(event)
        # Dropped when the last device disconnects, so a service that has been
        # up for months is not holding an empty set per person who ever
        # connected.
        if not watchers:
            self._subscribers.pop(subject, None)

    @property
    def subjects(self) -> int:
        """How many accounts have a device listening. For ``/health``."""
        return len(self._subscribers)

    @property
    def listening(self) -> bool:
        """Whether Postgres notifications are reaching this instance.

        False on a deployment where the listening connection could not be
        opened — everything still works, every device simply finds its changes
        on the next poll rather than immediately.
        """
        return self._connection is not None


@router.websocket("/stream")
async def stream(websocket: WebSocket) -> None:
    """Wake this device when its account's feed moves.

    Sends ``{"type": "hello", "cursor": n}`` once the socket is up, then
    ``{"type": "changed"}`` whenever something lands, and ``{"type": "ping"}``
    on an idle timer so a proxy in the middle does not decide the connection is
    dead.

    Never sends a document. A woken client reads the feed from its own cursor,
    which is what keeps this an optimisation over polling rather than a second
    delivery path that can disagree with it.
    """
    ctx: BrainContext = websocket.app.state.brain

    try:
        # The same verification every other route uses, including the device
        # check — a revoked machine is refused here exactly as it is on
        # /v1/me. Starlette's WebSocket carries the headers a Request does,
        # which is what lets one implementation serve both.
        principal = await resolve_principal(websocket)
    except BrainHTTPError as exc:
        # Refused before the handshake completes, so the client sees an HTTP
        # status it can act on rather than a socket that opens and shuts.
        await websocket.close(code=_close_code_for(exc), reason=exc.code)
        return
    except Exception as exc:  # noqa: BLE001 - never leak a traceback to a socket
        logger.warning("second_brain: could not authenticate a stream: %s", exc)
        await websocket.close(code=1011, reason="internal_error")
        return

    await websocket.accept()

    notifier = ctx.notifier
    event = notifier.subscribe(principal.subject)

    try:
        await websocket.send_json({"type": "hello", "device": principal.device_id})

        while True:
            try:
                await asyncio.wait_for(event.wait(), timeout=KEEPALIVE_SECONDS)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "ping"})
                continue

            # Cleared BEFORE the send, not after. Cleared after, a change that
            # landed while the frame was in flight would set the event and
            # then be cleared away unread — the one notification whose loss
            # actually delays a device until its next poll.
            event.clear()
            await websocket.send_json({"type": "changed"})
    except (WebSocketDisconnect, ConnectionError):
        pass
    except Exception as exc:  # noqa: BLE001 - a dead socket is not an incident
        logger.debug("second_brain: stream for %s ended: %s", principal.subject, exc)
    finally:
        notifier.unsubscribe(principal.subject, event)


def _close_code_for(exc: BrainHTTPError) -> int:
    """Map a refusal onto a close code a client can branch on."""
    if exc.status_code == 403:
        return CLOSE_DEVICE_REVOKED
    if exc.status_code == 401:
        return 4401
    if exc.status_code == 400:
        return 4400
    return 1011
