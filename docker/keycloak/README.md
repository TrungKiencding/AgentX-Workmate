# Keycloak client for AgentX Workmate

`agentx-workmate-client.json` is a Keycloak **ClientRepresentation**. Import it
into the realm that holds your AgentX users:

**Admin console → your realm → Clients → Import client → upload the file.**

Or from the CLI:

```bash
kcadm.sh create clients -r agent-hub -f agentx-workmate-client.json
```

The file carries no comments on purpose. Keycloak deserialises it strictly and
rejects any field it does not know — including a `_comment` key — with
`Unrecognized field ... not marked as ignorable`. Keep it a pure
ClientRepresentation; everything explanatory lives here instead.

## What each setting is for

**`publicClient: true`** — not negotiable. AgentX Workmate is installed on
employees' own machines, and a desktop binary cannot keep a client secret.
PKCE (S256) authenticates the token exchange in its place. Setting a secret
also stops the desktop app from signing in at all: it falls back to the
gateway-brokered flow, which a local backend cannot use (see the redirect URIs
below for why).

**The three `127.0.0.1:4782x/callback` URIs** — the fixed loopback ports the
desktop app listens on for its OAuth callback (`KEYCLOAK_CALLBACK_PORTS` in
`apps/desktop/electron/keycloak-oidc.ts`). They have to be fixed because the
local backend is started on an *ephemeral* port that changes every launch, so
its own `/auth/callback` URL could never be registered here. Three of them so a
colliding local process — or a second sign-in already in flight — doesn't
dead-end the user.

Loopback HTTP is correct even on an HTTPS realm: RFC 8252 §7.3 covers native
apps, and the connection never leaves the user's machine. Keycloak accepts it
with `sslRequired: external`.

**`http://localhost:9119/auth/callback`** — for the *browser* dashboard
(`agentx dashboard`). Change the port to match yours, point it at your real
host if the dashboard is served remotely, or delete the entry if you only ship
the desktop app.

**`directAccessGrantsEnabled: false`** — deliberately off. The direct-grant flow
cannot satisfy MFA, a required password change, or any other Keycloak required
action: the realm answers `invalid_grant` and the in-app form has no way to tell
the user why. Only enable it, alongside
`dashboard.oauth.keycloak.allow_password_grant`, if your realm has none of
those.

**`webOrigins: []`** — nothing needs CORS. The browser only *navigates* to
Keycloak; both token exchanges happen server-side (Python provider) or in the
Electron main process.

## What you don't need to add

If your realm keeps `tenant` in its default client scopes — the `agent-hub`
realm does — a newly created client inherits it, so the `tenant_slug` claim
arrives without any extra protocol mapper. That claim is what populates the
session's `org_id`.

## After importing

Point AgentX Workmate at the realm:

```bash
agentx dashboard keycloak \
  --base-url https://your-keycloak.example.com/auth \
  --realm agent-hub \
  --client-id agentx-workmate \
  --require-auth
```

`--base-url` is the Keycloak **server root**, not the realm URL — the command
derives the issuer as `{base_url}/realms/{realm}` and checks it against what the
realm actually advertises before writing anything.
