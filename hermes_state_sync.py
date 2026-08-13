"""Outbox drain, document exchange, and cursor bookkeeping for SessionDB.

Mixin contract: this is a plain mixin class consumed by
``hermes_state.SessionDB``. It defines no ``__init__`` and no state of its
own; methods access the host's attributes (``self._conn``, ``self.db_path``,
``self._execute_write`` and other SessionDB methods) established by
``SessionDB.__init__``. It must never import hermes_state (cycle) — shared
module-level constants live in hermes_state_common.

This is the LOCAL half of synchronisation: what changed here, how to describe
one of those changes as a document, and how to apply a document that arrived
from somewhere else. It opens no socket and knows no service — the engine
that carries documents between this database and the second-brain service
lives in ``hermes_cli`` and is built on top of exactly this surface.

Two things in here are load-bearing and easy to get wrong later:

**Documents are serialized by the existing exporter.** ``export_document``
delegates to ``export_session``, and ``apply_remote_documents`` writes through
``_prepare_session_import`` / ``_write_session_import``. A second serializer
would drift from the first, and the two are read by different people at
different times — the divergence would surface as history that survives an
export but not a sync.

**Applying must not re-enqueue.** Every write in here fires the same outbox
triggers a local edit does, so applying a remote document naively would queue
it straight back for pushing, and two devices would trade the same document
forever. The suppression is a watermark: read ``MAX(sync_outbox.id)`` at the
start of the apply transaction, delete everything above it at the end.

The alternative — a suppression flag in ``state_meta`` that the triggers
consult — was rejected, and the reason matters. ``state_meta`` is a table,
not connection state: several AgentX processes share one ``state.db``, so a
flag set there would also suppress a SIBLING process's genuine local edits
for the duration of the apply. That is silent data loss, where the watermark
is exact. ``_execute_write`` holds ``BEGIN IMMEDIATE`` for the whole apply,
so no other connection can write into that id range, and ``AUTOINCREMENT``
guarantees ids are never reused: every row above the watermark is one we
caused ourselves.
"""

import logging
import time
from typing import Any, Dict, Iterable, List, Optional

# Moved methods logged under the "hermes_state" logger before the split;
# keep that logger identity so log filtering/capture behavior is unchanged.
logger = logging.getLogger("hermes_state")


#: Document kinds this build serializes. ``kind`` is an opaque string
#: everywhere else — on the wire, in ``sync_outbox``, and in the service's
#: store — so that adding a synced content type is a client-side change
#: (second-brain plan, R8). These two are simply the ones v26 emits.
SYNC_KIND_SESSION = "session"
SYNC_KIND_MESSAGE = "message"

#: Session columns an applied document is allowed to overwrite: exactly the
#: set ``sync_sessions_update`` watches, minus ``parent_session_id``.
#:
#: Re-parenting is deliberately excluded. A session's parent is set when it is
#: created (``import_sessions`` resolves that, with its own existence and
#: cycle checks) and cleared when its parent is deleted — and that clearing
#: arrives here as the parent's own tombstone, which detaches the child
#: locally anyway. Accepting a remote parent id on an existing row would mean
#: re-implementing the cycle guard for no case the product actually produces.
_APPLIED_SESSION_COLUMNS = (
    "title",
    "display_name",
    "archived",
    "pinned",
    "last_read_at",
    "ended_at",
    "end_reason",
    "model",
)


class SessionSyncMixin:
    """See module docstring — mixin for SessionDB (Sync cluster)."""

    # Outbox rows drained per call by default. The engine pushes a batch per
    # tick, so this bounds one request's payload, not total throughput.
    _OUTBOX_BATCH_LIMIT = 200

    # ── Outbox ────────────────────────────────────────────────────────

    def next_outbox_batch(self, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """The oldest pending changes, coalesced to one entry per document.

        Coalescing is why this returns ``row_ids`` rather than a single id: a
        session renamed, pinned and archived in one sitting is three outbox
        rows describing one document, and pushing that document three times
        would be three copies of the same bytes. The last operation wins —
        a document upserted and then deleted is a delete — and every row the
        entry stands for is reported so :meth:`mark_outbox_done` can clear
        them together.

        Ordered oldest-first, and only within the window ``limit`` covers, so
        a document edited again after the batch was read simply appears in a
        later batch.
        """
        window = int(limit or self._OUTBOX_BATCH_LIMIT)
        with self._read_ctx() as conn:
            rows = conn.execute(
                "SELECT id, kind, doc_id, op, queued_at FROM sync_outbox "
                "ORDER BY id LIMIT ?",
                (window,),
            ).fetchall()

        batch: List[Dict[str, Any]] = []
        by_document: Dict[tuple, Dict[str, Any]] = {}
        for row in rows:
            key = (row["kind"], row["doc_id"])
            entry = by_document.get(key)
            if entry is None:
                entry = {
                    "kind": row["kind"],
                    "doc_id": row["doc_id"],
                    "op": row["op"],
                    "queued_at": row["queued_at"],
                    "row_ids": [],
                }
                by_document[key] = entry
                batch.append(entry)
            else:
                entry["op"] = row["op"]
                entry["queued_at"] = row["queued_at"]
            entry["row_ids"].append(int(row["id"]))
        return batch

    def mark_outbox_done(self, rows: Iterable[Any]) -> int:
        """Drop acknowledged outbox rows and record the push.

        Accepts entries from :meth:`next_outbox_batch` or bare row ids.
        Called only AFTER the service has acknowledged the batch: a
        connection that drops mid-push leaves the rows in place, so the next
        tick sends them again rather than losing them.
        """
        ids: List[int] = []
        for row in rows or ():
            if isinstance(row, dict):
                ids.extend(int(value) for value in row.get("row_ids") or ())
                if not row.get("row_ids") and row.get("id") is not None:
                    ids.append(int(row["id"]))
            else:
                ids.append(int(row))
        if not ids:
            return 0

        pushed_at = time.time()

        def _do(conn):
            removed = 0
            # SQLITE_MAX_VARIABLE_NUMBER is 999 on old builds.
            for start in range(0, len(ids), 900):
                window = ids[start:start + 900]
                placeholders = ",".join("?" for _ in window)
                cursor = conn.execute(
                    f"DELETE FROM sync_outbox WHERE id IN ({placeholders})",
                    window,
                )
                removed += cursor.rowcount or 0
            self._write_sync_state(conn, last_push_at=pushed_at, last_error=None)
            return removed

        return int(self._execute_write(_do))

    def outbox_pending_count(self) -> int:
        """How many change records are waiting to be pushed."""
        with self._read_ctx() as conn:
            row = conn.execute("SELECT COUNT(*) FROM sync_outbox").fetchone()
        return int(row[0] if row else 0)

    # ── Documents ─────────────────────────────────────────────────────

    def export_document(self, kind: str, doc_id: str) -> Optional[Dict[str, Any]]:
        """Describe one local document in the envelope the feed carries.

        Returns None when there is nothing to describe: the document was
        deleted locally after its outbox row was written (the tombstone in
        that row is what travels instead), or ``kind`` is not one this build
        knows how to serialize. The caller treats both as "nothing to push",
        which is also the safe reading while two versions share a database.
        """
        if kind == SYNC_KIND_SESSION:
            session = self.export_session(doc_id)
            if session is None:
                return None
            return self._envelope(
                kind,
                doc_id,
                # updated_at is NULL until the session is first edited, and
                # the column cannot be backfilled — started_at is the honest
                # floor, and it is NOT NULL.
                session.get("updated_at") or session.get("started_at"),
                session,
            )

        if kind == SYNC_KIND_MESSAGE:
            with self._read_ctx() as conn:
                row = conn.execute(
                    "SELECT * FROM messages WHERE uuid = ?", (doc_id,)
                ).fetchone()
            if row is None:
                return None
            message = self._message_row_dict(row)
            return self._envelope(
                kind,
                doc_id,
                message.get("timestamp"),
                {"session_id": message.get("session_id"), "message": message},
            )

        logger.debug("export_document: unknown kind %r", kind)
        return None

    def export_tombstone(self, kind: str, doc_id: str) -> Dict[str, Any]:
        """The envelope for a document that no longer exists here.

        Deletes have to travel as tombstones rather than as an absence:
        without one, a device that was offline during the delete pushes the
        rows back the next time it syncs.
        """
        envelope = self._envelope(kind, doc_id, time.time(), None)
        envelope["deleted"] = True
        return envelope

    @staticmethod
    def _envelope(
        kind: str,
        doc_id: str,
        updated_at: Any,
        payload: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        try:
            stamp = float(updated_at)
        except (TypeError, ValueError):
            stamp = 0.0
        return {
            "kind": kind,
            "doc_id": doc_id,
            "updated_at": stamp,
            "deleted": False,
            "payload": payload,
        }

    # ── Apply ─────────────────────────────────────────────────────────

    def apply_remote_documents(
        self, documents: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """Land documents pulled from the feed, oldest first.

        IDEMPOTENT by construction: a session that already exists is resolved
        by ``updated_at`` and a message that already exists is skipped by
        uuid, so applying the same page twice changes nothing the second
        time. That is what makes resetting a client's cursor to 0 a safe
        recovery — re-pulling the whole feed is not destructive.

        One transaction for the whole batch, so a crash mid-page leaves the
        cursor and the rows it covers in agreement, and so the outbox rows
        this apply provokes can be cleared before anything else can read
        them (see the module docstring).

        Returns counts plus a per-document ``errors`` list; a document that
        cannot be applied never aborts the ones around it.
        """
        if not isinstance(documents, list):
            raise ValueError("documents must be a list")
        if not documents:
            return {
                "ok": True, "applied": 0, "skipped": 0, "deleted": 0, "errors": []
            }

        def _do(conn):
            row = conn.execute("SELECT COALESCE(MAX(id), 0) FROM sync_outbox").fetchone()
            watermark = int(row[0] if row else 0)

            result: Dict[str, Any] = {
                "ok": True, "applied": 0, "skipped": 0, "deleted": 0, "errors": [],
            }
            for index, document in enumerate(documents):
                try:
                    self._apply_one_document(conn, document, result)
                except Exception as exc:  # noqa: BLE001 - reported, not raised
                    logger.warning(
                        "sync: could not apply document %r: %s",
                        (document or {}).get("doc_id"), exc,
                    )
                    result["errors"].append(
                        {
                            "index": index,
                            "doc_id": (document or {}).get("doc_id"),
                            "error": str(exc),
                        }
                    )

            # Everything the applies queued is ours, by definition of the
            # watermark. Dropping it here is what stops two devices from
            # pushing each other's changes back and forth forever.
            conn.execute("DELETE FROM sync_outbox WHERE id > ?", (watermark,))
            return result

        return self._execute_write(_do)

    def _apply_one_document(
        self, conn, document: Dict[str, Any], result: Dict[str, Any]
    ) -> None:
        if not isinstance(document, dict):
            raise ValueError("document must be an object")
        kind = document.get("kind")
        doc_id = str(document.get("doc_id") or "").strip()
        if not doc_id:
            raise ValueError("document doc_id is required")

        if document.get("deleted"):
            self._apply_deletion(conn, kind, doc_id, result)
            return

        if kind == SYNC_KIND_SESSION:
            self._apply_session(conn, document, doc_id, result)
        elif kind == SYNC_KIND_MESSAGE:
            self._apply_message(conn, document, doc_id, result)
        else:
            # An opaque kind this build does not handle is not an error — it
            # belongs to another client of the same feed (R8).
            result["skipped"] += 1

    def _apply_deletion(
        self, conn, kind: Any, doc_id: str, result: Dict[str, Any]
    ) -> None:
        if kind == SYNC_KIND_SESSION:
            exists = conn.execute(
                "SELECT 1 FROM sessions WHERE id = ? LIMIT 1", (doc_id,)
            ).fetchone()
            if exists is None:
                result["skipped"] += 1
                return
            # Only the named session. The cascade the origin device ran
            # produced its own tombstone per deleted row, and its detached
            # branch children arrive as their own upserts — re-deriving the
            # cascade here would delete sessions the feed never condemned.
            conn.execute(
                "UPDATE sessions SET parent_session_id = NULL "
                "WHERE parent_session_id = ?",
                (doc_id,),
            )
            conn.execute("DELETE FROM messages WHERE session_id = ?", (doc_id,))
            conn.execute("DELETE FROM sessions WHERE id = ?", (doc_id,))
            self._delete_unreferenced_system_prompts(conn)
            result["deleted"] += 1
            return

        if kind == SYNC_KIND_MESSAGE:
            row = conn.execute(
                "SELECT session_id FROM messages WHERE uuid = ?", (doc_id,)
            ).fetchone()
            if row is None:
                result["skipped"] += 1
                return
            conn.execute("DELETE FROM messages WHERE uuid = ?", (doc_id,))
            conn.execute(
                "UPDATE sessions SET message_count = MAX(message_count - 1, 0) "
                "WHERE id = ?",
                (row["session_id"],),
            )
            result["deleted"] += 1
            return

        result["skipped"] += 1

    def _apply_session(
        self, conn, document: Dict[str, Any], doc_id: str, result: Dict[str, Any]
    ) -> None:
        payload = document.get("payload")
        if not isinstance(payload, dict):
            raise ValueError("session document payload must be an object")
        remote_stamp = self._document_stamp(document, payload.get("started_at"))

        local = conn.execute(
            "SELECT COALESCE(updated_at, started_at) AS stamp FROM sessions "
            "WHERE id = ?",
            (doc_id,),
        ).fetchone()

        if local is None:
            payload = {**payload, "id": doc_id}
            normalized, errors = self._prepare_session_import([payload])
            if errors:
                raise ValueError(errors[0].get("error", "invalid session document"))
            self._write_session_import(conn, normalized)
            # `import_sessions` is the EXPORT format's importer, and it writes
            # the columns an export has always carried — which is not the same
            # set as the columns that synchronise. `pinned`, `display_name` and
            # `last_read_at` are synced but were never part of an export, so a
            # session arriving for the first time would land without them, and
            # last-writer-wins would then reject every later document that
            # could have supplied them. Two devices, permanently different, on
            # a field nobody thinks to check.
            #
            # Reusing the exporter and then completing the synced set is still
            # one serializer. Writing a second one here is what would drift.
            self._write_session_columns(conn, payload, doc_id, remote_stamp)
            result["applied"] += 1
            return

        if remote_stamp < float(local["stamp"] or 0.0):
            # Last writer wins, and the local copy is the last writer. Feed
            # ORDER comes from the server's per-account sequence; this stamp
            # only breaks ties within one document.
            result["skipped"] += 1
            return

        # A TIE APPLIES, and the strict `<` above is why. `updated_at` comes
        # from `julianday('now')`, which resolves to about a millisecond, so
        # two devices editing the same session moments apart genuinely land on
        # the same stamp — this is a routine condition, not a corner case.
        #
        # The server accepts ties (`documents.updated_at <= EXCLUDED`), so on a
        # tie its stored copy is whichever device pushed last. If this side
        # rejected ties, that device would keep its own version while every
        # other device converged on the server's: two machines holding
        # different rows forever, with nothing reporting a conflict.
        #
        # So the rule is the server's rule, on both sides: the feed is the
        # authority. Re-applying an identical document is a no-op, which is
        # what keeps this from oscillating — and is the same property that
        # makes a cursor reset safe.

        self._write_session_columns(conn, payload, doc_id, remote_stamp)
        self._merge_session_messages(conn, doc_id, payload.get("messages") or [])
        result["applied"] += 1

    @staticmethod
    def _write_session_columns(
        conn, payload: Dict[str, Any], doc_id: str, remote_stamp: float
    ) -> None:
        """Land the synced columns, then the stamp they arrived with.

        Two statements, and the order matters. The first touches columns
        ``sync_sessions_update`` watches, so that trigger fires and stamps
        ``updated_at`` with the LOCAL clock — overwriting anything the same
        statement had set. Written together, this row would claim it changed
        *now* rather than when the device that actually changed it says it did.

        That is not cosmetic. A device applying a document it received late
        would mark its copy newer than the document, and then reject as stale
        every update the origin made in between.

        ``updated_at`` is deliberately absent from the trigger's ``UPDATE OF``
        list, so the second statement fires nothing.
        """
        assignments = ", ".join(f"{column} = ?" for column in _APPLIED_SESSION_COLUMNS)
        conn.execute(
            f"UPDATE sessions SET {assignments} WHERE id = ?",
            [payload.get(column) for column in _APPLIED_SESSION_COLUMNS] + [doc_id],
        )
        conn.execute(
            "UPDATE sessions SET updated_at = ? WHERE id = ?",
            (remote_stamp, doc_id),
        )

    def _apply_message(
        self, conn, document: Dict[str, Any], doc_id: str, result: Dict[str, Any]
    ) -> None:
        payload = document.get("payload")
        if not isinstance(payload, dict):
            raise ValueError("message document payload must be an object")
        message = payload.get("message")
        session_id = str(payload.get("session_id") or "").strip()
        if not isinstance(message, dict) or not session_id:
            raise ValueError("message document must carry session_id and message")

        seen = conn.execute(
            "SELECT 1 FROM messages WHERE uuid = ? LIMIT 1", (doc_id,)
        ).fetchone()
        if seen is not None:
            result["skipped"] += 1
            return

        session_exists = conn.execute(
            "SELECT 1 FROM sessions WHERE id = ? LIMIT 1", (session_id,)
        ).fetchone()
        if session_exists is None:
            # The session document is pushed before its first message and the
            # feed is ordered, so this only happens when a page was applied
            # out of order or its session document was rejected. Skipping is
            # recoverable — the message is still in the feed — where an
            # insert would violate the foreign key and take the page with it.
            logger.debug(
                "sync: message %s arrived before session %s", doc_id, session_id
            )
            result["skipped"] += 1
            return

        self._merge_session_messages(conn, session_id, [{**message, "uuid": doc_id}])
        result["applied"] += 1

    def _merge_session_messages(
        self, conn, session_id: str, messages: List[Dict[str, Any]]
    ) -> None:
        """Insert the messages this database does not already have.

        Identity is the uuid, so a document re-applied after a cursor reset
        adds nothing. Messages that arrive without one cannot be matched and
        are dropped rather than duplicated on every pass — a message with no
        portable identity is not synchronisable by definition.
        """
        wanted = [
            message for message in messages
            if isinstance(message, dict)
            and isinstance(message.get("uuid"), str)
            and message.get("uuid")
        ]
        if not wanted:
            return

        known: set = set()
        candidates = sorted({message["uuid"] for message in wanted})
        for start in range(0, len(candidates), 900):
            window = candidates[start:start + 900]
            placeholders = ",".join("?" for _ in window)
            known.update(
                row[0]
                for row in conn.execute(
                    f"SELECT uuid FROM messages WHERE uuid IN ({placeholders})",
                    window,
                ).fetchall()
            )

        fresh = [message for message in wanted if message["uuid"] not in known]
        if not fresh:
            return

        inserted, tool_calls = self._insert_message_rows(conn, session_id, fresh)
        conn.execute(
            "UPDATE sessions SET message_count = message_count + ?, "
            "tool_call_count = tool_call_count + ? WHERE id = ?",
            (inserted, tool_calls, session_id),
        )

    @staticmethod
    def _document_stamp(document: Dict[str, Any], fallback: Any) -> float:
        for candidate in (document.get("updated_at"), fallback):
            try:
                if candidate is not None:
                    return float(candidate)
            except (TypeError, ValueError):
                continue
        return 0.0

    # ── Cursor and status ─────────────────────────────────────────────

    def sync_cursor(self) -> int:
        """This device's position in the server's change feed (0 = start)."""
        with self._read_ctx() as conn:
            row = conn.execute(
                "SELECT cursor FROM sync_state WHERE id = 1"
            ).fetchone()
        return int(row["cursor"]) if row is not None else 0

    def set_sync_cursor(self, cursor: int) -> None:
        """Advance the feed position after a page has been applied.

        Advancing IS the record of a successful pull, so this also stamps
        ``last_pull_at`` and clears ``last_error`` — there is no way to reach
        a new cursor without having reached the service.

        Written in the same transaction as nothing else on purpose: the
        caller applies a page and then advances, so a crash between the two
        replays that page, which :meth:`apply_remote_documents` makes free.
        """
        position = int(cursor)
        if position < 0:
            raise ValueError("sync cursor must not be negative")
        pulled_at = time.time()
        self._execute_write(
            lambda conn: self._write_sync_state(
                conn, cursor=position, last_pull_at=pulled_at, last_error=None
            )
        )

    def set_sync_error(self, message: Optional[str]) -> None:
        """Record (or clear, with None) why the last attempt did not finish."""
        self._execute_write(
            lambda conn: self._write_sync_state(conn, last_error=message)
        )

    def sync_status(self) -> Dict[str, Any]:
        """Everything a support surface needs: position, backlog, outcome."""
        with self._read_ctx() as conn:
            row = conn.execute(
                "SELECT cursor, last_pull_at, last_push_at, last_error "
                "FROM sync_state WHERE id = 1"
            ).fetchone()
            pending = conn.execute("SELECT COUNT(*) FROM sync_outbox").fetchone()
        return {
            "cursor": int(row["cursor"]) if row is not None else 0,
            "pending": int(pending[0] if pending else 0),
            "last_pull_at": row["last_pull_at"] if row is not None else None,
            "last_push_at": row["last_push_at"] if row is not None else None,
            "last_error": row["last_error"] if row is not None else None,
        }

    @staticmethod
    def _write_sync_state(conn, **fields: Any) -> None:
        """Upsert the single ``sync_state`` row, touching only what is given.

        ``last_error`` is written whenever the caller names it, including as
        None — clearing the last failure is the whole point of naming it —
        so it cannot be folded into the "skip None" rule the others use.
        """
        updates = {
            name: value
            for name, value in fields.items()
            if value is not None or name == "last_error"
        }
        if not updates:
            return
        columns = ", ".join(updates)
        placeholders = ", ".join("?" for _ in updates)
        assignments = ", ".join(f"{name} = excluded.{name}" for name in updates)
        conn.execute(
            f"INSERT INTO sync_state (id, {columns}) VALUES (1, {placeholders}) "
            f"ON CONFLICT(id) DO UPDATE SET {assignments}",
            list(updates.values()),
        )
