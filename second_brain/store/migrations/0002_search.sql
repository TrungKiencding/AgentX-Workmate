-- Make the store queryable, and make it tell listeners when it changes.
--
-- Two additions, both of which the design in 0001 was shaped to allow without
-- a redesign:
--
--   * a full-text index over `payload`, which is possible only because the
--     payload is JSONB the server can read. This is the concrete thing given
--     up by ruling end-to-end encryption out permanently: a second brain that
--     answers questions has to be able to read what it stores.
--
--   * a NOTIFY on every write, so a connected client learns about a change
--     immediately instead of on its next poll.
--
-- Applied by second_brain/store/engine.py after 0001, under the same lock.

-- Search --------------------------------------------------------------------
--
-- A generated column rather than a trigger-maintained one: Postgres keeps it
-- in step with `payload` by definition, so there is no path where an update
-- lands and the index silently does not.
--
-- `jsonb_to_tsvector` with an EXPLICIT regconfig, not the two-argument form.
-- The two-argument form reads `default_text_search_config`, which makes it
-- STABLE rather than IMMUTABLE, and a generated column may only call an
-- immutable expression. The failure would be at migration time, but the reason
-- is worth recording: it also means the indexed language cannot drift with a
-- session setting.
--
-- `'["string"]'` indexes the string values anywhere in the document and
-- ignores numbers and booleans. That is what keeps this kind-agnostic — the
-- index has no idea whether it is looking at a session title or a memory, and
-- a kind invented later is searchable the day it is first pushed, with no
-- migration (R8).
--
-- NOTE FOR AN EXISTING DEPLOYMENT: adding a stored generated column rewrites
-- the table and holds an ACCESS EXCLUSIVE lock for the duration. On a small
-- store that is a blink; on a large one, run it in a window.
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS search tsvector
    GENERATED ALWAYS AS (
        jsonb_to_tsvector('english'::regconfig, payload, '["string"]'::jsonb)
    ) STORED;

-- GIN, not GiST: this index is read far more than it is written, and GIN is
-- the faster of the two for that shape.
CREATE INDEX IF NOT EXISTS documents_search_idx ON documents USING GIN (search);

-- The search read filters by subject and skips tombstones before ranking.
CREATE INDEX IF NOT EXISTS documents_subject_live_idx
    ON documents (subject)
    WHERE NOT deleted;

-- Realtime ------------------------------------------------------------------
--
-- Same function as 0001 — the seq assignment, the lock that makes the cursor a
-- watermark, and the last-writer-wins guard are all unchanged, and the comment
-- there is still the explanation. The only addition is the last statement.
--
-- pg_notify is delivered on COMMIT, which is exactly the behaviour wanted: a
-- listener is told about a write only once that write is visible to the read
-- it is about to make. Notifying before commit would wake a client to fetch a
-- change it cannot yet see.
--
-- The payload is the subject and nothing else. It is a nudge, not a delivery:
-- the client re-reads the feed from its own cursor, so a notification that is
-- lost, duplicated, or arrives out of order costs nothing. That is also why
-- this fires whether or not the last-writer-wins guard applied the row —
-- a spurious wake-up is a wasted read, where a missed one is a change that
-- waits for the next poll.
--
-- NOTIFY's payload limit is 8000 bytes. A subject is a Keycloak `sub`, so
-- there is no case where this is close.
CREATE OR REPLACE FUNCTION brain_put_document(
    p_subject    TEXT,
    p_kind       TEXT,
    p_doc_id     TEXT,
    p_updated_at DOUBLE PRECISION,
    p_deleted    BOOLEAN,
    p_payload    JSONB,
    p_device_id  UUID
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    v_seq BIGINT;
BEGIN
    UPDATE accounts
       SET doc_seq = doc_seq + 1,
           updated_at = now()
     WHERE subject = p_subject
    RETURNING doc_seq INTO v_seq;

    IF v_seq IS NULL THEN
        RAISE EXCEPTION 'brain_put_document: no account for subject %', p_subject
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    INSERT INTO documents (
        subject, kind, doc_id, seq, updated_at, deleted, payload, device_id
    ) VALUES (
        p_subject, p_kind, p_doc_id, v_seq, p_updated_at,
        COALESCE(p_deleted, FALSE), COALESCE(p_payload, '{}'::jsonb), p_device_id
    )
    ON CONFLICT (subject, kind, doc_id) DO UPDATE
       SET seq        = EXCLUDED.seq,
           updated_at = EXCLUDED.updated_at,
           deleted    = EXCLUDED.deleted,
           payload    = EXCLUDED.payload,
           device_id  = EXCLUDED.device_id,
           stored_at  = now()
     WHERE documents.updated_at <= EXCLUDED.updated_at;

    PERFORM pg_notify('brain_documents', p_subject);

    RETURN v_seq;
END;
$$;
