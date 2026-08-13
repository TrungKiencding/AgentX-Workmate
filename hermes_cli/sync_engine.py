"""Carry documents between this machine's ``state.db`` and the second brain.

This is the half of synchronisation that moves bytes. The local half — what
changed, how to describe it, how to apply something that arrived — is
``hermes_state_sync.SessionSyncMixin``, and the remote half is
``second_brain/sync.py``. This module knows both and owns neither.

It runs inside the backend process because that is where ``state.db`` already
is. Starting a second process to reach the same file would mean two writers,
two schema reconciliations, and a lock to arbitrate them, for no gain.

Four rules hold the whole design up.

**Push before pull, every tick.** A record created here goes out before
anything comes in. Reversed, an incoming page could overwrite a local edit
that had not been sent yet, and last-writer-wins would decide it correctly
for the wrong reason — the local edit was newer, but nobody had heard of it.

**An outbox row is cleared only after the service acknowledges it.** A
connection that drops mid-push costs a repeated push, never a lost record.
Repeating is free: last-writer-wins accepts an equal stamp, so a document that
already landed lands again as a no-op.

**The cursor advances one applied page at a time.** A crash between applying a
page and recording its cursor replays that page, and replaying is free because
``apply_remote_documents`` is idempotent. The reverse order — cursor first —
would skip a page instead, which nothing recovers from.

**Unreachable is not an error the person has to see.** The service being down
leaves the app entirely usable: the tick records why it stopped, does nothing
else, and tries again later. This is the same contract ``ensure_account_key``
keeps for the model key, and it is the reason a laptop on a train is a laptop
that still works.

The tick is synchronous, because every outbound HTTP path in the CLI is
synchronous and :class:`SecondBrainClient` is shaped that way deliberately.
The async loop hands it to a worker thread, which is what
``web_routers/accounts.py`` already does for the same client.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("hermes_cli.sync_engine")

#: Seconds between ticks when nothing nudges the engine. Thirty is well inside
#: the window in which "did my other laptop get this?" still feels live, and
#: is two orders of magnitude cheaper than it sounds: an idle tick is one
#: request that returns an empty page.
DEFAULT_INTERVAL_SECONDS = 30.0

#: Outbox rows drained per request, and documents pulled per page. Both are
#: below the service's own ceilings (500 per push, 1000 per page) so a client
#: at its limit is never the thing that trips the service's.
PUSH_BATCH_SIZE = 200
PULL_PAGE_SIZE = 200

#: Requests one tick may make in each direction. A first sync of a large
#: history therefore spans several ticks instead of holding one thread for
#: minutes — and the app stays responsive while it catches up.
MAX_PUSH_BATCHES_PER_TICK = 20
MAX_PULL_PAGES_PER_TICK = 20

#: How long to wait before opening the change socket again after it closes.
#: Short, because the usual reason it closed is not a fault: the bearer that
#: opened it expired, and this process cannot renew one — the desktop mints
#: them and delivers them on the next tick.
STREAM_RECONNECT_SECONDS = 5.0

#: WebSocket ping interval and timeout. Bounds how long a half-open
#: connection — a laptop that slept, a NAT that dropped the mapping — can look
#: alive while carrying nothing.
STREAM_PING_SECONDS = 30.0

#: How long the engine waits after being told this device is revoked, or that
#: its token is not valid. Neither is fixed by retrying — a person has to sign
#: in again — so the loop backs off hard rather than hammering a service that
#: is correctly saying no.
REAUTH_BACKOFF_SECONDS = 300.0


@dataclass(frozen=True)
class SyncCredentials:
    """Who is syncing, from which machine, and until when.

    The engine never obtains a bearer itself, and cannot: this process has no
    persistent credential for the signed-in person and no way to refresh one.
    The token is an ID token verified against the realm's JWKS, it is minted by
    the desktop's main process (which holds the refresh token in the OS
    keychain), and it reaches the backend only as the ``Authorization`` header
    of a request somebody made. So the engine is *given* credentials, on every
    tick, and stops rather than retrying with a copy it cannot renew.

    ``expires_at`` is the token's own ``exp``. Zero means "unknown", which is
    treated as usable — the service is the authority on whether a token is
    good, and refusing to try would be this process second-guessing it.
    """

    bearer: str
    device_id: str
    device_name: str = ""
    expires_at: float = 0.0

    @property
    def usable(self) -> bool:
        if not (self.bearer and self.device_id):
            return False
        if self.expires_at and self.expires_at <= time.time():
            # Sending a token we can see has expired would spend a request to
            # be told 401, and a 401 puts the engine into its re-auth backoff —
            # so an expired copy would suspend synchronisation for five minutes
            # rather than simply waiting for the next one to arrive.
            return False
        return True


@dataclass
class SyncOutcome:
    """What one tick did, in the shape ``agentx sync status`` prints.

    ``status`` is the field to branch on:

    ``ok``            the tick completed, whether or not anything moved
    ``disabled``      switched off in config
    ``unconfigured``  no ``accounts.second_brain.base_url`` on this machine
    ``signed_out``    nobody is signed in, or no token was available
    ``offline``       the service could not be reached. Not an error.
    ``reauth``        this device is revoked, or the token was rejected
    ``error``         the service answered, and refused
    """

    status: str = "ok"
    detail: str = ""
    pushed: int = 0
    rejected: int = 0
    pulled: int = 0
    applied: int = 0
    deleted: int = 0
    skipped: int = 0
    cursor: int = 0
    pending: int = 0
    errors: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.status == "ok"

    def to_json(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "detail": self.detail,
            "pushed": self.pushed,
            "rejected": self.rejected,
            "pulled": self.pulled,
            "applied": self.applied,
            "deleted": self.deleted,
            "skipped": self.skipped,
            "cursor": self.cursor,
            "pending": self.pending,
            "errors": self.errors[:10],
        }


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SyncSettings:
    """``accounts.second_brain`` as synchronisation reads it."""

    base_url: str = ""
    enabled: bool = True
    interval_seconds: float = DEFAULT_INTERVAL_SECONDS
    request_timeout_seconds: float = 15.0
    #: Hold a socket open so changes arrive without waiting for the next tick.
    #: Strictly an optimisation in front of polling — with it off, or with the
    #: socket unavailable, everything still converges on ``interval_seconds``.
    realtime: bool = True
    #: Document kinds this device asks the feed for. Empty means every kind,
    #: which is what a client that wants to converge should ask for: filtering
    #: is for a different client of the same feed, not for saving bytes here.
    kinds: tuple = ()

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    @property
    def stream_url(self) -> str:
        """``/v1/sync/stream`` as a WebSocket URL, or empty when unconfigured."""
        if not self.base_url:
            return ""
        root = self.base_url
        if root.startswith("https://"):
            return "wss://" + root[len("https://"):] + "/v1/sync/stream"
        if root.startswith("http://"):
            return "ws://" + root[len("http://"):] + "/v1/sync/stream"
        return ""


def load_sync_settings() -> SyncSettings:
    """Read the sync policy from the INSTALL root's config.

    Machine policy rather than a personal preference — which service this
    fleet talks to, and whether this machine is allowed to talk to it at all.
    Read from the install root for the same reason ``_second_brain_settings``
    in ``web_routers/accounts.py`` is: an account home is created at sign-in
    with no ``config.yaml``, so a per-account setting would come back empty and
    nothing would ever be configured.
    """
    from hermes_cli.account_provisioning import load_machine_config
    from hermes_cli.config import cfg_get

    section = cfg_get(load_machine_config(), "accounts", "second_brain", default=None)
    if not isinstance(section, dict):
        section = {}

    sync_section = section.get("sync")
    if not isinstance(sync_section, dict):
        sync_section = {}

    def _float(source: dict, key: str, fallback: float) -> float:
        try:
            value = float(source.get(key) or fallback)
        except (TypeError, ValueError):
            return fallback
        return value if value > 0 else fallback

    enabled = sync_section.get("enabled")
    realtime = sync_section.get("realtime")
    return SyncSettings(
        base_url=str(section.get("base_url") or "").strip().rstrip("/"),
        # Both default on and both compare against False explicitly, so a
        # missing key and an explicit `true` behave identically.
        realtime=realtime is not False,
        # Default on, and explicitly comparable to False so that a missing key
        # and a `true` behave identically. The switch exists so synchronisation
        # can be turned off in the field without an update.
        enabled=enabled is not False,
        interval_seconds=_float(sync_section, "interval_seconds", DEFAULT_INTERVAL_SECONDS),
        request_timeout_seconds=_float(section, "request_timeout_seconds", 15.0),
    )


# ---------------------------------------------------------------------------
# The engine
# ---------------------------------------------------------------------------


class CredentialMailbox:
    """The most recent bearer this process was handed, held in memory only.

    This exists because of a hard constraint rather than a preference: the
    backend has no credential of its own for the signed-in person. It holds no
    refresh token, there is no confidential client it could use, and the
    dashboard's own auth layer deliberately writes nothing to disk. The only
    component that can produce a bearer at an arbitrary moment is the desktop's
    main process, and the only way it shares one is as a request header.

    So a request that carries a valid bearer leaves a copy here, and the
    background loop spends it until it expires. That gives the loop a working
    window after each desktop call rather than requiring the desktop to drive
    every single tick — which matters for a first sync, where the backlog
    needs several ticks in a row and the desktop's timer is the slow part.

    **Never persisted.** It dies with the process, which is the correct
    lifetime for a token this process cannot renew. Writing it to disk would
    create exactly the long-lived credential the auth layer took care not to
    have.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._held: Optional[SyncCredentials] = None

    def remember(self, credentials: Optional[SyncCredentials]) -> None:
        """Keep *credentials* if they are usable. Ignores anything else.

        A request arriving without a device header, or after the token has
        expired, must not replace a copy that still works.
        """
        if credentials is None or not credentials.usable:
            return
        with self._lock:
            self._held = credentials

    def current(self) -> Optional[SyncCredentials]:
        """The held credentials, or None once they have expired."""
        with self._lock:
            held = self._held
            if held is not None and not held.usable:
                self._held = None
                return None
            return held

    def forget(self) -> None:
        """Drop what is held. Called when somebody signs out."""
        with self._lock:
            self._held = None


class SyncEngine:
    """Runs the tick, and the loop around it.

    Everything it depends on is injected, which is what lets the convergence
    test drive two real databases against one in-process service with no
    network, no timers and no sleeping.
    """

    def __init__(
        self,
        *,
        credentials: Callable[[], Optional[SyncCredentials]],
        settings: Optional[SyncSettings] = None,
        open_db: Optional[Callable[[], Any]] = None,
        client: Any | None = None,
        transport: Any | None = None,
        clock: Callable[[], float] = time.monotonic,
        sources: Optional[List[Any]] = None,
    ) -> None:
        self._credentials = credentials
        self._settings = settings if settings is not None else load_sync_settings()
        self._open_db = open_db or _default_open_db
        self._client = client
        self._transport = transport
        self._clock = clock
        # Kinds that do not live in state.db. Each one supplies its own
        # change detection and its own export/apply pair, and neither this
        # class nor the service knows what any of them contain — adding one
        # is a change here and nowhere else.
        self._sources = list(sources) if sources is not None else _default_sources()

        self._db: Any | None = None
        self._db_lock = threading.Lock()
        self._owns_db = open_db is None
        self._last: SyncOutcome = SyncOutcome(status="idle")
        self._blocked_until = 0.0
        self._wake: Any | None = None
        self._loop: Any | None = None

    # -- lifecycle --------------------------------------------------------

    @property
    def settings(self) -> SyncSettings:
        return self._settings

    def close(self) -> None:
        """Release the database handle. Safe to call more than once."""
        with self._db_lock:
            db, self._db = self._db, None
        if db is not None and self._owns_db:
            try:
                db.close()
            except Exception as exc:  # noqa: BLE001 - shutdown must not raise
                logger.debug("sync: closing state.db failed: %s", exc)

    def _database(self) -> Any:
        """The engine's ``SessionDB``, opened once and reused.

        Held across ticks rather than reopened each time: opening reconciles
        the schema and probes the file, which is real work to repeat every
        thirty seconds for a process whose ``state.db`` cannot change under it
        — the backend is spawned per account and stays with that account for
        its life.
        """
        with self._db_lock:
            if self._db is None:
                self._db = self._open_db()
            return self._db

    def _forget_database(self) -> None:
        """Drop a handle that has stopped working, so the next tick reopens.

        Reached when SQLite reports the file is gone or malformed — a repaired
        or restored ``state.db``, or an account home replaced underneath us.
        Keeping a dead handle would turn one bad tick into permanently broken
        synchronisation.
        """
        with self._db_lock:
            db, self._db = self._db, None
        if db is not None and self._owns_db:
            try:
                db.close()
            except Exception:  # noqa: BLE001 - it is already broken
                pass

    # -- one tick ---------------------------------------------------------

    def tick(self) -> SyncOutcome:
        """Push everything queued, then pull until the feed is drained.

        Never raises. Every failure is a :class:`SyncOutcome` with a status
        the caller can render, because the callers are a background loop and a
        status route, and neither has anywhere useful to put an exception.
        """
        outcome = self._tick()
        self._last = outcome
        return outcome

    def _tick(self) -> SyncOutcome:
        from hermes_cli.second_brain_client import SecondBrainError

        if not self._settings.enabled:
            return SyncOutcome(
                status="disabled",
                detail="Synchronisation is switched off for this machine "
                "(accounts.second_brain.sync.enabled).",
            )
        if not self._settings.configured:
            return SyncOutcome(
                status="unconfigured",
                detail="No second brain is configured on this machine "
                "(accounts.second_brain.base_url).",
            )

        if self._clock() < self._blocked_until:
            # Backing off after a refusal that retrying cannot fix. Report the
            # reason that put us here rather than inventing a new one.
            return self._last

        credentials = self._resolve_credentials()
        if credentials is None or not credentials.usable:
            return SyncOutcome(
                status="signed_out",
                detail="Nobody is signed in on this machine, so there is no "
                "account to synchronise.",
            )

        try:
            database = self._database()
        except Exception as exc:  # noqa: BLE001 - reported, never raised
            logger.warning("sync: could not open state.db: %s", exc)
            return SyncOutcome(status="error", detail=f"could not open state.db: {exc}")

        client = self._session_client()
        outcome = SyncOutcome()

        try:
            self._push(database, client, credentials, outcome)
            self._pull(database, client, credentials, outcome)
        except SecondBrainError as exc:
            return self._from_error(database, exc)
        except Exception as exc:  # noqa: BLE001 - reported, never raised
            logger.warning("sync: tick failed: %s", exc)
            self._record_error(database, str(exc))
            if _is_database_gone(exc):
                self._forget_database()
            return SyncOutcome(status="error", detail=str(exc))

        outcome.pending = _safely(database.outbox_pending_count, 0)
        outcome.cursor = _safely(database.sync_cursor, 0)
        return outcome

    def _resolve_credentials(self) -> Optional[SyncCredentials]:
        try:
            return self._credentials()
        except Exception as exc:  # noqa: BLE001 - a missing token is not a crash
            logger.debug("sync: no credentials available: %s", exc)
            return None

    def _session_client(self) -> Any:
        if self._client is not None:
            return self._client

        from hermes_cli.second_brain_client import SecondBrainClient

        self._client = SecondBrainClient(
            self._settings.base_url,
            timeout=self._settings.request_timeout_seconds,
            transport=self._transport,
        )
        return self._client

    # -- push -------------------------------------------------------------

    def _push(
        self,
        database: Any,
        client: Any,
        credentials: SyncCredentials,
        outcome: SyncOutcome,
    ) -> None:
        """Send everything this device has that the feed has not been told about.

        The database's outbox first, then each file-backed source. Both halves
        run on every tick: a memory edited while no session changed is the
        common case, and an early return once the outbox came back empty would
        make that the case that never syncs.
        """
        self._push_outbox(database, client, credentials, outcome)
        self._push_sources(client, credentials, outcome)

    def _push_outbox(
        self,
        database: Any,
        client: Any,
        credentials: SyncCredentials,
        outcome: SyncOutcome,
    ) -> None:
        """Drain the outbox, oldest first, clearing only what was acknowledged."""
        for _ in range(MAX_PUSH_BATCHES_PER_TICK):
            batch = database.next_outbox_batch(PUSH_BATCH_SIZE)
            if not batch:
                return

            documents: List[Dict[str, Any]] = []
            acknowledged: List[int] = []

            for entry in batch:
                kind = entry.get("kind") or ""
                doc_id = entry.get("doc_id") or ""
                row_ids = list(entry.get("row_ids") or ())

                if entry.get("op") == "delete":
                    document = database.export_tombstone(kind, doc_id)
                else:
                    document = database.export_document(kind, doc_id)

                if document is None:
                    # Nothing left to describe: deleted locally after the row
                    # was queued (its tombstone travels separately), or a kind
                    # this build does not serialize. Acknowledged either way —
                    # a row nothing can turn into a document would otherwise be
                    # retried forever.
                    acknowledged.extend(row_ids)
                    continue

                documents.append(document)
                acknowledged.extend(row_ids)

            if documents:
                answer = client.push_documents(
                    documents,
                    bearer=credentials.bearer,
                    device_id=credentials.device_id,
                    device_name=credentials.device_name,
                )
                self._record_push(answer, outcome)

            # Only now, and only because the service answered.
            database.mark_outbox_done(acknowledged)

            if len(batch) < PUSH_BATCH_SIZE:
                return

        logger.info(
            "sync: outbox still has %d row(s) after a full tick; continuing next tick",
            _safely(database.outbox_pending_count, 0),
        )

    def _push_sources(
        self, client: Any, credentials: SyncCredentials, outcome: SyncOutcome
    ) -> None:
        """Push the kinds that live in files rather than in ``state.db``.

        Each source is drained independently, and a source that fails does not
        stop the others: a permissions problem on one directory must not
        silently stop conversation history from converging.
        """
        for source in self._sources:
            try:
                documents = source.pending(PUSH_BATCH_SIZE)
            except Exception as exc:  # noqa: BLE001 - one bad kind, not all of them
                logger.warning("sync: could not read %s documents: %s", source.kinds, exc)
                outcome.errors.append({"kind": ",".join(source.kinds), "error": str(exc)})
                continue

            if not documents:
                continue

            answer = client.push_documents(
                # `_manifest` is this side's bookkeeping and has no business on
                # the wire; the service would store it in the payload and hand
                # it to every other device.
                [
                    {name: value for name, value in document.items() if name != "_manifest"}
                    for document in documents
                ],
                bearer=credentials.bearer,
                device_id=credentials.device_id,
                device_name=credentials.device_name,
            )
            self._record_push(answer, outcome)

            # Only what the service acknowledged, and only now.
            source.acknowledge(documents)

    def _record_push(self, answer: Any, outcome: SyncOutcome) -> None:
        if not isinstance(answer, dict):
            return
        outcome.pushed += int(answer.get("accepted") or 0)
        rejected = int(answer.get("rejected") or 0)
        outcome.rejected += rejected
        if not rejected:
            return

        for result in answer.get("results") or ():
            if isinstance(result, dict) and not result.get("ok", True):
                # Loud, because the record is being dropped: its outbox row is
                # cleared with the rest of the batch, since a document the
                # service will never store is one that would otherwise be
                # resent on every tick for the life of the install.
                logger.warning(
                    "sync: the service rejected %s/%s: %s",
                    result.get("kind"),
                    result.get("doc_id"),
                    result.get("error"),
                )
                outcome.errors.append(
                    {
                        "kind": result.get("kind"),
                        "doc_id": result.get("doc_id"),
                        "error": result.get("error"),
                    }
                )

    # -- pull -------------------------------------------------------------

    def _pull(
        self,
        database: Any,
        client: Any,
        credentials: SyncCredentials,
        outcome: SyncOutcome,
    ) -> None:
        """Read pages from the cursor forward, applying each before advancing.

        Path fields on an applied session (``cwd``, ``git_repo_root``,
        ``profile_name``) travel with the payload and are stored as they
        arrived. They are provenance — "this conversation happened over there"
        — and nothing may open them on this machine: the other device's paths
        do not exist here, and following one would at best fail and at worst
        resolve to something unrelated.
        """
        cursor = int(_safely(database.sync_cursor, 0))

        for _ in range(MAX_PULL_PAGES_PER_TICK):
            page = client.changes(
                bearer=credentials.bearer,
                device_id=credentials.device_id,
                device_name=credentials.device_name,
                since=cursor,
                limit=PULL_PAGE_SIZE,
                kinds=self._settings.kinds,
            )
            if not isinstance(page, dict):
                raise ValueError("the second brain returned an unexpected feed page")

            documents = page.get("documents") or []
            if not documents:
                # Still a completed pull: stamping it is what makes "last
                # synchronised" mean "we reached the service", rather than
                # "something happened to change".
                database.set_sync_cursor(cursor)
                return

            outcome.pulled += len(documents)
            self._apply_page(database, list(documents), outcome)

            cursor = int(page.get("cursor") or cursor)
            # Advanced only after the page it covers has been applied. A crash
            # between the two replays the page, which is free.
            database.set_sync_cursor(cursor)

            if not page.get("has_more"):
                return

        logger.info("sync: feed still has pages after a full tick; continuing next tick")

    def _apply_page(
        self, database: Any, documents: List[Dict[str, Any]], outcome: SyncOutcome
    ) -> None:
        """Route one page to whatever owns each kind, and land it.

        A kind no source claims goes to ``state.db``, which is also where an
        unrecognised kind ends up — and where it is counted as skipped rather
        than as an error, because it belongs to another client of the same
        feed (R8).
        """
        by_source: Dict[int, List[Dict[str, Any]]] = {}
        for_database: List[Dict[str, Any]] = []

        for document in documents:
            kind = str((document or {}).get("kind") or "")
            owner = self._source_for(kind)
            if owner is None:
                for_database.append(document)
            else:
                by_source.setdefault(id(owner), []).append(document)

        if for_database:
            self._record_apply(database.apply_remote_documents(for_database), outcome)

        for source in self._sources:
            batch = by_source.get(id(source))
            if not batch:
                continue
            try:
                self._record_apply(source.apply(batch), outcome)
            except Exception as exc:  # noqa: BLE001 - one bad kind, not the page
                logger.warning("sync: could not apply %s documents: %s", source.kinds, exc)
                outcome.errors.append({"kind": ",".join(source.kinds), "error": str(exc)})

    def _source_for(self, kind: str) -> Any | None:
        for source in self._sources:
            if kind in source.kinds:
                return source
        return None

    @staticmethod
    def _record_apply(result: Any, outcome: SyncOutcome) -> None:
        if not isinstance(result, dict):
            return
        outcome.applied += int(result.get("applied") or 0)
        outcome.deleted += int(result.get("deleted") or 0)
        outcome.skipped += int(result.get("skipped") or 0)
        for failure in result.get("errors") or ():
            logger.warning("sync: could not apply a document: %s", failure)
            outcome.errors.append(failure)

    # -- failures ---------------------------------------------------------

    def _from_error(self, database: Any, exc: Any) -> SyncOutcome:
        """Turn a client error into the outcome that describes what to do."""
        detail = str(exc)

        if getattr(exc, "unreachable", False):
            # Never an error the person has to see. The app keeps working.
            logger.debug("sync: the second brain is unreachable: %s", detail)
            self._record_error(database, detail)
            return SyncOutcome(
                status="offline",
                detail="The second brain could not be reached. This device "
                "keeps working; changes will catch up when it returns.",
                pending=_safely(database.outbox_pending_count, 0),
                cursor=_safely(database.sync_cursor, 0),
            )

        status_code = getattr(exc, "status_code", None)
        if getattr(exc, "revoked", False) or status_code == 401:
            self._blocked_until = self._clock() + REAUTH_BACKOFF_SECONDS
            self._record_error(database, detail)
            logger.warning("sync: stopping until re-authentication: %s", detail)
            return SyncOutcome(
                status="reauth",
                detail="This device is no longer allowed to synchronise. "
                "Sign in again.",
                pending=_safely(database.outbox_pending_count, 0),
                cursor=_safely(database.sync_cursor, 0),
            )

        logger.warning("sync: the second brain refused: %s", detail)
        self._record_error(database, detail)
        return SyncOutcome(
            status="error",
            detail=detail,
            pending=_safely(database.outbox_pending_count, 0),
            cursor=_safely(database.sync_cursor, 0),
        )

    @staticmethod
    def _record_error(database: Any, message: str) -> None:
        try:
            database.set_sync_error(message[:500])
        except Exception as exc:  # noqa: BLE001 - reporting must not raise
            logger.debug("sync: could not record the last error: %s", exc)

    # -- status -----------------------------------------------------------

    def status(self) -> Dict[str, Any]:
        """Everything a support surface needs, without making a network call.

        Reads the database rather than the last outcome wherever it can, so
        ``agentx sync status`` over SSH answers about the machine and not
        about whether this particular process has ticked yet.
        """
        body: Dict[str, Any] = {
            "enabled": self._settings.enabled,
            "configured": self._settings.configured,
            "base_url": self._settings.base_url,
            "interval_seconds": self._settings.interval_seconds,
            "last": self._last.to_json(),
        }
        if not self._settings.configured:
            return body

        try:
            body.update(self._database().sync_status())
        except Exception as exc:  # noqa: BLE001 - status must always answer
            body["detail"] = f"could not read the local sync state: {exc}"
        return body

    def reset_cursor(self) -> Dict[str, Any]:
        """Rewind to the start of the feed, so the next tick re-pulls it all.

        The documented recovery from a service restored to an earlier point:
        a client holding a cursor above the server's counter would otherwise
        pull nothing, forever, and never say so. Safe precisely because
        applying is idempotent — re-pulling the whole feed adds nothing that
        is already here.
        """
        database = self._database()
        database.set_sync_cursor(0)
        return database.sync_status()

    # -- the loop ---------------------------------------------------------

    def nudge(self) -> None:
        """Ask for a tick now. Safe from any thread; never blocks.

        Called when a session ends and when the app window regains focus —
        the two moments a person is most likely to look at another device
        next.
        """
        wake, loop = self._wake, self._loop
        if wake is None or loop is None:
            return
        try:
            loop.call_soon_threadsafe(wake.set)
        except RuntimeError:
            # The loop has closed. There is nothing to wake and nothing wrong.
            pass

    async def run_forever(self) -> None:
        """Tick on the interval, or whenever something nudges. Never returns.

        Cancelled at shutdown by whoever started it.
        """
        import asyncio

        from starlette.concurrency import run_in_threadpool

        self._wake = asyncio.Event()
        self._loop = asyncio.get_running_loop()

        if not (self._settings.enabled and self._settings.configured):
            logger.info(
                "sync: not running (%s)",
                "switched off" if not self._settings.enabled else "no service configured",
            )
            return

        logger.info(
            "sync: every %.0fs against %s",
            self._settings.interval_seconds,
            self._settings.base_url,
        )

        # Best-effort, and deliberately not awaited anywhere: with the socket
        # unavailable — an old service, a proxy that drops upgrades, a network
        # that only passes HTTP — the loop below carries on exactly as it did
        # before there was one.
        watcher = (
            asyncio.create_task(self._watch_stream())
            if self._settings.realtime
            else None
        )

        try:
            while True:
                try:
                    await asyncio.wait_for(
                        self._wake.wait(), timeout=self._settings.interval_seconds
                    )
                except asyncio.TimeoutError:
                    pass
                self._wake.clear()

                # In a worker thread: the tick is synchronous, and SQLite plus
                # httpx would otherwise stall the event loop the dashboard and
                # the PTY sessions share.
                outcome = await run_in_threadpool(self.tick)
                if outcome.status not in ("ok", "offline", "signed_out"):
                    logger.info("sync: %s — %s", outcome.status, outcome.detail)
        except asyncio.CancelledError:
            raise
        finally:
            if watcher is not None:
                watcher.cancel()
            self._wake = None
            self._loop = None
            self.close()

    # -- realtime ---------------------------------------------------------

    async def _watch_stream(self) -> None:
        """Hold a socket open and nudge on every change. Never raises.

        An optimisation in front of polling, and nothing more: the socket
        carries "something changed" and never a document, so a connection that
        fails, drops, or is never established costs latency and never
        correctness. That is why every failure here is a debug line and a
        retry rather than anything the person is told about.

        The socket lives only as long as the bearer that opened it. This
        process cannot renew one — the desktop mints them and delivers them on
        ``POST /api/sync/tick`` — so a token expiring closes the connection and
        the next tick's credentials open the next one. That is also why the
        reconnect delay is short: it is usually not an error, it is a
        credential rolling over.
        """
        import asyncio

        url = self._settings.stream_url
        if not url:
            return

        while True:
            credentials = self._resolve_credentials()
            if credentials is None or not credentials.usable:
                # Nothing to authenticate with yet. The tick loop is idle for
                # the same reason, so there is nothing to be woken about.
                await asyncio.sleep(self._settings.interval_seconds)
                continue

            try:
                await self._stream_once(url, credentials)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - realtime is optional
                logger.debug("sync: change stream unavailable: %s", exc)

            await asyncio.sleep(STREAM_RECONNECT_SECONDS)

    async def _stream_once(self, url: str, credentials: SyncCredentials) -> None:
        """One connection, from open to close. Nudges on every change frame."""
        import json

        import websockets

        headers = {
            "Authorization": f"Bearer {credentials.bearer}",
            "X-AgentX-Device": credentials.device_id,
        }
        if credentials.device_name:
            headers["X-AgentX-Device-Name"] = credentials.device_name

        async with websockets.connect(
            url,
            additional_headers=headers,
            open_timeout=self._settings.request_timeout_seconds,
            # The server pings on its own timer; this bounds how long a
            # half-open connection can look alive to us.
            ping_interval=STREAM_PING_SECONDS,
            ping_timeout=STREAM_PING_SECONDS,
        ) as socket:
            logger.info("sync: watching %s for changes", url)
            async for frame in socket:
                try:
                    message = json.loads(frame)
                except (TypeError, ValueError):
                    continue
                if isinstance(message, dict) and message.get("type") == "changed":
                    # Straight to the tick loop, which does the actual work.
                    # Everything this socket knows is "go and look".
                    self.nudge()


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------


def _default_open_db() -> Any:
    """Open this process's own ``state.db``, writable.

    Writable because synchronisation applies remote documents as well as
    reading local ones — a read-only engine would be a one-way mirror.
    """
    from hermes_state import SessionDB

    return SessionDB(read_only=False)


def _default_sources() -> List[Any]:
    """The file-backed kinds, for this process's account home.

    Import-guarded: a build without them still synchronises sessions and
    messages rather than failing to start the engine at all.
    """
    try:
        from hermes_cli.sync_sources import default_sources

        return list(default_sources())
    except Exception as exc:  # noqa: BLE001 - optional kinds, never fatal
        logger.warning("sync: file-backed kinds unavailable: %s", exc)
        return []


#: The backend's one engine, and the mailbox feeding it. Process-global
#: because there is exactly one ``state.db`` per backend and exactly one
#: person signed into it — two engines would be two writers racing to apply
#: the same feed into the same file.
_MAILBOX = CredentialMailbox()
_ENGINE: Optional[SyncEngine] = None
_ENGINE_LOCK = threading.Lock()


def mailbox() -> CredentialMailbox:
    """The process's credential mailbox. Fed by authenticated requests."""
    return _MAILBOX


def engine() -> SyncEngine:
    """The backend's sync engine, built on first use.

    Built lazily rather than at import so that reading the config and opening
    ``state.db`` happen when something actually wants to synchronise — a CLI
    invocation that never syncs should not pay for either.
    """
    global _ENGINE

    with _ENGINE_LOCK:
        if _ENGINE is None:
            _ENGINE = SyncEngine(credentials=_MAILBOX.current)
        return _ENGINE


def shutdown() -> None:
    """Release the engine's database handle. Called from the web lifespan."""
    global _ENGINE

    with _ENGINE_LOCK:
        existing, _ENGINE = _ENGINE, None
    if existing is not None:
        existing.close()


def _safely(call: Callable[[], Any], fallback: Any) -> Any:
    """Run a status read that must not be able to fail a tick."""
    try:
        return call()
    except Exception as exc:  # noqa: BLE001 - it is a counter, not the point
        logger.debug("sync: %s failed: %s", getattr(call, "__name__", call), exc)
        return fallback


def _is_database_gone(exc: BaseException) -> bool:
    """True when the handle is dead rather than the operation being wrong."""
    import sqlite3

    if not isinstance(exc, sqlite3.Error):
        return False
    message = str(exc).lower()
    return (
        "no such table" in message
        or "malformed" in message
        or "not a database" in message
        or "disk i/o error" in message
    )
