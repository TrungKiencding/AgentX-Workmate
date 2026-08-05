"""The three branding mirrors must never drift.

Product identity lives in ``branding.py``, but the desktop/web/TUI stack reads
TypeScript and the installers read shell, so the same values are declared three
times.  Three declarations is two chances to update one and forget the others —
these tests close that gap by parsing all three and comparing them value by
value.
"""

import re
from pathlib import Path

import pytest

import branding

REPO_ROOT = Path(__file__).resolve().parent.parent
TS_PATH = REPO_ROOT / "apps" / "shared" / "src" / "branding.ts"
SH_PATH = REPO_ROOT / "scripts" / "lib" / "branding.sh"

# Python constant name -> shell variable name. TypeScript reuses the Python
# names verbatim, so it needs no mapping.
SHELL_NAMES = {
    "PRODUCT_NAME": "BRAND_PRODUCT_NAME",
    "SHORT_NAME": "BRAND_SHORT_NAME",
    "VENDOR_NAME": "BRAND_VENDOR_NAME",
    "SUPPORT_EMAIL": "BRAND_SUPPORT_EMAIL",
    "BRAND_GLYPH": "BRAND_GLYPH",
    "CLI_COMMAND": "BRAND_CLI_COMMAND",
    "GATEWAY_COMMAND": "BRAND_GATEWAY_COMMAND",
    "ACP_COMMAND": "BRAND_ACP_COMMAND",
    "CONFIG_DIR_POSIX": "BRAND_CONFIG_DIR_POSIX",
    "CONFIG_DIR_WINDOWS": "BRAND_CONFIG_DIR_WINDOWS",
    "PROJECT_CONFIG_FILE": "BRAND_PROJECT_CONFIG_FILE",
    "ENV_PREFIX": "BRAND_ENV_PREFIX",
    "APP_ID": "BRAND_APP_ID",
    "PROTOCOL_SCHEME": "BRAND_PROTOCOL_SCHEME",
    "DIST_NAME": "BRAND_DIST_NAME",
    "DESKTOP_APP_NAME": "BRAND_DESKTOP_APP_NAME",
    "WEBSITE_URL": "BRAND_WEBSITE_URL",
    "DOCS_URL": "BRAND_DOCS_URL",
    "REPO_URL": "BRAND_REPO_URL",
}


def _parse_ts() -> dict[str, str]:
    text = TS_PATH.read_text(encoding="utf-8")
    return {
        m.group(1): m.group(2)
        # The optional `: string` is load-bearing on the URL constants: without
        # it TypeScript narrows them to the empty-string literal type and the
        # helpers that guard on emptiness end up operating on `never`.
        for m in re.finditer(
            r"^export const (\w+)(?:: \w+)? = '([^']*)'$", text, re.MULTILINE
        )
    }


def _parse_sh() -> dict[str, str]:
    text = SH_PATH.read_text(encoding="utf-8")
    return {
        m.group(1): m.group(2)
        for m in re.finditer(r'^(BRAND_\w+)="([^"]*)"$', text, re.MULTILINE)
    }


@pytest.mark.parametrize("name", sorted(SHELL_NAMES))
def test_typescript_mirror_matches_python(name):
    ts = _parse_ts()
    assert name in ts, f"{name} missing from {TS_PATH.relative_to(REPO_ROOT)}"
    assert ts[name] == getattr(branding, name), (
        f"{name} differs: branding.py={getattr(branding, name)!r} "
        f"branding.ts={ts[name]!r}"
    )


@pytest.mark.parametrize(("py_name", "sh_name"), sorted(SHELL_NAMES.items()))
def test_shell_mirror_matches_python(py_name, sh_name):
    sh = _parse_sh()
    assert sh_name in sh, f"{sh_name} missing from {SH_PATH.relative_to(REPO_ROOT)}"
    assert sh[sh_name] == getattr(branding, py_name), (
        f"{py_name} differs: branding.py={getattr(branding, py_name)!r} "
        f"branding.sh={sh[sh_name]!r}"
    )


def test_no_mirror_has_extra_constants():
    """A constant added to one mirror only would silently go unchecked."""
    ts_extra = set(_parse_ts()) - set(SHELL_NAMES)
    sh_extra = set(_parse_sh()) - set(SHELL_NAMES.values())
    assert not ts_extra, f"branding.ts has unmirrored constants: {sorted(ts_extra)}"
    assert not sh_extra, f"branding.sh has unmirrored constants: {sorted(sh_extra)}"


def test_env_helper_uses_prefix():
    assert branding.env("HOME") == "AGENTX_HOME"
    assert branding.env("SESSION_ID") == "AGENTX_SESSION_ID"


def test_config_dir_name_is_platform_appropriate():
    import sys

    expected = (
        branding.CONFIG_DIR_WINDOWS if sys.platform == "win32" else branding.CONFIG_DIR_POSIX
    )
    assert branding.config_dir_name() == expected


def test_identity_values_are_the_agreed_ones():
    """Pin the actual strings so a careless edit to branding.py is caught."""
    assert branding.PRODUCT_NAME == "AgentX Workmate"
    assert branding.CLI_COMMAND == "agentx"
    assert branding.ENV_PREFIX == "AGENTX_"
    assert branding.CONFIG_DIR_POSIX == ".agentx"
    assert branding.APP_ID == "com.agentx.workmate"
    assert branding.BRAND_GLYPH == "⬡"
    assert branding.VENDOR_NAME == "AstralX Technology"
