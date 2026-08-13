-- The whole durable shape of the second brain, in one migration.
--
-- Four tables and one function. Three of the tables are obvious; the fourth,
-- `documents`, is deliberately kind-agnostic — `kind` is an opaque string and
-- `payload` is JSONB — so that adding a synced content type later (memories,
-- plans, kanban) is a client-side change and not a migration on both sides.
--
-- Applied by second_brain/store/engine.py, once, under an advisory lock.

-- Accounts ------------------------------------------------------------------
--
-- One row per person, keyed by the Keycloak `sub` claim, which is the only
-- identifier that survives a rename or an email change. `slug` mirrors what
-- `hermes_cli.accounts.account_slug_for_identity` derives on the laptop; it is
-- carried for support ("whose home is this?") and is never the authority.
--
-- `doc_seq` is the per-account change-feed counter. Per-account rather than a
-- global BIGSERIAL on purpose: with a global sequence, transaction 105 can
-- commit *after* a reader has already advanced past 106, and 105 is then
-- invisible forever. See brain_put_document below.
CREATE TABLE IF NOT EXISTS accounts (
    subject      TEXT PRIMARY KEY,
    slug         TEXT        NOT NULL DEFAULT '',
    email        TEXT        NOT NULL DEFAULT '',
    display_name TEXT        NOT NULL DEFAULT '',
    issuer       TEXT        NOT NULL DEFAULT '',
    doc_seq      BIGINT      NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Devices -------------------------------------------------------------------
--
-- The primary key is (subject, id), not id alone. The device id names an
-- INSTALL — it lives in Electron's userData so that signing out and signing in
-- as somebody else does not turn one machine into two — which means two people
-- sharing a laptop legitimately present the same id. Keyed on id alone, the
-- second person's sign-in would collide with the first person's row.
--
-- Revocation is a tombstone (`revoked_at`), never a delete: a revoked device
-- must keep getting 403 rather than being quietly readmitted as a new one the
-- next time it calls.
CREATE TABLE IF NOT EXISTS devices (
    subject      TEXT        NOT NULL REFERENCES accounts (subject) ON DELETE CASCADE,
    id           UUID        NOT NULL,
    name         TEXT        NOT NULL DEFAULT '',
    platform     TEXT        NOT NULL DEFAULT '',
    app_version  TEXT        NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at   TIMESTAMPTZ,
    PRIMARY KEY (subject, id)
);

-- Listing a person's devices is the common read, and the last-device check
-- during revocation counts the live ones.
CREATE INDEX IF NOT EXISTS devices_subject_live_idx
    ON devices (subject)
    WHERE revoked_at IS NULL;

-- Model keys ----------------------------------------------------------------
--
-- One row per person: the point of the service is that a person has exactly
-- one model key and every device gets that same one.
--
-- The plaintext is stored, envelope-encrypted, because LiteLLM returns a
-- virtual key's plaintext exactly once and `/key/list` answers with the hash
-- only. Storing it here is what makes "hand the same key back to the second
-- device" possible at all, and it is strictly better than the status quo it
-- replaces, where the plaintext sat in cleartext .env on every laptop *and*
-- the admin key shipped inside every installer.
--
-- `kek_id` is per row so the KEK can be rotated by re-encrypting rows in the
-- background rather than by taking the service down. `litellm_token` is the
-- hash LiteLLM knows the key by, and is the ONLY handle rotation deletes
-- against — there is no delete-by-alias anywhere in this system.
CREATE TABLE IF NOT EXISTS model_keys (
    subject       TEXT PRIMARY KEY REFERENCES accounts (subject) ON DELETE CASCADE,
    key_alias     TEXT        NOT NULL,
    litellm_token TEXT        NOT NULL DEFAULT '',
    ciphertext    BYTEA       NOT NULL,
    nonce         BYTEA       NOT NULL,
    kek_id        TEXT        NOT NULL,
    base_url      TEXT        NOT NULL DEFAULT '',
    models        JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at    TIMESTAMPTZ
);

-- Documents -----------------------------------------------------------------
--
-- The change feed. `kind` is opaque: 'session' today, 'memory' and 'plan'
-- later, and nothing in this file needs to know the difference.
--
-- `updated_at` is the CLIENT's clock (epoch seconds, matching state.db's REAL
-- columns) and is used only to break ties between two writes to the same
-- document. Feed ORDER comes from `seq`, which is the server's, so clock skew
-- between two laptops cannot reorder the feed.
--
-- A delete is a tombstone (`deleted`), not a row removal: without one, a
-- device that was offline when the delete happened pushes the row straight
-- back on its next tick.
CREATE TABLE IF NOT EXISTS documents (
    subject    TEXT             NOT NULL REFERENCES accounts (subject) ON DELETE CASCADE,
    kind       TEXT             NOT NULL,
    doc_id     TEXT             NOT NULL,
    seq        BIGINT           NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL,
    deleted    BOOLEAN          NOT NULL DEFAULT FALSE,
    payload    JSONB            NOT NULL DEFAULT '{}'::jsonb,
    device_id  UUID,
    stored_at  TIMESTAMPTZ      NOT NULL DEFAULT now(),
    PRIMARY KEY (subject, kind, doc_id)
);

-- The feed read: everything for one person above a cursor, in seq order.
CREATE INDEX IF NOT EXISTS documents_subject_seq_idx ON documents (subject, seq);

-- The tombstone sweep reads by age.
CREATE INDEX IF NOT EXISTS documents_deleted_stored_at_idx
    ON documents (stored_at)
    WHERE deleted;

-- brain_put_document --------------------------------------------------------
--
-- Assign a change-feed position and apply one document, last-writer-wins.
--
-- The UPDATE on accounts is what makes the cursor a true watermark. It takes a
-- row lock held until this transaction commits, so two devices pushing for the
-- same person are serialised: the writer holding seq 5 commits before the
-- writer holding seq 6 can. A reader consuming in seq order therefore cannot
-- observe 6 while 5 is still uncommitted and invisible. Locking per account is
-- cheap precisely because one person owns a handful of devices; two different
-- people never wait on each other.
--
-- GAPS ARE INTENTIONAL AND HARMLESS. A write rejected by the last-writer-wins
-- guard below has already consumed a seq, so the sequence has holes in it. The
-- cursor only has to be monotonic, never contiguous — a reader asking for
-- "everything above 41" is correct whether or not 42 exists. Please do not
-- "fix" this by moving the counter bump after the upsert: doing so reintroduces
-- exactly the skipped-record race the per-account counter exists to prevent.
--
-- Returns the seq this call consumed, whether or not the row was applied.
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
        -- The account row is created when its owner's token is first verified,
        -- so reaching here means a caller bypassed authentication. Raise with
        -- the foreign-key SQLSTATE so it surfaces as the integrity error it is.
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
     -- Last writer wins, ties included: re-pushing an unchanged document is
     -- how a client recovers from a dropped acknowledgement, and that must
     -- stay a no-op rather than a rejection.
     WHERE documents.updated_at <= EXCLUDED.updated_at;

    RETURN v_seq;
END;
$$;
