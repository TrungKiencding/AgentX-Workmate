"""The signed-in person's bearer, as the desktop last handed it to this process.

The backend has no credential of its own for the signed-in person. It holds no
refresh token, there is no confidential client it could use, and the
dashboard's own auth layer deliberately writes nothing to disk. The only
component that can produce a bearer at an arbitrary moment is the desktop's
main process, and the only way it shares one is as a request header.

So the request that carries it on a timer leaves a copy here:
``GET /api/account/license``, which the desktop's account ticker calls every
thirty seconds once somebody has signed in (``web_routers/accounts.py``). Work
that has to reach an AgentX service outside any request spends that copy until
it expires — the license check after a gateway refusal mid-turn
(``account_license``) and the AgentX AgentHub sync loop (``hub_sync``).

**Never persisted.** It dies with the process, which is the correct lifetime
for a token this process cannot renew. Writing it to disk would create exactly
the long-lived credential the auth layer took care not to have.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class AccountCredentials:
    """Who is signed in, from which machine, and until when.

    ``expires_at`` is the token's own ``exp``. Zero means "unknown", which is
    treated as usable — the service is the authority on whether a token is
    good, and refusing to try would be this process second-guessing it.
    """

    bearer: str
    device_id: str
    device_name: str = ""
    expires_at: float = 0.0

    @property
    def usable(self) -> bool:
        if not (self.bearer and self.device_id):
            return False
        # A token we can see has expired would only be spent to be told 401.
        return not (self.expires_at and self.expires_at <= time.time())


class CredentialMailbox:
    """The most recent usable credentials this process was handed, in memory only."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._held: Optional[AccountCredentials] = None

    def remember(self, credentials: Optional[AccountCredentials]) -> None:
        """Keep *credentials* if they are usable. Ignores anything else.

        A request arriving without a usable token must not replace a copy that
        still works.
        """
        if credentials is None or not credentials.usable:
            return
        with self._lock:
            self._held = credentials

    def current(self) -> Optional[AccountCredentials]:
        """The held credentials, or None once they have expired."""
        with self._lock:
            held = self._held
            if held is not None and not held.usable:
                self._held = None
                return None
            return held


#: Process-global: there is exactly one person signed into a backend.
_MAILBOX = CredentialMailbox()


def mailbox() -> CredentialMailbox:
    """The process's credential mailbox. Fed by ``GET /api/account/license``."""
    return _MAILBOX
