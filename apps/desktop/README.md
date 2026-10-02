# AgentX Workmate Desktop ⬡

<p align="center">
  <a href="https://agentx-landingpage.astralx.com.vn/#tai-ve"><img src="https://img.shields.io/badge/Download-macOS%20%C2%B7%20Windows-FFD700?style=for-the-badge" alt="Download"></a>
  <a href="https://github.com/TrungKiencding/AgentX-Workmate/tree/main/website/docs"><img src="https://img.shields.io/badge/Docs-GitHub-FFD700?style=for-the-badge" alt="Documentation"></a>
  <a href="https://github.com/TrungKiencding/AgentX-Workmate/discussions"><img src="https://img.shields.io/badge/Discussions-24292F?style=for-the-badge&logo=github&logoColor=white" alt="Discussions"></a>
  <a href="https://github.com/TrungKiencding/AgentX-Workmate/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License: MIT"></a>
</p>

**The native desktop app for [AgentX Workmate](../../README.md) — the self-improving AI agent from AstralX Technology.** Same agent, same skills, same memory as the CLI and gateway, in a polished native window — chat with streaming tool output, side-by-side previews, a file browser, voice, and settings, no terminal required. Available for **macOS, Windows, and Linux**.

<table>
<tr><td><b>Chat with the full agent</b></td><td>Streaming responses, live tool activity, structured tool summaries, and the same conversation history as every other AgentX surface.</td></tr>
<tr><td><b>Side-by-side previews</b></td><td>Render web pages, files, and tool outputs in a right-hand pane while you keep chatting.</td></tr>
<tr><td><b>File browser</b></td><td>Explore and preview the working directory without leaving the app.</td></tr>
<tr><td><b>Voice</b></td><td>Talk to AgentX and hear it back.</td></tr>
<tr><td><b>Settings & onboarding</b></td><td>Manage providers, models, tools, and credentials from a real UI. First-run setup gets you to your first message in seconds.</td></tr>
<tr><td><b>Stays current</b></td><td>The app finds each new release, downloads the installer in the background, and swaps itself — and the agent behind it — for the new version on a restart.</td></tr>
</table>

---

## Install

### Install with AgentX (recommended)

Already have the AgentX CLI? Just run:

```bash
agentx desktop
```

It builds and launches the GUI against your existing install — same config, keys, sessions, and skills. If Desktop cannot find a usable runtime or saved remote connection, a packaged build installs AgentX locally on first launch (a source-tree run still offers to connect to an existing AgentX gateway instead). Sign in with your AgentX account and the model key is provisioned for you; an existing gateway can be connected any time from Settings → Gateway.

### Prebuilt installers

Prebuilt installers for macOS (Apple silicon) and Windows are on [the AgentX Workmate download page](https://agentx-landingpage.astralx.com.vn/#tai-ve).

---

## Updating

An installed app updates itself, the app and the agent together:

1. It checks the release feed on the download site a little after launch and every few hours, and says when a new version is out (**Settings → About** shows the same, and **Check now** asks right away).
2. **Download update** fetches the installer for this computer in the background. It is used only if its size and sha256 match the signed feed.
3. **Restart to update** closes the app and installs the new version — on macOS by swapping the app bundle, on Windows by running the NSIS installer silently — then opens it again. If the agent is mid-turn, the app asks first.
4. On that first launch the new version brings the agent (`AGENTX_HOME/agentx-agent`) up to the commit it was built from, then the app confirms the update. If something did not take, it says so and offers the download page or a restart.

A copy that cannot replace itself — run straight from Downloads or the disk image, in a folder the account cannot write, or not set up by the installer — points at the download page instead.

`agentx update` remains for CLI installs. It moves only the agent, so an installed app should be updated from the app.

---

## Requirements

The installer handles everything for you (Python 3.11+, a portable Git, ripgrep).

---

## Development

Want to hack on the app itself? Install workspace deps from the repo root once, then run the dev server from this directory:

```bash
npm install          # from repo root — links apps/desktop, web, apps/shared
cd apps/desktop
npm run dev          # Vite renderer + Electron, which boots the Python backend
```

Point the app at a specific source checkout, or sandbox it away from your real config:

```bash
npm run dev:fresh       # every launch like the first: wipes a sandbox AGENTX_HOME + userData, history sync off (-- --sync)
# Linux only: run the command in a network-isolated bubblewrap sandbox (see dev-sandbox.sh --help)
../scripts/dev-sandbox.sh npm run dev
AGENTX_DESKTOP_AGENTX_ROOT=/path/to/clone npm run dev
AGENTX_HOME=/tmp/throwaway npm run dev
npm run dev:fake-boot   # exercise the startup overlay with deterministic delays
```

### Building installers

```bash
npm run dist:mac     # DMG + zip
npm run dist:win     # NSIS + MSI
npm run dist:linux   # AppImage + deb + rpm
npm run pack         # unpacked app under release/ (no installer)
```

macOS/Windows signing & notarization happen automatically when the relevant credentials are present in the environment (`CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_*` for macOS, `WIN_CSC_*` for Windows). Without a Developer ID, the macOS app is signed ad-hoc with an identifier-pinned requirement (`scripts/sign-mac-adhoc.mjs`), so macOS keeps its permissions and keychain access across updates.

### Publishing a release

Installed apps update from `release.json`, a feed signed with the Workmate release key, served beside the installers on the download site (`https://agentx-landingpage.astralx.com.vn/install/`). To publish:

1. Bump the version (`hermes_cli/__init__.py`, then `python scripts/release.py --sync-versions`), merge to `main`, and push — each installer pins the commit it was built from, and the agent is fetched from GitHub at that commit.
2. Write `release-notes/<version>.md`: a `## vi` and a `## en` heading, each followed by `- ` bullet points.
3. Build both installers from that clean commit (`npm run build`, then `npm run builder -- --mac dmg` and `npm run builder -- --win nsis --x64`, both with `'-c.artifactName=AgentXWorkmate-${os}-${arch}.${ext}'`).
4. `npm run release:feed -- build --out <download site folder>` (for the landing page: `AgentX-Landing/public/install`). It refuses unless the versions, the build stamp, the installers and the notes all agree, then copies the installers and writes the signed feed. `npm run release:feed -- verify <folder>` re-checks a folder.
5. Deploy that folder (`AgentX-Landing/deploy/deploy.sh`).

The release key lives at `~/.config/agentx-workmate/release-signing-key.pem` (or `AGENTX_WORKMATE_RELEASE_KEY`). Keep a backup: the app only trusts the public half compiled into it (`electron/app-update/feed.ts`), so a lost key means shipping a new public key with a manual install. `npm run release:feed -- keygen` creates one and never overwrites an existing key.

### How it works

The packaged app ships the Electron shell and a native React chat surface. On
first launch it can install the AgentX Workmate runtime into `AGENTX_HOME`
(`~/.agentx`, or `%LOCALAPPDATA%\agentx` on Windows), using the same layout as a
CLI install.

The app has three boundaries:

- **Electron** resolves and validates a runnable backend, owns native
  filesystem/git/window capabilities, and exposes a narrow preload bridge.
- **React** owns the Desktop routes, panes, interaction state, and
  `@assistant-ui/react` transcript.
- **AgentX Workmate** runs as a headless `agentx serve` process and exposes the
  `tui_gateway` JSON-RPC/WebSocket API. The renderer connects through
  [`apps/shared`](../shared/), which is also used by the browser dashboard.

Backend resolution is an ordered ladder:

1. `AGENTX_DESKTOP_AGENTX_ROOT`
2. the current source checkout during development
3. a completed managed install
4. `AGENTX_DESKTOP_AGENTX`, or `agentx` on `PATH`
5. a system Python that can import the AgentX runtime
6. the first-launch bootstrap installer

Candidates are probed before use; an existing shim or interpreter is not enough.
A runtime that predates `serve` falls back to headless
`dashboard --no-open`. This is compatibility for the backend command only and
does not launch or embed the dashboard UI.

The Electron orchestration entry point is `electron/main.ts`; pure resolution,
probe, hardening, and platform policies live in focused modules beside it. The
renderer is under `src/`, with shared atoms in `src/store` and transport/native
adapters in `src/lib`.

Before changing the app, read:

- [`AGENTS.md`](./AGENTS.md): architecture, state ownership, resolver/fallback,
  transport, performance, and testing rules.
- [`DESIGN.md`](./DESIGN.md): visual system, information architecture, motion,
  direct manipulation, and keyboard behavior.

### Connections, projects, and switching

Desktop supports a managed local backend, explicit remote gateways, and AgentX
Cloud connections. Remote and cloud modes use the same remote-capability path;
authentication and discovery differ, not the renderer feature model.

When no usable local runtime or saved remote connection exists, a packaged
build starts the local installer straight away; only a source-tree run
(`npm run dev`, sandboxes) pauses on a **Connect to existing AgentX** choice
first. Either way, Settings → Gateway is where an existing gateway is
connected: Desktop probes it to discover token or OAuth authentication,
requires a successful HTTP and WebSocket connection test, and saves the
connection using the same encrypted Desktop configuration. A saved remote
connection is used on later launches. The regular Desktop build still includes
the local-install option; remote is an operating mode, not a separate
client-only application.

In remote mode the gateway host is the execution boundary: agent tools,
terminal commands, and file operations run against the remote AgentX host, not
the computer displaying the Desktop UI.

Projects are the workspace abstraction. A project may own multiple folders,
repositories, worktrees, and sessions; a bare new chat remains detached unless
the user enters a project or configures a default project directory. Use the
Projects UI rather than adding a second per-session folder-picker workflow.

Changing profiles or connection modes is a soft workspace switch, not another
cold boot. The shell and current management overlay remain mounted while
gateway-bound nanostores are wiped, query-backed data is invalidated, and the
new connection repopulates skeletons. This prevents rows or transcripts from
the previous gateway bleeding into the next one.

### Verification

Run before opening a PR (lint may surface pre-existing warnings but must exit cleanly):

```bash
npm run fix
npm run typecheck
npm run lint
npm run test:ui
npm run test:desktop:platforms
```

Run `npm run test:desktop:all` for install, boot, update, packaging, or other
release-path changes.

### Troubleshooting

Boot logs land in `AGENTX_HOME/logs/desktop.log` (includes backend output and recent Python tracebacks) — check it first if the app reports a boot failure.

**macOS / Linux:**

```bash
# Force a clean first-launch setup
rm "$HOME/.agentx/agentx-agent/.agentx-bootstrap-complete"
# Rebuild a broken Python venv
rm -rf "$HOME/.agentx/agentx-agent/venv"
# Reset a stuck macOS microphone prompt (macOS only)
tccutil reset Microphone com.agentx.workmate
```

**Windows (PowerShell):**

```powershell
# Force a clean first-launch setup
Remove-Item "$env:LOCALAPPDATA\agentx\agentx-agent\.agentx-bootstrap-complete"
# Rebuild a broken Python venv
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\agentx\agentx-agent\venv"
```

> The default AgentX home on Windows is `%LOCALAPPDATA%\agentx`. Set the `AGENTX_HOME` env var if you've relocated it.

---

## Community

- 💬 [Discussions](https://github.com/TrungKiencding/AgentX-Workmate/discussions)
- 📖 [Documentation](https://github.com/TrungKiencding/AgentX-Workmate/tree/main/website/docs)
- 🐛 [Issues](https://github.com/TrungKiencding/AgentX-Workmate/issues)

---

## License

MIT — see [LICENSE](../../LICENSE).

Built by AstralX Technology.
