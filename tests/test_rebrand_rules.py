"""The rebrand rules must rename the brand without touching internal names.

Every rule in ``scripts/rebrand/apply.py`` is a regex applied to ~4,700 files.
A rule that is one character too greedy renames ``hermes_cli`` and breaks every
import in the tree; one that is too narrow leaves brand text on screen.  These
tests pin both edges with the exact strings that appear in the codebase.
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


def rewrite(text: str, phases=(2, 3)) -> str:
    """Run every rule in ``phases``, in table order, over ``text``."""
    for rule in rebrand.RULES:
        if rule.phase in phases:
            text = re.sub(rule.pattern, rule.replacement, text)
    return text


# ── Names that must survive untouched ────────────────────────────────────
# These are Python modules on disk and internal identifiers. Renaming any of
# them breaks imports; we keep them so the diff against upstream stays small.

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
    # camelCase properties that merely start with the old name
    "sandbox.hermesHome",
    "window.hermesDesktop",
    # Kebab tokens are a separate concern from the config directory, and the
    # path rules must not nibble the first segment off one. Renaming half of
    # a token pair is worse than renaming neither: it broke a CSS selector
    # (summary.hermes-kanban-run-meta-label) and an install-path check
    # (hermes-desktop) that their counterparts still spelled the old way.
    ".hermes-kanban-card",
    "summary.hermes-kanban-run-meta-label",
    ".hermes-update-old",
    "C:\\Users\\x\\AppData\\Local\\hermes-desktop",
    "~/.hermes-agent",
    # The Electron executable (named by the desktop build config, phase 4)
    # and the install root (phase 5) both end in a path segment that looks
    # like the launcher. Neither is.
    "release/linux-unpacked/hermes",
    "/usr/local/lib/hermes-agent",
    # Kebab neighbours of the toolset family that are NOT toolsets.
    "hermes-tools",  # MCP server name
    "hermes-index",  # skills-hub source id
    'wt_name = f"hermes-{short_id}"',  # scratch worktree
]


@pytest.mark.parametrize("text", PRESERVED)
def test_internal_identifiers_survive(text):
    assert rewrite(text) == text, f"rule table rewrote internal identifier: {text!r}"


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
    # Windows Title_Case spellings: scheduled-task name and registry value.
    ('_TASK_NAME_DEFAULT = "Hermes_Gateway"', '_TASK_NAME_DEFAULT = "AgentX_Gateway"'),
    ("Hermes_Home    REG_EXPAND_SZ", "AgentX_Home    REG_EXPAND_SZ"),
    ("HERMES_*_REFRESH_TIMEOUT_SECONDS", "AGENTX_*_REFRESH_TIMEOUT_SECONDS"),
    # config dir
    ("~/.hermes/config.yaml", "~/.agentx/config.yaml"),
    ("/root/.hermes", "/root/.agentx"),
    ("Path.home() / '.hermes'", "Path.home() / '.agentx'"),
    ("~/.hermes/logs/tool_calls.log", "~/.agentx/logs/tool_calls.log"),
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
    # display names
    ("Hermes Agent", "AgentX Workmate"),
    ("Hermes Desktop", "AgentX Workmate Desktop"),
    ("Welcome to Hermes!", "Welcome to AgentX!"),
    ("Share these links with the Hermes team.", "Share these links with the AgentX team."),
    # glyph
    ("Goodbye! ⚕", "Goodbye! ⬡"),
    (" ⚕ Hermes ", " ⬡ AgentX "),
]


@pytest.mark.parametrize(("before", "after"), RENAMES)
def test_brand_tokens_are_renamed(before, after):
    assert rewrite(before) == after


def test_display_name_full_wins_over_bare():
    """'Hermes Agent' must become the product name, not 'AgentX Agent'."""
    assert rewrite("Hermes Agent v1.0") == "AgentX Workmate v1.0"


def test_mixed_line_renames_env_but_keeps_module():
    line = 'hermes_home = os.environ.get("HERMES_HOME", "~/.hermes")'
    assert rewrite(line) == 'hermes_home = os.environ.get("AGENTX_HOME", "~/.agentx")'


def test_upstream_repo_slug_is_left_for_a_later_phase():
    """`hermes-agent` is the upstream repo/dir name — phase 5/10 owns it."""
    url = "https://github.com/NousResearch/hermes-agent.git"
    assert rewrite(url) == url


def test_every_rule_has_a_unique_id():
    ids = [r.id for r in rebrand.RULES]
    assert len(ids) == len(set(ids)), "duplicate rule id in the table"


def test_every_rule_pattern_compiles():
    for rule in rebrand.RULES:
        re.compile(rule.pattern)  # raises on a malformed pattern
