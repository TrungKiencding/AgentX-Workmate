"""The laptop's side of the conversation with the second-brain service.

Deliberately shaped like ``hermes_cli.litellm_admin.LiteLLMAdminClient``:
synchronous httpx, one retry, and an error type that distinguishes "the
service said no" from "the service could not be reached". Every outbound HTTP
path in the CLI is synchronous, and async callers wrap it in a threadpool
rather than forcing a second style into the tree.

That reachable-versus-refused distinction is the whole reason this file is not
three ``httpx.get`` calls inline. A laptop that cannot reach the service must
keep working with what it already holds — an outage is never a revocation —
and the only way callers can honour that is if the client tells them which
kind of failure they are looking at.

Two headers travel on every request:

``Authorization``      the person's Keycloak bearer. The service derives the
                       account from the verified ``sub`` and ignores anything
                       the body claims, so this decides whose devices are
                       listed.
``X-AgentX-Device``    which machine is asking. Without it the service answers
                       ``400``: a device list that cannot name the current
                       device is a device list nobody can safely revoke from.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

# Long enough for a service that is waking a database connection, short enough
# that an unreachable one cannot make Settings feel broken.
DEFAULT_TIMEOUT_SECONDS = 15.0

# Same shape as the LiteLLM admin client's: one retry covers a dropped
# connection or a restarting worker, and anything more persistent is better
# reported than waited out.
_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
_MAX_ATTEMPTS = 2
_RETRY_DELAY_SECONDS = 0.75

DEVICE_ID_HEADER = "X-AgentX-Device"
DEVICE_NAME_HEADER = "X-AgentX-Device-Name"

#: Where a backend with no desktop above it keeps its own device id. Named and
#: shaped exactly like ``apps/desktop/electron/device-id.ts`` writes, and for
#: the same reason: the id belongs to the INSTALL, so it sits at the install
#: root rather than in an account home, where signing in as somebody else would
#: turn one machine into two.
DEVICE_FILENAME = "device.json"

_DEVICE_NAME_MAX = 64


class SecondBrainError(RuntimeError):
    """A call to the second brain failed.

    ``status_code`` is the HTTP status when there was one and ``None`` when the
    request never got an answer. ``code`` is the service's machine-readable
    error (``device_revoked``, ``cannot_revoke_last_device``, …), which is what
    a caller should branch on — matching on the human sentence breaks the day
    somebody improves the wording.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        code: str = "",
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code

    @property
    def unreachable(self) -> bool:
        """True when we never got an HTTP answer at all."""
        return self.status_code is None

    @property
    def revoked(self) -> bool:
        """True when the service says this device has been cut off.

        The one failure that must reach the user as "sign in again" rather
        than as "try later".
        """
        return self.status_code == 403 and self.code == "device_revoked"


class SecondBrainClient:
    """Talks to one second-brain deployment on behalf of one person.

    ``transport`` exists so tests drive the whole flow through
    ``httpx.MockTransport`` with no network and no fixture server — the
    convention the rest of the tree's HTTP clients follow.
    """

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: Any | None = None,
        sleep: Any | None = None,
    ) -> None:
        root = (base_url or "").strip().rstrip("/")
        if not root:
            raise SecondBrainError("the second-brain base_url is empty")
        self._base_url = root
        self._timeout = timeout
        self._transport = transport
        if sleep is None:
            import time

            sleep = time.sleep
        self._sleep = sleep

    # -- plumbing ---------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        bearer: str,
        device_id: str,
        device_name: str = "",
        params: Mapping[str, Any] | None = None,
        json_body: Mapping[str, Any] | None = None,
    ) -> Any:
        import httpx

        url = f"{self._base_url}{path}"
        headers = {
            "Authorization": f"Bearer {bearer}",
            "Accept": "application/json",
            DEVICE_ID_HEADER: device_id,
        }
        if device_name:
            headers[DEVICE_NAME_HEADER] = device_name

        last: SecondBrainError | None = None
        for attempt in range(_MAX_ATTEMPTS):
            try:
                with httpx.Client(
                    timeout=self._timeout,
                    transport=self._transport,
                    follow_redirects=True,
                ) as client:
                    response = client.request(
                        method, url, params=params, json=json_body, headers=headers
                    )
            except httpx.RequestError as exc:
                last = SecondBrainError(f"could not reach the second brain at {url}: {exc}")
            else:
                if response.status_code in _RETRY_STATUSES:
                    last = _failure(response)
                elif response.status_code >= 400:
                    raise _failure(response)
                else:
                    try:
                        return response.json()
                    except ValueError as exc:
                        raise SecondBrainError(
                            f"the second brain returned a non-JSON body for {path}",
                            status_code=response.status_code,
                        ) from exc

            if attempt + 1 < _MAX_ATTEMPTS:
                self._sleep(_RETRY_DELAY_SECONDS)

        raise last or SecondBrainError(f"the request to {path} failed")

    # -- the calls --------------------------------------------------------

    def heartbeat(
        self,
        *,
        bearer: str,
        device_id: str,
        device_name: str = "",
        platform: str = "",
        app_version: str = "",
    ) -> dict[str, Any]:
        """Announce this machine, with the details only it knows."""
        return self._request(
            "POST",
            "/v1/devices/heartbeat",
            bearer=bearer,
            device_id=device_id,
            device_name=device_name,
            json_body={
                "name": device_name,
                "platform": platform,
                "app_version": app_version,
            },
        )

    def list_devices(
        self, *, bearer: str, device_id: str, device_name: str = ""
    ) -> dict[str, Any]:
        """Every machine this person is signed in on."""
        return self._request(
            "GET",
            "/v1/devices",
            bearer=bearer,
            device_id=device_id,
            device_name=device_name,
        )

    def revoke_device(
        self,
        target_device_id: str,
        *,
        bearer: str,
        device_id: str,
        device_name: str = "",
        rotate_key: bool = False,
    ) -> dict[str, Any]:
        """Cut a machine off, optionally taking its model access with it."""
        return self._request(
            "DELETE",
            f"/v1/devices/{target_device_id}",
            bearer=bearer,
            device_id=device_id,
            device_name=device_name,
            params={"rotate_key": "true" if rotate_key else "false"},
        )

    def model_key(
        self,
        *,
        bearer: str,
        device_id: str,
        device_name: str = "",
        rotate: bool = False,
    ) -> dict[str, Any]:
        """Fetch this person's model key, minting one only if they have none.

        The service answers the same plaintext to every device, which is the
        entire point: this call is what stopped a second laptop from costing
        somebody their first one. ``rotate`` asks for a replacement and retires
        the stored one — the "my key leaked" path, and the one the revoke
        button uses.
        """
        return self._request(
            "POST",
            "/v1/model-key",
            bearer=bearer,
            device_id=device_id,
            device_name=device_name,
            json_body={"rotate": bool(rotate)},
        )

    def push_documents(
        self,
        documents: Any,
        *,
        bearer: str,
        device_id: str,
        device_name: str = "",
    ) -> dict[str, Any]:
        """Send this device's changed documents to the feed.

        The answer names every document individually, because the service
        accepts a batch containing one it cannot store rather than refusing
        the batch — see the poison-document note in ``second_brain/sync.py``.
        The caller is expected to read ``results`` and not just the count.
        """
        return self._request(
            "POST",
            "/v1/sync/push",
            bearer=bearer,
            device_id=device_id,
            device_name=device_name,
            json_body={"documents": list(documents)},
        )

    def changes(
        self,
        *,
        bearer: str,
        device_id: str,
        device_name: str = "",
        since: int = 0,
        limit: int = 200,
        kinds: Any = (),
    ) -> dict[str, Any]:
        """One page of the feed above *since*, oldest first.

        ``has_more`` in the answer is what lets a device that has just been
        set up drain a whole history immediately rather than collecting one
        page per polling interval.
        """
        params: dict[str, Any] = {"since": int(since), "limit": int(limit)}
        wanted = [str(kind).strip() for kind in (kinds or ()) if str(kind).strip()]
        if wanted:
            params["kinds"] = ",".join(wanted)
        return self._request(
            "GET",
            "/v1/sync/changes",
            bearer=bearer,
            device_id=device_id,
            device_name=device_name,
            params=params,
        )


# ---------------------------------------------------------------------------
# Which machine is this?
# ---------------------------------------------------------------------------


def device_name_from(hostname: str) -> str:
    """Reduce a hostname to something safe to put in a header.

    Mirrors ``deviceNameFrom`` in ``device-id.ts``. Header values cannot carry
    CR/LF and a machine name is whatever its owner typed, so everything outside
    a conservative set collapses to a space and the result is bounded.
    """
    import re

    cleaned = re.sub(r"[^\x20-\x7E]+", " ", hostname or "")
    cleaned = re.sub(r"[^A-Za-z0-9 ._-]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()[:_DEVICE_NAME_MAX].strip()
    return cleaned or "unknown device"


def install_device_identity(root: Path | None = None) -> tuple[str, str]:
    """Return ``(device_id, device_name)`` for a backend nobody told.

    The desktop sends both headers on every request, so this is only reached by
    an install that has no desktop above it — a CLI sign-in, or a backend
    somebody started by hand over SSH. Without it those installs could not talk
    to the service at all: it answers ``400`` to a request that will not name
    its machine, because a device list that cannot name the current device is a
    device list nobody can safely revoke from.

    The id is generated once and kept at the install root, next to the accounts
    it is shared by. That is the same rule ``device-id.ts`` follows and for the
    same reason — the id names the install, not the person, so switching
    accounts must not produce a second device.

    Reading is total: a truncated or hand-edited file yields a fresh id rather
    than raising. This runs on the sign-in path, and an unreadable file costs
    one stale row in a device list somebody can delete, where an exception
    would cost them their model key.
    """
    import json
    import socket
    import uuid

    from hermes_constants import get_default_hermes_root

    try:
        name = device_name_from(socket.gethostname())
    except OSError:
        name = "unknown device"

    path = Path(root) if root is not None else Path(get_default_hermes_root())
    path = path / DEVICE_FILENAME

    stored = ""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        candidate = str((data or {}).get("id") or "") if isinstance(data, dict) else ""
        # Validated on the way out as well as on the way in: a hand-edited file
        # must not be able to put arbitrary text into a header.
        stored = str(uuid.UUID(candidate)) if candidate else ""
    except (OSError, ValueError, TypeError):
        stored = ""

    if stored:
        return stored, name

    device_id = str(uuid.uuid4())
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"id": device_id, "name": name}, indent=2) + "\n",
            encoding="utf-8",
        )
    except OSError:
        # An unwritable root means a new id next launch, which shows up as a
        # duplicate row in the device list. Still better than refusing to
        # provision.
        pass

    return device_id, name


def _failure(response: Any) -> SecondBrainError:
    """Turn a refusal into one line, keeping the code a caller can branch on."""
    status = response.status_code
    code = ""
    detail = ""
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        code = str(body.get("error") or "")
        detail = str(body.get("detail") or "")
    if not detail:
        detail = (getattr(response, "text", "") or "")[:300]
    detail = detail.strip()
    return SecondBrainError(
        f"the second brain returned HTTP {status}{f': {detail}' if detail else ''}",
        status_code=status,
        code=code,
    )
