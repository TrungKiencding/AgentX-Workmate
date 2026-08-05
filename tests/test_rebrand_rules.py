"""The rebrand rules must rename the brand without touching internal names.

Every rule in ``scripts/rebrand/apply.py`` is a regex applied to ~4,700 files.
A rule that is one character too greedy renames ``hermes_cli`` and breaks every
import in the tree; one that is too narrow leaves brand text on screen.  These
tests pin both edges with the exact strings that appear in the codebase.

Several rules are SCOPED — ``app-kebab`` only runs under ``apps/``, the IPC
channel rule only under ``apps/desktop/`` — so :func:`rewrite` takes the path
the text is pretending to live at and honours each rule's include/exclude the
way ``apply.py`` does.  Testing the patterns without their scope would both
miss real breakage and invent breakage that cannot happen.
"""

import importlib.util
import re
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
_SPEC = importlib.util.spec_from_file_location(
    "rebrand_apply", REPO_ROOT / "scripts" / "rebrand" / "apply.py"
)
rebrand = importlib.util.module_from_spec(_SPEC)
# @dataclass resolves annotations through sys.modules[cls.__module__]; without
# this line the decorator blows up with AttributeError on a None module.
sys.modules[_SPEC.name] = rebrand
_SPEC.loader.exec_module(rebrand)

# A path that is in scope for every unscoped rule and out of scope for the
# apps/-only ones — i.e. the ordinary case.
BACKEND = "hermes_cli/main.py"
DESKTOP = "apps/desktop/src/store/example.ts"
INSTALLER = "apps/bootstrap-installer/src/routes/welcome.tsx"


def rewrite(text: str, path: str = BACKEND) -> str:
    """Run every rule that applies to ``path``, in table order, over ``text``."""
    for rule in rebrand.RULES:
        if rule.matches_path(path):
            text = re.sub(rule.pattern, rule.replacement, text)
    return text


# ── Names that must survive untouched ────────────────────────────────────
# These are Python modules on disk, internal identifiers, third-party package
# names and model slugs. Renaming any of them breaks imports, installs or API
# requests; we keep them so the diff against upstream stays small.

PRESERVED = [
    "hermes_cli",
    "hermes_constants",
    "hermes_logging",
    "hermes_state",
    "hermes_state_common",
    "hermes_state_portability",
    "hermes_state_schema",
    "hermes_state_search",
    "hermes_time",
    "hermes_bootstrap",
    "from hermes_cli.main import main",
    "from hermes_constants import get_hermes_home",
    "import hermes_state_search as search",
    "hermes_home = get_hermes_home()",
    "self.hermes_root",
    "_hermes_bin_path",
    "def set_hermes_home_override(path):",
    # Dotted DATA/PROTOCOL keys. These look like paths but are not, and
    # renaming them would break the wire format or orphan files on disk.
    "_meta.hermes",  # ACP protocol extension namespace
    "``_meta.hermes``",
    "metadata.hermes",  # skill-frontmatter key read from existing skill files
    "mcp.hermes-tools.*",  # MCP server name in codex config
    "[mcp_servers.hermes-tools]",
    # camelCase properties that merely start with the old name. The Windows
    # installer parameter rule is \bHermesHome\b and must not reach these.
    "sandbox.hermesHome",
    "normalizeHermesHomeRoot(runtime.hermesHome)",
    # The Electron executable is named by the desktop build config, not by the
    # launcher rules: `bin/` and `_dir/` are what anchor those.
    "release/linux-unpacked/hermes",
    # Kebab neighbours that are NOT ours.
    "hermes-tools",  # MCP server name
    "hermes-ink",  # npm package directory on disk
    # github.com/stephenschoettler/hermes-lcm — a third-party context-engine
    # plugin, named in agent/ comments and packaged in nix/nixosModules.nix.
    "hermes-lcm",
    "See hermes-lcm#68",
    # A deliberate counter-example: model_switch.py's non-agentic filter must
    # not match a local Modelfile that merely starts with the word, and
    # test_nous_hermes_non_agentic.py asserts exactly that. Renaming this
    # fixture would make that test vacuous.
    "hermes-brain:qwen3-14b-ctx16k",
    "hermes-seaeye[bot]",  # a real GitHub account in the contributor audit
    # The same guarded names behind a path separator, which is where they
    # actually appear. Dropping `/` from the kebab lookbehind made these
    # reachable, so the by-name guards are now the only thing holding them.
    "ui-tui/packages/hermes-ink/package.json",
    "plugins/hermes-achievements/dashboard/dist/index.js",
    "import { parse } from 'hermes-parser'",
    "node_modules/hermes-estree/dist/index.js",
    # Deliberate references to a PRE-rename name: the migration allowlists that
    # find and remove units/entries left by installs older than the rename.
    "hermes.service",
    '_LEGACY_SERVICE_NAMES: tuple[str, ...] = ("hermes.service",)',
    'data_base / "applications" / "hermes.desktop"',
    "hermes-0day",  # the name of a security campaign, not a product
    # Nous's Hermes models. These slugs are sent to provider APIs; renaming
    # one turns a working request into a 404.
    "hermes-4",
    "hermes-4-mini",
    "hermes-3-llama-3.1-70b",
    "NousResearch/Hermes-3-Llama-3.1-70B",
    "nous-hermes-3",
    "Nous Hermes 3",
    "provider('nous', ['hermes-x', 'hermes-y'])",
    # Source FILE names, kept per REBRAND.md §2. Renaming a specifier without
    # renaming the file is an unresolved import — tsc caught exactly this when
    # the launcher rule was briefly allowed to match `./hermes`.
    "use-hermes-config",
    "from '../session/hooks/use-hermes-config'",
    "./windows-hermes-path",
    "from '@/types/hermes'",
    # Third-party npm packages that happen to share the name. Renaming one
    # breaks `npm ci` outright.
    "hermes-parser",
    "hermes-estree",
    # Upstream coordinates: the repo slug and the onboarding host stay until a
    # domain exists (REBRAND.md §14).
    "https://github.com/NousResearch/hermes-agent.git",
    "git@github.com:NousResearch/hermes-agent.git",
    "ghcr.io/nousresearch/hermes-agent:latest",
    "https://hermes-agent.nousresearch.com/install.sh",
    "https://setup.hermes-agent.nousresearch.com",
]


@pytest.mark.parametrize("text", PRESERVED)
def test_internal_identifiers_survive(text):
    assert rewrite(text) == text, f"rule table rewrote internal identifier: {text!r}"


@pytest.mark.parametrize("text", PRESERVED)
def test_internal_identifiers_survive_inside_apps(text):
    """The apps/-scoped rules are the broadest in the table — same edges hold."""
    assert rewrite(text, DESKTOP) == text, f"apps/ rules rewrote: {text!r}"


# Preserved INSIDE apps/ only: a TypeScript relative import of a source file
# whose name we keep. Outside apps/ the same characters are the launcher run
# from a checkout, and cli-launcher-relative renames it.
PRESERVED_APPS_ONLY = [
    "from './hermes'",
    "import('../hermes')",
]


@pytest.mark.parametrize("text", PRESERVED_APPS_ONLY)
def test_apps_only_identifiers_survive(text):
    assert rewrite(text, DESKTOP) == text, f"apps/ rules rewrote: {text!r}"


# ── Things that must change ──────────────────────────────────────────────

RENAMES = [
    # env vars
    ("HERMES_HOME", "AGENTX_HOME"),
    ("os.environ['HERMES_SESSION_ID']", "os.environ['AGENTX_SESSION_ID']"),
    ("$HERMES_YOLO_MODE", "$AGENTX_YOLO_MODE"),
    ("HERMES_KANBAN_TASK=1", "AGENTX_KANBAN_TASK=1"),
    # Private constants move too — every occurrence moves together, so
    # nothing is left dangling.
    ("_HERMES_HOME_OVERRIDE", "_AGENTX_HOME_OVERRIDE"),
    # Regressions the earlier \b-anchored rule let through. Each one broke
    # something real: a launcher generated as `exec ""`, and an unterminated
    # heredoc in the nix module.
    (r"f'set -e\nHERMES_BIN={pip_entry}'", r"f'set -e\nAGENTX_BIN={pip_entry}'"),
    (r"'noise\nHERMES_DASHBOARD_READY port=1'", r"'noise\nAGENTX_DASHBOARD_READY port=1'"),
    ("<<'HERMES_DOC_EOF'\\n${value}\\nHERMES_DOC_EOF", "<<'AGENTX_DOC_EOF'\\n${value}\\nAGENTX_DOC_EOF"),
    ("zombie HERMES_HOMEs", "zombie AGENTX_HOMEs"),
    # The prefix also has to move where a metacharacter follows the
    # underscore: these regexes are the desktop's only way to recognise the
    # port announcement the Python side prints.
    (
        "/^HERMES_(?:BACKEND|DASHBOARD)_READY port=(\\d+)/m",
        "/^AGENTX_(?:BACKEND|DASHBOARD)_READY port=(\\d+)/m",
    ),
    ("New `HERMES_*` env vars", "New `AGENTX_*` env vars"),
    # The brand as the LAST segment of an env var name — env-prefix needs a
    # trailing underscore and cannot see these.
    ("AGENTX_DESKTOP_HERMES", "AGENTX_DESKTOP_AGENTX"),
    ("AGENTX_WIN_SSH_HERMES", "AGENTX_WIN_SSH_AGENTX"),
    (r"'a\nAGENTX_DESKTOP_HERMES=x'", r"'a\nAGENTX_DESKTOP_AGENTX=x'"),
    # Windows Title_Case spellings: scheduled-task name and registry value.
    ('_TASK_NAME_DEFAULT = "Hermes_Gateway"', '_TASK_NAME_DEFAULT = "AgentX_Gateway"'),
    ("Hermes_Home    REG_EXPAND_SZ", "AgentX_Home    REG_EXPAND_SZ"),
    ("HERMES_*_REFRESH_TIMEOUT_SECONDS", "AGENTX_*_REFRESH_TIMEOUT_SECONDS"),
    # config dir
    ("~/.hermes/config.yaml", "~/.agentx/config.yaml"),
    ("/root/.hermes", "/root/.agentx"),
    ("Path.home() / '.hermes'", "Path.home() / '.agentx'"),
    ("~/.hermes/logs/tool_calls.log", "~/.agentx/logs/tool_calls.log"),
    # A sentence that ENDS on the config directory. The old trailing guard
    # banned any following dot to protect `.hermes.md`, and so skipped all 21
    # docstrings that say "never write to the real ~/.hermes."
    ("never write to the real ~/.hermes.", "never write to the real ~/.agentx."),
    ("returns ~/.hermes.\"\"\"", "returns ~/.agentx.\"\"\""),
    # URL-encoded separators: the desktop reads media over /api/fs URLs.
    (
        "path=%2Fhome%2Fu%2F.hermes%2Fskills%2Fa.png",
        "path=%2Fhome%2Fu%2F.agentx%2Fskills%2Fa.png",
    ),
    ("#media:%2FUsers%2Fb%2F.hermes%2Fcache", "#media:%2FUsers%2Fb%2F.agentx%2Fcache"),
    # project config file
    (".hermes.md", ".agentx.md"),
    ("SOUL.md, .hermes.md, AGENTS.md", "SOUL.md, .agentx.md, AGENTS.md"),
    ("HERMES.md", "AGENTX.md"),
    # Constant name and the brand strings it holds move together.
    (
        '_HERMES_MD_NAMES = (".hermes.md", "HERMES.md")',
        '_AGENTX_MD_NAMES = (".agentx.md", "AGENTX.md")',
    ),
    # windows config dir — both the variable form and the expanded form
    (r"%LOCALAPPDATA%\hermes", r"%LOCALAPPDATA%\agentx"),
    (r"$env:LOCALAPPDATA\hermes", r"$env:LOCALAPPDATA\agentx"),
    (r"C:\Users\test\AppData\Local\hermes", r"C:\Users\test\AppData\Local\agentx"),
    # source files escape the separator, so the rule must survive doubling
    (r"'C:\\Users\\test\\AppData\\Local\\hermes\\node'", r"'C:\\Users\\test\\AppData\\Local\\agentx\\node'"),
    # CLI command
    ("run `hermes setup` first", "run `agentx setup` first"),
    ('prog="hermes"', 'prog="agentx"'),
    ("hermes gateway restart", "agentx gateway restart"),
    ("hermes-acp", "agentx-acp"),
    # The platform composite toolsets are one family and move together.
    ("hermes-telegram", "agentx-telegram"),
    ("hermes-cli", "agentx-cli"),
    ('default_toolset=f"hermes-{entry.name}"', 'default_toolset=f"agentx-{entry.name}"'),
    ('f"hermes-{platform}"', 'f"agentx-{platform}"'),
    ("hermes-gateway", "agentx-gateway"),
    ("ai.hermes.gateway", "ai.agentx.gateway"),
    ("launchctl kickstart ai.hermes.gateway", "launchctl kickstart ai.agentx.gateway"),
    # The launcher as an installed path. cli-command deliberately refuses
    # anything after a slash, so these need their own rule.
    ("/usr/local/bin/hermes", "/usr/local/bin/agentx"),
    ('"$command_link_dir/hermes"', '"$command_link_dir/agentx"'),
    ('AGENTX_ENTRYPOINT="$INSTALL_DIR/hermes"', 'AGENTX_ENTRYPOINT="$INSTALL_DIR/agentx"'),
    ("venv/bin/hermes", "venv/bin/agentx"),
    ("./hermes --version", "./agentx --version"),
    # …and as Windows spells it. The console script the venv generates is
    # `agentx.exe` now; main.ts shipped `IS_WINDOWS ? 'hermes.exe' : 'agentx'`
    # for exactly as long as apps/ was excluded from the table.
    (r"path.join(venvBin, IS_WINDOWS ? 'hermes.exe' : 'agentx')",
     r"path.join(venvBin, IS_WINDOWS ? 'agentx.exe' : 'agentx')"),
    (r"venv\Scripts\hermes.exe", r"venv\Scripts\agentx.exe"),
    (r"/y\\hermes\.exe/", r"/y\\agentx\.exe/"),
    ("/mnt/c/Tools/hermes.cmd", "/mnt/c/Tools/agentx.cmd"),
    # display names
    ("Hermes Agent", "AgentX Workmate"),
    ("Hermes Desktop", "AgentX Workmate Desktop"),
    ("Welcome to Hermes!", "Welcome to AgentX!"),
    ("Share these links with the Hermes team.", "Share these links with the AgentX team."),
    # glyph
    ("Goodbye! ⚕", "Goodbye! ⬡"),
    (" ⚕ Hermes ", " ⬡ AgentX "),
    # The other caduceus codepoint, U+2624, which the READMEs and the
    # session-export footer use.
    ("# AgentX Workmate ☤", "# AgentX Workmate ⬡"),
    ("Built with ☤ AgentX Workmate", "Built with ⬡ AgentX Workmate"),
    # The placeholder Matrix bot id, which every other rule refuses on purpose.
    ("placeholder: '@hermes:example.org'", "placeholder: '@agentx:example.org'"),
    # The nix service account already runs as `agentx`; its directories did not.
    ('default = "/var/lib/hermes"', 'default = "/var/lib/agentx"'),
    ('containerHomeDir = "/home/hermes"', 'containerHomeDir = "/home/agentx"'),
    ("/etc/sudoers.d/hermes", "/etc/sudoers.d/agentx"),
    ("/var/lib/hermes-tools-provisioned", "/var/lib/agentx-tools-provisioned"),
    ("/home/hermes/projects", "/home/agentx/projects"),
    # …while the MCP server name, which is not a directory, still survives the
    # kebab guard both bare and dotted.
    ("mcp.hermes-tools.search", "mcp.hermes-tools.search"),
    # ── phase 4: the packaged desktop app ────────────────────────────────
    # The bundle and binary are named with the FULL product name, because
    # Electron derives userData from productName and gui_uninstall.py derives
    # the same directory from branding.DESKTOP_APP_NAME. `\bHermes\b` would
    # have made these the SHORT name and left the launcher globbing for a
    # bundle electron-builder never writes.
    ("/Applications/Hermes.app", "/Applications/AgentX Workmate.app"),
    ("release/win-unpacked/Hermes.exe", "release/win-unpacked/AgentX Workmate.exe"),
    ("/home/x/Apps/Hermes.AppImage", "/home/x/Apps/AgentX Workmate.AppImage"),
    (
        "/Applications/Hermes.app/Contents/MacOS/Hermes",
        "/Applications/AgentX Workmate.app/Contents/MacOS/AgentX Workmate",
    ),
    (r"C:\Users\x\AppData\Local\Programs\Hermes", r"C:\Users\x\AppData\Local\Programs\AgentX Workmate"),
    ("/opt/Hermes/linux-unpacked", "/opt/AgentX Workmate/linux-unpacked"),
    ("Library/Application Support/Hermes", "Library/Application Support/AgentX Workmate"),
    # application id
    ("com.nousresearch.hermes", "com.agentx.workmate"),
    ("com.nousresearch.hermes.setup", "com.agentx.workmate.setup"),
    ("tccutil reset Microphone com.nousresearch.hermes", "tccutil reset Microphone com.agentx.workmate"),
    # the dashboard auth header the desktop sends. Python moved in phase 3
    # while apps/ was excluded, so the desktop was authenticating with a
    # header the backend had stopped reading.
    ("X-Hermes-Session-Token", "X-Agentx-Session-Token"),
    # cross-process REST route: declared in web_server.py, called from both
    # the desktop and the web dashboard.
    ("/api/hermes/update/check", "/api/agentx/update/check"),
    # DOM attribute and the dataset property that writes it — one name, two
    # spellings, and the theme-epoch observer watches the attribute by name.
    ("data-hermes-theme", "data-agentx-theme"),
    ("root.dataset.hermesTheme = skinName", "root.dataset.agentxTheme = skinName"),
    # ── phase 5: packaging ───────────────────────────────────────────────
    ("/usr/local/lib/hermes-agent", "/usr/local/lib/agentx-agent"),
    ("$AGENTX_HOME/hermes-agent/venv/bin/agentx", "$AGENTX_HOME/agentx-agent/venv/bin/agentx"),
    ("services.hermes-agent.settings", "services.agentx-agent.settings"),
    ("pkgs.hermes-agent.override", "pkgs.agentx-agent.override"),
    ("hermes-setup.exe", "agentx-setup.exe"),
    ("/etc/cont-init.d/01-hermes-setup", "/etc/cont-init.d/01-agentx-setup"),
    ("hermes-dashboard.service", "agentx-dashboard.service"),
    (".hermes-update-old", ".agentx-update-old"),
    (".hermes-bootstrap-complete", ".agentx-bootstrap-complete"),
    ("@hermes/shared/skin", "@agentx/shared/skin"),
    ("/opt/hermes/linux-unpacked", "/opt/agentx/linux-unpacked"),
    ("chown -R hermes:hermes /opt/data", "chown -R agentx:agentx /opt/data"),
    ("--hermes-home PATH", "--agentx-home PATH"),
    ("[string]$HermesHome = $env:AGENTX_HOME", "[string]$AgentXHome = $env:AGENTX_HOME"),
    ("hermes-tui", "agentx-tui"),
    # ── phase 6: outbound identity ───────────────────────────────────────
    ('"User-Agent": "HermesAgent/1.0"', '"User-Agent": "AgentX/1.0"'),
    ("Mozilla/5.0 (compatible; HermesAgent/1.0)", "Mozilla/5.0 (compatible; AgentX/1.0)"),
    # ── phase 8: agent-visible content ───────────────────────────────────
    # The kanban namespace, in all five spellings it actually appears in.
    # The selector forms are the ones a word-character-only lookbehind would
    # have skipped, leaving a stylesheet that matches nothing.
    ('className: "hermes-kanban-card"', 'className: "agentx-kanban-card"'),
    (".hermes-kanban-drawer {", ".agentx-kanban-drawer {"),
    (
        "summary.hermes-kanban-run-meta-label",
        "summary.agentx-kanban-run-meta-label",
    ),
    (
        "var(--hermes-kanban-drawer-width, 640px)",
        "var(--agentx-kanban-drawer-width, 640px)",
    ),
    ("@keyframes hermes-kanban-drawer-in {", "@keyframes agentx-kanban-drawer-in {"),
    ("docs/hermes-kanban-v1-spec.pdf", "docs/agentx-kanban-v1-spec.pdf"),
    ("hermes-kanban-dispatcher.service", "agentx-kanban-dispatcher.service"),
    ('"User-Agent": "hermes-kanban/attach"', '"User-Agent": "agentx-kanban/attach"'),
    # The skills-hub source id, its cache file, and a qualified skill ref.
    ('"hermes-index": 5000', '"agentx-index": 5000'),
    ("hermes-index.json", "agentx-index.json"),
    ("hermes-index/featured-skill", "agentx-index/featured-skill"),
    ('sid == "hermes-index"', 'sid == "agentx-index"'),
    # The s6-rc static service. The four tracked paths under docker/s6-rc.d are
    # renamed by `git mv` in the same commit; this pins the content half.
    ('for static in ("main-hermes", "dashboard")', 'for static in ("main-agentx", "dashboard")'),
    ("docker/s6-rc.d/main-hermes/run", "docker/s6-rc.d/main-agentx/run"),
    # The observability namespace: metric, span attribute, logger, SSE event,
    # schema version, and the SPA storage keys sharing the shape.
    ("hermes.task_run.started", "agentx.task_run.started"),
    ('logging.getLogger("hermes.coding_context")', 'logging.getLogger("agentx.coding_context")'),
    ('"hermes.shared_metrics.v2"', '"agentx.shared_metrics.v2"'),
    ('event: "hermes.tool.progress"', 'event: "agentx.tool.progress"'),
    ('"hermes.lastLocation"', '"agentx.lastLocation"'),
    # General kebab: the backend/plugin/test counterpart of app-kebab.
    ('topic: "hermes-in"', 'topic: "agentx-in"'),
    ('publish_topic: "hermes-out"', 'publish_topic: "agentx-out"'),
    ('"source": "hermes-auth-store"', '"source": "agentx-auth-store"'),
    ('"hermes-update": "hermes-update.log"', '"agentx-update": "agentx-update.log"'),
    ('mkdtemp(prefix="hermes-update-")', 'mkdtemp(prefix="agentx-update-")'),
    ("hermes-ci-review-bot", "agentx-ci-review-bot"),
    ('f"hermes-{socket.gethostname()}"', 'f"agentx-{socket.gethostname()}"'),
    ('b"hermes-bws-encrypted-cache-v1"', 'b"agentx-bws-encrypted-cache-v1"'),
    ("hermes-sidebar-collapsed", "agentx-sidebar-collapsed"),
    # A kebab token behind a path separator or a selector dot. The first pass
    # excluded `/` and `.` in the kebab lookbehind, which silently split every
    # one of these from its already-renamed counterpart — a CSS rule whose
    # selector nobody sets, and a fixture path the producer no longer writes.
    ("/tmp/hermes-verify-example.py", "/tmp/agentx-verify-example.py"),
    ("docker/hermes-exec-shim.sh", "docker/agentx-exec-shim.sh"),
    ("profiles/hermes-security/skills/", "profiles/agentx-security/skills/"),
    ("https://hermes-temp-hello.serene-temple.workers.dev", "https://agentx-temp-hello.serene-temple.workers.dev"),
    # On-disk path names renamed by `git mv` in the same commit. The first two
    # were already half-renamed before phase 8: nix/packages.nix called
    # `./agentx-agent.nix` against a file still named hermes-agent.nix, and the
    # skill directories were stale against a `name:` frontmatter that already
    # said agentx-agent.
    ("pkgs.callPackage ./hermes-agent.nix", "pkgs.callPackage ./agentx-agent.nix"),
    ("./setup-hermes.sh", "./setup-agentx.sh"),
    (
        "skills/autonomous-ai-agents/hermes-agent/SKILL.md",
        "skills/autonomous-ai-agents/agentx-agent/SKILL.md",
    ),
    ("hermes-agent-skill-authoring", "agentx-agent-skill-authoring"),
    ("inspecting-hermes-desktop-dom", "inspecting-agentx-desktop-dom"),
    ("hermes-s6-container-supervision", "agentx-s6-container-supervision"),
]


@pytest.mark.parametrize(("before", "after"), RENAMES)
def test_brand_tokens_are_renamed(before, after):
    assert rewrite(before) == after


# ── Phase-8 rules with their own narrow file scope ───────────────────────
#
# Each of these renames a token whose OTHER spellings in the tree must not
# move, so the rule is scoped by an explicit include list rather than by a
# cleverer pattern.  Testing them at the wrong path would prove nothing.

GATEWAY = "gateway/relay/ws_transport.py"
CRON = "cron/blueprint_catalog.py"
WORKTREE = "cli.py"

SCOPED_RENAMES = [
    # The Slack parent slash command — producer already says "agentx".
    (GATEWAY, 'parent_parts[0] != "/hermes"', 'parent_parts[0] != "/agentx"'),
    (GATEWAY, '"/hermes sethome"', '"/agentx sethome"'),
    # The deep-link scheme. The desktop registered agentx:// in phase 4 while
    # this producer kept emitting the old one.
    (CRON, 'f"hermes://blueprint/{quote(key)}"', 'f"agentx://blueprint/{quote(key)}"'),
    # The branch namespace and the scratch-worktree ids inside it. Both halves
    # must move or the pruner stops matching what the creator writes.
    (WORKTREE, 'branch_name = f"hermes/{wt_name}"', 'branch_name = f"agentx/{wt_name}"'),
    (WORKTREE, 'b.startswith("hermes/hermes-")', 'b.startswith("agentx/agentx-")'),
    (WORKTREE, "refs/heads/hermes/feat", "refs/heads/agentx/feat"),
    (WORKTREE, 'wt_name = f"hermes-{short_id}"', 'wt_name = f"agentx-{short_id}"'),
]


@pytest.mark.parametrize(("path", "before", "after"), SCOPED_RENAMES)
def test_narrow_scoped_tokens_are_renamed(path, before, after):
    assert rewrite(before, path) == after


# The same tokens spelled at a path OUTSIDE each rule's scope. These are the
# real shapes that share the spelling: the desktop import specifier `@/hermes`,
# a reverse-proxy URL prefix, an openviking peer path, and OpenClaw's own
# extension directory. A rule that reached them would break a live lookup.
OUT_OF_SCOPE_PRESERVED = [
    ("apps/desktop/src/app/artifacts/index.tsx", "import { x } from '@/hermes'"),
    ("hermes_cli/dashboard_auth/middleware.py", "/hermes/login?next=..."),
    ("apps/desktop/electron/native-oauth.test.ts", "'/hermes/auth/native/authorize'"),
    ("plugins/memory/openviking/__init__.py", "viking://user/hermes/.overview.md"),
    (
        "optional-skills/migration/openclaw-migration/scripts/openclaw_to_hermes.py",
        "OpenClaw's extensions/migrate-hermes/apply.ts",
    ),
]


@pytest.mark.parametrize(("path", "text"), OUT_OF_SCOPE_PRESERVED)
def test_narrow_rules_do_not_reach_lookalikes(path, text):
    assert rewrite(text, path) == text


# ── Rules that only run inside apps/ ─────────────────────────────────────

APP_SCOPED_RENAMES = [
    # The Electron IPC namespace: preload.ts, main.ts and every caller must
    # agree, so it is a whole-family rename or none at all.
    ("ipcRenderer.invoke('hermes:git:review:push')", "ipcRenderer.invoke('agentx:git:review:push')"),
    ("hermes:pet-overlay:set-bounds", "agentx:pet-overlay:set-bounds"),
    # …and the custom URL schemes registered alongside it.
    ("hermes://open/agent/42", "agentx://open/agent/42"),
    ("hermes-media://stream/", "agentx-media://stream/"),
    # the contextBridge name, visible in DevTools, plus the mid-word form in
    # the test doubles.
    ("window.hermesDesktop.api", "window.agentxDesktop.api"),
    ("const initialHermesDesktop = {}", "const initialAgentxDesktop = {}"),
    # renderer storage namespaces, read back by prefix
    ("localStorage.getItem('hermes.desktop.layoutTree.v2')",
     "localStorage.getItem('agentx.desktop.layoutTree.v2')"),
    ("`hermes.plugin.${pluginId}.${key}`", "`agentx.plugin.${pluginId}.${key}`"),
    # app-local kebab tokens: CSS names, storage keys, mkdtemp prefixes
    ("@keyframes hermes-zone-fade", "@keyframes agentx-zone-fade"),
    ("localStorage.getItem('hermes-boot-background')", "localStorage.getItem('agentx-boot-background')"),
    ("mkdtempSync(join(tmpdir(), 'hermes-stage-'))", "mkdtempSync(join(tmpdir(), 'agentx-stage-'))"),
    ("'hermes-desktop-theme-v2'", "'agentx-desktop-theme-v2'"),
    # The CSS SELECTOR half of a class the bootstrap-installer routes already
    # set as `className="agentx-fade-in"`. Shipped split once, because the
    # kebab lookbehind excluded the `.` that starts every selector; pinned
    # here so it cannot split again.
    (".hermes-fade-in {", ".agentx-fade-in {"),
    (".hermes-glow {", ".agentx-glow {"),
]


@pytest.mark.parametrize(("before", "after"), APP_SCOPED_RENAMES)
def test_app_scoped_tokens_are_renamed(before, after):
    assert rewrite(before, DESKTOP) == after


@pytest.mark.parametrize(("before", "after"), APP_SCOPED_RENAMES)
def test_app_scoped_rules_do_not_run_on_the_backend(before, after):
    """These rules are scoped to apps/ on purpose — outside it they must not fire.

    The IPC channels and the preload bridge exist only in the Electron app;
    a rule that reached the backend would rename tokens with no counterpart
    there, which is the half-rename §4 of REBRAND.md is about.
    """
    if before == rewrite(before, BACKEND):
        return  # correctly untouched
    # A few of the strings above are ALSO claimed by unscoped rules; the only
    # thing that must never happen is a *different* result.
    assert rewrite(before, BACKEND) == after


def test_app_kebab_reaches_the_bootstrap_installer():
    """phase 5 moves apps/bootstrap-installer in the same pass as the desktop."""
    assert rewrite("className=\"hermes-fade-in\"", INSTALLER) == "className=\"agentx-fade-in\""


def test_display_name_full_wins_over_bare():
    """'Hermes Agent' must become the product name, not 'AgentX Agent'."""
    assert rewrite("Hermes Agent v1.0") == "AgentX Workmate v1.0"


def test_app_bundle_name_wins_over_bare_display_name():
    """`.` is a word boundary, so \\bHermes\\b would claim `Hermes.exe` first.

    It ran first once, and shipped a Python launcher looking for AgentX.exe
    beside an electron-builder config producing AgentX Workmate.exe.
    """
    ids = [r.id for r in rebrand.RULES]
    assert ids.index("desktop-app-file") < ids.index("display-name-short")
    assert ids.index("desktop-install-dir") < ids.index("display-name-short")
    assert ids.index("session-token-header") < ids.index("display-name-short")


def test_relative_import_rule_is_held_off_apps():
    """`./hermes` is the launcher in a shell and a module in the desktop."""
    assert rewrite("from './hermes'", DESKTOP) == "from './hermes'"
    assert rewrite("exec ./hermes setup", BACKEND) == "exec ./agentx setup"


def test_mixed_line_renames_env_but_keeps_module():
    line = 'hermes_home = os.environ.get("HERMES_HOME", "~/.hermes")'
    assert rewrite(line) == 'hermes_home = os.environ.get("AGENTX_HOME", "~/.agentx")'


def test_upstream_repo_slug_is_left_until_a_domain_exists():
    """`NousResearch/hermes-agent` is a third-party coordinate (REBRAND.md §14)."""
    url = "https://github.com/NousResearch/hermes-agent.git"
    assert rewrite(url) == url
    assert rewrite(url, DESKTOP) == url


def test_install_dir_moves_even_though_the_repo_slug_does_not():
    """Same token, opposite answers — the guard is the surrounding context."""
    assert rewrite("~/.agentx/hermes-agent/venv") == "~/.agentx/agentx-agent/venv"


def test_every_rule_has_a_unique_id():
    ids = [r.id for r in rebrand.RULES]
    assert len(ids) == len(set(ids)), "duplicate rule id in the table"


def test_every_rule_pattern_compiles():
    for rule in rebrand.RULES:
        re.compile(rule.pattern)  # raises on a malformed pattern


def test_every_rule_declares_a_phase_in_range():
    for rule in rebrand.RULES:
        assert 2 <= rule.phase <= 11, f"{rule.id} has phase {rule.phase}"
