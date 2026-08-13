"""Account routes — who is signed in, what model access they hold, and where.

The desktop app calls these immediately after a Keycloak sign-in succeeds. By
that point the backend is already running inside the signed-in person's own
``AGENTX_HOME`` (the app passes ``--account`` at spawn), so everything these
handlers write — the LiteLLM key in ``.env``, the ``providers:`` entry in
``config.yaml`` — lands in that person's home and nobody else's.

Every route is gated: they read ``request.state.session``, which the dashboard
auth middleware only populates for a verified bearer or cookie. There is no
"which account?" parameter, deliberately — the account is whoever the token
says it is, so no caller can provision on somebody else's behalf.

The device routes are a thin proxy in front of the second-brain service. They
live on this side rather than in the desktop app for two reasons: the service
URL is machine policy that already lives in ``config.yaml``, and the offline
contract belongs next to the one ``ensure_account_key`` already keeps. A
service that cannot be reached answers here as ``offline`` with HTTP 200 —
Settings degrades to a sentence, and nothing else in the app notices.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

_log = logging.getLogger("hermes_cli.web_server")

router = APIRouter()

#: Header the desktop puts this install's id in, on every request it makes.
#: Mirrors ``DEVICE_ID_HEADER`` in ``apps/desktop/electron/device-id.ts`` and
#: ``second_brain/auth.py``; the three must agree or the service answers 400.
DEVICE_ID_HEADER = "X-AgentX-Device"
DEVICE_NAME_HEADER = "X-AgentX-Device-Name"


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


def _device_headers(request: Request) -> tuple[str, str]:
    """The calling machine's id and name, as the desktop sent them.

    Used by provisioning as well as by the device routes: the second brain
    scopes every answer to one person AND one machine, so a call that cannot
    say which machine it is gets a 400 rather than a guess.
    """
    return (
        (request.headers.get(DEVICE_ID_HEADER) or "").strip(),
        (request.headers.get(DEVICE_NAME_HEADER) or "").strip(),
    )


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

    # The bearer the service needs is the very token that authenticated this
    # request. Session.access_token holds the Keycloak ID token, which is what
    # it verifies (its audience is our client_id — Keycloak's OAuth access
    # token has aud: account and would fail that check).
    bearer = getattr(session, "access_token", "") or ""

    # Which machine is asking. The second brain refuses a request that will
    # not name its machine, because a person who cannot see which device holds
    # their key cannot revoke it. The desktop sends these on every call; a
    # backend running without one falls back to an id kept at the install
    # root, so a CLI sign-in still works.
    device_id, device_name = _device_headers(request)

    from hermes_cli.account_provisioning import ensure_account_key

    def _run():
        # Sync httpx under the hood; keep it off the event loop so a slow
        # service cannot stall every other dashboard request.
        return ensure_account_key(
            identity,
            slug,
            bearer=bearer,
            device_id=device_id,
            device_name=device_name,
            force_rotate=rotate,
        )

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


# ---------------------------------------------------------------------------
# Devices — a proxy in front of the second-brain service
# ---------------------------------------------------------------------------


def _second_brain_settings():
    """Read ``accounts.second_brain`` from the INSTALL root's config.

    Machine policy, not a personal preference — which service this fleet talks
    to. Reading it from the account's own config would break the feature
    outright, since an account home is created at sign-in with no config.yaml.
    """
    from hermes_cli.account_provisioning import load_machine_config
    from hermes_cli.config import cfg_get

    section = cfg_get(load_machine_config(), "accounts", "second_brain", default=None)
    if not isinstance(section, dict):
        section = {}
    base_url = str(section.get("base_url") or "").strip().rstrip("/")
    try:
        timeout = float(section.get("request_timeout_seconds") or 15)
    except (TypeError, ValueError):
        timeout = 15.0
    return base_url, timeout


def _unconfigured(reason: str) -> dict:
    return {"status": "unconfigured", "detail": reason, "devices": [], "current": ""}


async def _call_second_brain(request: Request, call):
    """Run one client call, mapping every failure to a shape Settings can render.

    Answers HTTP 200 for everything except a programming error, for the same
    reason ``/api/account/provision`` does: a service outage is not a failed
    request from the app's point of view, and an error dialog for one would be
    a dialog the user can do nothing about.

    ``call`` receives ``(client, bearer, device_id, device_name)``.
    """
    session = _require_session(request)
    base_url, timeout = _second_brain_settings()

    if not base_url:
        return _unconfigured(
            "No second-brain service is configured for this install "
            "(accounts.second_brain.base_url)."
        )

    device_id, device_name = _device_headers(request)
    if not device_id:
        # The desktop sends this on every request; a caller that does not is
        # either an older build or something hand-rolled. Either way the
        # service would answer 400, so say what is missing here instead.
        return {
            "status": "no_device_id",
            "detail": f"This request carried no {DEVICE_ID_HEADER} header.",
            "devices": [],
            "current": "",
        }

    bearer = getattr(session, "access_token", "") or ""

    from hermes_cli.second_brain_client import SecondBrainClient, SecondBrainError

    def _run():
        client = SecondBrainClient(base_url, timeout=timeout)
        return call(client, bearer, device_id, device_name)

    try:
        body = await run_in_threadpool(_run)
    except SecondBrainError as exc:
        if exc.revoked:
            # The one failure the app must act on rather than wait out.
            _log.warning("second brain: this device is revoked")
            return {
                "status": "revoked",
                "detail": str(exc),
                "error": exc.code,
                "devices": [],
                "current": device_id,
            }
        if exc.unreachable:
            _log.info("second brain: unreachable (%s)", exc)
            return {
                "status": "offline",
                "detail": str(exc),
                "devices": [],
                "current": device_id,
            }
        _log.warning("second brain refused a call: %s", exc)
        return {
            "status": "error",
            "detail": str(exc),
            "error": exc.code,
            "status_code": exc.status_code,
            "devices": [],
            "current": device_id,
        }

    # Our two keys last: the service's own body must not be able to overwrite
    # the status the desktop branches on.
    return {**(body if isinstance(body, dict) else {}), "status": "ok", "current": device_id}


@router.get("/api/account/devices")
async def list_devices(request: Request):
    """The machines this person is signed in on, this one marked."""
    return await _call_second_brain(
        request,
        lambda client, bearer, device_id, device_name: client.list_devices(
            bearer=bearer, device_id=device_id, device_name=device_name
        ),
    )


@router.post("/api/account/devices/heartbeat")
async def heartbeat_device(request: Request):
    """Announce this machine, with the details only the app knows.

    Called once after sign-in. Authentication on the service registers the
    device by itself, so this exists to attach the platform and app version —
    without which a device list reads "unknown device" three times over.
    """
    body = {}
    try:
        body = await request.json()
    except Exception:
        body = {}
    platform = str((body or {}).get("platform") or "")
    app_version = str((body or {}).get("app_version") or "")

    return await _call_second_brain(
        request,
        lambda client, bearer, device_id, device_name: client.heartbeat(
            bearer=bearer,
            device_id=device_id,
            device_name=device_name,
            platform=platform,
            app_version=app_version,
        ),
    )


@router.delete("/api/account/devices/{device_id}")
async def revoke_device(device_id: str, request: Request, rotate_key: bool = False):
    """Revoke one machine, optionally issuing a new model key with it.

    ``rotate_key`` is what actually cuts the revoked machine's model access:
    one key per person means revocation alone cannot. The service refuses the
    combination that would lock the person out of their own account, and that
    refusal arrives here as ``cannot_revoke_last_device`` for the UI to explain
    in its own words.
    """
    return await _call_second_brain(
        request,
        lambda client, bearer, caller_id, device_name: client.revoke_device(
            device_id,
            bearer=bearer,
            device_id=caller_id,
            device_name=device_name,
            rotate_key=rotate_key,
        ),
    )
