---
sidebar_position: 18
title: "Accounts"
description: "Give every person who signs in their own AGENTX_HOME and their own LiteLLM key, minted from a verified Keycloak identity — with the admin key kept off employees' machines"
---

# Accounts

AgentX Workmate installs onto each employee's own machine, but the accounts are central: everybody signs in with the Keycloak account your organisation already has. An **account** is what that sign-in produces on disk — a state directory belonging to one person, and (optionally) a model key belonging to one person.

This page is for whoever rolls Workmate out. If you are only running a personal install and never sign in, none of it applies and nothing here changes how your install behaves.

## What an account is

An account is an `AGENTX_HOME` of its own. It sits under the install root, and the [profiles](../profiles.md) you already know about live *inside* it:

```
<install root>/                                 the machine: checkout, venv, node_modules
<install root>/accounts/<slug>/                 one signed-in person — their AGENTX_HOME
<install root>/accounts/<slug>/profiles/<name>/ that person's workspaces
```

The two axes do not compete. The account is the outer scope, so once a process is homed in `accounts/<slug>`, everything anchored on the home resolves inside it: `profiles/`, the sticky `active_profile` marker, the `default` profile, `config.yaml`, `.env`, sessions, memories, skills, the kanban store. Two people who sign in on the same laptop share nothing — not the provider key, not the chat history, not the memory files, not the config.

What stays at the install root is what belongs to *the machine*: the source checkout, the virtualenv, `node_modules`, update markers.

:::note An install with nobody signed in is unchanged
There is no `accounts/` directory until somebody signs in. Until then — and forever, if you never turn on dashboard auth — Workmate uses `<install root>` directly, exactly as every pre-account install does. Nothing migrates, nothing moves, and no existing path changes meaning.
:::

## The slug, and why it is derived

The directory name is a **slug** derived from the Keycloak identity:

- **Label** — the `preferred_username`, or the local part of the email when there is no username. Lowercased, anything outside `[a-z0-9]` collapsed to a hyphen, trimmed, truncated to 24 characters.
- **Digest** — the first 8 hex characters of `sha256(sub)`.
- **Slug** — `<label>-<digest>`, or `u-<digest>` when sanitising leaves no label at all.

So `kien.le@example.com` with username `kien.le` becomes something like `kien-le-3f9a1c02`.

It is derived rather than chosen for two reasons. First, the desktop app has to pick a directory *before* it can ask any backend anything — it spawns the backend already homed in the right place, so the name has to be computable from the token alone. (The same derivation is implemented in `apps/desktop/electron/account-slug.ts` and locked to the Python one by shared test vectors.) Second, deriving it from the immutable `sub` claim means the same person lands in the same home on every machine, with no mapping table to keep in sync.

The label is cosmetic. Two colleagues whose usernames sanitise to the same string still get different homes, because the digest is taken over `sub`. And a rename in Keycloak does not orphan anybody: Workmate looks for a home already recorded against that `sub` before it derives a fresh slug, and adopts it.

## Step 1 — Keycloak

Accounts exist only for verified identities, so dashboard auth has to be on first.

**A build installed from an AgentX Workmate installer already has this.** The realm and the public client id ship inside it (`hermes_cli/config_defaults.py`), and a configured provider is itself what engages the gate on a loopback bind — so an employee who installs the app is asked to sign in on the first launch, with nothing to run on their machine. The rest of this step is for pointing an install at a *different* realm.

Set that up with `agentx dashboard keycloak` — see [Web Dashboard → Keycloak provider](./web-dashboard.md#keycloak-provider-agentx-accounts) for the full walkthrough, the client settings that matter, and the redirect URIs to register. It is not repeated here.

Two things from that page are load-bearing for accounts:

- **A configured provider engages the gate.** `base_url` + `realm` + `client_id` (or an explicit `issuer`) is the opt-in; there is no separate switch to remember. `dashboard.require_auth: true` pins it on regardless, and `false` — or `AGENTX_DASHBOARD_REQUIRE_AUTH=0` — is the escape hatch for a developer working against a realm they cannot reach. With the gate on and no provider registered, the dashboard refuses to start: fail closed, never open.
- **A public client.** The desktop app is a binary on an employee's machine and cannot hold a secret.

## Step 2 — LiteLLM

With sign-in working, each account can get its own model access: a LiteLLM virtual key minted for that person, written into their account's `.env`, and referenced from their account's `config.yaml`. Ten people on one machine end up with ten keys and ten spend lines instead of one key everybody shares.

**A build installed from an AgentX Workmate installer already has this too.** It ships `enabled: true`, `mode: direct`, AgentX's own proxy, and a default model, and the installer carries the admin key that direct mode needs — so signing in mints the key and selects a model with no configuration step.

:::warning What `mode: direct` costs
Direct mode means the LiteLLM **admin** key travels inside the installer and is written to each machine's `~/.agentx/.env`. Anyone who unpacks the `.app` / `.exe`, or reads their own `.env`, can use it to mint themselves unlimited budget or delete a colleague's key. It ships that way because no broker is deployed yet and a laptop that cannot mint has no model at all.

The way out is `agentx litellm-broker serve`: stand it up, set `broker_url`, switch `mode` to `broker`, and rotate the admin key. Nothing on the laptop side changes.
:::

The configuration is one block in `config.yaml` (all keys and their defaults are documented in `cli-config.yaml.example`):

:::important `accounts.litellm` is read at the install root
This block is operator policy — which proxy, which mode, what budget — not a personal preference. It is read from the **install root's** `config.yaml` (`~/.agentx/config.yaml`), whichever account a process is running as, and every account on the machine inherits it. Write it once, before anybody signs in: an account home is created *at* sign-in with no `config.yaml` of its own, so a value written inside one would be invisible to the next person and to a brand-new account.

The same goes for `AGENTX_LITELLM_ADMIN_KEY` in direct mode — put it in the root's `~/.agentx/.env`. The provisioner checks the account's `.env` first and falls back to the root's.

Everything the *user* owns still lives in their own home: the minted key, their `providers:` entry, sessions, memory, skills.
:::

```yaml
accounts:
  litellm:
    enabled: true
    mode: broker                    # or "direct"
    broker_url: "https://keys.example.com/api/litellm/account-key"
    # base_url: "https://litellm.example.com"   # required on the broker; also used in direct mode
    key_alias_prefix: "agentx-workmate"
    provider_name: "litellm"
```

`enabled: false` is the default, and an install that never sets it provisions nothing.

There are two modes, and they differ in exactly one thing: **who holds the LiteLLM admin key.**

### Broker mode (default, and the one to deploy)

Minting a virtual key requires an admin credential. Workmate runs on the employee's own machine, so an admin key configured in direct mode sits in a plain file — `~/.agentx/.env` — that the employee owns and can read. That is enough to mint themselves a key with unlimited budget, and enough to enumerate and delete their colleagues' keys. It is not a hypothetical risk; it is a file on their disk.

Broker mode keeps the admin key on one server you control. The laptop proves who it is with the Keycloak token it already holds, and the server does the minting:

```
laptop ──(Bearer <Keycloak ID token>)──▶ broker ──(admin key)──▶ LiteLLM
                                               ◀── sk-… for that user
```

The broker derives the account slug from the **verified token**, never from the request body. The client does send an `account` hint, but it is used only for logging — and logged loudly when it disagrees with what the token says, because that is the shape a probing client has. Nobody can ask for somebody else's key by editing a JSON field.

**Deployment recipe**

1. On a server (not a laptop), install Workmate and configure the **same Keycloak realm** the app uses, under `dashboard.oauth.keycloak.*`. The broker reuses the dashboard's own Keycloak provider rather than a second verifier, so it accepts exactly the tokens the product accepts.
2. Put `AGENTX_LITELLM_ADMIN_KEY` in that server's `~/.agentx/.env`, and set `accounts.litellm.base_url` to your LiteLLM proxy.
3. Run it:

   ```bash
   agentx account broker --host 0.0.0.0 --port 8787
   ```

   It exposes `POST /api/litellm/account-key` and a `GET /health`. Missing configuration is fatal at startup, not at first request — a broker that only discovers it has no admin key during somebody's sign-in is worse than one that fails your deploy.
4. **Put TLS in front of it.** Bearer tokens and freshly minted `sk-…` values cross this connection. Terminate TLS with whatever your estate already uses (nginx, Caddy, an ingress) and do not expose port 8787 directly.
5. On the laptops, set:

   ```yaml
   accounts:
     litellm:
       enabled: true
       mode: broker
       broker_url: "https://keys.example.com/api/litellm/account-key"
   ```

   No `base_url` needed there: the broker's response names the proxy, and that answer wins over the local setting — so moving LiteLLM later does not mean pushing new config to every machine.

### Direct mode (pilots)

```yaml
accounts:
  litellm:
    enabled: true
    mode: direct
    base_url: "https://litellm.example.com"
```

plus `AGENTX_LITELLM_ADMIN_KEY` in that machine's `~/.agentx/.env`. There is nothing to deploy and it works today.

The exposure: anyone who can read that machine's `.env` — which, on a laptop, is the employee using it — holds your LiteLLM admin key and everything it can do. Use it for a pilot on machines you trust, and say so out loud before it becomes the rollout.

## What provisioning actually does

Provisioning runs on every sign-in (the desktop app calls `POST /api/account/provision`) and again whenever you run `agentx account provision`. The rule is **one LiteLLM key per account, found by alias, reused until it stops working**:

1. **Look for the key we already have.** The alias is `<key_alias_prefix>-<account-slug>` — for example `agentx-workmate-kien-le-3f9a1c02`. If this account's `.env` holds a key recorded under that alias, one cheap `GET /v1/models` with that key confirms the proxy still accepts it, and provisioning stops there (`reused`).
2. **Otherwise mint.** Any key already wearing the alias is deleted first, then a fresh one is generated with the budget, rate limits, model restriction and metadata from your config.
3. **Wire it in.** The plaintext key is saved to the account's `.env` as `AGENTX_CUSTOM_LITELLM_API_KEY` (the name follows `provider_name`), and a `providers.<provider_name>` entry is merged into the account's `config.yaml` with `base_url: <proxy>/v1`, `key_env`, and `discover_models`. Merged, not rebuilt — hand-added settings in that block survive. The key is never written into `config.yaml` in plaintext.
4. **Record it.** A `litellm-account.json` sidecar in the account home notes the alias, key hash, base URL and discovered models. It deliberately holds no plaintext.

If `default_model` is set, it is pinned as the account's default **only** the first time, and only while the user has not chosen a model themselves — re-pinning on every sign-in would fight anyone who ran `agentx model`.

:::info Why recovery is delete-then-mint
LiteLLM returns a virtual key's plaintext exactly once, at generation. `/key/list` and `/key/info` answer with the hash, never the `sk-…` value. There is a `/key/{token}/regenerate` that would issue new plaintext for the same key's settings, but on the open-source build it answers HTTP 500 with "Regenerating Virtual Keys is an Enterprise feature". So when Workmate no longer holds a usable copy of a key, the only recovery that exists is to retire the alias and mint a new one. That is a rotation, and it is reported as one.
:::

Provisioning never fails a sign-in over an unreachable proxy. Somebody opening their laptop on a train keeps the key they already have, and the next launch retries.

## Budgets, rate limits, and model access

Each key is stamped at mint time with whatever ceilings the config names:

```yaml
accounts:
  litellm:
    max_budget: 25            # USD spent per budget_duration; 0 = no limit
    budget_duration: "30d"    # LiteLLM duration string
    tpm_limit: 200000         # tokens per minute; 0 = no limit
    rpm_limit: 300            # requests per minute; 0 = no limit
    models: ["gpt-4o", "claude-sonnet-4-5"]   # [] = whatever the proxy exposes
```

LiteLLM enforces all of these, and its spend reporting is per key — so per person, which is the point of one key each.

These values apply **at mint time**. Changing them affects keys minted afterwards; a key somebody already holds keeps the limits it was born with until it is rotated (`agentx account provision --rotate`).

:::warning A listed model can still be refused
A LiteLLM virtual key can be restricted further by the upstream provider key behind it. The consequence is genuinely confusing: a model shows up in `GET /v1/models` for a user's key, they select it, and the call comes back with *"key not allowed to access model"*.

`models: []` does not mean "everything works" — it means "whatever the proxy exposes to this key", and the proxy's own upstream credential may be narrower than its model list. Pick `default_model` from a model you have actually completed a request with, on a key minted the same way your users' keys are, rather than from the model list.
:::

## The CLI

```bash
agentx account list                      # every account home on this machine; ◆ marks the active one
agentx account show [<slug>]             # home, identity, and provider key for one account
agentx account provision                 # ensure the active account holds a working key
agentx account provision --rotate        # retire the current key and mint a fresh one
agentx account delete <slug> [-y]        # delete an account home and everything in it
agentx account broker --host 0.0.0.0 --port 8787    # server-side; never on a laptop
```

Accounts are normally created and selected by the desktop app after sign-in, but the terminal is not a second-class citizen — somebody debugging a laptop over SSH needs to see whose homes exist, which one they are in, and whether that person's key is healthy.

`agentx --account <slug> <anything>` re-homes any command into that person's home:

```bash
agentx --account kien-le-3f9a1c02 account show
agentx --account kien-le-3f9a1c02 -p work chat
```

The flag is handled before argparse and before the profile flag, because the account is the outer scope: once `AGENTX_HOME` points inside `accounts/<slug>`, no `-p` value can reach across into somebody else's state. Unlike `--profile`, a home that does not exist yet is created rather than refused — a first launch is not an error. An *invalid* slug is fatal, though: continuing would silently write that person's history and key into the shared root home, which is precisely what the flag exists to prevent.

Three things worth knowing:

- `agentx account show <slug>` only reads the LiteLLM key for the account you are actually homed in, because the key lives in that account's own `.env`. For anyone else it tells you to re-run with `--account`.
- `agentx account provision` writes into an account's home and so needs one to be active; run it as `agentx --account <slug> account provision`. In broker mode it also needs the user's Keycloak token — the desktop app supplies it automatically, and by hand you pass `--token <bearer>`.
- `agentx account delete` refuses to delete the account the calling process is running under. The directory would be recreated underneath you by the next config load, leaving a half-deleted home that looks fine and has lost its data.

## Troubleshooting

Every provisioning attempt reports a status — in `agentx account provision` output, in `agentx account show`, and in the `litellm` block of `GET /api/account`.

| Status | Meaning | What to do |
|--------|---------|------------|
| `provisioned` | A key was minted for an account that had none. | Nothing. This is a first sign-in. |
| `rotated` | A key existed and was replaced. | Expected after `--rotate`, or after the proxy stopped accepting the old key. Repeated rotations on every launch mean the key is being revoked or deleted upstream — check LiteLLM for a competing process minting under the same alias. |
| `reused` | The key already on this account is still valid. | Nothing. This is the normal, common path. |
| `disabled` | `accounts.litellm.enabled` is false. | Set it to `true` if you meant to provision. Otherwise this is just an install that does not use per-account keys. |
| `unconfigured` | Enabled, but the mode's required setting is missing — `broker_url` in broker mode, `base_url` in direct mode. | Fill in the missing key. The detail names which one. |
| `offline` | LiteLLM (or the broker) could not be reached at all. | Not an error state for the user: the account keeps whatever key it has and the next launch retries. Check the proxy, DNS and TLS if it persists. Note that a stored key is deliberately *not* discarded on an unreachable proxy — an outage must never look like a revocation. |
| `error` | A real misconfiguration. Common cases: direct mode with no `AGENTX_LITELLM_ADMIN_KEY`; the broker rejected the sign-in (401 — the broker and the app disagree about the realm, or the session is stale, so sign out and in again); the broker answered 502/503 because LiteLLM refused or was unreachable from it; provisioning was attempted in broker mode with no bearer token. | Read `detail`; it names the specific failure. |
| `missing` | Status-only result from `agentx account show` / `GET /api/account`: this account has no key yet. Nothing has been attempted. | Run `agentx --account <slug> account provision`, or just sign in from the desktop app. |

`provisioned`, `rotated` and `reused` are the successful ones. `disabled` and `unconfigured` are deliberate configurations rather than failures, and the CLI exits 0 for them.

## See also

- [Web Dashboard → Keycloak provider](./web-dashboard.md#keycloak-provider-agentx-accounts) — setting up sign-in
- [Profiles](../profiles.md) — the inner axis, one person's several workspaces
- [Environment Variables → Per-Account Provisioning (LiteLLM)](../../reference/environment-variables.md#per-account-provisioning-litellm) — `AGENTX_LITELLM_ADMIN_KEY`
