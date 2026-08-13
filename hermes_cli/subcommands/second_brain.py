"""``agentx second-brain`` subcommand parser.

``serve`` is the process an operator runs so that one person's model key,
devices and history live in one place they control instead of being scattered
across every machine that person owns. It belongs on a server, never a laptop.

The other three are the laptop's side of the same relationship, and they are
here rather than under a name of their own because ``agentx sync`` is already
taken by Skill Sync — a different feature, syncing different things, through a
different service. Two commands called "sync" doing unrelated work would be a
support trap, and the thing these actually report on is this machine's
standing with the second brain.

``status``  where synchronisation has got to. Reads the local database: no
            credential, no network. This is the one that has to answer on a
            machine whose app will not open, which is the machine somebody
            will ask about.
``sync``    run a tick now instead of waiting for the next one.
``reset``   rewind the change-feed cursor so the next tick re-pulls
            everything. The documented recovery after the service has been
            restored to an earlier point.

It is deliberately a *separate* command from ``agentx account broker``: the
broker is the thing this replaces, and giving the replacement its own name
means an operator can stand one up beside the other, cut over, and retire the
old one without ever having run both behind the same verb.
"""

from __future__ import annotations

import argparse
from typing import Callable

#: Default bind port. Distinct from the broker's 8787 so both can run on one
#: host during a migration.
DEFAULT_PORT = 8811


def build_second_brain_parser(subparsers, *, cmd_second_brain: Callable) -> None:
    """Attach the ``second-brain`` subcommand to ``subparsers``."""
    parser = subparsers.add_parser(
        "second-brain",
        help="The central account service, and this machine's standing with it",
        epilog=(
            "Examples:\n"
            "  agentx second-brain status        where synchronisation has got to\n"
            "  agentx second-brain sync          synchronise now\n"
            "  agentx second-brain reset         re-pull the whole feed\n"
            "  agentx second-brain serve         run the service (on a server)\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    actions = parser.add_subparsers(dest="second_brain_action")

    serve = actions.add_parser(
        "serve",
        help="Serve the second-brain API: model keys, devices, and sync",
    )
    serve.add_argument(
        "--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)"
    )
    serve.add_argument(
        "--port", type=int, default=DEFAULT_PORT, help=f"Bind port (default: {DEFAULT_PORT})"
    )

    status = actions.add_parser(
        "status",
        help="Where history synchronisation has got to (no network call)",
    )
    status.add_argument(
        "--json", action="store_true", help="Print the raw status object"
    )

    actions.add_parser(
        "sync",
        help="Synchronise history now instead of waiting for the next tick",
    )

    reset = actions.add_parser(
        "reset",
        help="Re-pull the whole feed from the start (safe: applying is idempotent)",
    )
    reset.add_argument(
        "--yes", action="store_true", help="Do not ask for confirmation"
    )

    parser.set_defaults(func=cmd_second_brain)
