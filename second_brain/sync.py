"""The change feed: accept what a device pushed, serve it back in order.

Two routes and one ordering guarantee. A device pushes the documents it has
changed; every device — including the one that pushed them — reads the same
feed back, in ``seq`` order, from wherever it last got to.

**Order comes from the server, ties come from the client.** ``seq`` is assigned
by ``brain_put_document`` from a per-account counter taken inside the writing
transaction, so a reader consuming in ``seq`` order cannot skip a record that
was still uncommitted when it passed (see the comment on that function in
``0001_init.sql``). ``updated_at`` is the client's own clock and settles
last-writer-wins **within one document only** — which is why two laptops with
different ideas of the time cannot reorder anybody's history.

**``kind`` is opaque here.** Nothing in this module knows what a ``session``
is, or a ``memory``, or whatever a later client invents. Adding a synced
content type is a change on the client and nowhere else (R8), and the moment
this file needs a branch per kind, that boundary has been drawn wrongly.

**A malformed document does not fail the batch.** This is the one decision in
here that looks lax and is not. The client's outbox only clears rows the
service acknowledged, so refusing a whole push because one entry in it is
unreadable would wedge that device's synchronisation permanently, silently,
on a record that will never become valid — every subsequent tick resending the
same poison and getting the same refusal. Instead each document is answered
individually, and the client clears the rejected rows and logs loudly. Only a
body that is not a push at all gets a 4xx of its own.

A device reads its own writes back. Push does **not** advance the pusher's
pull cursor, and must never be made to: a device that jumped its cursor to the
high-water mark its own push produced would step over anything another device
committed in between. Re-pulling one's own documents costs a few bytes and
lands as a no-op, because ``apply_remote_documents`` is idempotent — and that
same idempotence is what makes "reset the cursor to 0" a safe recovery from a
restored backup.
"""

from __future__ import annotations

import json
import logging
import math
import time
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Depends, Request

from second_brain import API_PREFIX
from second_brain.auth import Principal, require_principal
from second_brain.errors import (
    INVALID_PUSH,
    PAYLOAD_TOO_LARGE,
    STORE_UNAVAILABLE,
    BrainHTTPError,
)
from second_brain.params import MAX_KIND_LENGTH, int_param, kinds_param
from second_brain.store.engine import StoreUnavailable

if TYPE_CHECKING:  # pragma: no cover - typing only
    from second_brain.app import BrainContext

logger = logging.getLogger(__name__)

#: Documents one push may carry. The push holds the account's row lock for as
#: long as it runs, so this bounds how long one device can make another wait —
#: not how much it can send, which the outbox simply spreads over more ticks.
MAX_DOCUMENTS_PER_PUSH = 500

#: Documents one page of the feed returns by default, and the ceiling a client
#: may ask for. A first sync drains by paging, so the ceiling only decides how
#: many round trips that takes.
DEFAULT_PAGE_LIMIT = 200
MAX_PAGE_LIMIT = 1000

#: Bound on the other opaque identifier. ``doc_id`` is unbounded ``TEXT`` in
#: Postgres and arrives from a client, so it is bounded here: an id longer than
#: this is not a document anybody has, it is a way to fill a disk.
#: ``MAX_KIND_LENGTH`` lives in ``params`` because the query parser needs it
#: too.
MAX_DOC_ID_LENGTH = 200

#: How far ahead of the server's clock a client's ``updated_at`` may be before
#: it is pulled back to it. Without a clamp, one laptop whose clock is a day
#: fast would win every last-writer-wins contest for a day — its stale edits
#: beating everybody else's fresh ones — and nothing would recover until the
#: real clock caught up. Five minutes absorbs ordinary drift and NTP steps.
MAX_CLOCK_SKEW_SECONDS = 300.0

router = APIRouter(prefix=f"{API_PREFIX}/sync")


# ---------------------------------------------------------------------------
# Refusals
# ---------------------------------------------------------------------------


def _store_unavailable(exc: StoreUnavailable) -> BrainHTTPError:
    logger.error("second_brain: store unavailable serving sync: %s", exc)
    return BrainHTTPError(
        503,
        STORE_UNAVAILABLE,
        "The service's database could not be reached. Try again shortly.",
    )


# ---------------------------------------------------------------------------
# Reading a push
# ---------------------------------------------------------------------------


async def read_capped_body(request: Request, limit: int) -> bytes:
    """Read the request body, refusing to hold more than *limit* bytes.

    Not ``await request.body()``, and not a FastAPI ``Body`` parameter, both of
    which buffer whatever arrives before anybody can object. The declared
    length is checked first so an honest oversized client is turned away
    without sending anything, and the stream is then measured as it is read so
    a dishonest one — or a chunked upload that declares nothing — is cut off at
    the same ceiling rather than at the memory limit of the process.
    """
    declared = (request.headers.get("content-length") or "").strip()
    if declared.isdigit() and int(declared) > limit:
        raise _too_large(int(declared), limit)

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise _too_large(total, limit)
        chunks.append(chunk)
    return b"".join(chunks)


def _too_large(size: int, limit: int) -> BrainHTTPError:
    return BrainHTTPError(
        413,
        PAYLOAD_TOO_LARGE,
        f"This push is {size} bytes and the service accepts {limit}. Nothing "
        "was stored. Send fewer documents per batch — the records are still "
        "queued on your device.",
        limit=limit,
    )


def parse_push_body(raw: bytes) -> list[Any]:
    """Return the ``documents`` array, or raise the 400 explaining why not.

    Structural only. Whether any individual entry is a document this service
    can store is decided per entry, later, and never fails the batch.
    """
    if not raw.strip():
        raise BrainHTTPError(400, INVALID_PUSH, "A push needs a JSON body.")
    try:
        body = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise BrainHTTPError(400, INVALID_PUSH, "A push body must be JSON.") from exc

    if not isinstance(body, dict):
        raise BrainHTTPError(400, INVALID_PUSH, "A push body must be a JSON object.")

    documents = body.get("documents")
    if not isinstance(documents, list):
        raise BrainHTTPError(
            400, INVALID_PUSH, "A push body must carry a 'documents' array."
        )
    if len(documents) > MAX_DOCUMENTS_PER_PUSH:
        raise BrainHTTPError(
            400,
            INVALID_PUSH,
            f"A push may carry {MAX_DOCUMENTS_PER_PUSH} documents; this one "
            f"carries {len(documents)}. Send them in more than one batch.",
            limit=MAX_DOCUMENTS_PER_PUSH,
        )
    return documents


def clamp_stamp(value: Any, *, now: float | None = None) -> float:
    """Read a client ``updated_at``, bounded to something usable as a tiebreak.

    A stamp that is not a finite number is 0, which loses every tie — the
    honest position for a write that cannot say when it happened. A stamp
    further ahead than :data:`MAX_CLOCK_SKEW_SECONDS` is pulled back to that
    ceiling, so a wrong clock costs its owner nothing and everybody else
    nothing either. Negative stamps clamp to 0.
    """
    try:
        stamp = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(stamp):
        return 0.0
    ceiling = (time.time() if now is None else now) + MAX_CLOCK_SKEW_SECONDS
    return min(max(stamp, 0.0), ceiling)


def normalize_document(document: Any) -> tuple[dict[str, Any] | None, str]:
    """Return ``(document, "")`` or ``(None, reason)``.

    The reason travels back to the client per document rather than as a
    refusal of the batch — see the module docstring on poison documents.
    """
    if not isinstance(document, dict):
        return None, "a document must be a JSON object"

    kind = str(document.get("kind") or "").strip()
    if not kind:
        return None, "a document must name its kind"
    if len(kind) > MAX_KIND_LENGTH:
        return None, f"kind is longer than {MAX_KIND_LENGTH} characters"

    doc_id = str(document.get("doc_id") or "").strip()
    if not doc_id:
        return None, "a document must carry a doc_id"
    if len(doc_id) > MAX_DOC_ID_LENGTH:
        return None, f"doc_id is longer than {MAX_DOC_ID_LENGTH} characters"

    deleted = bool(document.get("deleted"))
    payload = document.get("payload")
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        return None, "payload must be a JSON object"
    if deleted:
        # A tombstone's payload is dead weight that would be retained for the
        # whole window and handed to every device that reads the feed. The
        # delete itself is the entire message.
        payload = {}

    return (
        {
            "kind": kind,
            "doc_id": doc_id,
            "updated_at": clamp_stamp(document.get("updated_at")),
            "deleted": deleted,
            "payload": payload,
        },
        "",
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/push")
async def push(request: Request, principal: Principal = Depends(require_principal)):
    """Store what this device changed, and say where each one landed.

    Every entry is answered: ``{"ok": true, "seq": n}`` for one that was
    stored, ``{"ok": false, "error": "..."}`` for one this service will never
    be able to store. Both are acknowledgements — the client clears its outbox
    row either way, because resending a document that has already been refused
    for being malformed only produces the same refusal forever.

    Documents are applied one at a time rather than under one transaction, on
    purpose. Each ``brain_put_document`` takes the account's row lock for its
    own duration, so a 500-document push from one device does not hold up
    another device's single-document push for the length of the batch. A push
    interrupted half-way is safe to repeat: last-writer-wins accepts an equal
    stamp, so re-sending a document that already landed is a no-op rather than
    a rejection.
    """
    ctx: BrainContext = request.app.state.brain

    raw = await read_capped_body(request, ctx.settings.max_push_bytes)
    documents = parse_push_body(raw)

    results: list[dict[str, Any]] = []
    accepted = 0
    rejected = 0
    cursor = 0

    try:
        for entry in documents:
            normalized, reason = normalize_document(entry)
            if normalized is None:
                rejected += 1
                results.append(
                    {
                        "ok": False,
                        "kind": str((entry or {}).get("kind") or "")[:MAX_KIND_LENGTH]
                        if isinstance(entry, dict)
                        else "",
                        "doc_id": str((entry or {}).get("doc_id") or "")[:MAX_DOC_ID_LENGTH]
                        if isinstance(entry, dict)
                        else "",
                        "error": reason,
                    }
                )
                continue

            seq = await ctx.store.put_document(
                principal.subject,
                kind=normalized["kind"],
                doc_id=normalized["doc_id"],
                updated_at=normalized["updated_at"],
                deleted=normalized["deleted"],
                payload=normalized["payload"],
                device_id=principal.device_id,
            )
            accepted += 1
            cursor = max(cursor, int(seq))
            results.append(
                {
                    "ok": True,
                    "kind": normalized["kind"],
                    "doc_id": normalized["doc_id"],
                    "seq": int(seq),
                }
            )
    except StoreUnavailable as exc:
        raise _store_unavailable(exc) from exc

    if rejected:
        logger.warning(
            "second_brain: rejected %d of %d pushed documents for %s",
            rejected,
            len(documents),
            principal.subject,
        )

    return {
        "accepted": accepted,
        "rejected": rejected,
        # The account's high-water mark after this push. Diagnostic only: a
        # client that adopted it as its pull cursor would step over whatever
        # another device committed in between. See the module docstring.
        "cursor": cursor,
        "results": results,
    }


@router.get("/changes")
async def changes(request: Request, principal: Principal = Depends(require_principal)):
    """One page of this person's feed, everything above ``since``.

    ``has_more`` is what lets a device that has just been set up drain a whole
    history immediately instead of collecting one page per polling interval.
    It is derived by asking for one document more than the page holds, so it
    says whether another page exists rather than guessing from a full one.

    ``cursor`` advances only across documents actually returned. With a
    ``kinds`` filter that means it does not step over the kinds being filtered
    out — a client that later widens its filter still sees the older documents
    it previously skipped, rather than having silently passed them.
    """
    ctx: BrainContext = request.app.state.brain

    since = int_param(request, "since", default=0, minimum=0)
    limit = int_param(
        request, "limit", default=DEFAULT_PAGE_LIMIT, minimum=1, maximum=MAX_PAGE_LIMIT
    )
    kinds = kinds_param(request)

    try:
        # One more than the page, so `has_more` is observed and not inferred.
        rows = await ctx.store.documents_since(
            principal.subject, cursor=since, kinds=kinds, limit=limit + 1
        )
    except StoreUnavailable as exc:
        raise _store_unavailable(exc) from exc

    has_more = len(rows) > limit
    page = rows[:limit]

    return {
        "documents": [row.to_json() for row in page],
        "cursor": int(page[-1].seq) if page else since,
        "has_more": has_more,
    }


# ---------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------


async def sweep_tombstones_forever(ctx: BrainContext) -> None:
    """Sweep expired tombstones on an interval, forever. Started by the app.

    Sleeps **before** its first sweep rather than after, for two reasons: an
    instance that has just started is busy answering the requests that
    restarted it, and a service that swept during startup would have every
    instance in a fleet sweeping at once every time a deploy rolled.

    Never raises. A sweep that fails is logged and retried on the next
    interval — housekeeping falling behind is not a reason to take a
    background task, and the loop with it, permanently out of the process.
    """
    import asyncio

    interval = max(1, int(ctx.settings.tombstone_sweep_seconds))
    days = max(1, int(ctx.settings.tombstone_retention_days))

    while True:
        try:
            await asyncio.sleep(interval)
            swept = await ctx.store.sweep_tombstones(older_than_days=days)
            if swept:
                logger.info(
                    "second_brain: swept %d tombstone(s) older than %d days",
                    swept,
                    days,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - a sweep must not kill the loop
            logger.warning("second_brain: tombstone sweep failed: %s", exc)
