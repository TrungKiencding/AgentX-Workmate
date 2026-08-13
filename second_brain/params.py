"""Query parameters, read by hand so a bad one looks like every other refusal.

Not declared as FastAPI parameters, deliberately. FastAPI answers a validation
failure with its own 422 shape, and a client that switches on this service's
flat ``{"error": ..., "detail": ...}`` body cannot read it — so a mistyped
cursor would arrive at the desktop as an unrecognised failure rather than as
``invalid_cursor``. One error shape, everywhere, is worth reading three
parameters by hand.

Shared by :mod:`second_brain.sync` and :mod:`second_brain.search`, which both
take a bounded integer and a list of kinds.
"""

from __future__ import annotations

from typing import Sequence

from fastapi import Request

from second_brain.errors import INVALID_CURSOR, BrainHTTPError

#: Longest ``kind`` accepted anywhere. A kind is an opaque label a client
#: chooses; the column is unbounded ``TEXT``, so the bound lives here.
MAX_KIND_LENGTH = 64


def int_param(
    request: Request,
    name: str,
    *,
    default: int,
    minimum: int,
    maximum: int | None = None,
) -> int:
    """Read a bounded integer, or raise the 400 explaining why not.

    A value above *maximum* is clamped rather than refused: asking for a
    bigger page than the service serves is a reasonable thing for a client to
    try, and the honest answer is a full page rather than an error.
    """
    raw = (request.query_params.get(name) or "").strip()
    if not raw:
        return default

    try:
        value = int(raw)
    except ValueError as exc:
        raise BrainHTTPError(
            400, INVALID_CURSOR, f"{name} must be a whole number."
        ) from exc

    if value < minimum:
        raise BrainHTTPError(400, INVALID_CURSOR, f"{name} must be at least {minimum}.")
    if maximum is not None and value > maximum:
        return maximum
    return value


def kinds_param(request: Request) -> Sequence[str]:
    """Parse ``?kinds=session,message``. Empty means every kind.

    Accepts the parameter repeated as well as comma-separated, because both
    are things clients do and neither is worth refusing.
    """
    kinds: list[str] = []
    for item in request.query_params.getlist("kinds"):
        for part in str(item or "").split(","):
            kind = part.strip()
            if not kind:
                continue
            if len(kind) > MAX_KIND_LENGTH:
                raise BrainHTTPError(
                    400,
                    INVALID_CURSOR,
                    f"kinds entries are at most {MAX_KIND_LENGTH} characters.",
                )
            if kind not in kinds:
                kinds.append(kind)
    return tuple(kinds)
