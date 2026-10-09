"""``agentx uninstall`` subcommand parser.

Extracted verbatim from ``hermes_cli/main.py:main()`` (god-file Phase 2).
Handler injected to avoid importing ``main``.
"""

from __future__ import annotations

from typing import Callable


def build_uninstall_parser(subparsers, *, cmd_uninstall: Callable) -> None:
    """Attach the ``uninstall`` subcommand to ``subparsers``."""
    # =========================================================================
    # uninstall command
    # =========================================================================
    uninstall_parser = subparsers.add_parser(
        "uninstall",
        help="Uninstall AgentX Workmate",
        description=(
            "Remove AgentX Workmate from your system: the code, the agentx "
            "command and shortcuts. Your configs, sessions, logs, saved model "
            "key and the desktop app's data are kept for a future reinstall, "
            "like the Windows uninstaller and the app's Settings do. Pass "
            "--full to delete those too."
        ),
    )
    uninstall_parser.add_argument(
        "--keep-data",
        action="store_true",
        help=(
            "Keep configs, sessions, logs and the desktop app's data. This is "
            "the default; the flag is accepted so existing scripts keep working."
        ),
    )
    uninstall_parser.add_argument(
        "--full",
        action="store_true",
        help=(
            "Also delete configs, sessions, logs, the saved model key (~/.agentx) "
            "and the desktop app's data"
        ),
    )
    uninstall_parser.add_argument(
        "--gui",
        action="store_true",
        help="Uninstall only the desktop Chat GUI, leaving the agent intact",
    )
    uninstall_parser.add_argument(
        "--gui-summary",
        action="store_true",
        help="Print a JSON summary of installed GUI/agent artifacts and exit "
        "(used by the desktop app to gate uninstall options)",
    )
    uninstall_parser.add_argument(
        "--yes", "-y", action="store_true", help="Skip confirmation prompts"
    )
    uninstall_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what uninstall would remove without changing anything",
    )
    uninstall_parser.set_defaults(func=cmd_uninstall)
