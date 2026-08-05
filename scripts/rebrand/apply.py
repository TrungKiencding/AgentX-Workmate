#!/usr/bin/env python3
"""Rule-driven rebrand pass over the git-tracked tree.

The rebrand touches ~4,700 files.  A blanket ``sed s/hermes/agentx/g`` would
also rewrite Python module names (``hermes_cli``), on-disk file paths, and
upstream URLs — so every replacement here is a narrow, named rule with an
explicit file scope, and rules run in a fixed order.

Usage::

    scripts/rebrand/apply.py --list                 # show the rule table
    scripts/rebrand/apply.py --dry-run              # report, change nothing
    scripts/rebrand/apply.py --dry-run --rule env-prefix
    scripts/rebrand/apply.py --apply --rule env-prefix
    scripts/rebrand/apply.py --apply --phase 2      # every rule in a phase

``--dry-run`` is the default; nothing is written without ``--apply``.
"""

from __future__ import annotations

import argparse
import fnmatch
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Paths whose *content* must never be rewritten by any rule.  The upstream
# licence keeps its original copyright holder (MIT requires it), the lockfiles
# are generated, and this directory documents the old names on purpose.
GLOBAL_EXCLUDE = [
    "LICENSE",
    "uv.lock",
    "package-lock.json",
    "*/package-lock.json",
    "scripts/rebrand/*",
    ".mailmap",
]


@dataclass
class Rule:
    """One named, scoped search-and-replace."""

    id: str
    phase: int
    pattern: str
    replacement: str
    note: str
    include: list[str] = field(default_factory=lambda: ["*"])
    exclude: list[str] = field(default_factory=list)

    def matches_path(self, rel: str) -> bool:
        if any(fnmatch.fnmatch(rel, pat) for pat in GLOBAL_EXCLUDE):
            return False
        if any(fnmatch.fnmatch(rel, pat) for pat in self.exclude):
            return False
        return any(fnmatch.fnmatch(rel, pat) for pat in self.include)


# ── Rule table ────────────────────────────────────────────────────────────
#
# Order matters: more specific patterns run before broader ones so a broad
# rule never eats a token a narrow rule was meant to claim.
#
# Names that must SURVIVE every rule (they are Python module names or paths
# on disk, which we deliberately keep):
#     hermes_cli  hermes_constants  hermes_state*  hermes_logging
#     hermes_time  hermes_bootstrap  hermes_agent.egg-info
# The rules below never match a bare ``hermes_<lowercase>`` token, which is
# what protects them — see ``test_rebrand_rules.py``.

RULES: list[Rule] = [
    # ── Phase 2: runtime identity ────────────────────────────────────────
    Rule(
        id="env-prefix",
        phase=2,
        # Uppercase-only, so lowercase module names (hermes_cli) are safe.
        pattern=r"\bHERMES_([A-Z][A-Z0-9_]*)\b",
        replacement=r"AGENTX_\1",
        note="HERMES_* environment variables -> AGENTX_*",
    ),
    Rule(
        id="config-dir-posix",
        phase=2,
        # ``.hermes`` as a PATH SEGMENT: ~/.hermes, /root/.hermes, ".hermes".
        #
        # The lookbehind is what makes this safe. A dotted token whose left
        # side is a word character is an attribute or a data key, not a path,
        # and those must survive:
        #     _meta.hermes      ACP protocol extension namespace
        #     metadata.hermes   skill-frontmatter key (renaming it would
        #                       orphan every skill file already on disk)
        #     mcp.hermes-tools  MCP server name in codex config
        # A real path segment is always preceded by / ~ " ' ` : = or nothing.
        #
        # The trailing (?![.\w]) leaves ``.hermes.md`` to the next rule and
        # keeps ``.hermesHome``-style camelCase properties intact.
        pattern=r"(?<![A-Za-z0-9_])\.hermes(?![.\w])",
        replacement=".agentx",
        note="~/.hermes config directory -> ~/.agentx",
    ),
    Rule(
        id="project-config-file",
        phase=2,
        pattern=r"\.hermes\.md\b",
        replacement=".agentx.md",
        note="per-project .hermes.md instruction file -> .agentx.md",
    ),
    Rule(
        id="project-config-file-upper",
        phase=2,
        # The uppercase sibling of .hermes.md (see _HERMES_MD_NAMES in
        # agent/prompt_builder.py). No other rule reaches it: env-prefix
        # needs a trailing underscore and display-name-short only matches
        # the capitalised "Hermes", not "HERMES".
        pattern=r"\bHERMES\.md\b",
        replacement="AGENTX.md",
        note="per-project HERMES.md instruction file -> AGENTX.md",
    ),
    Rule(
        id="config-dir-windows",
        phase=2,
        pattern=r"(LOCALAPPDATA[%}]?[\\/])hermes\b",
        replacement=r"\1agentx",
        note="%LOCALAPPDATA%\\hermes -> %LOCALAPPDATA%\\agentx",
    ),
    # ── Phase 3: CLI surface ─────────────────────────────────────────────
    Rule(
        id="cli-command",
        phase=3,
        # `hermes` as a standalone lowercase token — which, in this tree, is
        # always the command a user types (`hermes setup`, `prog="hermes"`,
        # a bare `hermes` in backticks).
        #
        # The guards carve out everything that is NOT the command:
        #   preceded by [A-Za-z0-9_]  -> hermes_cli, get_hermes_home, MyHermes
        #   preceded by . / -         -> ~/.hermes, /api/hermes/, x-hermes
        #   followed by [A-Za-z0-9_]  -> hermesDesktop, hermes_state
        #   followed by . / -         -> hermes-agent, hermes.nousresearch.com
        # Enumerating the ~200 subcommands instead would silently miss any
        # subcommand added later.
        pattern=r"(?<![A-Za-z0-9_./-])hermes(?![A-Za-z0-9_./-])",
        replacement="agentx",
        note="bare `hermes` CLI command -> `agentx`",
    ),
    Rule(
        id="acp-prog",
        phase=3,
        pattern=r"\bhermes-acp\b",
        replacement="agentx-acp",
        note="hermes-acp entry point -> agentx-acp",
    ),
    Rule(
        id="gateway-prog",
        phase=3,
        pattern=r"\bhermes-gateway\b",
        replacement="agentx-gateway",
        note="hermes-gateway entry point -> agentx-gateway",
    ),
    Rule(
        id="brand-glyph",
        phase=3,
        pattern="⚕",
        replacement="⬡",
        note="caduceus (Hermes' staff) -> hexagon brand glyph",
    ),
    Rule(
        id="display-name-full",
        phase=3,
        pattern=r"\bHermes Agent\b",
        replacement="AgentX Workmate",
        note='"Hermes Agent" display string -> "AgentX Workmate"',
    ),
    Rule(
        id="display-name-desktop",
        phase=3,
        pattern=r"\bHermes Desktop\b",
        replacement="AgentX Workmate Desktop",
        note='"Hermes Desktop" -> "AgentX Workmate Desktop"',
    ),
    Rule(
        id="display-name-short",
        phase=3,
        # Bare capitalised Hermes in prose/UI. Runs last so the multi-word
        # display names above have already claimed their occurrences.
        pattern=r"\bHermes\b",
        replacement="AgentX",
        note='bare "Hermes" display string -> "AgentX"',
    ),
]

RULES_BY_ID = {r.id: r for r in RULES}


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


def read_text(path: Path) -> str | None:
    """Return file text, or None if it is binary / undecodable."""
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


def run(rules: list[Rule], *, apply: bool) -> int:
    files = tracked_files()
    per_rule: dict[str, int] = {r.id: 0 for r in rules}
    per_rule_files: dict[str, int] = {r.id: 0 for r in rules}
    changed_files = 0

    for rel in files:
        path = REPO_ROOT / rel
        if not path.is_file() or path.is_symlink():
            continue
        applicable = [r for r in rules if r.matches_path(rel)]
        if not applicable:
            continue
        original = read_text(path)
        if original is None:
            continue
        text = original
        for rule in applicable:
            text, n = re.subn(rule.pattern, rule.replacement, text)
            if n:
                per_rule[rule.id] += n
                per_rule_files[rule.id] += 1
        if text != original:
            changed_files += 1
            if apply:
                path.write_text(text, encoding="utf-8")

    verb = "Rewrote" if apply else "Would rewrite"
    print(f"\n{verb} {changed_files} files\n")
    print(f"{'rule':<24} {'hits':>8} {'files':>8}   note")
    print("-" * 96)
    for rule in rules:
        print(
            f"{rule.id:<24} {per_rule[rule.id]:>8} {per_rule_files[rule.id]:>8}   {rule.note}"
        )
    total = sum(per_rule.values())
    print("-" * 96)
    print(f"{'TOTAL':<24} {total:>8}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="rebrand/apply.py", description=__doc__)
    ap.add_argument("--list", action="store_true", help="print the rule table and exit")
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    ap.add_argument("--dry-run", action="store_true", help="explicit no-op default")
    ap.add_argument("--rule", action="append", default=[], help="run only this rule id (repeatable)")
    ap.add_argument("--phase", type=int, action="append", default=[], help="run every rule in this phase")
    args = ap.parse_args()

    if args.list:
        for r in RULES:
            print(f"[phase {r.phase}] {r.id:<24} {r.note}")
        return 0

    selected = RULES
    if args.rule:
        unknown = [r for r in args.rule if r not in RULES_BY_ID]
        if unknown:
            print(f"unknown rule id(s): {', '.join(unknown)}", file=sys.stderr)
            return 2
        selected = [r for r in RULES if r.id in set(args.rule)]
    if args.phase:
        selected = [r for r in selected if r.phase in set(args.phase)]
    if not selected:
        print("no rules selected", file=sys.stderr)
        return 2

    return run(selected, apply=args.apply)


if __name__ == "__main__":
    raise SystemExit(main())
