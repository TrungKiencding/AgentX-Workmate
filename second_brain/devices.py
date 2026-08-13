"""The machines a person is signed in on, and how they cut one off.

Before this existed, "sign out everywhere" had no meaning: a laptop held its
own model key in its own ``.env`` and nothing anywhere knew the laptop
existed. A stolen machine was a support ticket about rotating a key that half
the fleet shared.

Three routes, and one rule that is not obvious:

**Revoking your last device while rotating the key locks you out of your own
account.** One key per person is the whole point of the service (R1), so
revocation alone cannot cut a device's model access — the rotation is what
does that. But rotate while revoking the only device left, and the new key has
nowhere to go: no machine remains that could fetch it. So that combination is
refused with ``409``, in the service rather than by hiding a button, because
any client can call the API.

Devices belonging to another subject answer ``404``, never ``403``. A ``403``
would confirm that somebody else's device id exists, which is a question this
endpoint has no business answering.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Body, Depends, Query, Request

from second_brain import API_PREFIX
from second_brain.auth import Principal, is_device_id, require_principal
from second_brain.errors import (
    CANNOT_REVOKE_LAST_DEVICE,
    DEVICE_NOT_FOUND,
    STORE_UNAVAILABLE,
    BrainHTTPError,
)
from second_brain.store.engine import StoreUnavailable

if TYPE_CHECKING:  # pragma: no cover - typing only
    from second_brain.app import BrainContext

logger = logging.getLogger(__name__)

#: Longest platform / app-version string recorded. Both are free text from a
#: client, and neither needs to be long.
_FIELD_MAX = 64

router = APIRouter(prefix=f"{API_PREFIX}/devices")


def _text(body: Any, key: str) -> str:
    value = (body or {}).get(key) if isinstance(body, dict) else None
    return str(value or "").strip()[:_FIELD_MAX]


def _store_unavailable(exc: StoreUnavailable) -> BrainHTTPError:
    logger.error("second_brain: store unavailable serving devices: %s", exc)
    return BrainHTTPError(
        503,
        STORE_UNAVAILABLE,
        "The service's database could not be reached. Try again shortly.",
    )


@router.post("/heartbeat")
async def heartbeat(
    request: Request,
    principal: Principal = Depends(require_principal),
    body: dict = Body(default_factory=dict),
):
    """Say this machine is alive, and describe it.

    Authentication has already upserted the device — that is what makes the
    registry complete — so this route exists to attach the things only the
    client knows: the platform it runs on and the version it runs. Called on
    launch and on each sync tick.
    """
    ctx: BrainContext = request.app.state.brain

    platform = _text(body, "platform")
    app_version = _text(body, "app_version")
    name = _text(body, "name")

    if not (platform or app_version or name):
        # Nothing to add beyond what authentication already recorded.
        return {"device": principal.device.to_json(current=True)}

    try:
        device = await ctx.store.touch_device(
            principal.subject,
            principal.device_id,
            name=name,
            platform=platform,
            app_version=app_version,
        )
    except StoreUnavailable as exc:
        raise _store_unavailable(exc) from exc

    # `touch_device` answers None only for a revoked device, and a revoked
    # device cannot have reached this handler — authentication would have
    # refused it. Fall back to what we already hold rather than crashing on
    # the race where it was revoked between the two statements.
    return {"device": (device or principal.device).to_json(current=True)}


@router.get("")
async def list_devices(
    request: Request,
    principal: Principal = Depends(require_principal),
):
    """Every machine this person has signed in on.

    Revoked devices stay in the list, marked, rather than vanishing: "which
    machine did I cut off, and when" is exactly the question somebody asks
    after cutting one off.
    """
    ctx: BrainContext = request.app.state.brain

    try:
        devices = await ctx.store.list_devices(principal.subject)
    except StoreUnavailable as exc:
        raise _store_unavailable(exc) from exc

    return {
        "devices": [
            device.to_json(current=device.id == principal.device_id) for device in devices
        ],
        "current": principal.device_id,
    }


@router.delete("/{device_id}")
async def revoke_device(
    request: Request,
    device_id: str,
    principal: Principal = Depends(require_principal),
    rotate_key: bool = Query(
        default=False,
        description=(
            "Also issue a new model key, cutting the revoked device's model "
            "access. Refused when this is the last live device."
        ),
    ),
):
    """Cut a machine off, optionally taking its model access with it."""
    ctx: BrainContext = request.app.state.brain

    if not is_device_id(device_id):
        # An id that could never have been stored is an id that does not
        # exist. Same answer as somebody else's device, for the same reason.
        raise BrainHTTPError(404, DEVICE_NOT_FOUND, "No such device on this account.")

    try:
        existing = await ctx.store.device(principal.subject, device_id)
        if existing is None:
            raise BrainHTTPError(
                404,
                DEVICE_NOT_FOUND,
                "No such device on this account.",
            )

        if rotate_key and not existing.revoked:
            live = await ctx.store.live_device_count(principal.subject)
            if live <= 1:
                raise BrainHTTPError(
                    409,
                    CANNOT_REVOKE_LAST_DEVICE,
                    "This is the only device left on the account. Revoking it "
                    "and issuing a new model key at the same time would leave "
                    "no machine able to collect the new key. Sign in somewhere "
                    "else first, or revoke without issuing a new key.",
                )

        device = await ctx.store.revoke_device(principal.subject, device_id)
    except StoreUnavailable as exc:
        raise _store_unavailable(exc) from exc

    if device is None:  # pragma: no cover - lost a race with a cascade delete
        raise BrainHTTPError(404, DEVICE_NOT_FOUND, "No such device on this account.")

    rotation = "not_requested"
    if rotate_key:
        rotation = await _rotate_key(ctx, principal)

    logger.info(
        "second_brain: %s revoked device %s (rotation: %s)",
        principal.subject,
        device_id,
        rotation,
    )

    return {
        "device": device.to_json(current=device.id == principal.device_id),
        "key_rotated": rotation == "rotated",
        "key_rotation": rotation,
    }


async def _rotate_key(ctx: BrainContext, principal: Principal) -> str:
    """Rotate this person's model key, and say what happened.

    ``ctx.rotate_key`` is ``None`` on a deployment with no proxy configured,
    where each laptop still mints its own key and rotating centrally would
    therefore cut nothing; this answers ``unsupported``, because telling
    somebody who just revoked a stolen laptop that its model access is gone
    when it is not is worse than telling them nothing.

    A hook that returns a word of its own keeps it — the vault answers
    ``no_key`` for a person who has never been issued one, and that is not the
    same event as a rotation, however much it looks like one from here.
    """
    if ctx.rotate_key is None:
        return "unsupported"
    try:
        outcome = await ctx.rotate_key(principal.subject)
    except Exception as exc:
        # The revocation already stands; a failed rotation must not undo it.
        # Reported so the caller can retry rather than assume it worked.
        logger.error(
            "second_brain: revoked a device for %s but could not rotate the key: %s",
            principal.subject,
            exc,
        )
        return "failed"
    return outcome if isinstance(outcome, str) and outcome else "rotated"
