#!/usr/bin/env python3
"""Fail the build if upstream branding leaks back into a user-visible surface.

This is the regression gate for the AgentX Workmate rebrand.  Without it the
rename is a one-off sweep that quietly rots as new code lands; with it, any
commit that reintroduces the old brand in something a user can see fails CI.

HOW IT DECIDES
--------------
Four patterns are searched for.  ``brand-token`` finds ``hermes`` outside an
internal snake_case identifier; the other three find the caduceus glyph, the
upstream vendor name and the upstream domain.

Every hit is then checked against :data:`ALLOWED`.  A hit is suppressed only
when an allowed pattern matches at a span that *covers* it — so
``NousResearch/hermes-agent/issues/10454`` is allowed while a bare
``NousResearch/hermes-agent`` on the same line is not.  Matching per
occurrence rather than per line is what keeps the allowlist from becoming a
blanket pardon for whatever else shares a line with it.

Each entry in :data:`ALLOWED` says why it exists.  Adding one is a decision
that the name is genuinely not ours to rename — a third party's package, a
model slug a provider API expects, a wire format, a real person's address, a
source file the imports resolve through, or an internal identifier §2 of the
rebrand plan deliberately kept.  Anything else belongs in the rename, not
here.

WHAT STILL FAILS
----------------
A new ``HERMES_`` environment variable, ``~/.hermes``, ``Hermes Agent`` in a
string, a bare ``hermes`` command in prose or a doc link to the old host all
still fail — none of them is covered by an allowed pattern.

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
#
# Keep this list short.  A path glob pardons everything in the file forever,
# including a real regression that lands there later, so prefer an ALLOWED
# pattern whenever the exemption can be expressed as one.
ALLOWLIST = [
    # MIT requires the original copyright notice to survive redistribution.
    "LICENSE",
    # Pre-change test evidence: it describes the tree as it was.
    ".rebrand-baseline/*",
    # This tooling names the old brand on purpose, in patterns and in prose.
    "scripts/rebrand/*",
    # The rule-edge tests: the old names ARE the fixtures. Renaming them turns
    # every rename assertion into an identity check that can never fail.
    "tests/test_rebrand_rules.py",
    # This gate's own tests, for the same reason: they feed it the strings it
    # must reject, so the file is a wall of deliberate old brand names.
    "tests/test_branding_gate.py",
    # Generated, and carrying upstream package URLs.
    "uv.lock",
    "package-lock.json",
    "*/package-lock.json",
    "flake.lock",
    # Contributor identity data. Every entry is a real person's commit address
    # or account; rewriting one falsifies an attribution.
    ".mailmap",
    "contributors/*",
    "scripts/release.py",
]

# ``hermes`` preceded by [a-z0-9_] or followed by _[a-z] is an internal
# snake_case identifier and is allowed outright — Python module names
# (hermes_cli, hermes_constants), attributes and locals (hermes_home,
# get_hermes_home).  Those are the names §2 of the rebrand plan keeps so the
# diff against upstream stays reviewable and merges keep working.
#
# The case-insensitivity is scoped to the WORD, deliberately.  A global
# ``re.IGNORECASE`` also folds the ``[a-z]`` in the trailing guard, so ``_H``
# satisfied "followed by an underscore and a lowercase letter" and
# ``HERMES_HOME`` — the single most likely regression, and the first example
# in this module's own docstring — was silently allowed.
BRAND_RE = re.compile(r"(?<![a-z0-9_])(?i:hermes)(?!_[a-z])")

CHECKS = [
    ("brand-token", BRAND_RE, "'hermes' outside an internal snake_case identifier"),
    # Both caduceus codepoints. U+2695 is the one the first sweep knew about;
    # U+2624 is the one the READMEs and the share-card actually used, so a gate
    # that checked only the first called them clean.
    ("caduceus-glyph", re.compile("[⚕☤]"), "Hermes' staff — use the ⬡ brand glyph"),
    ("vendor-name", re.compile(r"Nous\s?Research", re.IGNORECASE), "upstream vendor name"),
    ("vendor-domain", re.compile(r"nousresearch\.com"), "upstream domain"),
    # Transliterations are invisible to every ASCII check: README.ur-pk.md kept
    # the product name in Urdu through several sweeps that reported it clean.
    ("brand-transliteration", re.compile("ہرمیس"), "transliterated old product name"),
]

# ── Names that are genuinely not ours to rename ───────────────────────────
#
# Each entry suppresses a hit only where the pattern actually matches, so the
# rest of the line is still checked.
ALLOWED: list[tuple[str, re.Pattern[str], str]] = [
    # -- Third parties that happen to share the name -----------------------
    (
        "meta-js-engine",
        re.compile(r"hermes-(?:parser|estree|eslint)[\w.-]*"),
        "Meta's JavaScript-engine packages, ordinary npm dependencies",
    ),
    (
        "third-party-repos",
        re.compile(
            r"(?:stephenschoettler/)?hermes-lcm\b|hermes-lcm#\d+"
            r"|ogallotti/rtk-hermes|rtk-hermes"
            r"|(?i:hermesclaw)"
            r"|(?:extensions/|OpenClaw's )?migrate-hermes(?![\w-])"
            r"|hermes-seaeye"
        ),
        "other people's projects: a context-engine plugin, an RTK fork, "
        "OpenClaw's migration extension, a GitHub bot account",
    ),
    (
        "nous-other-artifacts",
        re.compile(
            r"NousResearch/(?:Hermes-Agent[\w.-]*|Hermes3|Hermes-3[\w.-]*"
            r"|Nous-Hermes[\w.-]*|hermes-example-plugins[\w.-]*"
            r"|hermes-agent-megascience[\w-]*|terminal-tasks-glm-hermes-agent)"
            r"|`?hermes-example-plugins`?"
        ),
        "Nous's OTHER repos and HuggingFace artifacts — only "
        "NousResearch/hermes-agent was this product",
    ),
    # -- Model slugs sent to provider APIs ---------------------------------
    (
        "nous-model-slugs",
        re.compile(
            # The separator is `[-_ ]?`: providers and fixtures spell the same
            # family `hermes-4-70b`, `hermes_4_70b` and `Hermes 4`.
            r"(?i:nousresearch/)?(?i:nous[-_ ])?(?i:hermes)[-_ ]?\d[\w.-]*"
            r"|(?i:hermes)-[xy](?![\w-])"
            r"|Hermes\s+\d"
            r"|(?i:hermes)-brain[\w:.-]*"
            r"|#a-note-on-hermes-4"
            r"|(?i:nousresearch)/hermes-[34][\w.*-]*"
        ),
        "Nous's Hermes model families; renaming one turns a working request "
        "into a 404, and hermes-brain is the counter-example a filter test "
        "depends on starting with the word",
    ),
    (
        "model-detection",
        re.compile(
            # hermes_cli/model_switch.py detects Nous's chat models by name, so
            # its regex, its comments about that regex, and the substring it
            # replaced all have to spell the model family.
            r"\(\?:\^\|\[/:\]\)hermes\[-_ \]\?\[34\][^\n]*"
            r"|\"hermes\" in name\.lower\(\)"
            r"|carry \"hermes\" in their tag"
            r"|\"hermes\", \"llama\""
            r"|r/hermesagent"
        ),
        "the Nous-model detector's own pattern and the comments explaining it, "
        "plus a third-party community name",
    ),
    # -- Wire formats and on-disk keys -------------------------------------
    (
        "wire-namespaces",
        re.compile(
            r"_meta\.hermes|_meta\[.hermes.\]|\"hermes\":\s*\{"
            r"|meta\[[\"']hermes[\"']\]|== \{\"hermes\"\}|keys\(\)\) == \{\"hermes\"\}"
            r"|\[[\"']metadata[\"']\]\[[\"']hermes[\"']\]"
            r"|\"\s+hermes:\",|'\s+hermes:',"
            r"|metadata\.hermes[\w.]*|metadata\[.hermes.\]"
            # The four readers of the frontmatter key, and the fixtures that
            # feed them. All spell the key as a dict lookup, not a dotted path.
            r"|(?:meta|metadata|fm|front[\w]*)\.get\(\s*[\"']hermes[\"']"
            r"|\.get\(\s*[\"']hermes[\"']\s*[,)]"
            r"|^\s*hermes:\s*$|\\n\s*hermes:\\n|\"\s*hermes:\\n\""
            r"|hermes:\\n"
            r"|\bhermes-tools(?![\w-])"
            # The snake_case module prefix, written as a glob or an f-string
            # where the trailing `_[a-z]` the main rule looks for is absent.
            r"|hermes_(?=[*{\"'\s)]|\{)"
        ),
        "the ACP _meta extension namespace, the skill-frontmatter key kept for "
        "agentskills.io compatibility, and the MCP server name in codex config",
    ),
    (
        "legacy-migration",
        re.compile(r"hermes\.service|hermes\.desktop|hey_hermes[\w.]*"),
        "deliberate references to a PRE-rename name: the allowlists that find "
        "and remove units and entries left by older installs, and the wake-word "
        "model, which is trained on that phrase",
    ),
    # -- Directories and source files kept on disk (§2) --------------------
    (
        "kept-paths",
        re.compile(
            r"hermes-ink[\w.-]*|hermes-achievements[\w.-]*|hermes-0day"
            r"|@/(?:types/)?hermes(?![\w-])"
            r"|use-hermes-config[\w.]*|windows-hermes-path[\w.]*"
            r"|(?:\./|\.\./|src/|/)hermes(?:-cron-scope|-parity|-profile-scope)?"
            r"(?:\.test)?\.tsx?"
            r"|from '\.{1,2}/hermes'|import\('\.{1,2}/hermes'\)"
            r"|hermes_tools|openclaw_to_hermes[\w.]*|_hermes_home[\w.]*"
            # The same kept file names reached by a relative specifier rather
            # than the `@/` alias.
            r"|(?:\.\.?/)+(?:src/)?types/hermes(?![\w-])"
        ),
        "npm/plugin directories and the source FILE names imports resolve "
        "through — renaming a specifier without its file is an unresolved import",
    ),
    (
        "internal-identifiers",
        re.compile(
            # A camelCase/PascalCase identifier that merely contains the word.
            r"(?<![A-Za-z0-9_])(?:"
            r"[A-Za-z_][A-Za-z0-9_]*[Hh]ermes[A-Za-z0-9_]*"
            # `HermesAgent` and `HermesDesktop` in PascalCase were product
            # names (an outbound User-Agent token and an app title), so they
            # stay flagged; the lowercase-initial `hermesAgent` is a nix
            # attribute and an ordinary variable.
            r"|Hermes(?!Agent(?![a-z])|Desktop(?![a-z])|Workmate)[A-Z][A-Za-z0-9_]*"
            r"|hermes[A-Z][A-Za-z0-9_]*"
            r")(?![A-Za-z0-9_])"
        ),
        "internal class, type and variable names kept per §2 so the diff "
        "against upstream stays reviewable; the guard still catches "
        "HermesAgent / HermesDesktop, which are product names",
    ),
    # -- Upstream provenance ------------------------------------------------
    (
        "upstream-citations",
        re.compile(
            r"(?i:nousresearch)/hermes-agent"
            r"(?:#\d+|/(?:issues|pull|pulls|discussions|compare)/\d+)"
        ),
        "numbered issue and PR citations; those numbers exist in Nous's "
        "tracker and nowhere else, so repointing them breaks a correct link",
    ),
    # -- Nous the LLM PROVIDER, not Nous the upstream author ----------------
    (
        "provider-hosts",
        re.compile(
            r"(?:portal|inference|inference-api|stg-inference-api|api"
            r"|tool-gateway|firecrawl-gateway|openai-audio-gateway"
            r"|gateway-gateway|agent-\d+\.agents|nas-[\w-]+)"
            r"[\w.-]*\.(?:staging-)?nousresearch\.(?:com|wtf)"
            r"|portal\.staging-nousresearch\.com"
            # The Tool Gateway derives its per-service hosts from this domain,
            # so the bare value is a configuration default, not a brand string.
            r"|(?i:TOOL_GATEWAY_DOMAIN)[^\n]{0,60}?nousresearch\.com"
            r"|nousresearch\.com(?=[\"'`]?\s*(?:->|→|\)|,|\||$))"
            # The provider's own signup and marketing site, linked from the
            # provider plugin and the Portal integration page.
            r"|signup_url\s*=\s*\"https://nousresearch\.com/?\""
            r"|https://nousresearch\.com(?=[\"')\s]|$)"
            # Negative fixtures for base_url_host_matches: lookalike hosts that
            # must NOT match the provider domain (a suffix graft and a path
            # segment).  The provider host above is deliberately kept, so its
            # spoofing tests have to name it too.
            r"|nousresearch\.com\.evil\.io"
            r"|proxy\.example/nousresearch\.com"
        ),
        "the LLM provider's OAuth, inference and gateway hosts — rebranding "
        "one breaks authentication",
    ),
    (
        "provider-identity",
        re.compile(
            r"Nous\s?Research(?=\s*(?:'s)?\s+(?:Hermes|Portal|design|models))"
            r"|(?<=charge )Nous Research|(?<=authorize )Nous Research"
            r"|(?<=allow )Nous Research"
            r"|(?<=Sign in with )Nous Research"
            r"|(?<=OAuth gate ON via )Nous Research"
            r"|display_name\s*=\s*\"Nous Research\""
            r"|providerLabel:\s*'Nous Research'"
            r"|/ Nous Research'|Nous Research\)'"
            r"|\"nous\"|'nous'|nous-portal|\"nousresearch\"|Nous Portal"
            r"|Nous\s?Research(?=\s*[—-]\s*(?:Hermes|AgentX))"
            r"|Nous\s?Research(?=\s*(?:的|自有|自家))"
            # Prose in the Portal / provider pages describing the provider.
            r"|Nous Research(?='s (?:unified|own|subscription))"
            r"|Nous\s?Hermes(?=\s+(?:chat|3|4|LLM|non))"
            r"|(?<=e\.g\.\n// )Nous Research|Nous Research(?=\)\s*instead of)"
            r"|\[Nous Research(?: provider)?\]\(#default-provider-nous-research\)"
            r"|the actual Nous Research"
            r"|Nous Research(?=\.$|\.\s|'s (?:own|unified|subscription))"
            r"|(?<=guidance from )Nous Research|(?<=verified against your )Nous"
            r"|Default provider: Nous Research"
            r"|portal\.nousresearch\.com/[\w-]+"
            r"|#default-provider-nous-research"
            r"|(?<=Continue with )Nous Research|(?<=Default provider: )Nous Research"
            r"|(?<=Worked example: )Nous Research"
            r"|Nous Research(?= has been inducted)"
            r"|(?<=and )Nous Research(?=\.$)"
            # The provider-id membership tests and base-URL sniffs that route a
            # request to Portal. Renaming any of them silently unroutes it.
            r"|_is_nous\w*\s*=\s*\"nousresearch\"|\"nousresearch\" in "
        ),
        "the provider's display name, its billing-consent text naming the "
        "entity that charges the card, the OAuth button label, and the "
        "provider-id membership tests that route a request to Portal",
    ),
    (
        "nous-owned-repos",
        re.compile(
            r"NousResearch/(?:pokemon-agent|gateway-gateway|kanban-video-pipeline"
            r"|atropos|autoreason|swe-terminus[\w-]*|nous-account-service"
            r"|dataset-name|Llama-[\w.-]+|hermes)(?![\w-])"
            r"|github\.com/NousResearch(?![\w/-])"
        ),
        "other repositories in the Nous org that this product references but "
        "does not own",
    ),
    (
        "contributor-addresses",
        re.compile(r"[A-Za-z0-9._%+-]+@nousresearch\.com|hermes@[\w.-]+"),
        "real contributors' commit addresses",
    ),
    (
        "derivative-work-credit",
        re.compile(
            r"NousResearch \((?:plugin port|AgentX plugin port)\)"
            r"|original work by NousResearch"
            r"|Modifications by NousResearch"
            r"|NousResearch, MIT-licensed"
            r"|by `?world_sim`? by Nous Research|by Nous Research\""
            r"|Nous Research has a winner here"
        ),
        "third-party derivative-work notices: who actually ported or adapted "
        "somebody else's code, and quotes from named people. Rewriting either "
        "would state something untrue about a third party",
    ),
    (
        "third-party-docs-and-flags",
        re.compile(
            # Honcho documents its own AgentX integration on a page whose slug
            # is the old product name; the URL is theirs to change, not ours.
            r"docs\.honcho\.dev/[\w/.-]*hermes[\w#-]*"
            r"|running-honcho-locally-with-hermes"
            # get-shit-done-cc is somebody else's CLI and `--hermes` is its
            # flag; renaming it makes the documented command fail.
            r"|get-shit-done-cc --hermes"
            # A community sample repository on GitHub.
            r"|(?:[\w-]+/)?sample-hermes-agent-on-aws-with-bedrock"
        ),
        "third parties' documentation slugs, CLI flags and sample repos",
    ),
    (
        "electron-executable",
        re.compile(r"(?:linux-unpacked|\.mount_\w+)/hermes(?![\w.-])"),
        "the unpacked Electron binary, named by the desktop build config "
        "rather than by any rule here",
    ),
    (
        "provider-display-name",
        re.compile(r"displayName:\s*'Nous Research'|display_name == \"Nous Research\""),
        "the provider entry's display name, asserted by the desktop and "
        "dashboard-auth tests",
    ),
    # -- Deliberate non-brand uses of the glyph -----------------------------
    (
        "unicode-fixtures",
        re.compile(r"[⚕☤]"),
        "arbitrary non-ASCII used to prove a round-trip or a key ordering, "
        "not a brand mark",
    ),
]

# unicode-fixtures is the one entry that cannot be expressed as a pattern
# alone — the same codepoint is a brand mark everywhere else — so it is
# additionally scoped to the two test files that use it as test data.
ALLOWED_SCOPES = {"unicode-fixtures": ["tests/agent/*"]}


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


def allowed_file(rel: str) -> bool:
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


def _allowed_spans(rel: str, line: str) -> list[tuple[int, int]]:
    """Return the character ranges of ``line`` covered by an allowed name."""
    spans: list[tuple[int, int]] = []
    for name, pattern, _why in ALLOWED:
        scope = ALLOWED_SCOPES.get(name)
        if scope and not any(fnmatch.fnmatch(rel, pat) for pat in scope):
            continue
        spans.extend(m.span() for m in pattern.finditer(line))
    return spans


def violations_in(rel: str, line: str) -> list[str]:
    """Return the names of the checks this line violates."""
    spans = _allowed_spans(rel, line)
    hits: list[str] = []
    for name, pattern, _desc in CHECKS:
        for match in pattern.finditer(line):
            start, end = match.span()
            if any(a <= start and end <= b for a, b in spans):
                continue
            hits.append(name)
            break
    return hits


def main() -> int:
    ap = argparse.ArgumentParser(prog="check_branding.py", description=__doc__)
    ap.add_argument("--summary", action="store_true", help="counts only, no examples")
    ap.add_argument("--max", type=int, default=8, help="examples shown per category")
    args = ap.parse_args()

    categories: dict[str, list[tuple[str, int, str]]] = {}

    for rel in tracked_files():
        if allowed_file(rel):
            continue
        path = REPO_ROOT / rel
        if not path.is_file() or path.is_symlink():
            continue
        text = read_text(path)
        if text is None:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            for name in violations_in(rel, line):
                categories.setdefault(name, []).append((rel, lineno, line.strip()[:120]))

    if not categories:
        print("✓ no upstream branding found in user-visible surfaces")
        return 0

    descriptions = {name: desc for name, _p, desc in CHECKS}

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
