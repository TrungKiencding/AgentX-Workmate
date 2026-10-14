"""The conversation-sync bookkeeping state.db carried until 1.1.1, for upgrade tests.

The DDL below is what ``hermes_state_common`` shipped from schema v26 until
sync was retired (SCHEMA_SQL's two tables, SYNC_TRIGGER_SQL's four triggers,
and the three state_meta markers SessionSchemaMixin kept). Tests apply it to a
current database to reproduce a store written by 1.1.0, or by an older runtime
that still shares the file.
"""

from __future__ import annotations

import hashlib
import sqlite3

_EPOCH_NOW = "((julianday('now') - 2440587.5) * 86400.0)"
_UUID4 = (
    "lower("
    "hex(randomblob(4)) || '-' || hex(randomblob(2))"
    " || '-4' || substr(hex(randomblob(2)), 2)"
    " || '-' || substr('89ab', (random() & 3) + 1, 1)"
    " || substr(hex(randomblob(2)), 2)"
    " || '-' || hex(randomblob(6))"
    ")"
)

TABLES_SQL = """
CREATE TABLE IF NOT EXISTS sync_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    op TEXT NOT NULL,
    queued_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cursor INTEGER NOT NULL DEFAULT 0,
    last_pull_at REAL,
    last_push_at REAL,
    last_error TEXT
);
"""

TRIGGERS_SQL = f"""
CREATE TRIGGER IF NOT EXISTS sync_sessions_insert AFTER INSERT ON sessions
BEGIN
    INSERT INTO sync_outbox (kind, doc_id, op, queued_at)
    VALUES ('session', new.id, 'upsert', {_EPOCH_NOW});
END;

CREATE TRIGGER IF NOT EXISTS sync_sessions_update
AFTER UPDATE OF title, display_name, archived, pinned, last_read_at,
                ended_at, end_reason, model, parent_session_id ON sessions
WHEN old.title IS NOT new.title
   OR old.display_name IS NOT new.display_name
   OR old.archived IS NOT new.archived
   OR old.pinned IS NOT new.pinned
   OR old.last_read_at IS NOT new.last_read_at
   OR old.ended_at IS NOT new.ended_at
   OR old.end_reason IS NOT new.end_reason
   OR old.model IS NOT new.model
   OR old.parent_session_id IS NOT new.parent_session_id
BEGIN
    UPDATE sessions
    SET updated_at = MAX(
        {_EPOCH_NOW},
        COALESCE(updated_at, started_at) + 0.000001
    )
    WHERE id = new.id;

    INSERT INTO sync_outbox (kind, doc_id, op, queued_at)
    VALUES ('session', new.id, 'upsert', {_EPOCH_NOW});
END;

CREATE TRIGGER IF NOT EXISTS sync_sessions_delete AFTER DELETE ON sessions
BEGIN
    INSERT INTO sync_outbox (kind, doc_id, op, queued_at)
    VALUES ('session', old.id, 'delete', {_EPOCH_NOW});
END;

CREATE TRIGGER IF NOT EXISTS sync_messages_insert AFTER INSERT ON messages
BEGIN
    UPDATE messages SET uuid = {_UUID4}
    WHERE id = new.id AND uuid IS NULL;

    INSERT INTO sync_outbox (kind, doc_id, op, queued_at)
    SELECT 'message', uuid, 'upsert', {_EPOCH_NOW}
    FROM messages WHERE id = new.id AND uuid IS NOT NULL;
END;
"""

TRIGGERS = ("sync_sessions_insert", "sync_sessions_update", "sync_sessions_delete", "sync_messages_insert")
TABLES = ("sync_outbox", "sync_state")
META_KEYS = ("sync_trigger_fingerprint", "sync_uuid_backfill_high_water", "sync_uuid_backfill_progress")


def install(conn: sqlite3.Connection) -> None:
    """Give *conn*'s database the bookkeeping a 1.1.0 runtime kept in it."""
    conn.executescript(TABLES_SQL + TRIGGERS_SQL)
    high_water = conn.execute("SELECT COALESCE(MAX(id), 0) FROM messages").fetchone()[0]
    conn.executemany(
        "INSERT OR REPLACE INTO state_meta (key, value) VALUES (?, ?)",
        [
            ("sync_trigger_fingerprint", hashlib.sha256(TRIGGERS_SQL.encode("utf-8")).hexdigest()),
            ("sync_uuid_backfill_high_water", str(high_water)),
            ("sync_uuid_backfill_progress", str(high_water)),
        ],
    )
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (id, cursor, last_pull_at) VALUES (1, 42, 1760000000.0)"
    )
    conn.commit()


def present(conn: sqlite3.Connection) -> set[str]:
    """Which of the retired objects and markers *conn*'s database still has."""
    names = {
        row[0]
        for row in conn.execute(
            f"SELECT name FROM sqlite_master WHERE name IN ({','.join('?' for _ in TRIGGERS + TABLES)})",
            TRIGGERS + TABLES,
        )
    }
    names |= {
        row[0]
        for row in conn.execute(
            f"SELECT key FROM state_meta WHERE key IN ({','.join('?' for _ in META_KEYS)})",
            META_KEYS,
        )
    }
    return names
