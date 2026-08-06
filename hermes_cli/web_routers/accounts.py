"""Account routes — who is signed in, and what model access they hold.

The desktop app calls these immediately after a Keycloak sign-in succeeds. By
that point the backend is already running inside the signed-in person's own
``AGENTX_HOME`` (the app passes ``--account`` at spawn), so everything these
handlers write — the LiteLLM key in ``.env``, the ``providers:`` entry in
``config.yaml`` — lands in that person's home and nobody else's.

Both routes are gated: they read ``request.state.session``, which the dashboard
auth middleware only populates for a verified bearer or cookie. There is no
"which account?" parameter, deliberately — the account is whoever the token
says it is, so no caller can provision on somebody else's behalf.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

_log = logging.getLogger("hermes_cli.web_server")

router = APIRouter()


def _require_session(request: Request):
    """Return the verified session, or 401.

    Mirrors ``/api/auth/me``: an unauthenticated caller gets the same answer
    here as it does there, rather than a confusing 500 from a missing
    attribute.
    """
    session = getattr(request.state, "session", None)
    if session is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    return session


def _identity_from_session(session):
    """Map a dashboard ``Session`` onto the identity the account layer wants."""
    from hermes_cli.accounts import AccountIdentity

    return AccountIdentity(
        subject=session.user_id,
        username=getattr(session, "display_name", "") or "",
        email=getattr(session, "email", "") or "",
        display_name=getattr(session, "display_name", "") or "",
        issuer=getattr(session, "provider", "") or "",
    )


def _current_account_slug(session) -> str:
    """Return the account this process is running as.

    Normally the slug embedded in ``AGENTX_HOME`` — the app spawned us with
    ``--account``, so that value is the authority and it already matched this
    person at spawn time. An install running without accounts (CLI-only, or a
    backend started before the app learned who was signing in) has no slug in
    its path, so derive one from the verified claims instead. The key alias
    that follows is the same either way, which is what keeps a CLI-provisioned
    account and a desktop-provisioned one from minting two keys for one person.
    """
    from hermes_cli.accounts import resolve_account_for_identity
    from hermes_constants import get_active_account

    active = get_active_account()
    if active:
        return active
    return resolve_account_for_identity(
        session.user_id,
        username=getattr(session, "display_name", "") or "",
        email=getattr(session, "email", "") or "",
    )


@router.get("/api/account")
def get_account(request: Request):
    """Describe the signed-in account and its provider key. No network calls."""
    session = _require_session(request)

    from hermes_cli.account_provisioning import account_key_status
    from hermes_constants import get_active_account, get_hermes_home

    slug = _current_account_slug(session)
    status = account_key_status(slug)

    return {
        "account": slug,
        # False means this backend is serving the machine's shared home rather
        # than a per-person one — the desktop uses it to decide whether it
        # still needs to re-home and respawn.
        "isolated": bool(get_active_account()),
        "home": str(get_hermes_home()),
        "user_id": session.user_id,
        "email": getattr(session, "email", "") or "",
        "display_name": getattr(session, "display_name", "") or "",
        "provider": getattr(session, "provider", "") or "",
        "litellm": status.to_json(),
    }


@router.post("/api/account/provision")
async def provision_account(request: Request):
    """Ensure the signed-in account holds a working LiteLLM key.

    Idempotent and safe to call on every launch: a key that already works is
    reused after one cheap liveness check. Pass ``{"rotate": true}`` to force
    a fresh key — the "my key leaked" button.

    Answers 200 even when provisioning could not complete, with the reason in
    ``status``/``detail``. A LiteLLM outage must not read to the desktop as a
    failed sign-in; the person can still work with whatever key they already
    have, and the next launch retries.
    """
    session = _require_session(request)

    body = {}
    try:
        body = await request.json()
    except Exception:
        body = {}
    rotate = bool(isinstance(body, dict) and body.get("rotate"))

    identity = _identity_from_session(session)
    slug = _current_account_slug(session)

    # The bearer the broker needs is the very token that authenticated this
    # request. Session.access_token holds the Keycloak ID token, which is what
    # the broker verifies (its audience is our client_id — Keycloak's OAuth
    # access token has aud: account and would fail that check).
    bearer = getattr(session, "access_token", "") or ""

    from hermes_cli.account_provisioning import ensure_account_key

    def _run():
        # Sync httpx under the hood; keep it off the event loop so a slow
        # LiteLLM cannot stall every other dashboard request.
        return ensure_account_key(identity, slug, bearer=bearer, force_rotate=rotate)

    try:
        result = await run_in_threadpool(_run)
    except Exception as exc:  # pragma: no cover — defensive
        _log.error("account provisioning crashed for %s: %s", slug, exc, exc_info=True)
        raise HTTPException(status_code=500, detail="provisioning failed") from exc

    if result.ok:
        _log.info(
            "account %s: LiteLLM key %s (%s)", slug, result.status, result.key_alias
        )
    elif result.status not in {"disabled", "unconfigured"}:
        _log.warning("account %s: LiteLLM key %s — %s", slug, result.status, result.detail)

    return {"account": slug, "litellm": result.to_json()}
