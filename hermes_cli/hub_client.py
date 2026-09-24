"""The laptop's side of the conversation with the AgentX Skill Hub.

Shaped like :mod:`hermes_cli.second_brain_client` and for the same reasons:
synchronous httpx, one retry, and an error type that distinguishes "the hub
said no" from "the hub could not be reached". A laptop that cannot reach the
hub must keep working with the skills it already holds — an outage is never
a revocation — and callers can only honour that if the client tells them
which failure they are looking at.

Two headers travel on every request:

``Authorization``      the person's Keycloak bearer (the ID token the desktop
                       signed in with), or a personal hub token (``hub_…``)
                       for an install without a desktop. The hub derives the
                       account from the verified token and ignores anything a
                       body says.
``X-AgentX-Device``    which machine is asking — the same install id the
                       second brain gets (``device.json`` / Electron's
                       ``device-id.ts``), so an Install clicked on the web for
                       "máy A" reaches máy A and the web can say it landed.

Read-only helpers for the catalog live in ``tools/skills_hub.py``
(``AgentXHubSource``); this module is the *account* side: desired installs,
reports, uploads, the change feed and the event stream.
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Dict, Iterable, List, Mapping, Optional

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 20.0
_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
_MAX_ATTEMPTS = 2
_RETRY_DELAY_SECONDS = 0.75

DEVICE_ID_HEADER = "X-AgentX-Device"
DEVICE_NAME_HEADER = "X-AgentX-Device-Name"
PRODUCT = "workmate"
#: The hub sends a keepalive comment every 25 s; a stream silent for longer
#: than this is treated as dead and reopened.
STREAM_READ_TIMEOUT_SECONDS = 90.0


class HubError(RuntimeError):
    """A call to the hub failed.

    ``status_code`` is the HTTP status when there was one and ``None`` when the
    request never got an answer. ``code`` is the hub's machine-readable error
    (``invalid_token``, ``install_not_found``, ``rate_limited``, …); branch on
    it, never on the sentence.
    """

    def __init__(self, message: str, *, status_code: Optional[int] = None, code: str = "", detail: Any = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.detail = detail

    @property
    def unreachable(self) -> bool:
        """True when we never got an HTTP answer at all."""
        return self.status_code is None

    @property
    def reauth(self) -> bool:
        """True when the token was refused — sign in again fixes it, retrying does not."""
        return self.status_code == 401

    @property
    def identity_unavailable(self) -> bool:
        """The hub could not ask the realm (503 ``identity_unavailable``): keep
        the credentials, try later."""
        return self.status_code == 503 and self.code == "identity_unavailable"


def hub_base_url() -> str:
    """``skills.hub_url`` / ``AGENTX_SKILLS_HUB_URL`` / the default, via the source adapter."""
    from tools.skills_hub import agentx_hub_url

    return agentx_hub_url()


def hub_api_token() -> str:
    """A personal hub token for installs without a desktop (``skills.hub_token``)."""
    from tools.skills_hub import agentx_hub_token

    return agentx_hub_token()


class HubClient:
    """Talks to one AgentX Skill Hub on behalf of one person and one machine.

    ``transport`` exists so tests drive the whole flow through
    ``httpx.MockTransport`` with no network and no fixture server.
    """

    def __init__(self, base_url: str, *, timeout: float = DEFAULT_TIMEOUT_SECONDS, transport: Any | None = None, sleep: Any | None = None) -> None:
        root = (base_url or "").strip().rstrip("/")
        if not root:
            raise HubError("the hub base_url is empty")
        self.base_url = root
        self._timeout = timeout
        self._transport = transport
        if sleep is None:
            import time

            sleep = time.sleep
        self._sleep = sleep

    # -- plumbing ---------------------------------------------------------

    @staticmethod
    def headers(bearer: str, device_id: str = "", device_name: str = "") -> Dict[str, str]:
        headers = {"Authorization": f"Bearer {bearer}", "Accept": "application/json", "User-Agent": "agentx-workmate-hub-client"}
        if device_id:
            headers[DEVICE_ID_HEADER] = device_id
        if device_name:
            headers[DEVICE_NAME_HEADER] = device_name
        return headers

    def _send(
        self,
        method: str,
        path: str,
        *,
        bearer: str,
        device_id: str = "",
        device_name: str = "",
        params: Optional[Mapping[str, Any]] = None,
        json_body: Optional[Mapping[str, Any]] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
    ) -> Any:
        """The answer below 400 (one retry on a network error or a 429/5xx); a
        refusal raises :class:`HubError`."""
        import httpx

        url = f"{self.base_url}{path}"
        headers = self.headers(bearer, device_id, device_name)
        headers.update(extra_headers or {})
        last: Optional[HubError] = None
        for attempt in range(_MAX_ATTEMPTS):
            try:
                with httpx.Client(timeout=self._timeout, transport=self._transport, follow_redirects=False) as client:
                    response = client.request(method, url, params=params, json=json_body, headers=headers)
            except httpx.RequestError as exc:
                last = HubError(f"could not reach the AgentX Skill Hub at {url}: {exc}")
            else:
                if response.status_code in _RETRY_STATUSES:
                    last = _failure(response, path)
                elif response.status_code >= 400:
                    raise _failure(response, path)
                else:
                    return response
            if attempt + 1 < _MAX_ATTEMPTS:
                self._sleep(_RETRY_DELAY_SECONDS)
        raise last or HubError(f"the request to {path} failed")

    def _request(
        self,
        method: str,
        path: str,
        *,
        bearer: str,
        device_id: str = "",
        device_name: str = "",
        params: Optional[Mapping[str, Any]] = None,
        json_body: Optional[Mapping[str, Any]] = None,
    ) -> Any:
        response = self._send(method, path, bearer=bearer, device_id=device_id, device_name=device_name, params=params, json_body=json_body)
        if response.status_code == 204 or not response.content:
            return {}
        try:
            return response.json()
        except ValueError as exc:
            raise HubError(f"the hub returned a non-JSON body for {path}", status_code=response.status_code) from exc

    # -- who am I ----------------------------------------------------------

    def me(self, *, bearer: str, device_id: str = "", device_name: str = "") -> Dict[str, Any]:
        return self._request("GET", "/v1/me", bearer=bearer, device_id=device_id, device_name=device_name)

    # -- what the hub accepts ------------------------------------------------

    def max_bundle_bytes(self, *, bearer: str = "") -> Optional[int]:
        """The unpacked size the hub accepts for one skill (``limits.max_bundle_bytes``
        of ``/.well-known/agentx-hub.json``), or ``None`` from a hub that does not say."""
        body = self._request("GET", "/.well-known/agentx-hub.json", bearer=bearer)
        value = ((body or {}).get("limits") or {}).get("max_bundle_bytes")
        return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None

    # -- the change feed ---------------------------------------------------

    def changes(
        self,
        *,
        bearer: str,
        device_id: str = "",
        device_name: str = "",
        product: str = PRODUCT,
        cursor: Optional[int] = None,
        limit: int = 200,
    ) -> Dict[str, Any]:
        """The desired-state snapshot for this product and device, plus the
        events above *cursor* (none when *cursor* is None)."""
        params: Dict[str, Any] = {"product": product, "limit": int(limit)}
        if cursor is not None:
            params["cursor"] = int(cursor)
        if device_id:
            params["device_id"] = device_id
        return self._request("GET", "/v1/me/changes", bearer=bearer, device_id=device_id, device_name=device_name, params=params)

    # -- installs ----------------------------------------------------------

    def list_installs(self, *, bearer: str, device_id: str = "", device_name: str = "", product: str = PRODUCT) -> List[Dict[str, Any]]:
        body = self._request("GET", "/v1/me/installs", bearer=bearer, device_id=device_id, device_name=device_name, params={"product": product})
        return list((body or {}).get("installs") or [])

    def create_install(
        self,
        slug: str,
        *,
        bearer: str,
        device_id: str = "",
        device_name: str = "",
        product: str = PRODUCT,
        version: Optional[str] = None,
        reason: str = "",
    ) -> Dict[str, Any]:
        """Record that this machine wants *slug*; the hub answers the install row.
        Without ``device_id`` in the body the hub pins the row to the device header."""
        body: Dict[str, Any] = {"slug": slug, "product": product}
        if version:
            body["version"] = version
        if reason:
            body["reason"] = reason
        return self._request("POST", "/v1/installs", bearer=bearer, device_id=device_id, device_name=device_name, json_body=body)

    def report_install(
        self,
        install_id: str,
        state: str,
        *,
        bearer: str,
        device_id: str = "",
        device_name: str = "",
        version: Optional[str] = None,
        error: str = "",
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"state": state}
        if version:
            body["version"] = version
        if error:
            body["error"] = error[:2000]
        if device_name:
            body["device_name"] = device_name
        return self._request("POST", f"/v1/installs/{install_id}/report", bearer=bearer, device_id=device_id, device_name=device_name, json_body=body)

    # -- MCP servers from the hub (Agent Hub Phase 3) ------------------------

    def mcp_catalog(self, *, bearer: str, etag: str = "", product: str = PRODUCT) -> tuple[Optional[Dict[str, Any]], str]:
        """The MCP servers this person may install, each with the manifest the
        hub signed (``GET /v1/mcp/catalog.json``): ``(feed, etag)`` — ``feed``
        is ``None`` when the hub answered ``304`` to *etag* (nothing changed)."""
        extra = {"If-None-Match": etag} if etag else None
        response = self._send("GET", "/v1/mcp/catalog.json", bearer=bearer, params={"product": product}, extra_headers=extra)
        tag = str(response.headers.get("ETag") or "")
        if response.status_code == 304:
            return None, tag or etag
        try:
            body = response.json()
        except ValueError as exc:
            raise HubError("the hub returned a non-JSON MCP catalogue", status_code=response.status_code) from exc
        if not isinstance(body, dict) or not isinstance(body.get("servers"), list):
            raise HubError("the hub returned an MCP catalogue without servers", status_code=response.status_code)
        return body, tag

    def create_mcp_install(
        self,
        slug: str,
        *,
        bearer: str,
        device_id: str = "",
        device_name: str = "",
        product: str = PRODUCT,
        version: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Tell the hub this machine installed MCP server *slug* (the hub keeps
        its desired state from now on); the machine is the device header."""
        body: Dict[str, Any] = {"slug": slug, "product": product}
        if version:
            body["version"] = version
        return self._request("POST", "/v1/mcp/installs", bearer=bearer, device_id=device_id, device_name=device_name, json_body=body)

    def report_mcp_install(
        self,
        install_id: str,
        state: str,
        *,
        bearer: str,
        device_id: str = "",
        device_name: str = "",
        version: Optional[str] = None,
        error: str = "",
        surface: Optional[Mapping[str, Any]] = None,
        surface_hash: str = "",
        blocked_tools: Optional[Iterable[str]] = None,
    ) -> Dict[str, Any]:
        """What this machine did with an MCP install, and — *surface* — what the
        server offered before any filter (the hub compares it with the list it
        approved). *blocked_tools* are the tools kept off; ``None`` leaves the
        last report's list as it was."""
        body: Dict[str, Any] = {"state": state}
        if version:
            body["version"] = version
        if error:
            body["error"] = error[:2000]
        if device_name:
            body["device_name"] = device_name
        if surface is not None:
            body["surface"] = dict(surface)
        if surface_hash:
            body["surface_hash"] = surface_hash
        if blocked_tools is not None:
            body["blocked_tools"] = sorted({str(name) for name in blocked_tools})
        return self._request("POST", f"/v1/mcp/installs/{install_id}/report", bearer=bearer, device_id=device_id, device_name=device_name, json_body=body)

    def remove_mcp_install(self, install_id: str, *, bearer: str, device_id: str = "", device_name: str = "", purge: bool = False) -> Dict[str, Any]:
        """Stop the hub keeping an MCP install: ``purge`` forgets it at once;
        otherwise it waits for this machine to report ``removed``."""
        params = {"purge": "true"} if purge else None
        return self._request("DELETE", f"/v1/mcp/installs/{install_id}", bearer=bearer, device_id=device_id, device_name=device_name, params=params)

    def list_mcp_installs(self, *, bearer: str, device_id: str = "", device_name: str = "", product: str = PRODUCT) -> List[Dict[str, Any]]:
        params: Dict[str, Any] = {"product": product}
        if device_id:
            params["device_id"] = device_id
        body = self._request("GET", "/v1/mcp/me/installs", bearer=bearer, device_id=device_id, device_name=device_name, params=params)
        return list((body or {}).get("installs") or [])

    # -- catalog / publishing ---------------------------------------------

    def skill(self, slug: str, *, bearer: str = "") -> Dict[str, Any]:
        return self._request("GET", f"/v1/skills/{slug}", bearer=bearer)

    def validate(
        self,
        files: Mapping[str, str],
        *,
        bearer: str = "",
        kind: str = "",
        visibility: str = "",
        name: str = "",
        targets: Iterable[str] = (),
    ) -> Dict[str, Any]:
        """Live preview: what the hub would make of these files (always 200;
        ``{ok: false, error}`` for an invalid package)."""
        body: Dict[str, Any] = {"files": dict(files)}
        if kind:
            body["kind"] = kind
        if visibility:
            body["visibility"] = visibility
        if name:
            body["name"] = name
        if list(targets):
            body["targets"] = list(targets)
        return self._request("POST", "/v1/validate", bearer=bearer, json_body=body)

    def publish(
        self,
        files: Mapping[str, Any],
        *,
        bearer: str,
        device_id: str = "",
        device_name: str = "",
        kind: str = "",
        visibility: str = "private",
        workspace: str = "",
        targets: Iterable[str] = (),
        slug: str = "",
        version: str = "",
    ) -> Dict[str, Any]:
        """Upload a package as a new version (``202 {skill, version, scan_id}``).
        Text files go as strings, binary files as ``{"base64": ...}``. A
        ``workspace`` visibility names the workspace (id or slug) it is shared into."""
        body: Dict[str, Any] = {"files": dict(files), "visibility": visibility}
        if workspace:
            body["workspace"] = workspace
        if kind:
            body["kind"] = kind
        if list(targets):
            body["targets"] = list(targets)
        if slug:
            body["slug"] = slug
        if version:
            body["version"] = version
        return self._request("POST", "/v1/skills", bearer=bearer, device_id=device_id, device_name=device_name, json_body=body)

    # -- the event stream --------------------------------------------------

    async def aiter_events(
        self,
        *,
        bearer: str,
        device_id: str = "",
        device_name: str = "",
        product: str = PRODUCT,
        cursor: Optional[int] = None,
        read_timeout: float = STREAM_READ_TIMEOUT_SECONDS,
    ) -> AsyncIterator[Dict[str, Any]]:
        """Yield events from ``GET /v1/events`` until the connection closes.

        Each item is the event row (``{id, type, product, payload, created_at}``).
        Comments (keepalives) are swallowed. Raises :class:`HubError` when the
        hub refuses the stream; a dropped connection simply ends the iterator.
        """
        import httpx

        params: Dict[str, Any] = {"product": product}
        headers = self.headers(bearer, device_id, device_name)
        headers["Accept"] = "text/event-stream"
        if cursor is not None:
            headers["Last-Event-ID"] = str(int(cursor))
        timeout = httpx.Timeout(self._timeout, read=read_timeout)
        async with httpx.AsyncClient(timeout=timeout, transport=self._transport, follow_redirects=False) as client:
            async with client.stream("GET", f"{self.base_url}/v1/events", params=params, headers=headers) as response:
                if response.status_code >= 400:
                    await response.aread()
                    raise _failure(response, "/v1/events")
                current: Dict[str, Any] = {}
                data_lines: List[str] = []
                async for line in response.aiter_lines():
                    if line == "":
                        if data_lines:
                            try:
                                current["payload"] = json.loads("\n".join(data_lines))
                            except ValueError:
                                current["payload"] = None
                            event = current.get("payload")
                            if isinstance(event, dict):
                                if "id" not in event and "id" in current:
                                    event["id"] = current["id"]
                                yield event
                        current, data_lines = {}, []
                        continue
                    if line.startswith(":"):
                        continue
                    key, _, value = line.partition(":")
                    value = value[1:] if value.startswith(" ") else value
                    if key == "data":
                        data_lines.append(value)
                    elif key == "id":
                        try:
                            current["id"] = int(value)
                        except ValueError:
                            pass
                    elif key == "event":
                        current["event"] = value


# ---------------------------------------------------------------------------
# Which machine is this?
# ---------------------------------------------------------------------------


def install_device_identity() -> tuple[str, str]:
    """``(device_id, device_name)`` for this install — the same id the second
    brain sees (``device.json`` at the install root)."""
    from hermes_cli.second_brain_client import install_device_identity as _identity

    return _identity()


def _failure(response: Any, path: str) -> HubError:
    """Turn a refusal into one line, keeping the code a caller can branch on."""
    status = response.status_code
    code = ""
    message = ""
    detail: Any = None
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        code = str(body.get("code") or body.get("error") or "")
        message = str(body.get("message") or "")
        detail = body.get("detail")
    if not message:
        message = (getattr(response, "text", "") or "")[:300].strip()
    return HubError(f"the AgentX Skill Hub returned HTTP {status} for {path}{f': {message}' if message else ''}", status_code=status, code=code, detail=detail)
