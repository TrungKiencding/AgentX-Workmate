"""User-facing projection of a compacted transcript.

In-place compaction (#38763) soft-archives every live row (``active = 0,
compacted = 1``) and inserts the compacted set as new live rows: copies of the
protected head, the summary handoff, copies of the protected tail. The model
only ever reloads the live rows. A transcript UI that reads the same rows shows
the handoff as an opaque user bubble and loses everything it summarized.

:func:`fold_compaction_display` turns ``archived + live`` rows (in insertion
order) back into what the user actually lived through: every original turn
once, with one ``display_kind="compaction"`` row at each point the context was
summarized. It is a pure display transform; model-fed history never goes
through it.

The same fold also runs over a live-only history (no archived rows — an older
backend, the in-memory fallback): nothing is dropped there, the handoff is
still rendered as a divider.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional

COMPACTION_DISPLAY_KIND = "compaction"


def _text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(part for part in parts if part)
    return str(content)


def _norm(content: Any) -> str:
    return " ".join(_text(content).split())


def _call_ids(message: Dict[str, Any]) -> tuple:
    calls = message.get("tool_calls")
    if isinstance(calls, str):
        try:
            calls = json.loads(calls)
        except (TypeError, ValueError):
            calls = None
    if not isinstance(calls, list):
        return ()
    return tuple(c.get("id") for c in calls if isinstance(c, dict))


def _is_live(message: Dict[str, Any]) -> bool:
    """Whether the row is part of the model-fed history.

    ``_archived`` is stamped by the conversation projection; raw
    ``get_messages`` rows carry the ``active`` column instead. A dict with
    neither (in-memory history) is live.
    """
    if message.get("_archived"):
        return False
    return message.get("active", 1) not in (0, False)


def _same_turn(copy: Dict[str, Any], original: Dict[str, Any]) -> bool:
    """Whether *copy* is the compactor's re-insert of *original*.

    Copies keep the original's creation timestamp (live messages are stamped
    at append time), which is the strong key. The fallbacks cover rows written
    before timestamps were stamped: tool-call ids, then the visible text. The
    compactor may prune a copied tool result's body, so tool rows never
    compare content.
    """
    if copy.get("role") != original.get("role"):
        return False
    ts_copy, ts_original = copy.get("timestamp"), original.get("timestamp")
    if ts_copy is not None and ts_copy == ts_original:
        return True
    if copy.get("tool_call_id") or original.get("tool_call_id"):
        return bool(copy.get("tool_call_id")) and copy.get("tool_call_id") == original.get("tool_call_id")
    ids_copy, ids_original = _call_ids(copy), _call_ids(original)
    if ids_copy or ids_original:
        return ids_copy == ids_original
    text = _norm(copy.get("content"))
    return bool(text) and text == _norm(original.get("content"))


def _counts_as_user_turn(message: Dict[str, Any]) -> bool:
    # Mirrors prompt.submit's truncate ordinal: role=user rows without a
    # display_kind (timeline bookkeeping rows are not turns).
    return message.get("role") == "user" and not message.get("display_kind")


def _default_split(content: Any) -> Optional[tuple[str, str]]:
    from agent.context_compressor import split_compaction_summary

    return split_compaction_summary(content)


def fold_compaction_display(
    messages: List[Dict[str, Any]],
    *,
    split: Callable[[Any], Optional[tuple[str, str]]] = _default_split,
) -> List[Dict[str, Any]]:
    """Return the display projection of *messages* (ordered by row id).

    Each compaction handoff becomes ``{"display_kind": "compaction",
    "content": <summary body>, "display_metadata": {"compaction":
    {"user_turns_before": N}}}``. ``N`` counts the model-history user turns
    that the display does NOT show after the divider (the copied head, the
    handoff itself when it is a user row, the copied tail), so a client can
    map a turn it shows after the last divider back to prompt.submit's
    ``truncate_before_user_ordinal``. Re-inserted head/tail copies are dropped
    when their originals are present (archived rows); without archived rows
    nothing but the handoff changes.
    """
    summaries: Dict[int, tuple[str, str]] = {}
    for index, message in enumerate(messages):
        if message.get("role") not in ("user", "assistant") or message.get("display_kind"):
            continue
        parts = split(message.get("content"))
        if parts is not None:
            summaries[index] = parts
    if not summaries:
        return messages

    count = len(messages)
    order = sorted(summaries)
    drop: set[int] = set()
    dividers: Dict[int, Dict[str, Any]] = {}
    carriers: Dict[int, Dict[str, Any]] = {}  # real turn text shown after a divider
    seen_bodies: set[str] = set()
    previous = -1

    for position, s in enumerate(order):
        if s in drop:
            continue
        body, residual = summaries[s]
        if body.strip() in seen_bodies:
            # A handoff the compactor carried forward verbatim: its first
            # occurrence already marks this point.
            drop.add(s)
            continue
        seen_bodies.add(body.strip())

        # Head copies sit right before the handoff and repeat the transcript's
        # opening rows, which (as originals) must come first.
        head = 0
        for size in range(s - previous - 1, 0, -1):
            if s - size >= size and all(
                _same_turn(messages[s - size + i], messages[i]) for i in range(size)
            ):
                head = size
                break
        block_start = s - head

        # Tail copies follow the handoff (a carrier row that kept real turn
        # text is the first of them) and repeat the end of everything before
        # this block.
        carrier = None
        if residual:
            carrier = dict(messages[s])
            carrier["content"] = residual
        tail_start = s if carrier is not None else s + 1
        next_summary = order[position + 1] if position + 1 < len(order) else count
        tail = 0
        for size in range(min(next_summary - tail_start, block_start), 0, -1):
            if all(
                _same_turn(
                    carrier if tail_start + i == s else messages[tail_start + i],
                    messages[block_start - size + i],
                )
                for i in range(size)
            ):
                tail = size
                break
        tail_end = tail_start + tail

        # Copies are only redundant when their originals are on screen too.
        # A live-only history (older backend, in-memory fallback) has nothing
        # else to show, so its head and tail rows stay and count after the
        # divider like any other turn.
        has_originals = any(not _is_live(m) for m in messages[:block_start])
        carrier_is_copy = carrier is not None and has_originals and tail > 0
        if has_originals:
            drop.update(range(block_start, s))
            drop.update(i for i in range(tail_start, tail_end) if i != s)
        hidden_end = max(tail_end, s + 1) if has_originals else s + 1

        user_turns_before = sum(
            1
            for i in range(hidden_end)
            if _is_live(messages[i]) and _counts_as_user_turn(messages[i])
        )
        if carrier is not None and not carrier_is_copy and _counts_as_user_turn(messages[s]):
            # The carrier's real text is shown after the divider, where the
            # client counts it itself.
            user_turns_before -= 1

        divider = dict(messages[s])
        divider["content"] = body
        divider["display_kind"] = COMPACTION_DISPLAY_KIND
        divider.pop("tool_calls", None)
        metadata = divider.get("display_metadata")
        metadata = dict(metadata) if isinstance(metadata, dict) else {}
        metadata["compaction"] = {"user_turns_before": max(user_turns_before, 0)}
        divider["display_metadata"] = metadata
        dividers[s] = divider
        if carrier is not None and not carrier_is_copy:
            carrier.pop("display_kind", None)
            carriers[s] = carrier
        previous = s

    out: List[Dict[str, Any]] = []
    for index, message in enumerate(messages):
        if index in dividers:
            out.append(dividers[index])
            if index in carriers:
                out.append(carriers[index])
        elif index not in drop and index not in summaries:
            out.append(message)
    return out
