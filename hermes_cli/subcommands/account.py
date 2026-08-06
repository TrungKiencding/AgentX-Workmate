"""``agentx account`` subcommand parser.

Accounts are normally created and selected by the desktop app after a Keycloak
sign-in, but the terminal must not be a second-class citizen: somebody
debugging a laptop over SSH needs to see whose homes exist, which one they are
in, and whether that person's model key is healthy.
"""

from __future__ import annotations

from typing import Callable


def build_account_parser(subparsers, *, cmd_account: Callable) -> None:
    """Attach the ``account`` subcommand to ``subparsers``."""
    account_parser = subparsers.add_parser(
        "account",
        help="Inspect the signed-in accounts on this machine and their model keys",
    )
    account_subparsers = account_parser.add_subparsers(dest="account_action")

    account_subparsers.add_parser("list", help="List every account home on this machine")

    account_show = account_subparsers.add_parser(
        "show", help="Show one account's home, identity, and provider key"
    )
    account_show.add_argument(
        "account_name", nargs="?", help="Account slug (default: the active one)"
    )

    account_provision = account_subparsers.add_parser(
        "provision",
        help="Ensure the active account holds a working LiteLLM key",
    )
    account_provision.add_argument(
        "--rotate",
        action="store_true",
        help="Retire the current key and mint a fresh one (use if it leaked)",
    )
    account_provision.add_argument(
        "--token",
        default="",
        metavar="BEARER",
        help=(
            "Keycloak access token, required in broker mode. The desktop app "
            "supplies this automatically; pass it here only when provisioning "
            "by hand."
        ),
    )
    # Identity is normally recorded by sign-in. These exist for the paths that
    # have no sign-in to record it: a headless server, and an operator
    # verifying a LiteLLM setup before rolling the desktop app out.
    #
    # They grant no privilege. In direct mode this machine already holds the
    # admin key, so naming a subject buys nothing it could not already do; in
    # broker mode the bearer decides who gets a key and these are ignored.
    account_provision.add_argument(
        "--subject",
        default="",
        metavar="SUB",
        help=(
            "Record this Keycloak subject for the account before provisioning. "
            "Only needed when nobody has signed in on this machine yet."
        ),
    )
    account_provision.add_argument(
        "--username", default="", help="Username to record alongside --subject."
    )
    account_provision.add_argument(
        "--email", default="", help="Email to record alongside --subject."
    )

    # Server-side, not laptop-side: this is the process an operator runs so
    # that the LiteLLM admin key lives in one place they control instead of on
    # every employee's machine.
    account_broker = account_subparsers.add_parser(
        "broker",
        help="Run the central key-minting broker (server-side, not on a laptop)",
    )
    account_broker.add_argument(
        "--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)"
    )
    account_broker.add_argument(
        "--port", type=int, default=8787, help="Bind port (default: 8787)"
    )

    account_delete = account_subparsers.add_parser(
        "delete", help="Delete an account home and everything in it"
    )
    account_delete.add_argument("account_name", help="Account slug")
    account_delete.add_argument(
        "-y", "--yes", action="store_true", help="Skip the confirmation prompt"
    )

    account_parser.set_defaults(func=cmd_account)
