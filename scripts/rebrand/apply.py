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

# Paths whose *content* must never be rewritten by any rule.
#
# tests/test_rebrand_rules.py is here because it is the one file that must
# keep the old names: they are its fixtures. Left unexcluded, the first
# --apply run rewrote ("HERMES_HOME", "AGENTX_HOME") into
# ("AGENTX_HOME", "AGENTX_HOME") and every rename assertion silently became
# an identity check that can never fail.
GLOBAL_EXCLUDE = [
    "LICENSE",  # MIT requires the original copyright notice to survive
    "uv.lock",  # generated
    "package-lock.json",
    "*/package-lock.json",
    "flake.lock",
    "scripts/rebrand/*",  # this tooling names the old brand on purpose
    "tests/test_rebrand_rules.py",  # old names are its test fixtures
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
        # Uppercase-only, which is what keeps lowercase module names
        # (hermes_cli, hermes_constants) safe — no word boundaries needed.
        #
        # Boundaries were tried and removed. A leading \b silently skipped
        # every occurrence sitting after an escape in a string literal:
        # in `f'...\nHERMES_BIN=...'` the source character before H is the
        # `n` of `\n`, so \b never matched. That left install.sh reading
        # $AGENTX_BIN while its test still set HERMES_BIN, and the generated
        # launcher came out as `exec "" "$@"`. The same miss broke a heredoc
        # in nix/nixosModules.nix, where the opening delimiter was renamed
        # and the closing one was not. A trailing \b likewise skipped the
        # plural in prose ("zombie HERMES_HOMEs").
        #
        # Matching unanchored also renames private constants like
        # _HERMES_HOME_OVERRIDE. That is fine: every occurrence moves
        # together, so no reference is left dangling.
        #
        # Nothing follows the underscore in the pattern either. Requiring an
        # uppercase letter there skipped the prefix wherever it is spelled
        # with a metacharacter next — the ready-sentinel regexes
        # (/^HERMES_(?:BACKEND|DASHBOARD)_READY/) and glob prose (HERMES_*).
        # That desynced the desktop's port scraper from the Python side that
        # had already switched to AGENTX_DASHBOARD_READY, and every remote
        # spawn test timed out waiting for an announcement that now used the
        # other spelling.
        pattern=r"HERMES_",
        replacement="AGENTX_",
        note="HERMES_ prefix (env vars, constants, regexes, globs) -> AGENTX_",
    ),
    Rule(
        id="titlecase-prefix",
        phase=2,
        # Windows spells these in Title_Case: the scheduled-task name shown in
        # Task Scheduler (Hermes_Gateway) and the Environment registry value
        # (Hermes_Home). The uppercase env-prefix rule cannot see them, so the
        # registry parser's case-insensitivity test ended up looking up
        # AGENTX_HOME against a fixture that still said Hermes_Home.
        pattern=r"\bHermes_",
        replacement="AgentX_",
        note="Title_Case Hermes_ prefix (Windows task/registry names) -> AgentX_",
    ),
    Rule(
        id="bot-username",
        phase=2,
        # The sample Telegram bot handle. It belongs to phase 6 by topic, but
        # it has to move now: env-prefix already rewrote the uppercase spelling
        # (@HERMES_BOT, used to test that Telegram usernames compare
        # case-insensitively) while leaving the lowercase fixture behind, so
        # the two no longer describe the same handle.
        pattern=r"\bhermes_bot\b",
        replacement="agentx_bot",
        note="sample Telegram bot username hermes_bot -> agentx_bot",
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
        # The trailing (?![-.\w]) leaves ``.hermes.md`` to the next rule and
        # keeps ``.hermesHome``-style camelCase properties intact.
        #
        # The '-' in that class is load-bearing. Without it this rule also
        # matched kebab tokens like ``.hermes-kanban-card`` — but only the
        # occurrences at a selector start, because the lookbehind blocked
        # ``summary.hermes-kanban-run-meta-label``. The result was 180 tokens
        # renamed in one place and not the other, including a CSS selector
        # pair that no longer matched anything. Kebab tokens are a separate
        # concern with their own phase; this rule owns the config directory
        # only.
        # %2F is a path separator too — the desktop passes media paths through
        # /api/fs URLs, and there the preceding character is the F of %2F,
        # which the plain lookbehind reads as a word character and skips.
        pattern=r"(?:(?<=%2F)|(?<=%2f)|(?<![A-Za-z0-9_]))\.hermes(?![-.\w])",
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
        # Two spellings of the same directory reach it:
        #   %LOCALAPPDATA%\hermes  $env:LOCALAPPDATA\hermes  ${LOCALAPPDATA}/hermes
        #   C:\Users\x\AppData\Local\hermes   (expanded, as in the e2e fixtures)
        # [\\/]+ rather than [\\/] because TypeScript/Python source escapes the
        # separator: the file literally contains AppData\\Local\\hermes.
        # (?![-\w]) for the same reason as config-dir-posix: \b alone matched
        # the `hermes` inside `AppData\Local\hermes-desktop`, which is the
        # desktop app's own install directory and a different token.
        pattern=r"(?i)((?:LOCALAPPDATA[%}]?|AppData[\\/]+Local)[\\/]+)hermes(?![-\w])",
        replacement=r"\1agentx",
        note="%LOCALAPPDATA%\\hermes and AppData\\Local\\hermes -> ...\\agentx",
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
