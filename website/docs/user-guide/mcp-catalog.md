---
sidebar_position: 5
title: "MCP catalog and the AgentX Hub"
description: "Install MCP servers from the catalog shipped with AgentX or from your AgentX Hub — verified, locked to the tools the hub approved, switched off remotely when the hub withdraws them"
---

# MCP catalog and the AgentX Hub

Workmate offers MCP servers from two places, side by side in **Capabilities → MCP → Catalog** and in `agentx mcp`:

- **The shipped catalog** — the entries under `optional-mcps/` of the AgentX repository (see [MCP](./features/mcp.md#catalog-one-click-install-for-nous-approved-mcps)).
- **Your AgentX Hub** — the MCP servers your organisation's hub approved for you: a server published privately by you, one shared with a workspace you belong to, or one approved for your organisation. They are listed as `agentx-hub/<slug>`.

## What "verified" means

Workmate reads the hub's MCP feed (`GET /v1/mcp/catalog.json?product=workmate`), keeps it on disk for 30 minutes, and lists a hub server only when **both** of the hub's signatures hold, with a key the hub publishes at `/.well-known/agentx-hub.json`:

- the **version signature**, made when a hub admin approved the version (or, for a server of your own, when its scan published it): it covers the `server.json` by its hash, the tool list by its hash and the scan's verdict;
- the **manifest signature**, over the manifest Workmate installs: the exact command it runs, its environment, and the hashes of the tools it may use.

A server whose signatures do not hold, whose scan found it dangerous, or that Workmate cannot run as it is (an argument you would have to type into the command, an SSE-only remote, several secret headers) is not installable here; the catalog says why, and **Open on the Hub** leads to its page and its client configurations.

A hub entry installs nothing but its configuration: it runs through a package launcher pinned to one exact release (`npx -y pkg@1.2.3`, `uvx pkg@1.2.3`, `docker … image@sha256:…`) or a remote URL. There is no clone and no bootstrap script.

## Installing

Click **Install** on a hub server (or run `agentx mcp install agentx-hub/<slug>`). If it needs values — an API key, a token — you type them there; they are written to `~/.agentx/.env`, never sent to the hub, and the server's configuration only names them (`${LINEAR_API_KEY}`).

Workmate then tells the hub it installed the server on this machine. From then on the hub keeps the install's desired state, like it does for skills: the web shows **Installed on &lt;your machine&gt;**, and a change on the hub reaches this machine through the hub sync (at most a minute; at once while the Hub tab keeps its live connection).

## The tools you get are the tools the hub approved

Each time the server connects, Workmate hashes every tool it announces — its name, description and schemas, the way the hub hashed the list it approved — and turns on **only** the tools whose hash matches. A tool the server added, or one whose description or schema changed since the approval, stays off: the card says **N tools blocked**.

That is how a changed server (a "rug pull": a tool description that later asks the model to read your SSH keys) is stopped on your machine before anybody looks at it. Workmate also reports the list it saw to the hub. A hub admin reads the new list, scans it and either **accepts** it — the version is signed again with it, and your machine unblocks those tools on its next sync — or keeps it blocked. For a server of your own (private), publish a new version with the new tools.

Your own tool filter (`tools.include` / `tools.exclude`) still applies on top.

## When the hub withdraws a server

If the version you run is yanked, the server is taken down by a hub admin, or a rescan finds it unsafe, the hub asks every machine that runs it to switch it off. Workmate sets `enabled: false` on it — the configuration and your values stay — and you are notified with the reason. When the hub restores it, or approves the version again, it is switched back on. When a fixed version is published, the catalog offers it as an update.

The hub never removes or overwrites anything by itself while it cannot be reached: an unreachable hub leaves every installed server as it is, and the catalog keeps showing the list it fetched last.

## Updates, edits and removal

- **Update to X** — a newer version is published. Nothing updates on its own; click it (or reinstall) when you want the new version.
- **Edited on this machine** — you changed the server's command, arguments, environment or URL. The hub sync never overwrites it; **Replace with the Hub version…** puts the hub's configuration back, after a confirmation.
- **Remove** — removes the server from this machine, with its OAuth tokens and cached tool list. The hub hears it on the next sync (removing it from `mcp.json` by hand is understood the same way).

A hub server always installs into the default profile, where the hub sync runs, and never replaces a server of another origin that already uses its name.

## Troubleshooting

| What you see | Why |
|---|---|
| "Sign in to AgentX Hub to see its MCP servers" | Nobody is signed in on this machine: open the Hub tab. |
| "The AgentX Hub could not be reached" | The list shown is the one fetched last; installed servers keep working. |
| A hub server is missing | It is not approved for you, Workmate cannot run it as it is (see the note under the hub section), or its signatures did not hold (`agentx mcp catalog` prints the reason). |
| "needs_secrets" in the Hub tab | The hub asked this machine to install a server whose values it does not hold: install it from the catalog and type them. |
| Tools blocked | The server announces tools that differ from the approved list; a hub admin decides. |
