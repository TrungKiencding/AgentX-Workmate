"""Who is calling, and from which machine. Enforced before any route runs.

Two rules, both of which exist because this service holds things a person can
lose:

**The token decides the account. Always.** Nothing in a request body or a
query string can name an account. The subject comes from the verified ``sub``
claim and nowhere else, which is the same rule ``litellm_broker`` enforces and
for the same reason — a person must not be able to ask for somebody else's key
by editing a JSON field.

**An outage is not a revocation.** A realm that cannot be reached answers
``503``, never ``401``. The distinction is load-bearing: a laptop reads ``401``
as "your credentials are dead, discard them and sign in again", and doing that
because a JWKS endpoint blipped would sign a working machine out of a working
account. The same asymmetry runs through the whole product (see
``ensure_account_key``'s offline contract and ``key_is_live``): unreachable
must never be read as denied.

The verifier is the dashboard's own Keycloak provider, obtained by registering
the plugin through a capture object rather than re-implementing JWKS and
audience checks here. Two verifiers that can drift is how a service ends up
still trusting a realm the app has already left.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Depends, Request

from second_brain import API_PREFIX
from second_brain.errors import (
    DEVICE_HEADER_INVALID,
    DEVICE_HEADER_MISSING,
    DEVICE_REVOKED,
    IDENTITY_UNAVAILABLE,
    INVALID_TOKEN,
    MISSING_BEARER,
    STORE_UNAVAILABLE,
    BrainConfigError,
    BrainHTTPError,
)
from second_brain.store.engine import DeviceRow, StoreUnavailable

if TYPE_CHECKING:  # pragma: no cover - typing only
    from second_brain.app import BrainContext

logger = logging.getLogger(__name__)

#: Names this install to the service. Written by
#: ``apps/desktop/electron/device-id.ts``, which generates and validates
#: exactly this shape.
DEVICE_ID_HEADER = "X-AgentX-Device"

#: The machine's own name, shown in the device list. Advisory: a person can
#: rename their laptop to anything, so it is displayed and never trusted.
DEVICE_NAME_HEADER = "X-AgentX-Device-Name"

#: Mirrors ``DEVICE_ID_RE`` in ``device-id.ts``. Accepted case-insensitively
#: and lowercased before it reaches the store, because Postgres normalises
#: UUIDs and two spellings of one id must not become two devices.
_DEVICE_ID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

#: Longest device name recorded. The header is user-controlled; the column is
#: not bounded by the database, so it is bounded here.
_DEVICE_NAME_MAX = 64


@dataclass(frozen=True)
class Principal:
    """A verified caller: one person, on one of their machines.

    Built once per request and handed to the route. No handler reads a raw
    header, so there is exactly one place where "who is this" is decided.
    """

    subject: str
    slug: str
    email: str
    display_name: str
    issuer: str
    device: DeviceRow

    @property
    def device_id(self) -> str:
        return self.device.id

    def to_json(self) -> dict[str, Any]:
        return {
            "subject": self.subject,
            "account": self.slug,
            "email": self.email,
            "display_name": self.display_name,
            "issuer": self.issuer,
            "device": self.device.to_json(current=True),
        }


def keycloak_provider() -> Any:
    """Return the dashboard's Keycloak provider, or raise ``BrainConfigError``.

    Registers the plugin through a capture object — the same technique
    ``litellm_broker._keycloak_provider`` uses — so this service accepts
    exactly the tokens the product accepts, forever, without a second
    implementation to keep in step.
    """
    import plugins.dashboard_auth.keycloak as keycloak_plugin

    captured: list[Any] = []

    class _Capture:
        def register_dashboard_auth_provider(self, provider):
            captured.append(provider)

    keycloak_plugin.register(_Capture())
    if not captured:
        raise BrainConfigError(
            keycloak_plugin.LAST_SKIP_REASON
            or "Keycloak is not configured on this server, so the service has "
            "no way to verify who is calling it. Set "
            "AGENTX_DASHBOARD_KEYCLOAK_BASE_URL, _REALM and _CLIENT_ID."
        )
    return captured[0]


def bearer_from(authorization: str) -> str:
    """Pull the token out of an ``Authorization`` header, or return ``""``."""
    text = (authorization or "").strip()
    if text[:7].lower() != "bearer ":
        return ""
    return text[7:].strip()


def normalize_device_name(raw: str) -> str:
    """Reduce a device-name header to something safe to store and display.

    Mirrors ``deviceNameFrom`` in ``device-id.ts``. Applied again on this side
    because the client that sent it is not necessarily ours.
    """
    cleaned = re.sub(r"[^A-Za-z0-9 ._-]+", " ", raw or "")
    return re.sub(r"\s+", " ", cleaned).strip()[:_DEVICE_NAME_MAX].strip()


def is_device_id(value: str) -> bool:
    """True when *value* is shaped like a device id this service can store.

    Applied to path parameters as well as headers: without it, a hand-typed
    id reaches Postgres as a failed UUID cast, which surfaces as a 500 for
    what is plainly a 404.
    """
    return bool(_DEVICE_ID_RE.match((value or "").strip()))


def device_id_from(request: Request) -> str:
    """Return the caller's device id, or raise the 400 that explains why not."""
    raw = (request.headers.get(DEVICE_ID_HEADER) or "").strip()
    if not raw:
        raise BrainHTTPError(
            400,
            DEVICE_HEADER_MISSING,
            f"Every request must name its machine in {DEVICE_ID_HEADER}. "
            "Without it a person cannot be shown which devices they are "
            "signed in on, and cannot revoke one.",
        )
    if not _DEVICE_ID_RE.match(raw):
        raise BrainHTTPError(
            400,
            DEVICE_HEADER_INVALID,
            f"{DEVICE_ID_HEADER} must be a UUID.",
        )
    return raw.lower()


async def verify_bearer(ctx: BrainContext, authorization: str) -> Any:
    """Verify a bearer against the realm and return the provider's session.

    Raises 401 for a token the realm rejects and 503 for a realm that could
    not be asked. Split out from :func:`resolve_principal` because that
    distinction is the single most consequential decision this module makes.
    """
    from starlette.concurrency import run_in_threadpool

    token = bearer_from(authorization)
    if not token:
        raise BrainHTTPError(401, MISSING_BEARER, "This route needs a bearer token.")

    def _verify():
        return ctx.provider.verify_session(access_token=token)

    try:
        session = await run_in_threadpool(_verify)
    except Exception as exc:
        logger.warning("second_brain: could not verify a token: %s", exc)
        raise BrainHTTPError(
            503,
            IDENTITY_UNAVAILABLE,
            "The identity provider could not be reached. Keep the credentials "
            "you hold and try again.",
        ) from exc

    if session is None:
        raise BrainHTTPError(401, INVALID_TOKEN, "That token is not valid here.")
    return session


async def resolve_principal(request: Request) -> Principal:
    """Verify the caller and register the machine they called from.

    Registering here rather than only in the heartbeat is deliberate: a device
    that can call the service but is missing from the registry is a device
    nobody can revoke. The upsert doubles as the revocation check, because it
    declines to touch a tombstoned row — one statement, and no window between
    reading "not revoked" and acting on it.
    """
    ctx: BrainContext = request.app.state.brain

    session = await verify_bearer(ctx, request.headers.get("authorization", ""))
    device_id = device_id_from(request)

    from hermes_cli.accounts import account_slug_for_identity

    subject = str(getattr(session, "user_id", "") or "")
    email = str(getattr(session, "email", "") or "")
    display_name = str(getattr(session, "display_name", "") or "")
    issuer = str(getattr(session, "provider", "") or "")

    if not subject:
        # A provider that verifies a token but cannot say who it belongs to
        # has told us nothing we can authorize on.
        raise BrainHTTPError(401, INVALID_TOKEN, "That token carries no subject claim.")

    # The same derivation the laptop performs, so a person's slug is the same
    # string on the server, in `agentx account list`, and in their home path.
    slug = account_slug_for_identity(subject, username=display_name, email=email)

    try:
        await ctx.store.ensure_account(
            subject,
            slug=slug,
            email=email,
            display_name=display_name,
            issuer=issuer,
        )
        device = await ctx.store.touch_device(
            subject,
            device_id,
            name=normalize_device_name(request.headers.get(DEVICE_NAME_HEADER, "")),
        )
    except StoreUnavailable as exc:
        logger.error("second_brain: store unavailable during auth: %s", exc)
        raise BrainHTTPError(
            503,
            STORE_UNAVAILABLE,
            "The service's database could not be reached. Try again shortly.",
        ) from exc

    if device is None:
        raise BrainHTTPError(
            403,
            DEVICE_REVOKED,
            "This device has been revoked. Sign in again to use it.",
        )

    principal = Principal(
        subject=subject,
        slug=slug,
        email=email,
        display_name=display_name,
        issuer=issuer,
        device=device,
    )
    # Stashed for anything that reads the request outside the dependency
    # (logging middleware, error handlers) without re-verifying.
    request.state.principal = principal
    return principal


async def require_principal(request: Request) -> Principal:
    """The dependency every route depends on. No handler reads a raw header."""
    return await resolve_principal(request)


router = APIRouter(prefix=API_PREFIX)


@router.get("/me")
async def me(principal: Principal = Depends(require_principal)):
    """Who the service thinks you are, and which machine it thinks you are on.

    Cheap, and the route a client uses to find out whether this device is
    still allowed: a revoked machine gets ``403 device_revoked`` here exactly
    as it does everywhere else.
    """
    return principal.to_json()
