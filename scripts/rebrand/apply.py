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
            "website/*",
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
        exclude=["website/*"],
    ),
    Rule(
        id="cli-launcher-relative",
        phase=3,
        # `./hermes` / `../hermes`: the launcher invoked from a checkout, in
        # shell snippets and docs. Held off apps/* for the reason above.
        pattern=r"(\.\.?)([/\\]+)hermes(?![A-Za-z0-9_./:@-])",
        replacement=r"\1\2agentx",
        note="launcher run from a checkout ./hermes -> ./agentx",
        exclude=["apps/*", "website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
    ),
    Rule(
        id="toolset-family-dynamic",
        phase=3,
        # The same family, built at runtime from the platform name.
        pattern=r'f"hermes-\{(platform|entry\.name)\}"',
        replacement=r'f"agentx-{\1}"',
        note="dynamic toolset name f\"hermes-{platform}\" -> f\"agentx-{platform}\"",
        exclude=["website/*"],
    ),
    Rule(
        id="acp-prog",
        phase=3,
        pattern=r"hermes-acp",
        replacement="agentx-acp",
        note="hermes-acp entry point -> agentx-acp",
        exclude=["website/*"],
    ),
    Rule(
        id="gateway-prog",
        phase=3,
        pattern=r"hermes-gateway",
        replacement="agentx-gateway",
        note="hermes-gateway entry point / systemd unit -> agentx-gateway",
        exclude=["website/*"],
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
        exclude=["website/*"],
    ),
    Rule(
        id="brand-glyph",
        phase=3,
        pattern="⚕",
        replacement="⬡",
        note="caduceus (Hermes' staff) -> hexagon brand glyph",
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        pattern=r"([\\/]+)Hermes\b(?![-\s]*\d)(?! [a-z])",
        replacement=r"\1AgentX Workmate",
        note="install/bundle directory .../Hermes -> .../AgentX Workmate",
        exclude=["website/*"],
    ),
    # Display names, longest first so a broader rule never eats a token a
    # narrower one was meant to claim.
    Rule(
        id="wordmark-nous",
        phase=3,
        pattern=r"\bNOUS HERMES\b",
        replacement="AGENTX WORKMATE",
        note='uppercase "NOUS HERMES" wordmark -> "AGENTX WORKMATE"',
        exclude=["website/*"],
    ),
    Rule(
        id="wordmark-upper",
        phase=3,
        pattern=r"\bHERMES[- ]AGENT\b",
        replacement="AGENTX WORKMATE",
        note='uppercase "HERMES AGENT" wordmark -> "AGENTX WORKMATE"',
        exclude=["website/*"],
    ),
    Rule(
        id="display-name-full",
        phase=3,
        pattern=r"\bHermes Agent\b",
        replacement="AgentX Workmate",
        note='"Hermes Agent" display string -> "AgentX Workmate"',
        exclude=["website/*"],
    ),
    Rule(
        id="display-name-desktop",
        phase=3,
        pattern=r"\bHermes Desktop\b",
        replacement="AgentX Workmate Desktop",
        note='"Hermes Desktop" -> "AgentX Workmate Desktop"',
        exclude=["website/*"],
    ),
    Rule(
        id="display-name-short",
        phase=3,
        # Bare capitalised Hermes in prose/UI. Runs after the multi-word
        # display names above have claimed their occurrences.
        #
        # The two guards keep Nous's Hermes *models* intact — hermes-4,
        # Nous Hermes 3, NousResearch/Hermes-3-Llama-3.1-70B are model slugs
        # sent to provider APIs, and renaming one breaks the request.
        pattern=r"(?<!Nous )\bHermes\b(?![-\s]*\d)",
        replacement="AgentX",
        note='bare "Hermes" display string -> "AgentX" (model names exempt)',
        exclude=["website/*"],
    ),
    Rule(
        id="wordmark-bare-upper",
        phase=3,
        # Runs last: the multi-word uppercase wordmarks above are gone by now.
        pattern=r"\bHERMES\b(?![-\s]*\d)",
        replacement="AGENTX",
        note='bare uppercase "HERMES" -> "AGENTX"',
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*", "agent/curator.py"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        exclude=["website/*"],
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
        # The `-` and `.` in the lookbehind are load-bearing: they keep the
        # sweep off `use-hermes-config` and `windows-hermes-path`, which are
        # source FILE names (kept, §2) — renaming the specifier without the
        # file is an unresolved import.
        # The third guard is names that are not ours at all. `hermes-parser`
        # and `hermes-estree` are Meta's JavaScript-engine packages and reach
        # this tree as ordinary npm dependencies; `hermes-tools` is the MCP
        # server name in the codex config; `hermes-index` is the skills-hub
        # source id; `hermes-ink` and `hermes-achievements` are directories on
        # disk. None appears under apps/ today — the guard is here so that the
        # day one does, this rule does not quietly rename a third party's
        # package and break `npm ci`.
        pattern=(
            r"(?<![A-Za-z0-9_./-])hermes-"
            r"(?!agent|setup|[0-9]|[xy](?![A-Za-z0-9_-])"
            r"|parser|estree|eslint|tools\b|index\b|ink\b|achievements\b|0day)"
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
