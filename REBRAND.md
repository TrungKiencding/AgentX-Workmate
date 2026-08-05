# Rebrand: Hermes Agent → AgentX Workmate

Handoff document. Phases 0–7 are done and committed; phases 8–11 are not
started. Everything needed to continue in a fresh session is here.

---

## 1. Where things stand

Branch `rebrand/agentx-workmate`, on top of tag `upstream-baseline`
(`aec331899`):

| Commit | Phase | What landed |
|---|---|---|
| `5b53a2616` | 0 + 1 | Baseline test capture; `branding.py`/`.ts`/`.sh`; rebrand tooling |
| `74acc469d` | 2 | `AGENTX_*` env vars, `~/.agentx`, `.agentx.md`, Windows task/registry names |
| `24c7b25ed` | 3 | `agentx` CLI, 8-bit banner artwork, 23 toolsets, launchd label, glyph |
| *(this one)* | 4–7 | Desktop app + icons, packaging/containers, outbound identity, diagnostics |

**Zero regressions** against the phase-0 baseline. Reproduce with §5.

The regression gate reports what is left:

```bash
python3 scripts/rebrand/check_branding.py --summary
```

End of phase 3: 24,106 violations. End of phase 7: **19,720**. Phases 8–11
drive the rest to zero.

Distribution of the `hermes` tokens still in the tree:

| Area | Tokens | Phase |
|---|---:|---|
| `website/docs` + `website/i18n` + `website/src` | 13,764 | 9 |
| `apps/desktop` | 1,338 | **kept on purpose** — see below |
| `plugins/kanban` (CSS classes) | 615 | 8 |
| `hermes_cli` | 407 | mostly module-name self-references — check before touching |
| `tests` | ~1,360 | follows whichever phase owns the code |
| `tools` + `agent` + `gateway` + `ui-tui` + `web` | ~450 | leftovers, mostly prose |
| `scripts` + `nix` | 213 | prose + internal nix identifiers |
| `skills` + `plugins/*` | ~200 | 8 |

The 1,338 left in `apps/desktop` are not work: they are the internal
identifiers §2 keeps (`hermesHome`, `HermesGateway`, `HermesConfigRecord`),
the source file names imports resolve through (`@/hermes`,
`@/types/hermes`, `use-hermes-config`), Nous's model slugs, upstream repo
URLs, and example hosts in test fixtures (`https://gw.example.com/hermes`).
Phase 11 has to decide whether the gate grows an allowlist for those or
whether `check_branding.py`'s `BRAND_RE` learns about camelCase — as written
it can never reach zero, because `hermes-4` and `hermes-parser` must survive.

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
pattern, and an explicit `include`/`exclude` list — `rewrite()` in the test
file honours that scope, because several rules only run under `apps/`. `tests/test_rebrand_rules.py`
(226 tests) pins both edges: names that must survive, and names that must
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
| Regex literal opening delimiter | `([\\/]+)Hermes` read the `/` of `/Hermes is not installed/` as a path separator and produced `/AgentX Workmate is not installed/`, which stopped matching the message the code throws | Add `(?! [a-z])` — a path segment is never followed by a space and a lowercase word |
| Escaped separator inside a regex literal | `(?<=/)opt/hermes` never saw `\/opt\/hermes` in `assert.match(script, /rm -rf '\/opt\/hermes\/…'/)`, so the fixture data moved and the expectation reading it did not | Spell the separator `(\\?/)`, the same doubling trap as `AppData\\Local` |
| Relative import vs. relative launcher | `./hermes` is the launcher in a shell script and `src/hermes.ts` in the desktop. One rule covering both rewrote six `from './hermes'` specifiers into modules that do not exist | Split the rule and scope the relative form away from `apps/` |
| Bare name as a variable, in TypeScript too | `const hermes = await import('@/hermes')` renamed, `hermes.getHermesConfig` not — the §4 Python trap, in another language | `tsc --noEmit` catches it as TS2304; run every workspace's typecheck, not just the tests |
| A third party sharing the name | `hermes-parser` and `hermes-estree` are Meta's JS-engine packages and reach the tree as ordinary npm deps; a kebab sweep would rename them and break `npm ci` | Guard by name, even when no in-scope file references them yet |
| Import order is brand-sensitive | `@hermes/shared` → `@agentx/shared` and `HERMES_PATHS_MIME` → `AGENTX_PATHS_MIME` change where a symbol sorts, so eslint's `perfectionist/sort-imports` starts failing | Run `npm run lint` after a sweep; `lint:fix` resolves it mechanically |

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
* **`hermes-parser`, `hermes-estree`** — Meta's JavaScript-engine packages,
  ordinary npm dependencies. `app-kebab` guards them by name.
* **`hermes-0day`** — the name of a security campaign, not a product.
* **`@/hermes`, `@/types/hermes`, `use-hermes-config`, `windows-hermes-path`**
  — source FILE names in `apps/desktop`. Renaming a specifier without the
  file is an unresolved import; every kebab guard refuses a preceding hyphen
  for exactly this reason.

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

## 6. Phases 4–7 — done

All four landed in one commit, because the families cross their boundaries:
the desktop's update chain names the bootstrap installer (5), the installer
writes the marker files the Electron main process reads (5), and the
dashboard route the desktop calls is declared in `hermes_cli/web_server.py`.

### Phase 4 — Desktop app

* **Packaging identity** — `apps/desktop/package.json`: `productName`,
  `executableName`, `CFBundle*` and the NSIS/dmg names are all
  `AgentX Workmate`; `appId` `com.agentx.workmate`; protocol scheme
  `agentx://`; `artifactName` `AgentXWorkmate-…`; maintainer/author
  `AstralX Technology <kien.le@astralx.com.vn>`; the three
  `NS*UsageDescription` strings rewritten.
* **The full product name, not the short one.** electron-builder derives the
  bundle and binary from `productName`/`executableName`, Electron derives
  `userData` from `productName`, and `hermes_cli/gui_uninstall.py` derives the
  same directory from `branding.DESKTOP_APP_NAME`. All three now read
  `AgentX Workmate`, and `tests/test_branding_consistency.py` plus a live
  `npm run pack` confirm it.
* **IPC + bridge** — all 121 `hermes:*` channels → `agentx:*`, and
  `window.hermesDesktop` → `window.agentxDesktop` across ~560 call sites and
  the `global.d.ts` declarations. One commit, per the §4 whole-family rule.
* **Storage namespaces** — `hermes.desktop.*` (localStorage), the plugin
  SDK's `hermes.plugin.<id>.*`, the `hermes-boot-*` cold-start theme keys
  (shared with `ui-tui/src/lib/themeBoot.ts`), and the `data-hermes-*` /
  `dataset.hermes*` attribute pair.
* **Icons** — regenerated from the CLI's own artwork by
  `scripts/make_brand_assets.py`, which parses `WORKMATE_MASCOT` and
  `WORKMATE_LOGO` out of `hermes_cli/banner.py` so the terminal banner and
  the app icon cannot drift. Outputs `icon.png`/`.icns`/`.ico`,
  `apple-touch-icon.png`, `public/brand-mark.png` and the README
  `assets/banner.png`. The upstream `nous-girl.jpg` badge and the orphaned
  `public/hermes*.png` sprite artwork were deleted.

### Phase 5 — Installers, packaging, containers

* **Python dist** `agentx-workmate`; console scripts `agentx`,
  `agentx-agent`, `agentx-acp`. The dist name and the console script are
  deliberately different tokens, so the rule table splits them: `dist-name`
  moves the script/install-dir/repo-folder spelling, `dist-name-proper`
  moves only the pip requirement specs (`agentx-workmate[cron]`),
  `dist-artifact-name` moves the wheel/egg-info spelling, and
  `dist-metadata-lookup` moves the three `importlib.metadata.version(…)`
  call sites.
* **npm** — scope `@agentx/*`, root package `agentx-agent`, `ui-tui`
  `agentx-tui`, `apps/desktop` `agentx-workmate`. All four lockfiles
  regenerated/renamed so no `name` field disagrees with its `package.json`.
* **Docker** — install roots `/opt/agentx`, `/etc/agentx`, the container init
  hook `01-agentx-setup`, and the unix user/group. That last one was already
  half-moved: phase 3 renamed `useradd … agentx` and `s6-setuidgid agentx`
  but not the twelve `chown -R hermes:hermes` calls, so the image created one
  user and chowned the data volume to another that did not exist.
* **Nix** — `services.agentx-agent`, `pkgs.agentx-agent`, `agentx-dashboard`
  service, the `agentx-config-*` derivations.
* **Installer flags** — `--agentx-home` (install.sh) and `-AgentXHome`
  (install.ps1), which the desktop's `bootstrap-runner.ts` passes.
* **Bootstrap installer** — crate `agentx-bootstrap`, lib
  `agentx_bootstrap_lib`, `agentx-setup.manifest` (the file was renamed; the
  `include_str!` had already moved without it), Tauri product `AgentX Setup`,
  `com.agentx.workmate.setup`.

### Phase 6 — Outbound identity

The `hermes-*` User-Agent strings had already moved with `dist-name`; what
remained was the PascalCase product token `HermesAgent/1.0` and
`HermesAgent/{version}`, now `AgentX/…`. Bot display names, `owned_by`,
and the codex `client_name` had already moved in phase 3 — verified, not
re-done.

### Phase 7 — Logs and diagnostics

Four identifiers: the log-drain thread name, the debug-bundle format id
`agentx-debug-share/1`, and its multipart boundary. Log *paths* moved in
phase 2.

### Half-renames from earlier phases that these commits closed

Each of these was already broken on `main` before this work started, because
phase 3 renamed one side of a pair while `apps/*` was excluded:

| Broken | Effect |
|---|---|
| `hermes_cli/web_server.py` sent `X-Agentx-Session-Token`, desktop sent `X-Hermes-Session-Token` | every authenticated desktop→dashboard REST call rejected |
| `main.ts` resolved the backend as `IS_WINDOWS ? 'hermes.exe' : 'agentx'` | desktop could not find its backend on Windows |
| `hermes_cli/main.py` globbed for `AgentX.exe`/`AgentX.app`, package.json built `Hermes.*` | `agentx desktop` reported "Desktop GUI build failed" |
| Dockerfile created user `agentx`, twelve `chown` calls targeted `hermes:hermes` | every chown failed; supervise trees stayed root-owned |
| `website/scripts/generate-skill-docs.py` read `metadata.agentx`, all 168 `SKILL.md` say `hermes:` | skills catalog generated with no tags — visible in this commit's diff as ~170 restored `Tags` rows |
| `plugins/memory/honcho/oauth_flow.py` reported source `hermes-desktop` beside `agentx-cli` | mismatched OAuth attribution |
| `hermes-dashboard.service` vs the already-renamed `agentx-gateway.service` | two services shipping together under two brands |
| `remote-lifecycle.test.ts` matched `/command -v hermes/` against a resolver sending `agentx` | SSH fixtures asserting on a command no longer issued |
| `scripts/test-desktop.mjs` looked in `%LOCALAPPDATA%\hermes` | desktop harness reading a directory phase 2 abandoned |

### Still open, and deliberately so

* **Install URLs.** `install.sh` / `install.ps1` are still served from
  `hermes-agent.nousresearch.com`, and `NousResearch/hermes-agent` remains the
  repo slug. Blocked on a domain (§14). The rule table guards both by
  pattern — `(?<!esearch/)` and `(?!\.nousresearch)` — so a future sweep will
  not silently rewrite a host that resolves nowhere.
* **The `hermes/<slug>` branch namespace** and the `hermes-<id>` scratch
  worktree names (`cli.py`, `hermes_cli/web_git.py`, the desktop's
  `git-worktree-ops.ts`, and the backup/sandbox/session-id generators in
  `plugins/*` and `tools/environments/*`). One coherent family with no owner
  in phases 4–7; renaming the branch prefix alone would leave
  `agentx/hermes-deadbeef`, and the pruner matching `startswith("hermes-")`.
  Phase 8 should take it whole.
* **`web/`'s own `hermes.*` localStorage keys and CSS classes** — a separate
  surface from the desktop's, no cross-app contract, no phase in 4–7.
* **Example hosts in desktop test fixtures** (`https://gw.example.com/hermes`,
  `/tmp/hermes-*`). Every pattern broad enough to catch them also catches
  `@/types/hermes`, which is a real import — left rather than risked.

---

## 7. Phase 8 — Prompts, skills, agent-visible content

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

## 8. Phase 9 — Docs and website

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

Blocked on a domain for any URL rewriting (§11).

---

## 9. Phase 10 — Attribution cleanup

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

## 10. Phase 11 — Gate and final verification

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

## 11. Still needed from the user

| # | Item | Blocks |
|---|---|---|
| 1 | Domain to replace `hermes-agent.nousresearch.com` | Phase 5 install URLs, phase 9 docs links, `WEBSITE_URL`/`DOCS_URL` in `branding.py` |
| 2 | Decision: rename skill-frontmatter `metadata: hermes:` → `agentx:`? | Phase 8 — trade-off is a clean break vs. compatibility with agentskills.io skills written for Hermes. **Note**: `website/scripts/generate-skill-docs.py` had already been half-moved to `agentx:` and was reading nothing; it is back on `hermes:` and now excluded from `cli-command` alongside the other three readers |

Answered during phases 4–7, recorded so they are not re-litigated:

| # | Item | Answer |
|---|---|---|
| 3 | The 121 `hermes:*` IPC channels and `window.hermesDesktop` | **Renamed**, whole family, one commit |
| 4 | The Docker unix user | **Renamed** to `agentx` — it was already half-renamed and the image was broken |
| 5 | Icon and banner artwork | **Generated** from the CLI mascot by `scripts/make_brand_assets.py` |

### One-time migration for the developer machine

The app now reads `~/.agentx`. Not run automatically — the file holds real
API keys:

```bash
mv ~/.hermes ~/.agentx && sed -i '' 's/^HERMES_/AGENTX_/' ~/.agentx/.env
```

No migration code ships in the product: every AgentX Workmate install is
new, so nobody but this machine has a `~/.hermes` to migrate.
