---
sidebar_position: 5
title: "MCP catalog and the AgentX Hub"
description: "Install MCP servers from the catalog shipped with AgentX or from your AgentX Hub — verified, locked to the tools the hub approved, switched off remotely when the hub withdraws them"
---

# MCP catalog and the AgentX Hub

Workmate offers MCP servers from two places, side by side in **Utilities → Store → MCP** (the **From AgentX Hub** and **Recommended by AgentX** shelves) and in `agentx mcp`:

- **The shipped catalog** — the entries under `optional-mcps/` of the AgentX repository (see [MCP](./features/mcp.md#catalog-one-click-install-for-nous-approved-mcps)).
- **Your AgentX Hub** — the MCP servers your organisation's hub approved for you: a server published privately by you, one shared with a workspace you belong to, or one approved for your organisation. They are listed as `agentx-hub/<slug>`.

Each hub server is set up in **one place** — on the hub or on this machine — and the hub says which. You never type the same key or sign in to the same account twice.

## Set up in one place

The hub decides where each of its servers is set up, the same way for everybody:

- **On the hub** (its card is tagged **Through AgentX Hub**) — a remote server the hub's AgentX Gateway serves. Its account — an API key, an OAuth sign-in, a value such as a tenant — is kept by the hub, encrypted, and Workmate reaches the server through the gateway with this machine's own token (`AGENTX_HUB_GATEWAY_TOKEN` in `~/.agentx/.env`, renewed by itself). **Nothing about it is typed in Workmate.** Its card has one button, which says what comes next:
  - **Add** — your account is connected on the hub (or your organisation shares one with you): the server is added at once.
  - **Connect** — Workmate opens the hub's connect page in your browser. Connect once there (sign in, or paste the key). Workmate waits — the card says *Waiting for you to connect on AgentX Hub…*, with **Open the page again** and **Cancel** — and adds the server as soon as you are connected. It asks again when you come back to Workmate, and the hub tells it too; a wait lasts 30 minutes.
  - **Connect again** — your account on the hub needs a new sign-in. The hub's page opens; once you are signed in there, the server works again (it stays added).
  - No button — the gateway does not serve it right now, or the hub has approved none of its tools yet: the card says which.
- **On this machine** — a server that runs on your computer (a package), a hub without a gateway (or with the gateway turned off for that server), or a server whose provider takes no sign-in through the hub (its card says **Sign in on this machine**). It is installed from its signed manifest, and its values are typed on its card (see [Installing](#installing)).

The hub's own pages follow the same rule. On a server set up on the hub, **Add to Workmate** asks every machine where you are signed in to add it on its next sync. **Open in Workmate** (the link `agentx://mcp/<slug>`) opens this store with that server's card in view. The toolsets you gathered on the hub have their own **Toolsets** shelf and are added the same way.

`agentx mcp install agentx-hub/<slug>` on a server set up on the hub says to add it from **Utilities → Store → MCP**: there is nothing to install or type on the command line.

A server you installed from its manifest **before** the hub set it up on the hub keeps running as it is, with the values you typed. To move it to the hub, remove it and add it again.

Before config v38 Workmate kept this machine's gateway token as `AGENTX_GATEWAY_TOKEN` — the key the [OpenClaw migration](../guides/migrate-from-openclaw.md) fills with OpenClaw's own gateway token. Workmate moves the hub's token to `AGENTX_HUB_GATEWAY_TOKEN` by itself (`agentx update` does too). A value under the old key that is not the hub's token stays exactly where it is, and Workmate asks the hub for a new token.

## What "verified" means

Workmate reads the hub's MCP feed (`GET /v1/mcp/catalog.json?product=workmate`), keeps it on disk for 30 minutes, and lists a hub server only when **both** of the hub's signatures hold, with a key the hub publishes at `/.well-known/agentx-hub.json`:

- the **version signature**, made when a hub admin approved the version (or, for a server of your own, when its scan published it): it covers the `server.json` by its hash, the tool list by its hash and the scan's verdict;
- the **manifest signature**, over the manifest Workmate installs: the exact command it runs, its environment, and the hashes of the tools it may use.

A server whose signatures do not hold, whose scan found it dangerous, or that Workmate cannot run as it is (an argument you would have to type into the command, an SSE-only remote, several secret headers) is not installable here; the store says why, and **Open on the Hub** leads to its page and its client configurations.

A hub entry installs nothing but its configuration: it runs through a package launcher pinned to one exact release (`npx -y pkg@1.2.3`, `uvx pkg@1.2.3`, `docker … image@sha256:…`) or a remote URL. There is no clone and no bootstrap script.

## Installing

Click **Connect** on a hub server set up on this machine (or run `agentx mcp install agentx-hub/<slug>`). If it needs values — an API key, a token — you type them on its card; they are written to `~/.agentx/.env`, never sent to the hub, and the server's configuration only names them (`${LINEAR_API_KEY}`). The server then joins the **Connected** shelf, where it is switched on and off, signed in, checked, updated and removed; its card in the hub's shelf reads **Connected**.

Workmate then tells the hub it installed the server on this machine — a server set up on the hub too, once it is added. One installed while the hub could not be reached is told on a later sync, with the version it runs. From then on the hub keeps the install's desired state, like it does for skills: the web shows **Installed on &lt;your machine&gt;**, and a change on the hub reaches this machine through the hub sync (at most a minute; at once while the store is open, since it keeps a live connection).

## The tools you get are the tools the hub approved

Each time the server connects, Workmate hashes every tool it announces — its name, description and schemas, the way the hub hashed the list it approved — and turns on **only** the tools whose hash matches. A tool the server added, or one whose description or schema changed since the approval, stays off: the server's card says **N tools blocked**, and its **Details** list them.

That is how a changed server (a "rug pull": a tool description that later asks the model to read your SSH keys) is stopped on your machine before anybody looks at it. Workmate also reports the list it saw to the hub. A hub admin reads the new list, scans it and either **accepts** it — the version is signed again with it, and your machine unblocks those tools on its next sync — or keeps it blocked. For a server of your own (private), publish a new version with the new tools.

Your own tool filter (`tools.include` / `tools.exclude`) still applies on top.

## When the hub withdraws a server

If the version you run is yanked, the server is taken down by a hub admin, or a rescan finds it unsafe, the hub asks every machine that runs it to switch it off. Workmate sets `enabled: false` on it — the configuration and your values stay — and its card says **Off by the hub** with the reason. Its switch stays locked: switching it on here, or in `mcp.json`, does not last (Workmate says it kept it off). When the hub restores it, or approves the version again, it is switched back on; when a fixed version is published, the store offers it as an update, and once you run it the hub switches the server back on.

When its owner **stops publishing** it, it keeps working: a server installed here from its manifest runs as it is; one reached through the AgentX Gateway is served 30 more days — its card says until when — unless the owner stopped it at once. The card says **No longer published** and names what the owner points to instead, when there is one. **Remove connection** takes it off, the hub's way (its tokens and cached tools too).

The hub never removes or overwrites anything by itself while it cannot be reached: an unreachable hub leaves every installed server as it is, and the catalog keeps showing the list it fetched last.

## Updates, edits and removal

- **Update** — a newer version is published (the card says **Update X available**). Nothing updates on its own; click it (or reinstall) when you want the new version. A server set up on the hub has no update to click: the gateway serves the version the hub approved.
- **Edited here** — you changed the server's command, arguments, environment or URL. The hub sync never overwrites it; **Replace with the Hub version…** in its **Details** puts the hub's configuration back, after a confirmation.
- **Remove connection** (in its **Details**, after a confirmation) — removes the server from this machine, with its OAuth tokens and cached tool list. The hub hears it on the next sync (removing it from `mcp.json` by hand is understood the same way).

A hub server always installs into the default profile, where the hub sync runs, and never replaces a server of another origin that already uses its name. A named profile — including one the desktop runs on its own — offers no hub server, and tells the hub nothing of the servers it has.

## Troubleshooting

| What you see | Why |
|---|---|
| "Sign in to AgentX to see the MCP servers your Hub approved for you" | Nobody is signed in on this machine: sign in to AgentX. |
| "The AgentX Hub could not be reached" | The list shown is the one fetched last; installed servers keep working. |
| A hub server is missing | It is not approved for you, Workmate cannot run it as it is (see the note under the hub section), or its signatures did not hold (`agentx mcp catalog` prints the reason). |
| "needs_secrets" under **Store → Skills** (what the hub asked of this machine) | The hub asked this machine to install a server whose values it does not hold: connect it from **Store → MCP** and type them. |
| "gateway_not_ready" under **Store → Skills** | The hub asked this machine to add a server set up on the hub, and your account there is not connected: click **Connect** on its card (or connect on the hub). |
| *Waiting for you to connect on AgentX Hub…* | Workmate opened the hub's connect page; connect there. **Open the page again** if you closed it, **Cancel** to stop waiting. |
| **Sign in again on the hub** on a connected server | Its account on the hub lapsed: **Connect again** opens the hub's page. |
| Tools blocked | The server announces tools that differ from the approved list; a hub admin decides. |
| **Off by the hub** on a server, its switch locked | The hub withdrew what it runs; the reason is on the card. Only the hub turns it back on — or update to a version it serves. |
| **No longer published** | Its owner took it out of the catalogue. It keeps working here (through the gateway, until the date on its card). |
