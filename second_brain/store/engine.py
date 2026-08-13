"""The only module in the service that writes SQL.

Everything above this layer — auth, devices, and later keys and sync — calls
methods. That boundary is not stylistic: it is what lets the schema change
without a grep across the service, and it is the reason a route cannot
accidentally read a row belonging to a different subject. Every method here
that touches per-person data takes ``subject`` as its first argument and
filters on it, so isolation is a property of the store rather than a rule each
handler is trusted to remember.

Connections are asyncpg. Migrations are plain ``.sql`` files applied in name
order under an advisory lock, so two instances booting at once cannot both
apply ``0001``.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncIterator, Sequence

logger = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"

#: Advisory-lock id held while migrations run. Arbitrary but fixed — any two
#: processes using this store must pick the same number for the lock to mean
#: anything.
_MIGRATION_LOCK_ID = 0x5EC0_4D8A

#: First half of the two-int advisory lock serialising key issuance, so those
#: locks live in a namespace of their own and cannot collide with the
#: migration lock above. The second half is a hash of the subject, which is
#: what makes the lock per person: two people never wait on each other, and a
#: hash collision between two subjects costs one of them a short wait and
#: nothing else. Must fit in int4.
_ISSUANCE_LOCK_CLASS = 0x5EC0_4B27


@dataclass(frozen=True)
class DeviceRow:
    """One machine a person signs in on."""

    id: str
    subject: str
    name: str
    platform: str
    app_version: str
    created_at: datetime
    last_seen_at: datetime
    revoked_at: datetime | None

    @property
    def revoked(self) -> bool:
        return self.revoked_at is not None

    def to_json(self, *, current: bool = False) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "platform": self.platform,
            "app_version": self.app_version,
            "created_at": self.created_at.isoformat(),
            "last_seen_at": self.last_seen_at.isoformat(),
            "revoked_at": self.revoked_at.isoformat() if self.revoked_at else None,
            "revoked": self.revoked,
            "current": current,
        }


@dataclass(frozen=True)
class ModelKeyRow:
    """One person's model key, as it is stored: wrapped, never in the clear.

    ``ciphertext``, ``nonce`` and ``kek_id`` are the envelope, and opening it
    is :mod:`second_brain.keys`' job rather than the store's. The store is
    never given the KEK, which is what makes it structurally impossible for a
    bug in here to put a usable key into a log line.

    ``litellm_token`` is the hash the proxy knows this key by. It is the ONLY
    handle rotation deletes against — there is no delete-by-alias anywhere in
    this system, because deleting by alias is what made a second laptop cost
    somebody their first one.
    """

    subject: str
    key_alias: str
    litellm_token: str
    ciphertext: bytes
    nonce: bytes
    kek_id: str
    base_url: str
    models: tuple[str, ...]
    created_at: datetime
    rotated_at: datetime | None


@dataclass(frozen=True)
class DocumentRow:
    """One synced document, as the feed describes it."""

    kind: str
    doc_id: str
    seq: int
    updated_at: float
    deleted: bool
    payload: dict[str, Any]
    device_id: str | None

    def to_json(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "doc_id": self.doc_id,
            "seq": self.seq,
            "updated_at": self.updated_at,
            "deleted": self.deleted,
            "payload": self.payload,
            "device_id": self.device_id,
        }


class StoreUnavailable(RuntimeError):
    """Postgres could not be reached.

    Kept distinct from every other failure for the same reason
    ``LiteLLMError.unreachable`` is: a caller must be able to tell "the store
    said no" from "the store could not be asked", because only the first one
    means anything about the request.
    """


def _device_row(record: Any) -> DeviceRow:
    return DeviceRow(
        id=str(record["id"]),
        subject=record["subject"],
        name=record["name"],
        platform=record["platform"],
        app_version=record["app_version"],
        created_at=record["created_at"],
        last_seen_at=record["last_seen_at"],
        revoked_at=record["revoked_at"],
    )


def _model_key_row(record: Any) -> ModelKeyRow:
    import json

    models = record["models"]
    if isinstance(models, str):
        models = json.loads(models)
    return ModelKeyRow(
        subject=record["subject"],
        key_alias=record["key_alias"],
        litellm_token=record["litellm_token"],
        ciphertext=bytes(record["ciphertext"]),
        nonce=bytes(record["nonce"]),
        kek_id=record["kek_id"],
        base_url=record["base_url"],
        models=tuple(str(m) for m in (models or ())),
        created_at=record["created_at"],
        rotated_at=record["rotated_at"],
    )


def _document_row(record: Any) -> DocumentRow:
    import json

    payload = record["payload"]
    if isinstance(payload, str):
        payload = json.loads(payload)
    return DocumentRow(
        kind=record["kind"],
        doc_id=record["doc_id"],
        seq=int(record["seq"]),
        updated_at=float(record["updated_at"]),
        deleted=bool(record["deleted"]),
        payload=payload if isinstance(payload, dict) else {},
        device_id=str(record["device_id"]) if record["device_id"] else None,
    )


class Store:
    """The service's Postgres, and every statement it runs.

    Construct with :meth:`connect` (which opens the pool) or with a pool
    supplied by a caller that owns it — the tests do the latter so one database
    serves a whole session.
    """

    def __init__(self, pool: Any | None = None, *, dsn: str = "") -> None:
        self._pool = pool
        # Kept because a LISTEN connection has to be opened outside the pool
        # (see `listen_for_documents`) and asyncpg will not tell us what the
        # pool connected with.
        self._dsn_value = dsn

    # -- lifecycle --------------------------------------------------------

    async def open(self, settings: Any) -> None:
        """Open the pool against ``settings.database_url``, if not already.

        Separate from ``__init__`` because a pool needs a running event loop
        and the app is built before there is one. ``build_app`` constructs the
        store and opens it during startup.
        """
        if self._pool is not None:
            return

        import asyncpg

        self._dsn_value = settings.database_url
        try:
            self._pool = await asyncpg.create_pool(
                settings.database_url,
                min_size=settings.pool_min,
                max_size=settings.pool_max,
            )
        except OSError as exc:
            raise StoreUnavailable(f"could not reach Postgres: {exc}") from exc

    @classmethod
    async def connect(cls, settings: Any) -> "Store":
        """Return a store with its pool already open."""
        store = cls()
        await store.open(settings)
        return store

    async def close(self) -> None:
        if self._pool is None:
            return
        pool, self._pool = self._pool, None
        await pool.close()

    async def migrate(self) -> list[str]:
        """Apply every unapplied migration in name order. Returns their names.

        Idempotent, and safe to run from more than one instance at once: the
        advisory lock is transaction-scoped, so the second instance waits,
        then finds the ledger already naming what it was about to apply.
        """
        applied: list[str] = []
        files = sorted(MIGRATIONS_DIR.glob("*.sql"))

        async with self._pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute("SELECT pg_advisory_xact_lock($1)", _MIGRATION_LOCK_ID)
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS brain_migrations (
                        name       TEXT PRIMARY KEY,
                        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
                done = {
                    record["name"]
                    for record in await conn.fetch("SELECT name FROM brain_migrations")
                }
                for path in files:
                    if path.name in done:
                        continue
                    logger.info("second_brain: applying migration %s", path.name)
                    await conn.execute(path.read_text(encoding="utf-8"))
                    await conn.execute(
                        "INSERT INTO brain_migrations (name) VALUES ($1)", path.name
                    )
                    applied.append(path.name)

        return applied

    async def ping(self) -> bool:
        """True when Postgres answers. Never raises — this feeds ``/health``."""
        if self._pool is None:
            return False
        try:
            async with self._pool.acquire() as conn:
                await conn.execute("SELECT 1")
        except Exception as exc:
            logger.warning("second_brain: Postgres unreachable: %s", exc)
            return False
        return True

    # -- plumbing ---------------------------------------------------------
    #
    # Every statement goes through one of these four so that "Postgres is
    # down" arrives at the routes as :class:`StoreUnavailable` rather than as
    # whichever asyncpg type happened to surface. A route answering 503 for an
    # outage and 500 for a bug is only possible if the two are distinguishable
    # here, where the driver is the only thing that knows the difference.

    @staticmethod
    def _unavailable(exc: BaseException) -> bool:
        import asyncio

        import asyncpg

        return isinstance(
            exc,
            (
                OSError,
                asyncio.TimeoutError,
                asyncpg.PostgresConnectionError,
                asyncpg.InterfaceError,
            ),
        )

    def _live_pool(self) -> Any:
        """The pool, or the outage error. A closed store is an unavailable one.

        Reached during shutdown, and whenever a deploy misorders startup. It
        must surface as 503 like any other unreachable database rather than as
        an ``AttributeError`` on ``None``.
        """
        if self._pool is None:
            raise StoreUnavailable("the store is not open")
        return self._pool

    async def _execute(self, sql: str, *args: Any) -> Any:
        pool = self._live_pool()
        try:
            return await pool.execute(sql, *args)
        except Exception as exc:
            raise self._translate(exc) from exc

    async def _fetch(self, sql: str, *args: Any) -> Any:
        pool = self._live_pool()
        try:
            return await pool.fetch(sql, *args)
        except Exception as exc:
            raise self._translate(exc) from exc

    async def _fetchrow(self, sql: str, *args: Any) -> Any:
        pool = self._live_pool()
        try:
            return await pool.fetchrow(sql, *args)
        except Exception as exc:
            raise self._translate(exc) from exc

    async def _fetchval(self, sql: str, *args: Any) -> Any:
        pool = self._live_pool()
        try:
            return await pool.fetchval(sql, *args)
        except Exception as exc:
            raise self._translate(exc) from exc

    def _translate(self, exc: Exception) -> Exception:
        if self._unavailable(exc):
            return StoreUnavailable(f"could not reach Postgres: {exc}")
        return exc

    # -- accounts ---------------------------------------------------------

    async def ensure_account(
        self,
        subject: str,
        *,
        slug: str = "",
        email: str = "",
        display_name: str = "",
        issuer: str = "",
    ) -> None:
        """Record (or refresh) the account behind a verified token.

        Called on every authenticated request, which is why the update is
        guarded: a person whose claims have not changed since their last
        request costs a no-op rather than a row version, and ``updated_at``
        keeps meaning "something about this person changed".
        """
        await self._execute(
            """
            INSERT INTO accounts (subject, slug, email, display_name, issuer)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (subject) DO UPDATE
               SET slug         = EXCLUDED.slug,
                   email        = EXCLUDED.email,
                   display_name = EXCLUDED.display_name,
                   issuer       = EXCLUDED.issuer,
                   updated_at   = now()
             WHERE accounts.slug         IS DISTINCT FROM EXCLUDED.slug
                OR accounts.email        IS DISTINCT FROM EXCLUDED.email
                OR accounts.display_name IS DISTINCT FROM EXCLUDED.display_name
                OR accounts.issuer       IS DISTINCT FROM EXCLUDED.issuer
            """,
            subject,
            slug,
            email,
            display_name,
            issuer,
        )

    # -- devices ----------------------------------------------------------

    async def device(self, subject: str, device_id: str) -> DeviceRow | None:
        """Return one of *subject*'s devices, or None.

        Scoped by subject, so a device id belonging to somebody else is
        indistinguishable from one that does not exist — which is what lets
        the revoke route answer 404 without confirming another person's
        device.
        """
        record = await self._fetchrow(
            "SELECT * FROM devices WHERE subject = $1 AND id = $2::uuid",
            subject,
            device_id,
        )
        return _device_row(record) if record else None

    async def touch_device(
        self,
        subject: str,
        device_id: str,
        *,
        name: str = "",
        platform: str = "",
        app_version: str = "",
    ) -> DeviceRow | None:
        """Upsert a device and stamp ``last_seen_at``. None when revoked.

        A revoked device is left untouched — including its ``last_seen_at`` —
        so revocation cannot be undone by the revoked machine simply calling
        again, and so the device list keeps showing when it was last really
        used rather than when it last retried.

        Empty strings do not overwrite what is already recorded: the heartbeat
        knows the platform and app version, while an ordinary request carries
        only the headers, and the second must not erase what the first
        learned.
        """
        record = await self._fetchrow(
            """
            INSERT INTO devices (subject, id, name, platform, app_version)
            VALUES ($1, $2::uuid, $3, $4, $5)
            ON CONFLICT (subject, id) DO UPDATE
               SET name         = COALESCE(NULLIF(EXCLUDED.name, ''), devices.name),
                   platform     = COALESCE(NULLIF(EXCLUDED.platform, ''), devices.platform),
                   app_version  = COALESCE(NULLIF(EXCLUDED.app_version, ''), devices.app_version),
                   last_seen_at = now()
             WHERE devices.revoked_at IS NULL
            RETURNING *
            """,
            subject,
            device_id,
            name,
            platform,
            app_version,
        )
        return _device_row(record) if record else None

    async def list_devices(self, subject: str) -> list[DeviceRow]:
        """Every device this person has ever signed in on, newest use first."""
        records = await self._fetch(
            """
            SELECT * FROM devices
             WHERE subject = $1
             ORDER BY revoked_at IS NOT NULL, last_seen_at DESC
            """,
            subject,
        )
        return [_device_row(record) for record in records]

    async def live_device_count(self, subject: str) -> int:
        """How many of this person's devices are not revoked."""
        return int(
            await self._fetchval(
                "SELECT count(*) FROM devices WHERE subject = $1 AND revoked_at IS NULL",
                subject,
            )
        )

    async def revoke_device(self, subject: str, device_id: str) -> DeviceRow | None:
        """Tombstone a device. Returns the row, or None when there is no such
        device for this subject.

        Idempotent: revoking an already-revoked device keeps the original
        ``revoked_at`` rather than moving it, so the audit trail says when
        access actually ended.
        """
        record = await self._fetchrow(
            """
            UPDATE devices
               SET revoked_at = COALESCE(revoked_at, now())
             WHERE subject = $1 AND id = $2::uuid
            RETURNING *
            """,
            subject,
            device_id,
        )
        return _device_row(record) if record else None

    # -- model keys -------------------------------------------------------

    @asynccontextmanager
    async def issuance_lock(self, subject: str) -> AsyncIterator[None]:
        """Serialise key issuance for one person, across every instance.

        Minting is the one operation here that is not idempotent: two devices
        arriving together on a person who has no key yet would each ask
        LiteLLM for one, and the loser's key would be orphaned upstream —
        alive, billable, and held by nobody. "Mint exactly once per person" is
        the whole promise of this service, so it is enforced with a lock
        rather than hoped for.

        The lock is a transaction-scoped Postgres advisory lock, so it is
        released by commit or by the connection dying, and a crashed instance
        cannot wedge somebody out of their own key. It is taken per subject:
        two people never wait on each other.

        This holds a pooled connection for the duration of the block, which
        includes a network call to LiteLLM. That is deliberate and bounded —
        one mint per person for the life of their account, under the proxy
        timeout — but it is why ``pool_max`` should stay comfortably above the
        number of people who might sign in for the first time at once.
        """
        pool = self._live_pool()
        try:
            async with pool.acquire() as conn:
                async with conn.transaction():
                    await conn.execute(
                        "SELECT pg_advisory_xact_lock($1, hashtext($2))",
                        _ISSUANCE_LOCK_CLASS,
                        subject,
                    )
                    yield
        except Exception as exc:
            # Whatever the caller raised inside the block passes through
            # untouched — the refusals this lock wraps (a proxy that is down,
            # a key that will not open) already say what they mean, and
            # re-raising them as themselves would leave each one its own
            # __cause__. Only a driver-level outage is translated.
            translated = self._translate(exc)
            if translated is exc:
                raise
            raise translated from exc

    async def model_key(self, subject: str) -> ModelKeyRow | None:
        """This person's stored key, still wrapped, or None."""
        record = await self._fetchrow(
            "SELECT * FROM model_keys WHERE subject = $1", subject
        )
        return _model_key_row(record) if record else None

    async def save_model_key(
        self,
        subject: str,
        *,
        key_alias: str,
        litellm_token: str,
        ciphertext: bytes,
        nonce: bytes,
        kek_id: str,
        base_url: str = "",
        models: Sequence[str] = (),
    ) -> ModelKeyRow:
        """Store this person's wrapped key, replacing any already there.

        A conflict means the row existed, and the only thing that replaces an
        existing row is a rotation — so ``rotated_at`` is stamped here and
        nowhere else, while ``created_at`` goes on saying when this person
        first got a key.
        """
        import json

        record = await self._fetchrow(
            """
            INSERT INTO model_keys (
                subject, key_alias, litellm_token, ciphertext, nonce, kek_id,
                base_url, models
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
            ON CONFLICT (subject) DO UPDATE
               SET key_alias     = EXCLUDED.key_alias,
                   litellm_token = EXCLUDED.litellm_token,
                   ciphertext    = EXCLUDED.ciphertext,
                   nonce         = EXCLUDED.nonce,
                   kek_id        = EXCLUDED.kek_id,
                   base_url      = EXCLUDED.base_url,
                   models        = EXCLUDED.models,
                   rotated_at    = now()
            RETURNING *
            """,
            subject,
            key_alias,
            litellm_token,
            ciphertext,
            nonce,
            kek_id,
            base_url,
            json.dumps([str(m) for m in (models or ())]),
        )
        return _model_key_row(record)

    async def rewrap_model_key(
        self,
        subject: str,
        *,
        ciphertext: bytes,
        nonce: bytes,
        kek_id: str,
        from_kek_id: str,
    ) -> bool:
        """Re-wrap a stored key under a new KEK. Returns whether a row moved.

        Not a rotation: the model key is the same key, and the person's access
        does not change, so ``rotated_at`` is deliberately left alone. This is
        what turns a KEK roll into a background job — every row is re-wrapped
        the next time somebody reads it, and the roll finishes itself.

        Guarded on ``from_kek_id`` so that two instances re-wrapping the same
        row at once cannot have the slower one overwrite the faster one's
        work with a ciphertext for a KEK that is already gone.
        """
        result = await self._execute(
            """
            UPDATE model_keys
               SET ciphertext = $2, nonce = $3, kek_id = $4
             WHERE subject = $1 AND kek_id = $5
            """,
            subject,
            ciphertext,
            nonce,
            kek_id,
            from_kek_id,
        )
        return str(result or "").strip() != "UPDATE 0"

    # -- documents --------------------------------------------------------

    async def put_document(
        self,
        subject: str,
        *,
        kind: str,
        doc_id: str,
        updated_at: float,
        deleted: bool = False,
        payload: Any = None,
        device_id: str | None = None,
    ) -> int:
        """Apply one document through ``brain_put_document``; return its seq.

        The seq is consumed whether or not the last-writer-wins guard applied
        the row, which leaves gaps in the sequence. That is intended — see the
        comment on the function in ``0001_init.sql``.
        """
        import json

        return int(
            await self._fetchval(
                "SELECT brain_put_document($1, $2, $3, $4, $5, $6::jsonb, $7::uuid)",
                subject,
                kind,
                doc_id,
                float(updated_at),
                bool(deleted),
                json.dumps(payload if payload is not None else {}),
                device_id,
            )
        )

    async def document(self, subject: str, kind: str, doc_id: str) -> DocumentRow | None:
        """Return one stored document, or None."""
        record = await self._fetchrow(
            "SELECT * FROM documents WHERE subject = $1 AND kind = $2 AND doc_id = $3",
            subject,
            kind,
            doc_id,
        )
        return _document_row(record) if record else None

    async def documents_since(
        self,
        subject: str,
        *,
        cursor: int = 0,
        kinds: Sequence[str] = (),
        limit: int = 500,
    ) -> list[DocumentRow]:
        """The change feed: everything above *cursor*, in seq order.

        Serving this over HTTP is Phase 3's job; the read lives here now
        because the ordering guarantee it depends on belongs with the function
        that produces it, and because it is what proves the guarantee holds.
        """
        if kinds:
            records = await self._fetch(
                """
                SELECT * FROM documents
                 WHERE subject = $1 AND seq > $2 AND kind = ANY($3::text[])
                 ORDER BY seq
                 LIMIT $4
                """,
                subject,
                cursor,
                list(kinds),
                limit,
            )
        else:
            records = await self._fetch(
                """
                SELECT * FROM documents
                 WHERE subject = $1 AND seq > $2
                 ORDER BY seq
                 LIMIT $3
                """,
                subject,
                cursor,
                limit,
            )
        return [_document_row(record) for record in records]

    async def search_documents(
        self,
        subject: str,
        query: str,
        *,
        kinds: Sequence[str] = (),
        limit: int = 20,
    ) -> list[tuple[DocumentRow, float]]:
        """Rank this person's live documents against *query*.

        Scoped by subject like every other read here, which is what makes
        "search returns only my documents" a property of the store rather than
        a rule each handler is trusted to remember.

        Tombstones are excluded: a deleted document is retained so other
        devices learn about the delete, not so it can keep turning up in
        somebody's search results.

        ``websearch_to_tsquery`` rather than ``to_tsquery`` because the input
        is a person's typing. ``to_tsquery`` raises a syntax error on an
        unbalanced quote or a bare ``&``, which would turn an ordinary search
        into a 500; ``websearch_to_tsquery`` accepts anything and reads it the
        way a search box is expected to.
        """
        records = await self._fetch(
            """
            SELECT *, ts_rank_cd(search, websearch_to_tsquery('english', $2)) AS rank
              FROM documents
             WHERE subject = $1
               AND NOT deleted
               AND search @@ websearch_to_tsquery('english', $2)
               AND ($3::text[] IS NULL OR kind = ANY($3::text[]))
             ORDER BY rank DESC, seq DESC
             LIMIT $4
            """,
            subject,
            query,
            list(kinds) or None,
            limit,
        )
        return [(_document_row(record), float(record["rank"])) for record in records]

    # -- change notifications ---------------------------------------------

    async def listen_for_documents(self, callback: Any) -> Any:
        """Call *callback(subject)* whenever a document is committed. Returns
        a connection the caller must close.

        A dedicated connection, outside the pool, because a listening
        connection is occupied for as long as it listens — taking one from the
        pool would permanently remove it from the pool's capacity, and asyncpg
        would hand the same connection to somebody else's query.

        Notifications are a nudge and not a delivery: they carry the subject
        and nothing more, so one that is lost, duplicated or reordered costs a
        wasted read at worst. That is what lets this be best-effort.
        """
        import asyncpg

        connection = await asyncpg.connect(self._dsn())

        def _on_notify(_connection, _pid, _channel, payload):
            try:
                callback(str(payload or ""))
            except Exception as exc:  # noqa: BLE001 - a listener must not die
                logger.warning("second_brain: notification handler failed: %s", exc)

        await connection.add_listener("brain_documents", _on_notify)
        return connection

    def _dsn(self) -> str:
        """The DSN this store connected with.

        Recorded in :meth:`open` rather than read back out of the pool:
        asyncpg does not expose it, and reaching into its internals for
        something this load-bearing is a break waiting for the next release.
        """
        if not self._dsn_value:
            raise StoreUnavailable(
                "this store has no DSN, so it cannot open a listening connection"
            )
        return self._dsn_value

    async def sweep_tombstones(self, *, older_than_days: int = 90) -> int:
        """Drop tombstones past the retention window. Returns how many went.

        A tombstone exists so that a device which was offline when a document
        was deleted learns about the delete instead of pushing the row back.
        Once no device can plausibly still be that far behind, the row is only
        cost, so it goes.

        Swept across every account at once, and deliberately not scoped by
        subject: this is housekeeping the service does for itself, not a
        request anybody makes. It is the one method here that does not take a
        subject, which is why it says so.

        The consequence of the window being too short is real and worth
        stating: a device offline for longer than ``older_than_days`` will
        re-push documents whose tombstones have been swept, resurrecting them
        on every other device. Lengthen the window rather than shorten it.
        """
        result = await self._execute(
            """
            DELETE FROM documents
             WHERE deleted
               AND stored_at < now() - make_interval(days => $1)
            """,
            int(older_than_days),
        )
        # asyncpg hands back the tag, e.g. "DELETE 12".
        tail = str(result or "").strip().rsplit(" ", 1)
        return int(tail[-1]) if tail and tail[-1].isdigit() else 0
