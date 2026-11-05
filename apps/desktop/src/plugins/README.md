# Bundled plugins

Drop a `<name>/plugin.{ts,tsx}` here that default-exports a `HermesPlugin` and
it registers automatically at boot (vite glob in `../contrib/plugins.ts`), with
the same inventory + live enable/disable contract as runtime plugins.

Shipped today:

- `agentx-bots` — **Bot Mode** ("Trợ lý" in the sidebar, ON by default): named
  assistants, each an AgentX profile with its own picture, memory, skills,
  scheduled tasks, ONE ongoing "Bot Chat", and group rooms. The teammate
  messaging protocol is taught by the backend inside each "Bot Chat"
  (`tools/bot_mode_protocol.py`); the plugin never edits SOUL.md.
- `kanban` — the `/kanban` board (OFF by default).

Reference/demo plugins (the counter example, the gateway-pill 1:1 rebuild, the
runtime-loader hello world) also live here for the SDK's own tests.

User- and agent-authored plugins load at runtime from
`$AGENTX_HOME/desktop-plugins/<name>/plugin.js` (the disk door) — see the
`agentx-desktop-plugins` skill.
