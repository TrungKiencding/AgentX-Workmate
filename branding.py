"""Single source of truth for AgentX Workmate product identity.

Every user-visible name, command, path segment, and identifier that carries
the product brand is defined here exactly once.  Nothing else in the tree
should hard-code the product name or the CLI command — import from this
module instead, so a future rename is a one-file edit.

Import-safe: standard library only, no intra-project imports, no side
effects.  ``hermes_constants`` imports this, and ``hermes_constants`` is
itself imported from everywhere, so this module must stay dependency-free.

Mirrored, deliberately, in two other places for the non-Python surfaces:

  * ``apps/shared/src/branding.ts``  — desktop / web / TUI (TypeScript)
  * ``scripts/lib/branding.sh``      — installers (POSIX shell)

``tests/test_branding_consistency.py`` asserts all three stay in sync, so a
value changed here without changing the mirrors fails CI.
"""

from __future__ import annotations

# ── Product identity ──────────────────────────────────────────────────
#: Full product name.  Banner titles, About dialogs, installer windows.
PRODUCT_NAME = "AgentX Workmate"

#: Short form for tight spaces (status bars, response labels, bot names).
SHORT_NAME = "AgentX"

#: Legal entity that publishes the product.  Package author, copyright
#: lines, Linux package maintainer, macOS bundle vendor.
VENDOR_NAME = "AstralX Technology"

#: Where users are told to send support requests.
SUPPORT_EMAIL = "kien.le@astralx.com.vn"

#: Brand glyph used as a decorative prefix in the CLI and TUI.
BRAND_GLYPH = "⬡"  # ⬡ WHITE HEXAGON

# ── Commands ──────────────────────────────────────────────────────────
#: The command users type.  Console-script entry point name.
CLI_COMMAND = "agentx"

#: Long-running gateway process entry point.
GATEWAY_COMMAND = "agentx-gateway"

#: Agent Client Protocol adapter entry point.
ACP_COMMAND = "agentx-acp"

# ── Filesystem layout ─────────────────────────────────────────────────
#: Config/state directory under ``$HOME`` on POSIX (``~/.agentx``).
CONFIG_DIR_POSIX = ".agentx"

#: Config/state directory under ``%LOCALAPPDATA%`` on Windows.
CONFIG_DIR_WINDOWS = "agentx"

#: Per-project instruction file, alongside AGENTS.md / CLAUDE.md.
PROJECT_CONFIG_FILE = ".agentx.md"

# ── Environment ───────────────────────────────────────────────────────
#: Prefix for every environment variable the product reads or writes.
#: Kept as a constant because ``tools/code_execution_tool`` filters the
#: child environment by this prefix at runtime.
ENV_PREFIX = "AGENTX_"

# ── Packaging identifiers ─────────────────────────────────────────────
#: Reverse-DNS application id.  macOS bundle id, Windows AppUserModelId.
APP_ID = "com.agentx.workmate"

#: Custom URL scheme the desktop app registers (``agentx://…``).
PROTOCOL_SCHEME = "agentx"

#: Python distribution name (``pyproject.toml`` ``[project].name``).
DIST_NAME = "agentx-workmate"

#: Desktop application name.  electron-builder ``productName`` and
#: ``executableName``; also the ``Application Support`` folder name.
DESKTOP_APP_NAME = "AgentX Workmate"

# ── Web presence ──────────────────────────────────────────────────────
# Not registered yet.  Empty string means "no link" — every consumer must
# treat these as optional and omit the surrounding UI when unset, rather
# than rendering a dead link.
WEBSITE_URL = ""
DOCS_URL = ""


def env(name: str) -> str:
    """Return the full environment variable name for a bare ``name``.

    ``env("HOME")`` -> ``"AGENTX_HOME"``.  Use this instead of writing the
    prefix inline so the prefix stays greppable and changeable.
    """
    return f"{ENV_PREFIX}{name}"


def config_dir_name() -> str:
    """Return the platform-appropriate config directory *name* (not path)."""
    import sys

    return CONFIG_DIR_WINDOWS if sys.platform == "win32" else CONFIG_DIR_POSIX
