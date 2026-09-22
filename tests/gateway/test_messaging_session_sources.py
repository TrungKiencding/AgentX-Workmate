"""MESSAGING_SESSION_SOURCE_VALUES is a static list; pin it to what it mirrors."""

import re
from pathlib import Path

from gateway.config import (
    MESSAGING_SESSION_SOURCE_VALUES,
    Platform,
    _BUILTIN_PLATFORM_VALUES,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DESKTOP_SESSION_SOURCE = _REPO_ROOT / "apps" / "desktop" / "src" / "lib" / "session-source.ts"


def test_matches_builtin_platforms_and_bundled_plugins():
    expected = (
        set(_BUILTIN_PLATFORM_VALUES) - {"local"}
    ) | Platform._scan_bundled_plugin_platforms()

    assert MESSAGING_SESSION_SOURCE_VALUES == expected


def test_matches_desktop_messaging_source_ids():
    text = _DESKTOP_SESSION_SOURCE.read_text(encoding="utf-8")
    match = re.search(
        r"export const MESSAGING_SESSION_SOURCE_IDS\s*=\s*\[(.*?)\]", text, re.S
    )
    assert match, "MESSAGING_SESSION_SOURCE_IDS not found in session-source.ts"
    desktop_ids = re.findall(r"['\"]([^'\"]+)['\"]", match.group(1))

    assert len(desktop_ids) == len(set(desktop_ids))
    assert set(desktop_ids) == MESSAGING_SESSION_SOURCE_VALUES
