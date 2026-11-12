"""``agentx logout`` subcommand parser.

Extracted verbatim from ``hermes_cli/main.py:main()`` (god-file Phase 2).
Handler injected to avoid importing ``main``.
"""

from __future__ import annotations

from typing import Callable


def build_logout_parser(subparsers, *, cmd_logout: Callable) -> None:
    """Attach the ``logout`` subcommand to ``subparsers``."""
    # =========================================================================
    # logout command
    # =========================================================================
    logout_parser = subparsers.add_parser(
        "logout",
        help="Sign out of AgentX SSO on this CLI",
        description="End the CLI sign-in while preserving account data",
    )
    logout_parser.add_argument(
        "--provider",
        choices=["nous", "openai-codex", "xai-oauth", "spotify"],
        default=None,
        help="Provider to log out from (default: active provider)",
    )
    logout_parser.set_defaults(func=cmd_logout)
