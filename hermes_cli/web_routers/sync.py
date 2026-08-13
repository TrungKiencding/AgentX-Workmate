"""Sync routes — drive a tick, read the local state, rewind the cursor.

Thin. All the work is in ``hermes_cli.sync_engine``; these three routes exist
because of where the credential lives.

The backend cannot synchronise on its own initiative. It holds no refresh
token for the signed-in person and has no way to mint a bearer — the desktop's
main process is the only component that can, and it shares one only as the
``Authorization`` header on a request. So ``POST /api/sync/tick`` is both the
trigger and the delivery: it runs a tick, and it leaves the bearer it carried
in the engine's mailbox so the background loop can keep working for as long as
that token is good.

That is why the desktop calls it on a timer rather than the backend simply
looping: the timer is what keeps a fresh credential arriving.

``GET /api/sync/status`` deliberately needs no credential and makes no network
call. It is the route that has to answer on a machine where something is
wrong, and a diagnostic that cannot run when the thing it diagnoses is broken
is not a diagnostic.

Like ``accounts.py``, these answer HTTP 200 for everything except a
programming error. A service outage is not a failed request from the app's
point of view, and an error dialog for one would be wrong every time.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Body, Request
from starlette.concurrency import run_in_threadpool

_log = logging.getLogger("hermes_cli.web_server")

router = APIRouter()


def _credentials_from(request: Request):
    """Build :class:`SyncCredentials` from the request that just authenticated.

    The bearer is the very token that got this request past the auth gate, and
    the device headers are the ones the desktop puts on every call. Nothing
    here is read from a body: the account is whoever the token says it is, the
    same rule every other account route follows.
    """
    from hermes_cli.sync_engine import SyncCredentials
    from hermes_cli.web_routers.accounts import _device_headers

    session = getattr(request.state, "session", None)
    if session is None:
        return None

    device_id, device_name = _device_headers(request)
    if not device_id:
        # A backend with no desktop above it still has an install identity.
        from hermes_cli.second_brain_client import install_device_identity

        device_id, fallback = install_device_identity()
        device_name = device_name or fallback

    try:
        expires_at = float(getattr(session, "expires_at", 0) or 0)
    except (TypeError, ValueError):
        expires_at = 0.0

    return SyncCredentials(
        bearer=getattr(session, "access_token", "") or "",
        device_id=device_id,
        device_name=device_name,
        expires_at=expires_at,
    )


@router.post("/api/sync/tick")
async def sync_tick(request: Request, body: dict = Body(default_factory=dict)):
    """Synchronise now, with the bearer this request carried.

    Called by the desktop on a timer, when a session ends, and when the window
    regains focus. Safe to call as often as you like: a tick with nothing to
    push and nothing to pull is one request that returns an empty page.

    Answers 200 with a ``status`` the caller can render — ``offline`` when the
    service could not be reached, which is not a failure anybody needs to see.
    """
    from hermes_cli.sync_engine import engine, mailbox

    credentials = _credentials_from(request)
    if credentials is None:
        return {
            "status": "signed_out",
            "detail": "Nobody is signed in on this machine.",
        }

    # Left here whether or not the tick succeeds: the mailbox is about who is
    # signed in, and a service outage says nothing about that.
    mailbox().remember(credentials)

    running = engine()
    outcome = await run_in_threadpool(running.tick)
    return outcome.to_json()


@router.get("/api/sync/status")
async def sync_status():
    """Where synchronisation has got to. No credential, no network call.

    Reads the local database, so it answers the same thing over SSH on a
    machine whose desktop will not open — which is the situation it exists
    for.
    """
    from hermes_cli.sync_engine import engine

    return await run_in_threadpool(engine().status)


@router.post("/api/sync/reset")
async def sync_reset(request: Request):
    """Rewind this device's cursor so the next tick re-pulls the whole feed.

    The documented recovery from a service restored to an earlier point: a
    client holding a cursor above the server's counter pulls nothing, forever,
    and nothing reports it. Safe because applying is idempotent.
    """
    from hermes_cli.sync_engine import engine

    _require_session(request)
    return await run_in_threadpool(engine().reset_cursor)


def _require_session(request: Request):
    """Refuse an unauthenticated caller, matching the account routes.

    Only the mutating route needs this. Reading the local position is a
    diagnostic; rewinding it schedules real work.
    """
    from fastapi import HTTPException

    session = getattr(request.state, "session", None)
    if session is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    return session
