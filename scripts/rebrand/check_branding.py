#!/usr/bin/env python3
"""Fail the build if upstream branding leaks back into a user-visible surface.

This is the regression gate for the AgentX Workmate rebrand.  Without it the
rename is a one-off sweep that quietly rots as new code lands; with it, any
commit that reintroduces "Hermes" in a string a user can see fails CI.

WHAT IS ALLOWED
---------------
Lowercase ``hermes`` as part of a snake_case identifier — Python module names
(``hermes_cli``, ``hermes_constants``), attributes, and locals (``hermes_home``,
``get_hermes_home``).  Those are internal names we deliberately kept so the
diff against upstream stays reviewable and merges keep working.

Concretely, an occurrence is allowed when it is immediately preceded by
``[a-z0-9_]`` or immediately followed by ``_[a-z]``.  That single test admits
``hermes_cli`` and ``get_hermes_home`` while still catching every user-facing
form: ``Hermes``, ``HERMES_HOME``, ``~/.hermes``, ``hermes-agent``, and a bare
``hermes`` used as a command in prose.

Usage::

    scripts/rebrand/check_branding.py            # report + exit 1 on any hit
    scripts/rebrand/check_branding.py --summary  # counts per category only
    scripts/rebrand/check_branding.py --max 20   # cap examples shown per category
"""

from __future__ import annotations

import argparse
import fnmatch
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Files exempt from every check.
#   LICENSE            — MIT requires the original copyright notice to survive.
#   scripts/rebrand/*  — this tooling names the old brand on purpose.
#   *.lock, lockfiles  — generated, and carry upstream package URLs.
ALLOWLIST = [
    "LICENSE",
    "REBRAND.md",  # the handoff plan documents the old names
    ".rebrand-baseline/*",  # pre-change test evidence
    "scripts/rebrand/*",
    "uv.lock",
    "package-lock.json",
    "*/package-lock.json",
    "flake.lock",
    ".mailmap",
]

# ``hermes`` preceded by [a-z0-9_] or followed by _[a-z] is an internal
# snake_case identifier and is allowed. Everything else is a violation.
BRAND_RE = re.compile(r"(?<![a-z0-9_])hermes(?!_[a-z])", re.IGNORECASE)

EXTRA_CHECKS = [
    ("caduceus-glyph", re.compile("⚕"), "Hermes' staff — use the ⬡ brand glyph"),
    ("vendor-name", re.compile(r"Nous\s?Research", re.IGNORECASE), "upstream vendor name"),
    ("vendor-domain", re.compile(r"nousresearch\.com"), "upstream domain"),
]


def tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    ).stdout
    return [p for p in out.split("\0") if p]


def allowed(rel: str) -> bool:
    return any(fnmatch.fnmatch(rel, pat) for pat in ALLOWLIST)


def read_text(path: Path) -> str | None:
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if b"\0" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(prog="check_branding.py", description=__doc__)
    ap.add_argument("--summary", action="store_true", help="counts only, no examples")
    ap.add_argument("--max", type=int, default=8, help="examples shown per category")
    args = ap.parse_args()

    categories: dict[str, list[tuple[str, int, str]]] = {}

    for rel in tracked_files():
        if allowed(rel):
            continue
        path = REPO_ROOT / rel
        if not path.is_file() or path.is_symlink():
            continue
        text = read_text(path)
        if text is None:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if BRAND_RE.search(line):
                categories.setdefault("brand-token", []).append((rel, lineno, line.strip()[:120]))
            for name, pattern, _desc in EXTRA_CHECKS:
                if pattern.search(line):
                    categories.setdefault(name, []).append((rel, lineno, line.strip()[:120]))

    if not categories:
        print("✓ no upstream branding found in user-visible surfaces")
        return 0

    descriptions = {name: desc for name, _p, desc in EXTRA_CHECKS}
    descriptions["brand-token"] = "'hermes' outside an internal snake_case identifier"

    total = 0
    for name in sorted(categories):
        hits = categories[name]
        total += len(hits)
        files = len({h[0] for h in hits})
        print(f"\n✗ {name}: {len(hits)} hits in {files} files — {descriptions[name]}")
        if args.summary:
            continue
        for rel, lineno, line in hits[: args.max]:
            print(f"    {rel}:{lineno}: {line}")
        if len(hits) > args.max:
            print(f"    … and {len(hits) - args.max} more")

    print(f"\nTOTAL: {total} violations")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
