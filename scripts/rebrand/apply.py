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
    "REBRAND.md",  # the handoff plan names the old brand on purpose
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
        id="env-suffix",
        phase=4,
        # The brand also appears as the LAST segment of an env var, where
        # env-prefix cannot see it: AGENTX_DESKTOP_HERMES (the desktop's
        # backend-command override, used by the Nix packaging) and
        # AGENTX_WIN_SSH_HERMES (the remote CLI under test).
        #
        # ``AGENTX`` and not ``AGENT`` in the replacement, because phase 2
        # already shipped the sibling AGENTX_DESKTOP_AGENTX_ROOT and the two
        # name the same thing. Documented in website/docs, which is why this
        # rule is the one phase-4 rule that is not held back from website/*:
        # an env var name is an exact identifier, not prose, and a doc that
        # names the old one tells the reader to export a variable nothing reads.
        #
        # No \b on either end — the same escape-sequence trap env-prefix
        # documents, plus a trailing underscore would reintroduce it.
        pattern=r"(?:(?<=\\n)|(?<=\\t)|(?<![A-Za-z0-9_]))AGENTX_((?:[A-Z0-9]+_)*)HERMES(?![A-Za-z0-9_])",
        replacement=r"AGENTX_\1AGENTX",
        note="brand as an env var SUFFIX, AGENTX_*_HERMES -> AGENTX_*_AGENTX",
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
        # The trailing guard splits the dot case rather than banning it. A dot
        # followed by a word character is a longer token — `.hermes.md`, which
        # the next rule owns — but a dot followed by anything else is just the
        # end of a sentence, and `(?![-.\w])` skipped all 21 of those: every
        # docstring and comment that says "never write to the real ~/.hermes."
        # kept naming a directory the product stopped using in phase 2.
        pattern=r"(?:(?<=%2F)|(?<=%2f)|(?<![A-Za-z0-9_]))\.hermes(?![-\w])(?!\.[\w-])",
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
    #
    # website/** is still deferred to phase 9. apps/** was deferred while
    # phase 3 ran — renaming a token here whose desktop counterpart still
    # spelled it the old way is the exact failure mode phase 2 kept hitting —
    # and released in phases 4 (desktop) and 5 (bootstrap installer), which
    # move the rest of those surfaces in the same commits. The rule table
    # describes the final state; the phase tag only records the order.
    Rule(
        id="cli-command",
        phase=3,
        # `hermes` as a standalone lowercase token, which in this tree is
        # always the command a user types (`hermes setup`, `prog="hermes"`,
        # a bare `hermes` in backticks). Enumerating the ~200 subcommands
        # instead would silently miss any subcommand added later.
        #
        # The guards carve out everything that is NOT the command:
        #   preceded by [A-Za-z0-9_] -> hermes_cli, get_hermes_home
        #   preceded by . / -        -> ~/.hermes, /api/hermes/, x-hermes
        #   preceded by @ or :       -> @hermes:example.org, chown hermes:hermes
        #   followed by [A-Za-z0-9_] -> hermesDesktop, hermes_state
        #   followed by . / -        -> hermes-agent, hermes.example.com
        #   followed by :            -> 'hermes:found-in-page' (Electron IPC),
        #                               `  hermes:` (skill frontmatter key)
        # and two more for the vendor namespace inside data, which reaches
        # here as an ordinary quoted token:
        # A `.get("hermes")` guard used to live here too. It was removed once
        # the two protected namespaces moved to file-level exclusions: as a
        # pattern it also blocked honcho's own per-host lookup, so the config
        # writer moved to "agentx" while the reader kept asking for "hermes"
        # and every stored host block became unreachable.
        #
        # The leading guard also admits an escape sequence, the same trap
        # env-prefix hit: in "#!/bin/bash\\nhermes gateway restart\\n" the
        # character before the token is the `n` of \\n, which reads as a word
        # character. Those strings are the scripts the lifecycle guard scans,
        # so missing them left the guard's own fixtures naming a command it
        # no longer recognises.
        # The trailing guard is a bare `:` and not `["\']\s*:` on purpose.
        # Blocking the quoted form too also blocked every ordinary JSON key
        # that names the product — honcho's per-host override block is
        # {"hosts": {"hermes": {...}}}, and leaving that behind while the
        # lookup moved to "agentx" silently dropped the override. The two
        # namespaces that genuinely must not move (ACP _meta, skill
        # frontmatter) are held back by file, not by pattern.
        pattern=r'(?:(?<=\\n)|(?<=\\t)|(?<![A-Za-z0-9_./@:-]))hermes(?![A-Za-z0-9_./:@-])',
        replacement="agentx",
        note="bare `hermes` CLI command -> `agentx`",
        exclude=[
            # A list of model-family substrings ("claude", "qwen", "hermes", …)
            # matched against the *model* name to pick an edit format. The
            # entry names Nous's Hermes models, not this product.
            "agent/coding_context.py",
            # Detects Nous's Hermes 3/4 chat models by regex to warn that they
            # are not tool-call-tuned. Renaming the pattern makes the check
            # match nothing, so the warning silently stops firing.
            "hermes_cli/model_switch.py",
            # The two vendor namespaces that must survive verbatim. ACP's
            # _meta extension key is a wire format; the skill-frontmatter key
            # is read from SKILL.md files already on disk, and renaming it
            # would orphan every one of them.
            "acp_adapter/provenance.py",
            "acp_adapter/server.py",
            "agent/skill_utils.py",
            "agent/learning_graph.py",
            "tools/blueprints.py",
            "tools/skills_tool.py",
            "skills/*",
            "optional-skills/*",
            "tests/acp/test_session_provenance.py",
            "tests/tools/test_skills_tool.py",
            # Same namespace, three more readers. The generator is the one
            # that matters: it had already been left reading `metadata.agentx`
            # while all 168 SKILL.md files on disk still say `hermes:`, so the
            # skills catalog it writes came out with empty metadata.
            "tests/tools/test_skills_hub.py",
            "tests/skills/test_grounded_citations_skill.py",
            "website/scripts/generate-skill-docs.py",
            # The fourth reader of the same key, and the one phase 9 exposed:
            # its `metadata.get("hermes", {})` is quoted on both sides, and a
            # quote is in neither of this rule's guard classes. Unexcluded, the
            # sweep would have moved the lookup while all 169 SKILL.md files
            # kept the key, emptying the skills index the site builds from.
            "website/scripts/extract-skills.py",
        ],
    ),
    Rule(
        id="cli-launcher-path",
        phase=3,
        # The launcher file on PATH, as an installed path rather than a bare
        # command: /usr/local/bin/hermes, $command_link_dir/hermes,
        # venv/bin/hermes, $INSTALL_DIR/hermes.
        #
        # cli-command cannot claim these — it refuses anything after a slash,
        # which is what keeps it off ~/.hermes and /api/hermes/. But leaving
        # them behind is worse than either: install.sh already logs
        # "Installed agentx launcher" while writing a file named hermes.
        #
        # Anchoring on bin/ and *_dir/ *_DIR/ is what separates the launcher
        # from the Electron executable (release/linux-unpacked/hermes, whose
        # name comes from the desktop build config in phase 4) and from the
        # install root (/usr/local/lib/hermes-agent, phase 5).
        #
        # `./hermes` — the launcher run from a checkout — is deliberately NOT
        # in this alternation, and lives in cli-launcher-relative below. In
        # apps/desktop the identical characters are a RELATIVE IMPORT of
        # src/hermes.ts, a source file whose name we keep (§2); releasing
        # apps/* onto the combined rule rewrote six `from './hermes'`
        # specifiers into modules that do not exist, which tsc caught as
        # "Cannot find module './agentx'".
        pattern=r"(bin|_dir|_DIR)([/\\]+)hermes(?![A-Za-z0-9_./:@-])",
        replacement=r"\1\2agentx",
        note="installed launcher path .../bin/hermes -> .../bin/agentx",
    ),
    Rule(
        id="cli-launcher-relative",
        phase=3,
        # `./hermes` / `../hermes`: the launcher invoked from a checkout, in
        # shell snippets and docs. Held off apps/* for the reason above.
        pattern=r"(\.\.?)([/\\]+)hermes(?![A-Za-z0-9_./:@-])",
        replacement=r"\1\2agentx",
        note="launcher run from a checkout ./hermes -> ./agentx",
        exclude=["apps/*"],
    ),
    Rule(
        id="windows-launcher-exe",
        phase=4,
        # The CLI launcher as Windows spells it: `hermes.exe`, `hermes.cmd`,
        # `hermes.bat`. cli-command refuses anything followed by `.`, and
        # cli-launcher-path anchors on `bin/`, so between them the venv's
        # Scripts\ directory was never reached — and the console script it
        # generates is called `agentx` now, so main.ts:3081 shipped as
        #     path.join(venvBin, IS_WINDOWS ? 'hermes.exe' : 'agentx')
        # i.e. the desktop resolved its backend on POSIX and failed to find it
        # on Windows.
        #
        # Lowercase only. The capitalised `Hermes.exe` is a different file —
        # the packaged Electron app — and desktop-app-file owns it.
        #
        # `\\?\.` for the escaped spelling inside TypeScript regex literals
        # (windows-user-env.test.ts matches /y\\hermes\.exe/).
        pattern=r"(?<![A-Za-z0-9_.-])hermes(\\?\.(?:exe|cmd|bat))",
        replacement=r"agentx\1",
        note="Windows CLI launcher hermes.exe/.cmd/.bat -> agentx.*",
    ),
    Rule(
        id="app-id",
        phase=4,
        # The reverse-DNS application id: electron-builder `appId`, the
        # Windows AppUserModelId set in electron/main.ts, the macOS bundle id
        # that `tccutil reset` takes, and the bootstrap installer's
        # `com.nousresearch.hermes.setup`. Not held back from website/*: a
        # bundle id is an exact identifier, and a doc naming the old one hands
        # the reader a tccutil command that resets permissions for nothing.
        pattern=r"com\.nousresearch\.hermes",
        replacement="com.agentx.workmate",
        note="application id com.nousresearch.hermes -> com.agentx.workmate",
    ),
    Rule(
        id="toolset-family",
        phase=3,
        # Platform composite toolsets, named hermes-<platform> and shown in
        # `agentx tools` and config.yaml. They are one family: acp-prog and
        # gateway-prog below renamed two of them, which split the family in
        # half and made the three `startswith("hermes-")` filters stop
        # recognising the renamed pair. The blank-slate installer then
        # disabled agentx-acp as if it were a leaf toolset and stripped
        # terminal/read_file/write_file from the agent.
        #
        # The alternation is explicit rather than `hermes-\w+` so it cannot
        # swallow hermes-agent (the dist/repo name, phase 5), hermes-tools
        # (the MCP server), hermes-index (a skills-hub source id), or the
        # hermes-<id> scratch-worktree names.
        pattern=r"hermes-(acp|gateway|cli|cron|bluebubbles|dingtalk|discord|email"
        r"|feishu|homeassistant|matrix|mattermost|qqbot|signal|slack|sms"
        r"|telegram|webhook|wecom|weixin|whatsapp|yuanbao|api-server)\b",
        replacement=r"agentx-\1",
        note="platform composite toolsets hermes-<platform> -> agentx-<platform>",
    ),
    Rule(
        id="toolset-family-dynamic",
        phase=3,
        # The same family, built at runtime from the platform name.
        pattern=r'f"hermes-\{(platform|entry\.name)\}"',
        replacement=r'f"agentx-{\1}"',
        note="dynamic toolset name f\"hermes-{platform}\" -> f\"agentx-{platform}\"",
    ),
    Rule(
        id="acp-prog",
        phase=3,
        pattern=r"hermes-acp",
        replacement="agentx-acp",
        note="hermes-acp entry point -> agentx-acp",
    ),
    Rule(
        id="gateway-prog",
        phase=3,
        pattern=r"hermes-gateway",
        replacement="agentx-gateway",
        note="hermes-gateway entry point / systemd unit -> agentx-gateway",
    ),
    Rule(
        id="launchd-label",
        phase=3,
        # The macOS launchd service label, as shown by `launchctl list`. It is
        # the same identity as the systemd unit renamed just above, and the
        # lifecycle guard matches both with one pattern — so leaving this
        # behind made that pattern stop recognising its own service.
        #
        # No rule reaches it otherwise: config-dir-posix skips `.hermes` when
        # a word character precedes it (to protect _meta.hermes), and here the
        # preceding character is the `i` of `ai.`.
        pattern=r"\bai\.hermes\.",
        replacement="ai.agentx.",
        note="launchd label ai.hermes.* -> ai.agentx.*",
    ),
    Rule(
        id="brand-glyph",
        phase=3,
        pattern="⚕",
        replacement="⬡",
        note="caduceus (Hermes' staff) -> hexagon brand glyph",
    ),
    # ── Phase 11: the long tail the gate surfaced ────────────────────────
    Rule(
        id="git-refs-namespace",
        phase=11,
        # `refs/hermes/<project-hash>` — the git ref namespace the checkpoint
        # manager writes rollback commits to (`_REFS_PREFIX` in
        # tools/checkpoint_manager.py) and the two doc pages describing it.
        # Not reachable by branch-namespace: that rule refuses a preceding `/`
        # so it stays off `/api/hermes/` and the openviking peer paths.
        pattern=r"refs/hermes(?![A-Za-z0-9_])",
        replacement="refs/agentx",
        note="checkpoint git ref namespace refs/hermes/* -> refs/agentx/*",
    ),
    Rule(
        id="kanban-diag-vars",
        phase=11,
        # `--hermes-diag-{warning,error,critical}`: three CSS custom properties
        # and their fourteen var() readers. kanban-kebab could not see them —
        # the token is `hermes-diag`, not `hermes-kanban`, even though it lives
        # in the same stylesheet and belongs to the same board.
        pattern=r"(?<![A-Za-z0-9_])hermes-diag-",
        replacement="agentx-diag-",
        note="kanban diagnostic CSS custom properties hermes-diag-* -> agentx-diag-*",
    ),
    Rule(
        id="desktop-root-flag",
        phase=11,
        # `agentx desktop --hermes-root PATH`. The env var it sets moved in
        # phase 2 (AGENTX_DESKTOP_AGENTX_ROOT); the flag the user types did
        # not, so the docs describe one name and the parser accepts the other.
        pattern=r"--hermes-root(?![A-Za-z0-9_-])",
        replacement="--agentx-root",
        note="desktop source-root flag --hermes-root -> --agentx-root",
    ),
    # ── Phase 10: attribution and upstream coordinates ───────────────────
    Rule(
        id="docker-image",
        phase=10,
        # The Docker Hub / ghcr coordinate. Split from repo-slug because a
        # registry name must stay lowercase: reusing repo-slug's PascalCase
        # replacement would emit `AstralX/agentx-workmate` into a `docker pull`,
        # which no registry serves. Runs before repo-slug so it claims these
        # first.
        pattern=r"(?<![A-Za-z0-9_-])nousresearch/hermes-agent(?![A-Za-z0-9-])",
        replacement="astralx/agentx-workmate",
        note="container image coordinate nousresearch/hermes-agent -> astralx/agentx-workmate",
        include=[
            ".github/workflows/docker.yml",
            "docker-compose.windows.yml",
            "hermes_cli/config.py",
            "hermes_cli/tools_config.py",
            "tools/browser_tool.py",
            "scripts/run_tests_parallel.py",
            "tests/hermes_cli/test_cmd_update_docker.py",
            "tests/hermes_cli/test_doctor.py",
            "tests/hermes_cli/test_web_server.py",
            "tests/docker/*",
            "website/docs/user-guide/docker.md",
            "website/i18n/*/docusaurus-plugin-content-docs/current/user-guide/docker.md",
        ],
    ),
    Rule(
        id="repo-slug",
        phase=10,
        # The GitHub coordinate of the project itself: 608 sites — the update
        # check's `git ls-remote` target, the installers' `git clone` source,
        # the raw.githubusercontent URLs the desktop and the Tauri bootstrapper
        # fetch install.sh from, the six `if: github.repository == …` workflow
        # gates (leave one and that job silently never runs in the fork), the
        # nix `src` fetchers, issue templates and doc links.
        #
        # The ORG casing varies and the REPO casing does not. GitHub URLs spell
        # it `NousResearch/hermes-agent`; the canonical string the update check
        # compares an origin against is lowercased to `nousresearch/hermes-agent`,
        # and update-remote.test.ts exercises both — so the org half is an
        # explicit alternation rather than a case-sensitive literal.
        #
        # The repo half must NOT be case-folded. `NousResearch/Hermes-Agent` is
        # a different artifact: Nous's HuggingFace dataset. An earlier `(?i)`
        # here rewrote it, and its two SFT variants, into coordinates that
        # resolve nowhere.
        #
        # `(?![A-Za-z0-9-])` keeps it off the neighbouring repos and datasets
        # that share the prefix: NousResearch/hermes-example-plugins,
        # NousResearch/hermes-agent-megascience-sft1,
        # NousResearch/terminal-tasks-glm-hermes-agent.
        #
        # The negative lookahead for a numbered issue/PR/discussion is the
        # provenance exemption: 101 comments cite where a bug was actually
        # discussed (`See …/issues/10454`, `agentx-agent#13848`). Those numbers
        # do not exist in the new repo, so repointing them would turn a correct
        # citation into a dead link. They stay, and check_branding.py allows
        # exactly this shape.
        pattern=(
            r"(?<![A-Za-z0-9_-])(?:NousResearch|nousresearch)/hermes-agent"
            r"(?![A-Za-z0-9-])(?!#\d)(?!/(?:issues|pull|pulls|discussions|compare)/\d)"
        ),
        replacement="AstralX/agentx-workmate",
        note="upstream repo slug NousResearch/hermes-agent -> AstralX/agentx-workmate",
    ),
    Rule(
        id="vendor-attribution",
        phase=10,
        # "Nous Research" where it names the PUBLISHER OF THIS BUILD: package
        # authors, bundle publisher/copyright, the Windows PE CompanyName and
        # LegalCopyright, plugin/skill `author:` frontmatter, README "Built by"
        # lines and the flake description.
        #
        # Anchored on the field or phrase that introduces it, never on the name
        # alone, because the same two words mean something else in three other
        # places that MUST keep working:
        #   * the LLM provider — portal/inference base URLs, the "nous" provider
        #     id and its display name, the Nous Portal OAuth and billing flows;
        #   * the billing consent text ("you authorize Nous Research to charge
        #     …"), which names the entity that actually charges the card;
        #   * Nous's own models — "Nous Research Hermes 3 & 4 models are NOT
        #     agentic" is a statement about a third party's product.
        # A blanket `Nous Research -> AstralX Technology` sweep breaks auth and
        # turns two true sentences into false ones.
        pattern=(
            r"(?i)((?:copyright|authors?|publisher|companyname|company|maintainer"
            r"|maintained by|built by|developed by|framework by|agent by|org)"
            r"[\"'\s:=]{0,6}(?:\(c\)\s*)?(?:©\s*)?(?:\d{4}\s+)?[\"'\[]{0,2})"
            r"Nous\s?Research"
        ),
        replacement=r"\1AstralX Technology",
        note='vendor-as-publisher "Nous Research" -> "AstralX Technology"',
        # Contributor identity data: real people's names and addresses. The
        # same reason .mailmap is globally excluded.
        exclude=["contributors/*", "scripts/release.py"],
    ),
    Rule(
        id="vendor-homepage-link",
        phase=10,
        # Runs after vendor-attribution, which turns "Built by [Nous Research]"
        # into "Built by [AstralX Technology]" and leaves the href pointing at
        # nousresearch.com — a link whose text and destination disagree. AstralX
        # has no site registered (branding.WEBSITE_URL is ""), so the credit
        # becomes plain text rather than a link somewhere else. Matching on the
        # already-rewritten label is what keeps this off the many legitimate
        # nousresearch.com links that describe the model provider.
        pattern=r"\[AstralX Technology\]\(https://nousresearch\.com/?\)",
        replacement="AstralX Technology",
        note="vendor credit link -> plain text (no vendor site registered)",
    ),
    Rule(
        id="vendor-badge",
        phase=10,
        # The shields.io "Built by" badge, whose label is URL-encoded and so is
        # invisible to every rule that spells the vendor with a space.
        pattern=r"Built%20by-Nous%20Research",
        replacement="Built%20by-AstralX%20Technology",
        note="shields.io Built-by badge label -> AstralX Technology",
    ),
    Rule(
        id="vendor-contact-email",
        phase=10,
        # The three ROLE addresses that route support for this product. Every
        # other @nousresearch.com address in the tree belongs to a named
        # contributor and is attribution data, so this rule lists the role
        # accounts explicitly rather than matching the domain.
        pattern=r"(?:info|security|support)@nousresearch\.com",
        replacement="kien.le@astralx.com.vn",
        note="product role addresses @nousresearch.com -> the support address",
        exclude=["contributors/*", "scripts/release.py"],
    ),
    Rule(
        id="service-user-home",
        phase=9,
        # The service account's home and state directories. nix/nixosModules.nix
        # already declares `user = "agentx"` and `group = "agentx"` (phase 5),
        # but left that user's home at /var/lib/hermes, its container home at
        # /home/hermes and its sudoers drop-in at /etc/sudoers.d/hermes — a
        # user by one name living in a directory named after the other.
        #
        # cli-command cannot reach these: its guard refuses a preceding `/` on
        # purpose, which is what keeps it off /api/hermes/ and ~/.hermes. So
        # the directories are enumerated here instead. The trailing guard
        # deliberately permits `-`, so /var/lib/hermes-tools-provisioned (the
        # first-boot marker) moves with its directory rather than being
        # stranded by general-kebab's MCP-server guard.
        pattern=r"(?<![A-Za-z0-9_])(/(?:home|var/lib|data|etc/sudoers\.d)/)hermes(?![A-Za-z0-9_])",
        replacement=r"\1agentx",
        note="service-account home/state dirs /var/lib/hermes, /home/hermes -> .../agentx",
    ),
    Rule(
        id="matrix-user-id",
        phase=9,
        # `@hermes:example.org` — the placeholder Matrix bot user id shown in
        # the config schema, the five desktop locales and the messaging docs.
        # Every rule that could otherwise reach it deliberately refuses a
        # leading `@` or a trailing `:` (that guard is what protects real
        # Matrix ids and `chown hermes:hermes`), so this family needs its own
        # rule anchored on both punctuation marks at once — which no real
        # third-party id in the tree matches.
        pattern=r"@hermes:",
        replacement="@agentx:",
        note="placeholder Matrix bot user id @hermes:… -> @agentx:…",
    ),
    Rule(
        id="brand-glyph-alt",
        phase=9,
        # The OTHER caduceus. U+2624 CADUCEUS is a different codepoint from
        # U+2695 STAFF OF AESCULAPIUS that brand-glyph sweeps, and it is the
        # one the README titles, the desktop README, the session-export footer
        # and the achievements share-card actually use — so a gate that
        # checked only U+2695 reported those clean.
        #
        # Excluded from tests/agent/, where the same character is deliberate
        # arbitrary unicode: test_system_prompt_restore.py round-trips it to
        # prove non-ASCII survives storage, and test_tool_guardrails.py uses it
        # as a dictionary VALUE in a key-ordering fixture. Neither is a brand
        # mark, and rewriting them would quietly change what those tests test.
        pattern="☤",
        replacement="⬡",
        note="caduceus U+2624 -> hexagon brand glyph",
        exclude=["tests/agent/*"],
    ),
    Rule(
        id="session-token-header",
        phase=4,
        # `X-Hermes-Session-Token`. The Python side moved in phase 3
        # (hermes_cli/web_server.py `_SESSION_HEADER_NAME`) while apps/desktop
        # was excluded, so the desktop has been sending a header the backend
        # no longer recognises. Spelled `X-Agentx-` and not `X-AgentX-`: that
        # is how it reaches the wire once urllib title-cases it, and how Node
        # reads it back (§4).
        pattern=r"X-Hermes-Session-Token",
        replacement="X-Agentx-Session-Token",
        note="dashboard auth header X-Hermes-Session-Token -> X-Agentx-Session-Token",
    ),
    # ── Phase 4: the packaged desktop app's own file names ───────────────
    #
    # These two run BEFORE the display-name rules below. `display-name-short`
    # is \bHermes\b, and `.` is a word boundary — left to run first it would
    # turn `Hermes.app` into `AgentX.app` while electron-builder, driven by
    # productName/executableName, actually writes `AgentX Workmate.app`. The
    # Python launcher then globs for a bundle that does not exist and
    # `agentx desktop` reports "Desktop GUI build failed".
    #
    # The desktop app is named with the FULL product name, not the short one:
    # `hermes_cli/gui_uninstall.py` derives Electron's userData directory from
    # `branding.DESKTOP_APP_NAME`, and Electron derives it from productName.
    # The two have to stay equal or the uninstaller cleans a directory the app
    # never wrote to.
    Rule(
        id="desktop-app-file",
        phase=4,
        # Hermes.app / Hermes.exe / Hermes.AppImage — the bundle and binary
        # electron-builder produces. Capitalised, which is exactly what
        # separates them from the lowercase CLI launcher: a Windows install
        # has BOTH `…\AgentX Workmate\AgentX Workmate.exe` (this app) and
        # `…\venv\Scripts\agentx.exe` (the CLI), and they are different files.
        #
        # `\\?\.` because TypeScript regex literals escape the dot:
        # windows-user-env.test.ts matches /y\\Hermes\.exe/.
        pattern=r"\bHermes(\\?\.(?:app|exe|AppImage))",
        replacement=r"AgentX Workmate\1",
        note="packaged app file Hermes.app/.exe/.AppImage -> AgentX Workmate.*",
    ),
    Rule(
        id="desktop-install-dir",
        phase=4,
        # The directory named after the app, always behind a path separator:
        #   …\AppData\Local\Programs\Hermes     NSIS per-user install root
        #   /opt/Hermes                         electron-builder linux prefix
        #   …/Library/Application Support/Hermes   Electron userData
        #   …/Contents/MacOS/Hermes             CFBundleExecutable
        #   …/linux-unpacked/Hermes             unpacked binary
        # The separator on the left is what keeps this off ordinary prose,
        # which display-name-short handles. Runs after desktop-app-file so
        # `/Applications/Hermes.app` is already spelled out and this rule
        # only ever sees a bare directory or binary name.
        #
        # Two trailing guards. `(?![-\s]*\d)` is the model-name guard
        # display-name-short carries, for the same reason: nothing named
        # `…/Hermes 3` should move. `(?! [a-z])` says the match is a path
        # segment and not prose — because a JavaScript regex LITERAL opens
        # with the same character a path separates with, and without it
        # `/Hermes is not installed/` in windows-remote-lifecycle.test.ts
        # read as a path and became `/AgentX Workmate is not installed/`,
        # which no longer matched the message the code throws.
        #
        # The `(?<!esearch/)` AFTER the separator group is a third guard —
        # after, because the group consumes the slash and a lookbehind
        # placed before it would be testing the wrong position: `NousResearch/Hermes-Agent`
        # is one of Nous's HuggingFace artifacts, not an install directory, and
        # the `/` in front of it reads exactly like a path segment here.
        pattern=r"([\\/]+)(?<!esearch/)Hermes\b(?![-\s]*\d)(?! [a-z])",
        replacement=r"\1AgentX Workmate",
        note="install/bundle directory .../Hermes -> .../AgentX Workmate",
    ),
    # Display names, longest first so a broader rule never eats a token a
    # narrower one was meant to claim.
    Rule(
        id="wordmark-nous",
        phase=3,
        pattern=r"(?<![A-Za-z0-9_])NOUS HERMES(?![A-Za-z0-9_])",
        replacement="AGENTX WORKMATE",
        note='uppercase "NOUS HERMES" wordmark -> "AGENTX WORKMATE"',
    ),
    Rule(
        id="wordmark-upper",
        phase=3,
        pattern=r"(?<![A-Za-z0-9_])HERMES[- ]AGENT(?![A-Za-z0-9_])",
        replacement="AGENTX WORKMATE",
        note='uppercase "HERMES AGENT" wordmark -> "AGENTX WORKMATE"',
    ),
    Rule(
        id="display-name-full",
        phase=3,
        pattern=r"(?<![A-Za-z0-9_])Hermes Agent(?![A-Za-z0-9_])",
        replacement="AgentX Workmate",
        note='"Hermes Agent" display string -> "AgentX Workmate"',
    ),
    Rule(
        id="display-name-desktop",
        phase=3,
        pattern=r"(?<![A-Za-z0-9_])Hermes Desktop(?![A-Za-z0-9_])",
        replacement="AgentX Workmate Desktop",
        note='"Hermes Desktop" -> "AgentX Workmate Desktop"',
    ),
    Rule(
        id="display-name-short",
        phase=3,
        # Bare capitalised Hermes in prose/UI. Runs after the multi-word
        # display names above have claimed their occurrences.
        #
        # `\b` is deliberately NOT used on either side. Python's `re` makes it
        # Unicode-aware, so `Hermes` followed by a CJK or Hangul character has
        # no boundary at all — the Japanese, Korean and Chinese UI strings kept
        # the product name through every earlier sweep because of it. The
        # explicit ASCII classes below match the token in any script.
        #
        # The guards keep Nous's own artifacts intact. `(?<!Nous )` and
        # `(?![-\s]*\d)` protect the model slugs — hermes-4, Nous Hermes 3,
        # NousResearch/Hermes-3-Llama-3.1-70B are sent to provider APIs and a
        # rename turns a working request into a 404.
        #
        # `(?<!esearch/)` and `(?<!Nous-)` protect the artifacts whose name
        # carries no digit and so slips past the model guard:
        # `NousResearch/Hermes-Agent` (a HuggingFace dataset, plus its two
        # -Thinking-GLM SFT variants) and `NousResearch/Nous-Hermes-llama-1b-v1`.
        # All three were rewritten into coordinates that resolve nowhere before
        # these guards existed. `esearch/` is the same nine-character
        # fixed-width lookbehind dist-name uses, and it matches both the
        # PascalCase and the lowercase spelling of the org.
        pattern=r"(?<!Nous )(?<!Nous-)(?<!esearch/)(?<![A-Za-z0-9_])Hermes(?![A-Za-z0-9_])(?![-\s]*\d)",
        replacement="AgentX",
        note='bare "Hermes" display string -> "AgentX" (model names exempt)',
    ),
    Rule(
        id="wordmark-bare-upper",
        phase=3,
        # Runs last: the multi-word uppercase wordmarks above are gone by now.
        pattern=r"(?<![A-Za-z0-9_])HERMES(?![A-Za-z0-9_])(?![-\s]*\d)",
        replacement="AGENTX",
        note='bare uppercase "HERMES" -> "AGENTX"',
    ),
    # ── Phase 5: packaging families ──────────────────────────────────────
    #
    # These run before phase 4's desktop kebab sweep below, because
    # `hermes-agent` and `hermes-setup` occur inside apps/desktop too and
    # their guards (upstream repo slugs, the upstream install URL) are
    # narrower than the sweep's.
    Rule(
        id="dist-name",
        phase=5,
        # `hermes-agent` wears six hats at once: the Python dist name, the
        # console script, the Docker image, the nix module option, the
        # install directory under $AGENTX_HOME, and the upstream repo slug.
        # The first five are ours and move; the sixth is a third-party
        # coordinate that must not.
        #
        # `(?<!esearch/)` is the repo-slug guard, sized to the tail of both
        # `NousResearch/` and `nousresearch/` so one fixed-width lookbehind
        # covers github.com URLs, `git@github.com:` SSH remotes and
        # `ghcr.io/nousresearch/hermes-agent:latest` alike.
        #
        # `(?!\.nousresearch)` is the install-host guard: the launcher scripts
        # are still served from hermes-agent.nousresearch.com, and rewriting
        # that host produces a URL that resolves nowhere — strictly worse than
        # leaving the upstream name visible. It moves when a domain exists.
        #
        # pyproject's `[project].name` is the deliberate exception and is
        # hand-edited to the dist name proper, `agentx-workmate`.
        # No `.` in the left guard. The nix module option is spelled
        # `services.hermes-agent` / `pkgs.hermes-agent` / `prev.hermes-agent`,
        # and a guard that refused a preceding dot renamed
        # nix/python.nix's binding (`agentx-agent = prev.hermes-agent…`)
        # while leaving the attribute it reads from behind. The only other
        # dot-preceded spelling in the tree is the upstream onboarding host
        # `setup.hermes-agent.nousresearch.com`, which the lookahead below
        # already exempts.
        pattern=r"(?<![A-Za-z0-9_-])(?<!esearch/)hermes-agent(?!\.nousresearch)",
        replacement="agentx-agent",
        note="hermes-agent dist/script/install-dir -> agentx-agent (repo slug and install host exempt)",
    ),
    Rule(
        id="dist-name-proper",
        phase=5,
        # The DISTRIBUTION name, as distinct from the console script. Both
        # were spelled `hermes-agent` upstream and dist-name above moves the
        # whole token to `agentx-agent`, which is right for the script, the
        # install directory and the repo folder — but the dist itself is
        # `agentx-workmate` (branding.py DIST_NAME), and pyproject's
        # self-referential extras are pip requirement specs naming the dist.
        #
        # The `[` is the whole discriminator: `agentx-agent[cron]` can only be
        # a requirement spec, while a bare `agentx-agent` in this tree is the
        # command, a path segment or prose. Runs after dist-name so it sees
        # the already-normalised spelling.
        pattern=r"agentx-agent\[",
        replacement="agentx-workmate[",
        note="pip requirement spec agentx-agent[extra] -> agentx-workmate[extra]",
    ),
    Rule(
        id="dist-metadata-lookup",
        phase=5,
        # `importlib.metadata.version(<dist>)`. Three call sites resolve the
        # running version this way (codex's userAgent line, the OpenAI-compat
        # /health payload, the QQ bot's client info), and the argument is the
        # DIST name, not the console script — so it follows pyproject's
        # [project].name to agentx-workmate rather than dist-name's
        # agentx-agent. Each is wrapped in try/except, which is exactly why
        # this had to be found by reading rather than by a crash: a wrong dist
        # name here degrades silently to "dev".
        pattern=r'version\("agentx-agent"\)',
        replacement='version("agentx-workmate")',
        note='importlib.metadata.version("agentx-agent") -> ("agentx-workmate")',
    ),
    Rule(
        id="dist-artifact-name",
        phase=5,
        # The same dist name as setuptools normalises it for build artifacts:
        # `hermes_agent-0.17.0.whl`, `hermes_agent.egg-info`. Underscored, so
        # neither dist-name (hyphen) nor the gate (which allows snake_case)
        # sees it — and tests/test_packaging_build_guard.py globs for the
        # built wheel by exactly this name.
        pattern=r"hermes_agent(?=-\*|\.egg-info)",
        replacement="agentx_workmate",
        note="build artifact/egg-info name hermes_agent-* -> agentx_workmate-*",
    ),
    Rule(
        id="installer-exe",
        phase=5,
        # The Tauri bootstrap installer binary, `hermes-setup.exe`, and the
        # `hermes-setup` name it is referred to by. The desktop's update
        # chain hands off to it by name (electron/update-marker.ts,
        # electron/main.ts), so it is one family with apps/bootstrap-installer.
        # No `-` in the lookbehind: the container image installs the stage-2
        # hook as /etc/cont-init.d/01-hermes-setup, and a guard that refused a
        # preceding hyphen renamed the Dockerfile's heredoc target while every
        # script that documents running "after 01-hermes-setup" kept the old
        # spelling.
        pattern=r"(?<![A-Za-z0-9_.])hermes-setup",
        replacement="agentx-setup",
        note="bootstrap installer binary / container init hook hermes-setup -> agentx-setup",
    ),
    Rule(
        id="dashboard-service",
        phase=5,
        # `hermes-dashboard`: the systemd unit (`hermes-dashboard.service`, in
        # hermes_cli/main.py `_DASHBOARD_SYSTEMD_UNIT` and dashboard_procs.py),
        # the docker-compose container_name, and the OAuth client_id in
        # cli-config.yaml.example. Phase 3's gateway-prog moved the gateway's
        # sibling unit to agentx-gateway and left this one behind, so the two
        # services that ship together now answer to different brands.
        pattern=r"(?<![A-Za-z0-9_.-])hermes-dashboard",
        replacement="agentx-dashboard",
        note="dashboard service/container/client id hermes-dashboard -> agentx-dashboard",
    ),
    Rule(
        id="config-artifact",
        phase=5,
        # Nix derivation names (`hermes-config-keys`, `hermes-config-merge`,
        # `hermes-config-attrs`), the generated `hermes-config.yaml`, the
        # dashboard's config export filename and the .dockerignore entry.
        #
        # The `-` in the lookbehind protects `use-hermes-config`, which is the
        # name of a FILE on disk (src/app/session/hooks/use-hermes-config.ts)
        # and therefore kept: renaming the import specifier without the file
        # is an unresolved module.
        pattern=r"(?<![A-Za-z0-9_.-])hermes-config",
        replacement="agentx-config",
        note="config derivation/export artifact names hermes-config* -> agentx-config*",
        # curator.py names `hermes-config-*` as an example SKILL-name cluster
        # inside a prompt; skill names are phase 8.
        exclude=["agent/curator.py"],
    ),
    Rule(
        id="install-flag-home",
        phase=5,
        # `--hermes-home`, the data-directory flag scripts/install.sh parses
        # and apps/desktop/electron/bootstrap-runner.ts passes. Both halves of
        # a CLI contract; the desktop would otherwise hand the installer a flag
        # it no longer recognises. The leading `--` is why no other rule
        # reaches it: every kebab guard in this table refuses a preceding
        # hyphen so it cannot eat `use-hermes-config`.
        pattern=r"--hermes-home",
        replacement="--agentx-home",
        note="installer data-directory flag --hermes-home -> --agentx-home",
    ),
    Rule(
        id="install-tree-markers",
        phase=5,
        # Dotfile sentinels written into the user's install tree:
        #   .hermes-update-old / -new / -staging / -in-progress
        #   .hermes-bootstrap-complete  .hermes-runtime
        #   .hermes-tmp  .hermes-sandbox
        # Phase 2 reverted a partial rename of these once already: they are
        # written by the Python installer, read by the Rust updater
        # (apps/bootstrap-installer/src-tauri/src/update.rs) and by the
        # Electron main process, so a half-move makes the updater blind to
        # its own staging directory.
        #
        # config-dir-posix cannot reach them — its trailing (?![-.\w]) stops
        # at the hyphen, which is precisely what kept ~/.hermes off the kebab
        # tokens.
        pattern=r"\.hermes-(update|bootstrap|runtime|tmp|sandbox)",
        replacement=r".agentx-\1",
        note="install-tree marker dotfiles .hermes-* -> .agentx-*",
    ),
    Rule(
        id="tui-package-name",
        phase=5,
        # `hermes-tui`: the npm package name in ui-tui/package.json, the
        # directory nix/tui.nix installs it into ($out/lib/hermes-tui, which
        # nix/agentx-agent.nix symlinks), and the active-session tempfile
        # prefix hermes_cli/main.py writes. The DIRECTORY
        # ui-tui/packages/hermes-ink keeps its name — that is a source path.
        pattern=r"(?<![A-Za-z0-9_.-])hermes-tui",
        replacement="agentx-tui",
        note="TUI package/lib-dir name hermes-tui -> agentx-tui",
    ),
    Rule(
        id="install-flag-home-windows",
        phase=5,
        # `-HermesHome`, the PowerShell parameter of scripts/install.ps1 and
        # the `$HermesHome` variable threaded through it. This is the Windows
        # half of `--hermes-home`; leaving it behind would give the two
        # installers different flags for the same directory.
        #
        # Capitalised and whole-word, which is what keeps it off the
        # TypeScript `hermesHome` property and off `normalizeHermesHomeRoot`
        # — those are internal identifiers, kept per §2.
        pattern=r"\bHermesHome\b",
        replacement="AgentXHome",
        note="install.ps1 parameter -HermesHome / $HermesHome -> AgentXHome",
    ),
    Rule(
        id="user-agent-token",
        phase=6,
        # The product token in outbound User-Agent headers: `HermesAgent/1.0`
        # (copilot_auth, gateway/platforms/base) and
        # `HermesAgent/{version}` (agent/auxiliary_client). Every server this
        # product talks to sees this string. The sibling spellings moved with
        # dist-name already — `agentx-agent/{version}`,
        # `AgentX-Agent-Outbound-Webhook` — leaving this one the odd brand out.
        pattern=r"\bHermesAgent\b",
        replacement="AgentX",
        note="outbound User-Agent product token HermesAgent -> AgentX",
    ),
    Rule(
        id="npm-scope",
        phase=5,
        # The workspace npm scope: @hermes/shared, @hermes/ink,
        # @hermes/plugin-sdk. Package names and import specifiers move
        # together; the DIRECTORY ui-tui/packages/hermes-ink stays, because
        # source paths on disk are kept (§2 of REBRAND.md).
        pattern=r"@hermes/",
        replacement="@agentx/",
        note="npm scope @hermes/* -> @agentx/*",
    ),
    Rule(
        id="container-user",
        phase=5,
        # The unix user/group inside the container image, as it appears in
        # `chown user:group`. Phase 3's cli-command already renamed every
        # SPACE-separated occurrence — `useradd -u 10000 -m -d /opt/data agentx`,
        # `s6-setuidgid agentx` — because those read as bare command tokens,
        # but it refuses anything followed by `:`, so the twelve
        # `chown -R hermes:hermes` calls kept the old name. The image as it
        # stands creates `agentx` and then chowns the data volume to a user
        # that does not exist: every one of those chowns fails and the
        # supervise trees stay root-owned.
        #
        # hermes_cli/config.py's `exec_user` default already reads "agentx"
        # for the same reason, so this closes the last half of the pair.
        pattern=r"\bhermes:hermes\b",
        replacement="agentx:agentx",
        note="container unix user/group chown hermes:hermes -> agentx:agentx",
    ),
    Rule(
        id="container-prefix",
        phase=5,
        # The container install root (/opt/hermes, 46 sites) and the system
        # config dir (/etc/hermes). Also the desktop's Linux install prefix
        # in uninstall fixtures. cli-command refuses anything after a slash,
        # so nothing else reaches these.
        # `(\\?/)` because a TypeScript regex literal escapes the separator:
        # desktop-uninstall.test.ts asserts on /rm -rf '\/opt\/hermes\/…'/,
        # and a rule that only knew the bare form renamed the fixture data
        # while leaving the expectation that reads it behind.
        pattern=r"(?<=/)(opt|etc)(\\?/)hermes(?![A-Za-z0-9_.-])",
        replacement=r"\1\2agentx",
        note="container/system install roots /opt/hermes, /etc/hermes -> .../agentx",
    ),
    # ── Phase 4: desktop app, lowercase surfaces ─────────────────────────
    Rule(
        id="desktop-ipc-channel",
        phase=4,
        # The Electron IPC namespace — 121 channels (`hermes:api`,
        # `hermes:git:review:push`, `hermes:pet-overlay:state`, …) plus the
        # renderer storage keys that share the prefix (`hermes:composer-drafts:v3`)
        # and the custom URL scheme (`hermes://`). preload.ts, main.ts and every
        # caller have to agree on the spelling, so this is a whole-family rename
        # or none at all; phase 3's cli-command skipped them precisely because
        # of the trailing `:`.
        #
        # The `@` in the lookbehind keeps it off `@hermes:example.org`, a Matrix
        # user id in the messaging fixtures.
        pattern=r"(?<![A-Za-z0-9_@./-])hermes:",
        replacement="agentx:",
        note="Electron IPC channels / URL scheme hermes:* -> agentx:*",
        include=["apps/desktop/*"],
    ),
    Rule(
        id="desktop-bridge",
        phase=4,
        # `window.hermesDesktop` — the contextBridge name, visible in DevTools,
        # and ~560 call sites across src/**, electron/preload.ts and the
        # `declare global` block in src/global.d.ts. Renaming the bridge without
        # the declarations is a compile error; renaming the declarations without
        # the bridge is a runtime `undefined`. Same family rule as the channels.
        #
        # Not held back from website/* — along with env-suffix, app-id,
        # desktop-storage-key and dom-brand-dataset, this renames an EXACT
        # IDENTIFIER rather than prose. A doc that spells `window.hermesDesktop`
        # or `hermes.plugin.<id>.` hands a plugin author a name nothing
        # answers to, which is worse than a doc still using the old product
        # name in a sentence. Prose in website/ stays for phase 9.
        pattern=r"hermesDesktop",
        replacement="agentxDesktop",
        note="preload bridge window.hermesDesktop -> window.agentxDesktop",
    ),
    Rule(
        id="desktop-bridge-capitalised",
        phase=4,
        # The same identifier where it sits mid-word: `initialHermesDesktop`,
        # `MockHermesDesktop`. Split from the rule above only because the
        # replacement has to preserve the leading capital.
        pattern=r"HermesDesktop",
        replacement="AgentxDesktop",
        note="mid-word HermesDesktop -> AgentxDesktop",
    ),
    Rule(
        id="desktop-storage-key",
        phase=4,
        # Renderer persistence namespaces: `hermes.desktop.<key>` in
        # localStorage (~90 keys) and `hermes.plugin.<id>.<key>`, the scoped
        # store the desktop plugin SDK hands each plugin. Both are read back
        # by prefix, so a partial rename orphans the settings it does not move.
        pattern=r"(?<![A-Za-z0-9_-])hermes\.(desktop|plugin)\.",
        replacement=r"agentx.\1.",
        note="renderer storage namespaces hermes.desktop.* / hermes.plugin.* -> agentx.*",
    ),
    Rule(
        id="dom-brand-attribute",
        phase=4,
        # `data-hermes-*` attributes on <html> and injected <style>/<link>
        # tags, and the `dataset.hermes*` properties that write them. The DOM
        # maps one to the other (`dataset.hermesTheme` <-> `data-hermes-theme`),
        # so the two spellings are the same name and must move together — the
        # §4 "two spellings of one name" trap. The observer in
        # src/hooks/use-theme-epoch.ts watches the attribute list by name.
        pattern=r"data-hermes-",
        replacement="data-agentx-",
        note="DOM brand attributes data-hermes-* -> data-agentx-*",
    ),
    Rule(
        id="dom-brand-dataset",
        phase=4,
        pattern=r"dataset\.hermes",
        replacement="dataset.agentx",
        note="the dataset half of data-hermes-* (dataset.hermesTheme -> dataset.agentxTheme)",
    ),
    Rule(
        id="dashboard-api-route",
        phase=4,
        # `/api/hermes/update` and `/api/hermes/update/check` — declared in
        # hermes_cli/web_server.py, called from apps/desktop/src/hermes.ts and
        # web/src/lib/api.ts. A cross-process contract: three call sites and
        # two route declarations that have to change in the same commit.
        pattern=r"/api/hermes/",
        replacement="/api/agentx/",
        note="dashboard admin route /api/hermes/* -> /api/agentx/*",
    ),
    Rule(
        id="desktop-package-name",
        phase=4,
        # `hermes-desktop` names the app OUTSIDE apps/desktop too, and those
        # sites are the half the desktop-scoped sweep below cannot see: the
        # %LOCALAPPDATA%\hermes-desktop install directory that
        # hermes_cli/gui_uninstall.py removes, the nix package pname and its
        # $out/share + $out/bin paths, the `source` field honcho's OAuth flow
        # reports (already spelled `agentx-cli` for its sibling since phase 3),
        # the dashboard's voice tmpdir prefix and install.ps1's build log.
        #
        # The `-` in the lookbehind leaves `debugging-hermes-desktop` alone —
        # that is an example SKILL name in a docstring, and skill names are
        # phase 8.
        pattern=r"(?<![A-Za-z0-9_.-])hermes-desktop",
        replacement="agentx-desktop",
        note="desktop app package/install-dir name hermes-desktop -> agentx-desktop",
    ),
    Rule(
        id="boot-theme-key",
        phase=4,
        # `hermes-boot-background` / `hermes-boot-color-scheme`: the
        # localStorage keys the shell writes so the next cold start can paint
        # the window chrome before React mounts. apps/desktop/index.html reads
        # them, src/themes/context.tsx writes them, and ui-tui/src/lib/themeBoot.ts
        # shares the same key namespace — one storage contract across three
        # files in two workspaces.
        pattern=r"(?<![A-Za-z0-9_.-])hermes-boot-",
        replacement="agentx-boot-",
        note="boot theme localStorage keys hermes-boot-* -> agentx-boot-*",
    ),
    Rule(
        id="app-kebab",
        phase=4,
        # Everything else the desktop spells `hermes-<something>`: CSS class
        # and keyframe names (`hermes-zone-fade`), datalist ids, localStorage
        # keys (`hermes-desktop-theme-v2`, `hermes-boot-background`), the
        # `hermes-media://` protocol, the `hermes-desktop` install directory
        # under %LOCALAPPDATA% — which pairs with hermes_cli/gui_uninstall.py —
        # and the mkdtemp prefixes the platform tests use.
        #
        # Two guards. `(?!agent|setup)` hands the packaging families to the
        # phase-5 rules above, whose repo-slug and install-host exemptions are
        # narrower than anything expressible here; the rule stays correct when
        # run on its own with `--phase 4`. `(?![0-9xy]\b)` is the model guard:
        # `hermes-4`, `hermes-4-mini`, `hermes-3-llama-3.1-70b` are slugs sent
        # to provider APIs, and `hermes-x`/`hermes-y` stand in for them in the
        # model-visibility fixtures.
        #
        # The `-` in the lookbehind is load-bearing: it keeps the sweep off
        # `use-hermes-config` and `windows-hermes-path`, which are source FILE
        # names (kept, §2) — renaming the specifier without the file is an
        # unresolved import.
        #
        # `.` and `/` were in the lookbehind too and were WRONG there, in the
        # §4 "path rule eating kebab tokens" shape. The first pass renamed
        # `className="hermes-fade-in"` in four bootstrap-installer routes and
        # the `@keyframes` block, but not the `.hermes-fade-in` SELECTOR that
        # binds them, because a CSS selector is a `.` followed by the class
        # name — so the installer shipped with its entrance animation bound to
        # a class nothing sets. `/` hid the same class of token behind a path
        # segment (`/tmp/hermes-verify-example.py`). Neither character
        # protects anything: every third-party and file name that must survive
        # is named explicitly in the guard below.
        # The third guard is names that are not ours at all. `hermes-parser`
        # and `hermes-estree` are Meta's JavaScript-engine packages and reach
        # this tree as ordinary npm dependencies; `hermes-tools` is the MCP
        # server name in the codex config; `hermes-ink` and
        # `hermes-achievements` are directories on disk. None appears under
        # apps/ today — the guard is here so that the day one does, this rule
        # does not quietly rename a third party's package and break `npm ci`.
        #
        # `hermes-index` was guarded here too until phase 8, which renames the
        # skills-hub source id across the whole tree. Leaving the guard would
        # have made apps/ the one place still spelling it the old way — the
        # §4 half-rename shape exactly.
        pattern=(
            r"(?<![A-Za-z0-9_-])hermes-"
            r"(?!agent|setup|[0-9]|[xy](?![A-Za-z0-9_-])"
            r"|parser|estree|eslint|tools(?![-\w])|ink\b|achievements\b|0day"
            r"|lcm\b|brain\b|seaeye|jc\b|example-plugins)"
        ),
        replacement="agentx-",
        note="app-local hermes-* CSS/storage/tmpdir names -> agentx-*",
        # apps/* rather than apps/desktop/*: the bootstrap installer carries
        # the same shape of token (the `hermes-fade-in` keyframe its four
        # routes reference, `hermes-glow`, its mkdtemp prefixes) and phase 5
        # moves it in the same pass. web/ and ui-tui/ keep theirs — their
        # leftovers are a separate surface with no phase in 4-7 owning them,
        # and a partial sweep there would split namespaces the way §4 warns.
        include=["apps/*"],
    ),
    # ── Phase 8: prompts, skills, agent-visible content ──────────────────
    Rule(
        id="kanban-kebab",
        phase=8,
        # The kanban board's whole `hermes-kanban*` namespace, moved as one
        # family (§4): 557 CSS class names split across the two checked-in
        # build artifacts (plugins/kanban/dashboard/dist/index.js declares
        # them, dist/style.css styles them — there is no other source, so the
        # pair IS the source of truth and a rule that moved only one would
        # produce a stylesheet matching nothing), plus three siblings that
        # spell the same prefix with a different separator:
        #   - `hermes-kanban-dispatcher.service`, the systemd unit users type
        #     into `systemctl --user enable` (the FILE is renamed too),
        #   - `docs/hermes-kanban-v1-spec.pdf`, cited from three docstrings
        #     and four doc pages (the FILE is renamed too),
        #   - the `hermes-kanban/attach` User-Agent in tools/kanban_tools.py,
        #     which is why the pattern stops at the prefix rather than
        #     requiring the trailing hyphen.
        #
        # No `hermes-kanban*` token in the tree belongs to anyone else, so
        # this rule needs none of app-kebab's third-party guards.
        #
        # The lookbehind blocks ONLY [A-Za-z0-9_], and that is the whole point.
        # app-kebab additionally blocks `.` `/` `-`, and copying it here was
        # measured to move 278 of 285 tokens in dist/index.js but 3 of 307 in
        # dist/style.css — every class name renamed, every selector left behind,
        # i.e. a stylesheet matching nothing. The three characters each carry a
        # real occurrence: `.` is a CSS selector (`.hermes-kanban-card`,
        # `summary.hermes-kanban-run-meta-label`), `/` is a path
        # (`docs/hermes-kanban-v1-spec.pdf`), and `-` is the second dash of the
        # `--hermes-kanban-drawer-width` custom property. Nothing in the tree
        # spells this token after a word character, so nothing wider is needed.
        pattern=r"(?<![A-Za-z0-9_])hermes-kanban",
        replacement="agentx-kanban",
        note="kanban CSS/service/spec/User-Agent namespace hermes-kanban* -> agentx-kanban*",
    ),
    Rule(
        id="skills-index-source-id",
        phase=8,
        # `hermes-index` is the skills-hub source id for our own skills index:
        # a dict key in two source registries (hermes_cli/skills_hub.py,
        # tools/skills_hub.py), the `source` field stamped onto every cached
        # bundle, the equality test in hermes_cli/web_routers/skills.py, the
        # key of the display-name map in web_server.py (whose value phase 3
        # already moved to "AgentX Index" — this rule closes that half-rename),
        # and the `hermes-index.json` on-disk cache file name.
        #
        # Renaming the id invalidates that cache file rather than corrupting
        # it: an unknown filename simply misses and the index is refetched.
        #
        # Deliberately NOT `(?![-.\w])`-terminated: `hermes-index.json` and
        # `hermes-index/featured-skill` must move with the bare id. The
        # lookbehind blocks only word characters, for the reason spelled out
        # on kanban-kebab above — a path- or dot-preceded spelling of this id
        # is still this id.
        pattern=r"(?<![A-Za-z0-9_])hermes-index",
        replacement="agentx-index",
        note="skills-hub source id hermes-index -> agentx-index",
    ),
    Rule(
        id="slack-slash-command",
        phase=8,
        # The Slack parent slash command. hermes_cli/commands.py:1305 already
        # registers the subcommand table under "agentx" while the comment two
        # lines above still says `/hermes`, and gateway/relay/ws_transport.py
        # compares an inbound parent against the old spelling — so the relay
        # path recognises a command the CLI no longer advertises.
        #
        # The `@` and `/` in the lookbehind are load-bearing even though this
        # rule is scoped: without `@` the pattern matches `@/hermes`, the
        # import specifier resolving to apps/desktop/src/hermes.ts (170 sites,
        # a source FILE name we keep); without `/` it matches the reverse-proxy
        # prefix examples `/hermes/login` and `/hermes/auth/native/authorize`,
        # which belong to the URL-prefix family, not to this one.
        pattern=r"(?<![A-Za-z0-9_@./-])/hermes(?![A-Za-z0-9_-])",
        replacement="/agentx",
        note="Slack parent slash command /hermes -> /agentx",
        # plugins/platforms/slack/adapter.py is the PRODUCER — it holds the
        # `^/hermes$` match and every doc line describing the command — and
        # tests/gateway/ holds the fixtures the relay asserts against. The
        # first pass scoped this to gateway/ only, which renamed the relay's
        # comparison and left both the adapter and the fixtures behind: the
        # command stopped routing and two test files went red.
        include=[
            "gateway/*",
            "hermes_cli/commands.py",
            "plugins/platforms/slack/*",
            "tests/gateway/*",
            "AGENTS.md",
        ],
    ),
    Rule(
        id="proxy-path-prefix",
        phase=8,
        # `/hermes` as a reverse-proxy path prefix: the worked example in the
        # dashboard-auth cookie/middleware/prefix docstrings, the
        # `X-Forwarded-Prefix: /hermes` header value they parse, and the
        # matching hint in all five desktop locales. Shares its spelling with
        # the Slack slash command above, which is why both are scoped by file
        # rather than distinguished by pattern — the same eight characters mean
        # a chat command in one tree and a URL segment in the other.
        pattern=r"(?<![A-Za-z0-9_@./-])/hermes(?![A-Za-z0-9_-])",
        replacement="/agentx",
        note="reverse-proxy path prefix example /hermes -> /agentx",
        include=[
            "hermes_cli/dashboard_auth/*",
            "hermes_cli/web_server.py",
            "hermes_cli/doctor.py",
            "apps/desktop/src/i18n/*",
            "apps/desktop/electron/*.test.ts",
            "tests/hermes_cli/test_dashboard_auth*.py",
            "tests/agent/test_system_prompt.py",
            "tests/gateway/test_profile_resolution.py",
        ],
    ),
    Rule(
        id="deeplink-scheme",
        phase=8,
        # `hermes://blueprint/<key>?slot=val`. The desktop registered
        # `agentx://` in phase 4 (apps/desktop/package.json build.protocols,
        # main.ts:11733) but the PRODUCER lives in cron/blueprint_catalog.py,
        # which phase 4 could not see: every deep link the blueprint catalog
        # hands the docs site and the desktop today names a scheme no platform
        # claims. Same pattern as the phase-4 desktop-ipc-channel rule, scoped
        # to the producer side.
        #
        # `//` in the pattern rather than a bare `hermes:` keeps it off the
        # skill frontmatter key (`  hermes:` — kept by decision) and off the
        # ACP `_meta` wire key (`{"hermes": …}`).
        pattern=r"(?<![A-Za-z0-9_@./-])hermes://",
        replacement="agentx://",
        note="deep-link URL scheme hermes:// -> agentx://",
        include=["cron/*", "tests/cron/*", "plugins/memory/honcho/*", "website/scripts/*"],
    ),
    Rule(
        id="s6-service-name",
        phase=8,
        # The s6-rc static service `main-hermes`. Four tracked paths under
        # docker/s6-rc.d carry it (three files plus the contents.d entry whose
        # FILE NAME *is* the service name), and hermes_cli/doctor.py:437 reads
        # it back: `for static in ("main-hermes", "dashboard")`. The `git mv`
        # of the two directories ships in the same commit as this rule —
        # a content-only rename leaves the supervisor looking for a service
        # tree that is not there.
        pattern=r"(?<![A-Za-z0-9_])main-hermes(?![A-Za-z0-9_-])",
        replacement="main-agentx",
        note="s6-rc static service main-hermes -> main-agentx",
    ),
    Rule(
        id="telemetry-namespace",
        phase=8,
        # The observability namespace: OTLP metric and span-attribute names
        # (`hermes.task_run.started`, `hermes.gateway.up`), logger names
        # (`hermes.coding_context`, `hermes.lint.lsp`), the SSE event
        # `hermes.tool.progress`, the two shared-metrics schema versions, and
        # the renderer/SPA storage keys that share the shape
        # (`hermes.lastLocation`, `hermes.tokenReloadAttempted`).
        #
        # The lookbehind excludes `.` and `@`, and that alone is what protects
        # the two dotted keys we keep: `metadata.hermes.*` (skill frontmatter,
        # kept for agentskills.io compatibility) and `_meta.hermes` (the ACP
        # wire namespace) are both preceded by a dot. `@` keeps it off the
        # Matrix user id `@hermes:example.org` and the contributor addresses in
        # scripts/release.py.
        #
        # Two explicit exemptions, both deliberate references to a PRE-rename
        # name rather than to this product:
        #   `hermes.service` — hermes_cli/gateway.py:2096 `_LEGACY_SERVICE_NAMES`,
        #     the migration allowlist that finds and offers to remove systemd
        #     units from installs predating the rename. Renaming it makes the
        #     cleanup match nothing, which is the whole point of the constant.
        #   `hermes.desktop` — the same idea in hermes_cli/gui_uninstall.py:156,
        #     which removes both the legacy and the current XDG desktop entry.
        pattern=r"(?<![A-Za-z0-9_@./-])hermes\.(?!service\b|desktop\b)(?=[a-z_])",
        replacement="agentx.",
        note="observability/metric/logger/storage namespace hermes.* -> agentx.*",
        # release.py is a contributor identity map: the keys are real people's
        # email addresses (`hermes.wanderer@yahoo.com`). Rewriting one falsifies
        # an attribution, the same reason .mailmap is globally excluded.
        exclude=["scripts/release.py"],
    ),
    Rule(
        id="worktree-branch-pair",
        phase=8,
        # `hermes/hermes-<shortid>` — the scratch worktree branch, where the
        # brand appears TWICE and the two halves are claimed by two different
        # rules. This rule must run first and take both, because neither of the
        # others can: branch-namespace below stops at the slash, and
        # general-kebab's lookbehind refuses a preceding `/` (which is what
        # keeps it off `/tmp/...` style paths). Left to those two the token
        # comes out `agentx/hermes-deadbeef` — a branch the creator writes one
        # way and the pruner at cli.py:2480 matches the other, which is the
        # exact failure REBRAND.md §6 predicted for this family.
        pattern=r"(?:(?<=refs/heads/)|(?<![A-Za-z0-9_@./:-]))hermes/hermes-",
        replacement="agentx/agentx-",
        note="scratch worktree branch hermes/hermes-<id> -> agentx/agentx-<id>",
        include=[
            "cli.py",
            "hermes_cli/web_git.py",
            "apps/desktop/electron/git-worktree-ops.ts",
            "apps/desktop/electron/git-worktree-ops.test.ts",
            "tests/cli/test_worktree.py",
        ],
    ),
    Rule(
        id="branch-namespace",
        phase=8,
        # The git branch namespace `hermes/<slug>` and, inside it, the scratch
        # worktree branches `hermes/hermes-<shortid>`. This is the family
        # REBRAND.md §6 deferred: renaming the prefix alone would leave
        # `agentx/hermes-deadbeef`, and renaming the worktree id alone would
        # leave the pruner at cli.py:2480 — `b.startswith("hermes/hermes-")` —
        # matching nothing. The `hermes-<shortid>` half moves under the
        # general-kebab rule below, so the two must ship together.
        #
        # Scoped by an explicit include list rather than by a clever pattern,
        # because `hermes/` appears in five unrelated shapes that must NOT
        # move: reverse-proxy prefixes (`gw.example.com/hermes`,
        # `/hermes/login`), filesystem fixtures (`/home/hermes`, `/tmp/hermes`),
        # the openviking peer path (`viking://user/hermes/memories`), OpenClaw's
        # own `extensions/migrate-hermes/`, and `docker/s6-rc.d/main-hermes/`.
        # Every one of those is preceded by `/` or `-`, which is exactly what a
        # branch ref is not — except `refs/heads/hermes/feat`, hence the
        # explicit lookbehind alternative.
        pattern=r"(?:(?<=refs/heads/)|(?<![A-Za-z0-9_@./:-]))hermes/",
        replacement="agentx/",
        note="git branch namespace hermes/<slug> -> agentx/<slug>",
        include=[
            "cli.py",
            "hermes_cli/web_git.py",
            "apps/desktop/electron/git-worktree-ops.ts",
            "apps/desktop/electron/git-worktree-ops.test.ts",
            "apps/desktop/src/app/chat/sidebar/projects/*",
            "tests/cli/test_worktree.py",
            "tests/tui_gateway/test_project_tree.py",
            # Not branches, but the same token used as "A/B" prose naming the
            # product ("targeting hermes/python", "kill hermes/gateway
            # process") and the sops secret path example `"hermes/env"`.
            "tests/conftest.py",
            "tools/approval.py",
            "nix/nixosModules.nix",
        ],
    ),
    Rule(
        id="repo-path-names",
        phase=8,
        # Paths on disk whose names carry the brand, renamed by `git mv` in
        # this commit. Each is an exact identifier rather than prose, so this
        # rule is NOT held back from website/* — a doc naming the old path
        # tells the reader to run a script or open a directory that is gone.
        #
        # Three of these were already half-renamed before this phase:
        #   nix/hermes-agent.nix     — nix/packages.nix:15 already called
        #                              `./agentx-agent.nix`, so the nix build
        #                              could not evaluate at all.
        #   skills/…/hermes-agent/   — SKILL.md already declared
        #                              `name: agentx-agent`, and skills resolve
        #                              by frontmatter name, so only the
        #                              directory (and every doc citing it) was
        #                              stale.
        #   …/hermes-agent-skill-authoring, …/hermes-s6-container-supervision
        #                            — same shape.
        # Written as one alternation of zero-width contexts around a bare
        # `hermes` so the replacement stays a plain string. Four of the seven
        # are unreachable by general-kebab below: three sit behind its `agent`
        # guard (which belongs to the phase-5 dist-name family) and two sit
        # behind a hyphen, which its lookbehind refuses so that
        # `use-hermes-config` survives.
        pattern=(
            r"(?:(?<=setup-)hermes(?=\.sh)"
            r"|(?<=inspecting-)hermes(?=-desktop-dom)"
            r"|(?<=autonomous-ai-agents/)hermes(?=-agent(?![A-Za-z0-9_-]))"
            r"|(?<![A-Za-z0-9_-])hermes(?=-agent\.nix)"
            r"|(?<![A-Za-z0-9_-])hermes(?=-already-has-routines\.md)"
            r"|(?<![A-Za-z0-9_-])hermes(?=-agent-skill-authoring)"
            r"|(?<![A-Za-z0-9_-])hermes(?=-s6-container-supervision))"
        ),
        replacement="agentx",
        note="on-disk path names (scripts, nix package, skill directories) -> agentx-*",
    ),
    Rule(
        id="general-kebab",
        phase=8,
        # app-kebab's counterpart for everything outside apps/: the product's
        # own `hermes-<something>` names in the backend, the gateway, the
        # plugins, the TUI, the web dashboard and the tests. Container labels
        # and sandbox names, /tmp scratch prefixes, ntfy topic defaults,
        # credential-source tags, CI comment markers, the dashboard action id,
        # the scratch worktree ids, storage keys and DOM ids.
        #
        # The guard list is app-kebab's plus four names this scope reaches that
        # apps/ never did, each verified against the tree:
        #   lcm    — github.com/stephenschoettler/hermes-lcm, a THIRD-PARTY
        #            context-engine plugin cited by name in agent/ comments and
        #            packaged in nix/nixosModules.nix.
        #   brain  — `hermes-brain:qwen3-14b-ctx16k`, a deliberate counter-
        #            example: hermes_cli/model_switch.py's non-agentic filter
        #            must NOT match a user's local Modelfile that merely starts
        #            with the word, and tests/hermes_cli/test_nous_hermes_non_agentic.py
        #            asserts exactly that. Renaming it makes the test vacuous.
        #   seaeye — `hermes-seaeye[bot]`, a real GitHub account cited in
        #            scripts/contributor_audit.py as an example of the `[bot]`
        #            suffix.
        #   jc     — `jason@hermes-jc`, a contributor's real email domain.
        pattern=(
            r"(?<![A-Za-z0-9_-])hermes-"
            r"(?!agent|setup|[0-9]|[xy](?![A-Za-z0-9_-])"
            r"|parser|estree|eslint|tools(?![-\w])|ink\b|achievements\b|0day"
            r"|lcm\b|brain\b|seaeye|jc\b|example-plugins)"
        ),
        replacement="agentx-",
        note="backend/plugin/test hermes-* names -> agentx-*",
        # apps/* is app-kebab's (phase 4, already applied); website/* is phase 9.
        # release.py is the contributor identity map — see telemetry-namespace.
        exclude=["apps/*", "scripts/release.py"],
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
