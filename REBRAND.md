# Rebrand: Hermes Agent → AgentX Workmate

Handoff document. Phases 0–3 are done and committed; phases 4–11 are not
started. Everything needed to continue in a fresh session is here.

---

## 1. Where things stand

Branch `rebrand/agentx-workmate`, three commits on top of tag
`upstream-baseline` (`aec331899`):

| Commit | Phase | What landed |
|---|---|---|
| `5b53a2616` | 0 + 1 | Baseline test capture; `branding.py`/`.ts`/`.sh`; rebrand tooling |
| `74acc469d` | 2 | `AGENTX_*` env vars, `~/.agentx`, `.agentx.md`, Windows task/registry names |
| `24c7b25ed` | 3 | `agentx` CLI, 8-bit banner artwork, 23 toolsets, launchd label, glyph |

**Zero regressions** against the phase-0 baseline. Reproduce with §5.

The regression gate reports what is left:

```bash
python3 scripts/rebrand/check_branding.py --summary
```

At the end of phase 3: **24,106 violations**. That number is the remaining
work and phases 4–11 drive it to zero.

Distribution of the ~23,900 `hermes` tokens still in the tree:

| Area | Tokens | Phase |
|---|---:|---|
| `website/docs` + `website/i18n` + `website/src` | 13,808 | 9 |
| `apps/desktop` | 4,376 | 4 |
| `tests` | 1,913 | follows whichever phase owns the code |
| `plugins/kanban` (CSS classes) | 615 | 8 |
| `hermes_cli` | 591 | mostly module-name self-references — check before touching |
| `scripts` + `nix` + `docker` + `apps/bootstrap-installer` | 783 | 5 |
| `ui-tui` + `web` + `tools` + `agent` + `gateway` | 599 | leftovers, mostly prose |
| `skills` + `plugins/*` | ~300 | 8 |

---

## 2. Identity — already decided, do not re-litigate

| Thing | Value |
|---|---|
| Product name | `AgentX Workmate` |
| Short name | `AgentX` |
| Vendor | `AstralX Technology` |
| Support email | `kien.le@astralx.com.vn` |
| CLI command | `agentx` |
| Sub-commands | `agentx-gateway`, `agentx-acp` |
| Config dir | `~/.agentx` · `%LOCALAPPDATA%\agentx` |
| Env prefix | `AGENTX_` |
| App id | `com.agentx.workmate` |
| Protocol scheme | `agentx://` |
| Python dist | `agentx-workmate` |
| Brand glyph | `⬡` |
| Website / docs URL | **not registered yet** — `WEBSITE_URL`/`DOCS_URL` are `""` |

All of these live in `branding.py`, mirrored into
`apps/shared/src/branding.ts` and `scripts/lib/branding.sh`.
`tests/test_branding_consistency.py` fails if the three drift.

**Kept deliberately** (the user asked to keep source file/folder names):
Python module names (`hermes_cli`, `hermes_constants`, `hermes_state*`,
`hermes_logging`, `hermes_time`, `hermes_bootstrap`), directories on disk,
and internal snake_case identifiers (`get_hermes_home`, `hermes_home`).

---

## 3. The tooling

```bash
scripts/rebrand/apply.py --list                    # the rule table
scripts/rebrand/apply.py --dry-run --phase 4       # report, change nothing
scripts/rebrand/apply.py --apply --rule <id>       # one rule
scripts/rebrand/check_branding.py                  # the gate, with examples
```

Rules live in one table in `apply.py`. Each has an id, a phase, a scoped
pattern, and an explicit `exclude` list. `tests/test_rebrand_rules.py`
(80 tests) pins both edges: names that must survive, and names that must
move. **Add a case there for every new rule** — that file is excluded from
the sweep precisely because the old names are its fixtures.

`GLOBAL_EXCLUDE` holds `LICENSE` (MIT requires the original notice),
lockfiles, `.mailmap`, `scripts/rebrand/*`, `tests/test_rebrand_rules.py`,
and this file.

### Working rhythm that actually held up

1. `--dry-run` the phase, read the per-rule hit counts.
2. Apply.
3. Run the full Python suite and diff the failing-file list against
   `.rebrand-baseline/failing-tests.txt`.
4. Fix every new failure. **Each one is a real half-rename**, not a stale
   test — phases 2 and 3 produced 39 of them and every single one was a
   genuine break.
5. Re-run until the failing-file list matches baseline exactly.

---

## 4. Landmines — read this before writing any rule

Every regression in phases 2 and 3 had the same shape: **a guard added to
protect an internal identifier also blocked a legitimate spelling of the
brand, so one half of a pair moved and the other did not.** A half-rename
is worse than no rename — it silently breaks a lookup that used to work.

| Trap | What it broke | Lesson |
|---|---|---|
| `\b` as a boundary | `f'...\nHERMES_BIN='` — the char before `H` is the `n` of `\n`, so `\b` never matched. `install.sh` read `$AGENTX_BIN` while its test set `HERMES_BIN`; the generated launcher came out `exec "" "$@"` | Don't use `\b`. Use explicit character classes, and add `(?<=\\n)`/`(?<=\\t)` alternatives |
| Requiring a letter after a prefix | `/^HERMES_(?:BACKEND\|DASHBOARD)_READY/` — `(` follows the underscore. The desktop's port scraper desynced from Python; 15 remote-spawn tests timed out | Match the prefix unanchored |
| Lookbehind for word chars | `%2F.hermes%2F` in `/api/fs` URLs (the `F` reads as a word char); `ai.hermes.gateway` (the `i` of `ai.`) | Enumerate the real separators: `/ ~ " ' \` : = %2F` |
| Path rule eating kebab tokens | `.agentx-kanban-run-meta-block` vs `summary.hermes-kanban-run-meta-label` — **a CSS selector matching nothing**. 180 tokens split | Path rules must end in `(?![-.\w])` |
| Renaming part of a family | 2 of 23 `hermes-<platform>` toolsets moved; three `startswith("hermes-")` filters stopped recognising the pair, and blank-slate installs stripped `terminal`/`read_file`/`write_file` from the agent | Rename a whole family or none of it |
| Header case | `X-AgentX-Event` reaches the wire as `X-Agentx-Event` (urllib title-cases) and Node reads it lower-cased. The photon sidecar 401'd every request | Spell headers the way they are transmitted |
| Bare name as a variable | `hermes = hosts.get(...)` renamed, `hermes.get(...)` not → **live `NameError` in `plugins/memory/honcho/cli.py`** | Run the AST check in §5 |
| Two spellings of one name | `_looks_like_human_speaker('agentx agent', 'AgentX Workmate')` — lowercase and Title Case moved by different rules | Grep for both forms together |
| `git grep -E` | Does **not** support `\b`. An early "the tree is clean" check was simply wrong | Use `git grep -P` |

### Must never be renamed

* **Nous Hermes models** — `hermes-4`, `hermes-4-405b`, `hermes-3`,
  `NousResearch/Hermes-3-Llama-3.1-70B`, `Nous Hermes 3`. These are model
  slugs sent to provider APIs. `hermes_cli/model_switch.py` is excluded
  from `cli-command`; `display-name-short` carries
  `(?<!Nous )` and `(?![-\s]*\d)` guards.
* **`agent/coding_context.py`** — `"hermes"` sits in a list of model-family
  substrings next to `"claude"`, `"qwen"`, `"llama"`.
* **ACP `_meta` namespace** — `{"hermes": {...}}` is a wire format.
* **`hermes-tools`** — MCP server name in codex config.
* **`hermes_cli`, `hermes-ink`, `hermes-achievements`** — Python module and
  npm/plugin directory names.

---

## 5. Verification

Full pass takes ~15 min for Python plus ~2 min for JS.

```bash
scripts/run_tests.sh                              # 2618 files, ~15 min
npm run build:ink --prefix ui-tui                 # required once before JS
npm test --prefix ui-tui
npm run test:ui --prefix apps/desktop
npm run test:desktop:platforms --prefix apps/desktop
npm test --prefix web
npm test --prefix tests-js
for w in apps/shared web ui-tui; do npm run typecheck --prefix $w; done
```

Compare, don't count:

```bash
grep -oE "✗ tests/[^ ]+\.py" run.log | sed 's/^✗ //' | sort -u > now.txt
comm -13 .rebrand-baseline/failing-tests.txt now.txt   # must be empty
```

Baseline is 25,542 passed / 69 failed across 29 environment-dependent files
(missing media deps, network, Linux-only services). See
`.rebrand-baseline/README.md`, which also names two timing-flaky JS tests.

**The AST check** — a `NameError` is invisible to `py_compile`, so after
every phase that touches Python:

```bash
python3 - <<'PY'
import ast, subprocess, pathlib
files = [p for p in subprocess.run(["git","ls-files","-z","*.py"],
         capture_output=True,text=True,check=True).stdout.split("\0") if p]
for rel in files:
    try: tree = ast.parse(pathlib.Path(rel).read_text(encoding="utf-8"))
    except Exception: continue
    bound, loaded = set(), []
    for n in ast.walk(tree):
        if isinstance(n, ast.Name):
            (bound.add(n.id) if isinstance(n.ctx,(ast.Store,ast.Del))
             else loaded.append((n.id, n.lineno)))
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names: bound.add((a.asname or a.name).split(".")[0])
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            bound.add(n.name)
            for a in n.args.args + n.args.kwonlyargs + n.args.posonlyargs:
                bound.add(a.arg)
    for name, line in loaded:
        if name in {"hermes","agentx"} and name not in bound:
            print(f"{rel}:{line}: unbound {name!r}")
PY
```

**The half-rename check** — find tokens that exist in both spellings:

```bash
python3 - <<'PY'
import re, subprocess, pathlib
files = [p for p in subprocess.run(["git","ls-files","-z"],
         capture_output=True,text=True,check=True).stdout.split("\0") if p]
A, H = set(), set()
for rel in files:
    if rel.startswith(("scripts/rebrand/","tests/test_rebrand_rules")): continue
    p = pathlib.Path(rel)
    if not p.is_file() or p.is_symlink(): continue
    try:
        d = p.read_bytes()
        if b"\0" in d: continue
        t = d.decode("utf-8")
    except Exception: continue
    A.update(re.findall(r'agentx[-_]([a-z0-9][a-z0-9-]*)', t))
    H.update(re.findall(r'hermes[-_]([a-z0-9][a-z0-9-]*)', t))
print("half-renamed:", sorted(A & H))
PY
```

---

## 6. Phase 4 — Desktop app (Electron)

**Scope** `apps/desktop/` — 4,376 tokens. Currently untouched: phase 3
excluded it wholesale so the app keeps working while the CLI moved.

### Packaging identity — `apps/desktop/package.json`

| Line | Key | Now | Target |
|---|---|---|---|
| 2 | `name` | `hermes` | `agentx-workmate` |
| 3, 166 | `productName` | `Hermes` | `AgentX Workmate` |
| 165 | `appId` | `com.nousresearch.hermes` | `com.agentx.workmate` |
| 167 | `executableName` | `Hermes` | `AgentX Workmate` |
| 170 | protocol `name` | `Hermes Protocol` | `AgentX Workmate Protocol` |
| — | protocol `schemes` | `["hermes"]` | `["agentx"]` |
| 176 | `artifactName` | `Hermes-${version}-…` | `AgentXWorkmate-${version}-…` |
| 212–214 | `CFBundleDisplayName/Executable/Name` | `Hermes` | `AgentX Workmate` |
| — | `NS*UsageDescription` ×3 | "Hermes uses the microphone…" | rewrite |
| 227 | dmg `title` | `Install Hermes` | `Install AgentX Workmate` |
| 249 | `legalTrademarks` | `Hermes` | `AgentX Workmate` |
| 258 | linux `maintainer` | `Nous Research <support@nousresearch.com>` | `AstralX Technology <kien.le@astralx.com.vn>` |
| 259 | linux `synopsis` | "…for Hermes Agent." | rewrite |
| 270–271 | nsis `shortcutName`, `uninstallDisplayName` | `Hermes` | `AgentX Workmate` |

`executableName` and `CFBundleExecutable` feed
`scripts/patch-electron-builder-mac-binary.mjs` and
`scripts/after-pack.mjs` (`${productName}.exe`) — change them together.
`scripts/test-desktop.mjs:148` hard-codes the NSIS `artifactName` template.

### Icons — you must supply or generate these

`apps/desktop/assets/icon.icns`, `icon.ico`, `icon.png`, plus
`apps/desktop/public/` and `assets/banner.png` at the repo root.
The 8-bit style is already established by the CLI banner: the 5×5 pixel
font and the 26×14 robot sprite in `hermes_cli/banner.py`
(`WORKMATE_LOGO`, `WORKMATE_MASCOT`) on the cyan→violet ramp
`#7DF9FF → #38BDF8 → #4F7BF7 → #6366F1 → #8B5CF6`. Render the mascot at
1024×1024 and downscale.

### Code surfaces

* `electron/main.ts` — 240 occurrences, the largest single file.
* `electron/preload.ts:3` — `contextBridge.exposeInMainWorld('hermesDesktop', …)`.
  Visible in DevTools. Renaming it touches ~360 call sites across
  `src/**` plus the `window.hermesDesktop` type declarations in
  `src/global.d.ts`. **Rename all of them in one commit** or not at all.
* **121 distinct IPC channels** named `hermes:*` (`hermes:api`,
  `hermes:boot-progress`, `hermes:bootstrap:cancel`, …). Same rule: whole
  family or none. The `:` in the name is why phase 3's `cli-command`
  skipped them.
* `src/lib/external-link.tsx:23` — `SKIP_PROTO_RE` lists `hermes` as a
  protocol; must match the new `agentx://` scheme.
* `src/lib/voice-stop-word.ts` — the wake phrase `'hermes stop'`.
* `src/components/chat/intro.tsx:147` — `const WORDMARK = 'HERMES AGENT'`.
* `src/components/chat/intro-copy.jsonl` — marketing copy naming Hermes.
* `src/i18n/{en,zh,zh-hant,ja,ar}.ts` — ~560 strings.
* `electron/desktop-uninstall.ts:98` — matches `/[\\/]hermes-desktop$/i`;
  its `%LOCALAPPDATA%\hermes-desktop` install dir must move with it.
* `hermes_cli/gui_uninstall.py` — **already wired**: it reads
  `branding.DESKTOP_APP_NAME` for the Electron `userData` directory. Phase 3
  had moved this side while `productName` still said `Hermes`, so the
  uninstaller was looking in a directory the app never wrote to. Setting
  `productName` to `AgentX Workmate` closes the loop — keep the two equal.
* `apps/desktop/e2e/` — Playwright specs and visual snapshots will need
  regenerating after the window title changes.

**Verify**: `npm run test:ui` (392 files) and `test:desktop:platforms`
(79 files) must stay green, plus `npm run typecheck --prefix apps/desktop`.
Then build a real DMG on macOS and check the name in Finder, the Dock,
the menu bar, and About:

```bash
npm run dist:mac:dmg --prefix apps/desktop
```

---

## 7. Phase 5 — Installers, packaging, containers

**Scope** `apps/bootstrap-installer/` (233), `scripts/install*` (267),
`nix/` (214), `docker/` + `Dockerfile` (69), `pyproject.toml`, the
`package.json` name fields.

* **Python dist** — `pyproject.toml:4` `name = "hermes-agent"` →
  `agentx-workmate`. Entry point `hermes-agent = "run_agent:main"`
  (line 360) → `agentx-agent`. **Deliberately deferred from phase 3**:
  `hermes-agent` is simultaneously the dist name, the console script, the
  Docker image, the nix module option, the install directory and the
  upstream repo slug. Move all of them in one commit.
* **npm names** — `package.json` `hermes-agent`, `apps/shared` `@hermes/shared`,
  `ui-tui` `hermes-tui`, `ui-tui/packages/hermes-ink` `@hermes/ink`,
  `apps/desktop` `hermes`. The `@hermes/*` specifiers appear in
  `file:` workspace deps and in imports; the *directory*
  `ui-tui/packages/hermes-ink` stays (folder name).
* **Install root** — `$AGENTX_HOME/hermes-agent`, `/usr/local/lib/hermes-agent`,
  `~/.agentx/hermes-agent/venv`. A user browsing `~/.agentx/` currently
  sees a folder called `hermes-agent`; that is runtime output, not source,
  so rename it.
* **Docker** — `/opt/hermes` (46 sites) and the unix user/group
  `hermes:hermes` (12 sites, `chown -R hermes:hermes`). Renaming the user
  means the Dockerfile `useradd`, every `chown`, and
  `hermes_cli/config.py:675` `exec_user` must move together;
  `tests/docker/` and `tests/tools/test_dockerfile_immutable_install.py`
  assert on them.
* **Nix** — `services.hermes-agent` module option (8 sites) plus
  `nix/nixosModules.nix`. A heredoc delimiter there was desynced once
  already; grep for `_DOC_EOF` pairs after any sweep.
* **Update markers** — `.hermes-update-old`, `.hermes-update-new`,
  `.hermes-update-staging`, `.hermes-bootstrap-complete`, `.hermes-runtime`,
  `.hermes-tmp`, `.hermes-sandbox`. These are created in the user's install
  tree. Phase 2 deliberately reverted a partial rename of these; move each
  family completely, including
  `apps/bootstrap-installer/src-tauri/src/update.rs` and
  `apps/desktop/electron/main.ts:3553`.
* **Bootstrap installer** — Tauri app titled "Hermes Setup";
  `src/routes/welcome.tsx:34` renders the `HERMES AGENT` wordmark, and
  `src-tauri/tauri.conf.json` carries its own bundle identity.
* **Install URLs** — `install.sh` / `install.ps1` are served from
  `hermes-agent.nousresearch.com`. Blocked on a domain (§11).

**Verify**: `tests/docker/`, `tests/test_install_sh_symlink_stomp.py`,
`tests/hermes_cli/test_verify_console_scripts.py`,
`tests/test_hermes_bootstrap.py`, and a real
`pip install -e .` round-trip confirming `agentx` lands on PATH.

---

## 8. Phase 6 — Gateway, bots, outbound identity

**Scope** `plugins/platforms/` (61), `gateway/` (64).

* **HTTP User-Agent** — every outbound request currently identifies as
  Hermes: `hermes-cli/{version}` (`hermes_cli/auth.py:108`),
  `hermes-agent/{version}` (`agent/gemini_native_adapter.py:967`),
  `hermes-agent-petdex` (`agent/pet/`), `hermes-agent` (iron_proxy,
  bitwarden), `hermes-agent-osv-check/1.0`, and two osint-skill strings.
  These leak to every server the product talks to.
* **Bot display names** — `hermes_cli/slack_cli.py:186` and
  `hermes_cli/subcommands/slack.py:47` default to `"Hermes"`.
* **API response fields** — `gateway/platforms/api_server.py:2951`
  `"owned_by": "hermes"` in the OpenAI-compatible model list, and the
  `X-Agentx-Session-Id` / `X-Agentx-Session-Key` request headers
  (already renamed; note the lowercase `x` — see §4).
* `agent/transports/codex_app_server.py:162` — `client_name="hermes"`
  sent to the codex app server.

**Verify**: `tests/gateway/`, `tests/plugins/platforms/`.

---

## 9. Phase 7 — Logs and diagnostics

**Scope** `hermes_logging.py` (33 tokens), log formatting, debug bundles.

Log *paths* already moved with phase 2 (`~/.agentx/logs/`). What remains is
the formatter prefix, crash-report headers, and the `agentx debug share`
bundle metadata. Small phase; can be folded into 6 or 8.

---

## 10. Phase 8 — Prompts, skills, agent-visible content

This is the phase that decides whether a user can tell what the product was
built from.

* **Vendor in the system prompt** — phase 3 renamed the *name*, not the
  *vendor*. Three files still say **"created by Nous Research"**:
  `agent/prompt_builder.py:145`, `hermes_cli/default_soul.py:4`,
  `docker/SOUL.md:1`. Ask the agent "who made you?" today and it answers
  Nous Research. Fix these with phase 10's vendor sweep or earlier.
* **Skill frontmatter namespace** — `metadata: hermes:` in 168 SKILL.md
  files, read by `agent/skill_utils.py`, `agent/learning_graph.py`,
  `tools/blueprints.py`, `tools/skills_tool.py`. Phase 3 deliberately kept
  it (renaming orphans every skill file on disk, and it is the vendor key
  in the agentskills.io extension point). **Decision needed**: rename to
  `agentx:` for a clean break, or keep for third-party skill compatibility.
  If renaming, move all 168 files and all four readers in one commit.
* **Kanban CSS classes** — 615 `hermes-kanban-*` tokens across
  `plugins/kanban/dashboard/`. Whole family or none (§4).
* **`hermes-index`** — the skills-hub source id in `hermes_cli/skills_hub.py`.
* **`plugins/hermes-achievements/`** — plugin directory name plus a canvas
  string that renders `HERMES AGENT · hermes-agent.nousresearch.com`.
* `skills/creative/ascii-art/SKILL.md` and
  `optional-skills/security/web-pentest/` embed `HERMES` in example output
  and XSS canary markers.
* `optional-skills/migration/openclaw-migration/` maps another product's
  names onto Hermes; retarget it.

---

## 11. Phase 9 — Docs and website

**Scope** 13,808 tokens — the single largest phase.

`website/docs` (7,059), `website/i18n` (6,169, mostly `zh-Hans`),
`website/src` (580), `website/scripts` (40, partly done in phase 3),
plus `README.md` / `README.es.md` / `README.zh-CN.md` / `README.ur-pk.md`,
`CONTRIBUTING*.md`, `SECURITY*.md`, `AGENTS.md`, `docs/`, and
`assets/banner.png`.

Two `website/` files were already rebranded in phase 3 because tests assert
they mirror production: `website/docs/user-guide/windows-native.md` and
`website/docs/reference/skills-catalog.md` (regenerate the latter with
`python3 website/scripts/generate-skill-docs.py`).

Mostly mechanical — the phase-3 rules apply cleanly once `website/` is
removed from their `exclude` lists. Watch for: `docusaurus.config.ts`
(site title, favicon, og:image), `website/static/img/favicon.svg` (contains
`⚕`), and the 13 remaining caduceus glyphs, all of which are in `website/`.

Blocked on a domain for any URL rewriting (§13).

---

## 12. Phase 10 — Attribution cleanup

**Scope** 1,763 `Nous Research` + 670 `nousresearch.com` occurrences.

* **Keep `LICENSE` verbatim.** MIT requires the original copyright notice
  to survive redistribution. Add a second copyright line for AstralX
  Technology; do not remove Nous Research's.
* Replace vendor strings with `AstralX Technology` and
  `kien.le@astralx.com.vn` — including the three system-prompt files in §10.
* **Update-check machinery** — `hermes_cli/banner.py:128–129`
  `_UPSTREAM_REPO_URL` / `_OFFICIAL_REPO_CANONICAL` and line ~440
  `_RELEASE_URL_BASE` still point at `NousResearch/hermes-agent`. The
  startup banner today prints `· upstream aec33189`, i.e. it phones the
  upstream repo. Point these at your fork or disable the check.
* Remove `discord.gg/NousResearch` links, `support@nousresearch.com`,
  README badges, `.github/` issue templates, `contributors/`, `.mailmap`.
* `nix/` and `Dockerfile` reference `nousresearch/hermes-agent:latest`
  container images.

---

## 13. Phase 11 — Gate and final verification

1. Wire `scripts/rebrand/check_branding.py` into CI (`.github/workflows/lint.yml`)
   so any commit reintroducing the brand fails. It must report **0** first.
2. Full Python + all five JS suites, compared against
   `.rebrand-baseline/failing-tests.txt`.
3. Desktop e2e (`npm run test:e2e --prefix apps/desktop`) with regenerated
   visual snapshots.
4. Install e2e (`.github/workflows/install-e2e.yml`).
5. **Build real artifacts and look at them**: DMG on macOS, NSIS on Windows.
   Check the app name in Finder, Dock, menu bar, About dialog, Task
   Scheduler, `systemctl list-units`, and Add/Remove Programs.
6. Manual smoke: `agentx --help`, `agentx model`, the TUI banner, a gateway
   start, and — the real test — ask the agent **"who are you and who made
   you?"**
7. Consider deleting `scripts/rebrand/` and this file once the gate is
   green, keeping only `check_branding.py` and `branding.py`.

---

## 14. Still needed from the user

| # | Item | Blocks |
|---|---|---|
| 1 | Domain to replace `hermes-agent.nousresearch.com` | Phase 5 install URLs, phase 9 docs links, `WEBSITE_URL`/`DOCS_URL` in `branding.py` |
| 2 | Decision: rename skill-frontmatter `metadata: hermes:` → `agentx:`? | Phase 8 — trade-off is a clean break vs. compatibility with agentskills.io skills written for Hermes |
| 3 | Decision: rename the 121 `hermes:*` Electron IPC channels and `window.hermesDesktop`? | Phase 4 — only visible in DevTools; renaming touches ~500 sites |
| 4 | Decision: rename the Docker unix user `hermes` → `agentx`? | Phase 5 — visible in `docker exec`/`ps` inside the container |
| 5 | Icon and banner artwork, or approval to generate them from the CLI mascot | Phase 4 packaging, phase 9 README |

### One-time migration for the developer machine

The app now reads `~/.agentx`. Not run automatically — the file holds real
API keys:

```bash
mv ~/.hermes ~/.agentx && sed -i '' 's/^HERMES_/AGENTX_/' ~/.agentx/.env
```

No migration code ships in the product: every AgentX Workmate install is
new, so nobody but this machine has a `~/.hermes` to migrate.
