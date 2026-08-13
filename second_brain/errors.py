"""What a refusal looks like on the wire, and the codes clients switch on.

Two kinds of failure live here and they are not the same thing.

:class:`BrainConfigError` is the operator's. It is raised while the app is
being built, before anything is listening, and it names the setting that is
missing. It never reaches a client.

:class:`BrainHTTPError` is the caller's. It carries a machine-readable
``code`` alongside the human sentence, because the desktop app has to act
differently on ``device_revoked`` (sign the person out) than on
``identity_unavailable`` (keep working, try later) — and a client that has to
match on English prose to tell those apart is a client that breaks when the
prose improves.

The rendered body is deliberately flat::

    {"error": "device_revoked", "detail": "This device has been revoked."}

rather than FastAPI's default ``{"detail": ...}`` wrapper, so ``error`` is one
field access away in every client and never a nested shape that depends on
whether we passed a string or a dict.
"""

from __future__ import annotations

from typing import Any

# --- codes ----------------------------------------------------------------
#
# Every code the service can answer with, named once so a route cannot invent
# a near-miss spelling of one that already exists and clients cannot be caught
# out by it.

#: No bearer token on a route that requires one.
MISSING_BEARER = "missing_bearer"

#: The realm rejected the token: expired, malformed, wrong audience.
INVALID_TOKEN = "invalid_token"

#: The realm could not be asked. Never conflated with INVALID_TOKEN — a 401
#: tells a laptop to discard what it holds, and an outage must not do that.
IDENTITY_UNAVAILABLE = "identity_unavailable"

#: The caller sent no ``X-AgentX-Device`` header.
DEVICE_HEADER_MISSING = "device_header_missing"

#: The caller sent one, but it is not the UUID shape this service accepts.
DEVICE_HEADER_INVALID = "device_header_invalid"

#: This device was revoked. Answered on every route, including ``/v1/me``.
DEVICE_REVOKED = "device_revoked"

#: No such device *for this subject*. Also the answer for a device that
#: belongs to somebody else, so the route cannot be used to confirm that
#: another person's device exists.
DEVICE_NOT_FOUND = "device_not_found"

#: Revoking this device would leave the person with no device able to fetch
#: the replacement key.
CANNOT_REVOKE_LAST_DEVICE = "cannot_revoke_last_device"

#: The store could not be reached. Distinct from a 500: nothing is wrong with
#: the request and retrying it later is the right move.
STORE_UNAVAILABLE = "store_unavailable"

#: This deployment has no LiteLLM proxy configured, so it cannot mint. An
#: operator problem rather than a caller's, but answered as 503 for the same
#: reason an outage is: the laptop should keep the key it holds and try again
#: once somebody has fixed the deploy.
LITELLM_UNCONFIGURED = "litellm_unconfigured"

#: The proxy could not be reached. Nothing was minted and nothing was stored.
LITELLM_UNAVAILABLE = "litellm_unavailable"

#: The proxy answered, and refused. Distinct from the above because only this
#: one means the request itself is the problem.
LITELLM_REFUSED = "litellm_refused"

#: A key is stored for this person and the service cannot open it — the KEK it
#: was wrapped with is not one this process holds. Never a 401: the caller is
#: exactly who they say they are, and discarding their credentials would not
#: help. See "Rotating the KEK" in deploy/second-brain/README.md.
KEY_UNREADABLE = "key_unreadable"

#: A pushed body is larger than this deployment accepts. Nothing was stored,
#: so the client still holds every record it tried to send and should retry
#: with a smaller batch rather than dropping them.
PAYLOAD_TOO_LARGE = "payload_too_large"

#: A push body that is not the shape the route accepts at all — not JSON, or
#: without a ``documents`` array. Distinct from a single malformed document,
#: which is reported per-document and never fails the batch: see the note on
#: poison documents in :mod:`second_brain.sync`.
INVALID_PUSH = "invalid_push"

#: A ``since``, ``limit`` or ``kinds`` value the feed cannot read.
INVALID_CURSOR = "invalid_cursor"


class BrainConfigError(RuntimeError):
    """The service cannot start with the configuration it was given.

    Raised during ``build_app``, so a misconfigured deploy fails while the
    operator is watching it rather than during somebody's sign-in.
    """


class BrainHTTPError(Exception):
    """A refusal with a status, a code, and a sentence.

    Raised by any module; rendered by the handler that ``build_app``
    registers. Routes raise this rather than ``HTTPException`` so the body
    shape is decided in one place.
    """

    def __init__(self, status_code: int, code: str, detail: str, **extra: Any) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.code = code
        self.detail = detail
        #: Extra fields merged into the body. Used where a client can act on
        #: more than the code alone (which devices remain, for instance).
        self.extra = extra

    def to_json(self) -> dict[str, Any]:
        return {"error": self.code, "detail": self.detail, **self.extra}


def install_error_handler(app: Any) -> None:
    """Teach *app* to render :class:`BrainHTTPError` as its flat body."""
    from fastapi.responses import JSONResponse

    @app.exception_handler(BrainHTTPError)
    async def _render(_request: Any, exc: BrainHTTPError):  # pragma: no cover - trivial
        return JSONResponse(status_code=exc.status_code, content=exc.to_json())
