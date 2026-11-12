"""``agentx login`` subcommand parser.

Extracted verbatim from ``hermes_cli/main.py:main()`` (god-file Phase 2).
Handler injected to avoid importing ``main``.
"""

from __future__ import annotations

import argparse
from typing import Callable


def build_login_parser(subparsers, *, cmd_login: Callable) -> None:
    """Attach SSO login; accept legacy flags for an actionable error."""
    login_parser = subparsers.add_parser(
        "login",
        help="Sign in with your AgentX SSO account",
        description="Sign in through your browser. Model access is assigned to your AgentX account.",
    )
    # Parse old flags so existing aliases get the account-policy explanation.
    # SSO deployment settings live in config.yaml, never in login flags.
    login_parser.add_argument(
        "--provider",
        default=None,
        help=argparse.SUPPRESS,
    )
    login_parser.add_argument(
        "--portal-url", help=argparse.SUPPRESS
    )
    login_parser.add_argument(
        "--inference-url",
        help=argparse.SUPPRESS,
    )
    login_parser.add_argument(
        "--client-id", default=None, help=argparse.SUPPRESS
    )
    login_parser.add_argument("--scope", default=None, help=argparse.SUPPRESS)
    login_parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not attempt to open the browser automatically",
    )
    login_parser.add_argument(
        "--timeout",
        type=float,
        default=300.0,
        help="Time to complete browser sign-in, in seconds (default: 300)",
    )
    login_parser.add_argument(
        "--ca-bundle", help=argparse.SUPPRESS
    )
    login_parser.add_argument(
        "--insecure",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    login_parser.set_defaults(func=cmd_login)
