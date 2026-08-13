"""Ask the second brain a question about what it holds.

One route. It exists because the store keeps payloads as JSONB the server can
read, which is the concrete thing bought by ruling end-to-end encryption out
permanently: a second brain that answers questions has to be able to read what
it stores. That decision is what turned search into a migration rather than a
redesign.

**Kind-agnostic, like everything else on this side.** The index covers the
string values anywhere in a document, so a kind invented on a client next year
is searchable the day it is first pushed, with no migration and no branch here
(R8). Nothing in this module knows what a session is.

**Scoped by the verified subject, in the store.** The isolation is a property
of ``search_documents`` — it takes a subject and filters on it — rather than a
rule this handler is trusted to remember. That is deliberate: a search route
that leaked across accounts would be the worst possible bug in this service,
and the place to prevent it is the layer that writes the SQL.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, Depends, Request

from second_brain import API_PREFIX
from second_brain.auth import Principal, require_principal
from second_brain.errors import INVALID_CURSOR, STORE_UNAVAILABLE, BrainHTTPError
from second_brain.params import int_param, kinds_param
from second_brain.store.engine import StoreUnavailable

if TYPE_CHECKING:  # pragma: no cover - typing only
    from second_brain.app import BrainContext

logger = logging.getLogger(__name__)

#: Results per request, and the ceiling a caller may ask for. Search is a
#: person reading answers, not a client draining a feed — that is what
#: ``/v1/sync/changes`` is for, and it pages.
DEFAULT_SEARCH_LIMIT = 20
MAX_SEARCH_LIMIT = 100

#: Longest query accepted. The text is handed to ``websearch_to_tsquery``,
#: which will happily parse a megabyte of it.
MAX_QUERY_LENGTH = 500

router = APIRouter(prefix=f"{API_PREFIX}/search")


@router.get("")
async def search(request: Request, principal: Principal = Depends(require_principal)):
    """Rank this person's documents against ``?q=``.

    Returns matches newest-and-best first, each with the ``kind`` and
    ``doc_id`` needed to fetch or open it on a client. Tombstones never match:
    a deleted document is kept so other devices learn about the delete, not so
    it keeps turning up in somebody's results.

    An empty query returns nothing rather than everything. "Everything" is a
    feed read, and answering it here would let a blank search box page a whole
    account through a route that does not paginate.
    """
    ctx: BrainContext = request.app.state.brain

    query = (request.query_params.get("q") or "").strip()
    if len(query) > MAX_QUERY_LENGTH:
        raise BrainHTTPError(
            400,
            INVALID_CURSOR,
            f"A search query is at most {MAX_QUERY_LENGTH} characters.",
        )

    limit = int_param(
        request,
        "limit",
        default=DEFAULT_SEARCH_LIMIT,
        minimum=1,
        maximum=MAX_SEARCH_LIMIT,
    )
    kinds = kinds_param(request)

    if not query:
        return {"query": "", "results": [], "count": 0}

    try:
        matches = await ctx.store.search_documents(
            principal.subject, query, kinds=kinds, limit=limit
        )
    except StoreUnavailable as exc:
        logger.error("second_brain: store unavailable serving search: %s", exc)
        raise BrainHTTPError(
            503,
            STORE_UNAVAILABLE,
            "The service's database could not be reached. Try again shortly.",
        ) from exc

    return {
        "query": query,
        "results": [{**row.to_json(), "rank": rank} for row, rank in matches],
        "count": len(matches),
    }
