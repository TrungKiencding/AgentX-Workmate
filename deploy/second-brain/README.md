# Deploying the AgentX second brain

The service that holds one model key per person, the list of devices they use
it on, and (from Phase 3) the change feed their conversation history syncs
through.

It belongs on **one server you control**. Nothing in here goes on a laptop —
the whole point is that the LiteLLM admin key stops travelling to laptops.

---

## Standing it up from nothing

You need: a host with Docker, a DNS name pointing at it, and the LiteLLM admin
key.

```bash
cd deploy/second-brain
cp .env.example .env
make kek                 # prints a fresh KEK — paste it into AGENTX_BRAIN_KEK
```

Then edit `.env`:

- `POSTGRES_PASSWORD` — anything long; put the same value in
  `AGENTX_BRAIN_DATABASE_URL`.
- `AGENTX_BRAIN_KEK` — what `make kek` printed. **Back this up somewhere that
  is not this host.** See "If you lose the KEK" below.
- `AGENTX_LITELLM_ADMIN_KEY` — the LiteLLM admin credential. This host is the
  only place it belongs now; the desktop installer no longer carries it.
  Treat the one that shipped inside previous installers as compromised and
  rotate it in LiteLLM before putting the new value here.
- `AGENTX_DASHBOARD_KEYCLOAK_*` — the realm. These must name the **same** realm
  the desktop app signs in against, or the service will reject tokens the app
  considers perfectly valid.
- `BRAIN_DOMAIN` — the DNS name. Use `localhost` for a local trial and Caddy
  will use its internal CA instead of asking Let's Encrypt for a certificate it
  cannot get.

Then:

```bash
make up
make health
```

`/health` reports Postgres and LiteLLM separately, and answers 503 only when
Postgres is unreachable — that is the one dependency without which no route can
do anything. A LiteLLM that is down or absent is reported and is not fatal:
devices still list, and stored keys still serve.

The database schema is applied by the service on startup, under an advisory
lock, so a rolling deploy of two instances is safe.

---

## One model key per person

`POST /v1/model-key` is where a laptop gets its model key. The first call for a
person mints one against LiteLLM, wraps it, and stores it. **Every call after
that — from that machine or any other — reads the stored copy and makes no
request to LiteLLM at all.**

That is the fix for the fault this service was built for: keys used to be
looked up by an alias derived from the person's `sub`, and both mint paths
deleted whatever wore that alias first, so signing in on a second laptop
revoked the first one's key. There is no delete-by-alias anywhere in this
service. Deletion happens during explicit rotation only, and only against the
token recorded on the row being replaced.

Rotation — `{"rotate": true}`, or `DELETE /v1/devices/{id}?rotate_key=true` —
is therefore self-healing. Other devices are not broken by it; they collect the
new key the next time they call.

### Auditing what the proxy puts on a new key

Worth doing once, when you first stand this up. A LiteLLM proxy can attach
key-level defaults (`object_permission`, `default_internal_user_params`) that a
`hosted_vllm` upstream then rejects — a `vector_store_ids` 400 on a freshly
minted key, with nothing in this repository sending that parameter. Old keys
predate the defaults and do not show it, which is why the symptom looks like
"the new machine is broken".

```bash
# What the proxy is configured to attach to new keys
curl -sS -H "Authorization: Bearer $AGENTX_LITELLM_ADMIN_KEY" \
  https://your-proxy/config/list | jq '.default_internal_user_params, .litellm_settings'

# What one person's key actually carries
curl -sS -H "Authorization: Bearer $AGENTX_LITELLM_ADMIN_KEY" \
  "https://your-proxy/key/info?key=<token>" | jq '.info.object_permission, .info.metadata'
```

Also worth running once after cutover: `/key/list` will still hold the keys
every laptop minted for itself under the old arrangement. Anything not carrying
`metadata.source = "agentx-second-brain"` was issued by a laptop and can be
retired once its owner has signed in against this service.

---

## Rotating the KEK

Every stored model key is wrapped with a key-encryption key, and each row
records which KEK opened it (`kek_id`). That is what makes rotation a
background job rather than an outage.

1. Generate the new KEK: `make kek`.
2. Move the current pair out of the way: copy `AGENTX_BRAIN_KEK` into
   `AGENTX_BRAIN_KEK_PREVIOUS` and `AGENTX_BRAIN_KEK_ID` into
   `AGENTX_BRAIN_KEK_PREVIOUS_ID`.
3. Put the new KEK in `AGENTX_BRAIN_KEK` and bump `AGENTX_BRAIN_KEK_ID`
   (`k1` → `k2`). Both ids must differ, and the service refuses to start if
   they do not — rows written from now on would be indistinguishable from the
   ones being retired.
4. `make up` to restart with both.
5. Rows re-wrap themselves: each one moves onto the new KEK the next time its
   owner asks for their key, which every device does on launch. Nothing to
   schedule, and no window.
6. Once no row carries the old `kek_id`, empty `AGENTX_BRAIN_KEK_PREVIOUS` and
   `AGENTX_BRAIN_KEK_PREVIOUS_ID` and restart. Check first:

   ```bash
   make psql
   select kek_id, count(*) from model_keys group by kek_id;
   ```

Drop the old KEK before that query is down to one row and the people still on
it get `503 key_unreadable` — the service says it cannot open their key rather
than minting them a new one, so putting the KEK back is all the recovery
needed.

Rotate the KEK if it has been exposed, and on whatever schedule your policy
says. Rotating it is unrelated to rotating anybody's *model* key, which is
`DELETE /v1/devices/{id}?rotate_key=true` or the button in Settings.

### If you lose the KEK

The encrypted rows remain and nothing can open them. There is no recovery
beyond minting everyone a new model key, which is what the service does for
each person on their next request once their row is deleted. Back the KEK up
off this host.

---

## Backup and restore

```bash
make backup                       # writes backup-<UTC timestamp>.sql
make restore FILE=backup-....sql
```

The dump contains every person's encrypted model key and their conversation
history. Store it with the care that implies; the encryption protects the model
keys, not the history.

### The one restore consequence to know about

Each client remembers a **sync cursor**: the highest change-feed position it has
already pulled. The server hands out positions from a per-account counter
(`accounts.doc_seq`).

Restore Postgres to an earlier point and that counter goes backwards, while
every client's cursor does not. A client holding cursor 900 against a server
whose counter is back at 400 asks for "everything above 900" and is correctly
told there is nothing — **forever**, or at least until the account produces 500
more changes.

The fix is to reset the affected clients' cursors to 0. Re-pulling everything is
safe: applying a document that is already applied is a no-op by construction.

---

## Search and the change socket

Two capabilities the `0002_search.sql` migration adds. Both are optional in the
sense that nothing breaks without them; neither needs any configuration.

**`GET /v1/search?q=…`** ranks a person's own documents by full text. The index
is a generated `tsvector` over the JSONB payload, so it covers the string
values anywhere in a document and has no idea what kind it is looking at — a
content type a client invents next year is searchable the day it is first
pushed, with no migration here. Results never cross accounts: the filter is in
the store's SQL, not in the route.

> Applying `0002` on an existing store rewrites the `documents` table and holds
> an `ACCESS EXCLUSIVE` lock while it does. On a small store that is a blink;
> on a large one, run it in a window.

**`/v1/sync/stream`** is a WebSocket that tells a connected device when its
account's feed moves. It carries a nudge and never a document — the client
re-reads the feed from its own cursor — so a notification that is lost or
duplicated costs nothing and every device still converges on its polling
interval without it.

Notifications come from Postgres (`pg_notify` inside `brain_put_document`),
not from the process handling the push, so a device pushing through one
instance wakes a device listening on another. `/health` reports
`realtime.status` as `polling` when the listening connection could not be
opened; the service is fully working in that state and simply has no shortcut.

If you put something other than the bundled Caddy in front of this, it must
pass WebSocket upgrades and must not close idle connections faster than the
service pings them — see the note in the `Caddyfile`.

---

## Retention

- **Documents** live as long as the account does. Deleting an account row
  cascades to its devices, its model key and its documents.
- **Tombstones** — the markers left behind when a document is deleted — are kept
  for 90 days and then swept (`AGENTX_BRAIN_TOMBSTONE_RETENTION_DAYS`). They
  cannot safely be dropped sooner: without a tombstone, a device that was
  offline when the delete happened pushes the row straight back on its next
  sync, resurrecting it everywhere. Lengthen the window rather than shorten it.
- **Revoked devices** are kept, marked, not deleted. "Which machine did I cut
  off, and when" is exactly the question somebody asks after cutting one off.
- **Backups** are yours to age out. Nothing here deletes them.

---

## Running the tests

The service's tests need a real Postgres — never a SQLite stand-in, because the
correctness of the change feed rests on row locking inside a transaction, which
SQLite does not have.

```bash
make test-db                 # prints the DSN to export
export AGENTX_BRAIN_TEST_DSN=postgresql://brain:brain@127.0.0.1:55433/brain
python -m pytest tests/second_brain
make test-db-stop
```

Without `AGENTX_BRAIN_TEST_DSN` the suite creates and removes its own throwaway
container, provided Docker is running. With neither, it skips and says so.

---

## Why this directory has an allowlist `.gitignore`

The repository's root `.gitignore` covers `.env`. It does not cover
`secrets.yaml`, `kek.txt`, `admin-key.json`, or `backup-20260813.sql` — all
plausible names for something an operator drops here while standing the service
up, and this repository is public.

So `.gitignore` here ignores everything and names what may be committed. A new
file is invisible to git until somebody adds it on purpose, which is exactly the
moment to think about whether it holds a secret. CI scans the whole tree for
secret shapes as a second line; neither is a substitute for the other.
