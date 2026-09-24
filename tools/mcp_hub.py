"""MCP servers from the AgentX Skill Hub (Agent Hub P3.7).

The hub's feed — ``GET /v1/mcp/catalog.json?product=workmate`` — lists the
MCP servers this person may install, each with the catalog manifest v1 the
hub rendered for Workmate (``hermes_cli/mcp_catalog.py``). This module
fetches it (with its ``ETag``: an unchanged feed is a ``304``), keeps it on
disk, and checks every manifest before :mod:`hermes_cli.mcp_catalog` lists
it. Reading the catalog never touches the network: the MCP tab and the sync
refresh the feed (:func:`refresh`, at most every :data:`FEED_TTL_SECONDS`
unless forced), everything else reads the copy on disk
(:func:`checked_servers`) — a hub that is down leaves the last feed usable.

A manifest is **verified** when both of the hub's signatures hold, with a
key of ``/.well-known/agentx-hub.json`` (the keys and the cache the skill
source uses, ``tools/skills_hub.py``):

* ``hub.signature`` over ``hub.signed`` — the version's manifest, signed when
  a hub admin (or the private-server rule) approved it: the ``server.json``
  by its hash, the tool surface by its hash, the verdict. Its slug, version
  and hashes must be those of the ``hub`` block.
* ``hub.manifest_sig`` over the canonical JSON of the whole manifest without
  ``hub.manifest_sig`` and ``hub.manifest_kid`` — the command this machine
  would run, its environment, the tool hashes it locks to: the hub's
  rendering of the version, which the version signature does not cover.

A manifest that fails either check, or whose scan was ``dangerous``, is
listed as a problem and cannot be installed. The canonical JSON is the
hub's: sorted keys, no whitespace, UTF-8 kept.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional

logger = logging.getLogger(__name__)

#: How long a fetched feed is fresh: the MCP tab asks on every open.
FEED_TTL_SECONDS = 30 * 60
#: After a refresh that failed (the hub down), how long before asking again.
RETRY_SECONDS = 60
#: What the version signature covers (the hub's ``MCP_MANIFEST_FIELDS``).
MCP_MANIFEST_FIELDS = ("kind", "slug", "name", "version", "content_hash", "surface_hash", "verdict", "scanned_at", "scanner_versions")
#: The keys of the ``hub`` block the manifest signature leaves out (they hold it).
MANIFEST_SIGNATURE_KEYS = ("manifest_sig", "manifest_kid")
_CACHE_FILENAME = "mcp_hub_feed.json"
_cache_lock = threading.Lock()


# ─── Signatures ──────────────────────────────────────────────────────────────


def canonical_bytes(value: Any) -> bytes:
    """The hub's canonical JSON: sorted keys, no whitespace, UTF-8 kept."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def signed_manifest_body(manifest: Mapping[str, Any]) -> Dict[str, Any]:
    """What ``hub.manifest_sig`` covers: *manifest* without the signature's own keys."""
    hub = {key: value for key, value in dict(manifest.get("hub") or {}).items() if key not in MANIFEST_SIGNATURE_KEYS}
    return {**dict(manifest), "hub": hub}


def _unb64(text: str) -> bytes:
    text = (text or "").strip()
    return base64.b64decode((text + "=" * (-len(text) % 4)).replace("-", "+").replace("_", "/"))


def _verify(public_b64: str, message: bytes, signature_b64: str) -> bool:
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        Ed25519PublicKey.from_public_bytes(_unb64(public_b64)).verify(_unb64(signature_b64), message)
        return True
    except Exception:  # noqa: BLE001 - any failure is "not verified"
        return False


def manifest_problem(manifest: Any, keys: Mapping[str, str]) -> Optional[str]:
    """Why *manifest* may not be installed, or None when both signatures hold
    (the module docstring). Never raises."""
    if not isinstance(manifest, dict) or not isinstance(manifest.get("hub"), dict):
        return "no manifest from the hub"
    hub = manifest["hub"]
    signed = hub.get("signed")
    if not isinstance(signed, dict):
        return "the version is not signed"
    for key in ("signature", "kid", "manifest_sig", "manifest_kid"):
        if not isinstance(hub.get(key), str) or not hub.get(key):
            return f"hub.{key} is missing"
    version_key, manifest_key = keys.get(hub["kid"]), keys.get(hub["manifest_kid"])
    if not version_key or not manifest_key:
        return "signed with a key this hub does not publish"
    subset = {key: signed.get(key) for key in MCP_MANIFEST_FIELDS}
    if not _verify(version_key, canonical_bytes(subset), hub["signature"]):
        return "the version signature does not hold"
    if signed.get("kind") != "mcp" or any(signed.get(key) != hub.get(key) for key in ("slug", "version", "content_hash", "surface_hash")):
        return "the manifest does not describe the version the hub signed"
    if not _verify(manifest_key, canonical_bytes(signed_manifest_body(manifest)), hub["manifest_sig"]):
        return "the manifest signature does not hold"
    if signed.get("verdict") == "dangerous":
        return "the hub's scan found it dangerous"
    return None


def signing_keys(base_url: str, *, transport: Any = None, refresh: bool = False) -> Dict[str, str]:
    """``{kid: ed25519_pub}`` the hub publishes — the skill source's keys and
    cache (one hour). ``refresh`` asks the hub again (a manifest signed with
    a key the cache does not know: the hub rotated its key)."""
    from tools.skills_hub import _AGENTX_HUB_KEYS_CACHE_KEY, AgentXHubSource, _write_index_cache

    if refresh:
        _write_index_cache(_AGENTX_HUB_KEYS_CACHE_KEY, {"hub_url": "", "keys": {}})
    return dict(AgentXHubSource(base_url, token="", transport=transport)._signing_keys())


# ─── The feed on disk ────────────────────────────────────────────────────────


@dataclass
class HubFeed:
    """The last feed this machine fetched from one hub."""

    hub_url: str
    servers: List[Dict[str, Any]] = field(default_factory=list)
    etag: str = ""
    fetched_at: float = 0.0
    #: What the last refresh could not do (the hub unreachable, a refusal) — the feed is the one before.
    error: str = ""
    #: Checked against these keys when fetched (a kid missing here asks the hub again).
    keys: Dict[str, str] = field(default_factory=dict)
    #: When a refresh was last tried, whatever came of it.
    attempted_at: float = 0.0

    def fresh(self, now: float) -> bool:
        """Nothing to ask the hub yet: fetched within the TTL, or failed moments ago."""
        if self.error:
            return now - self.attempted_at < RETRY_SECONDS
        return bool(self.fetched_at) and now - self.fetched_at < FEED_TTL_SECONDS

    def to_json(self) -> Dict[str, Any]:
        return {"hub_url": self.hub_url, "servers": self.servers, "etag": self.etag, "fetched_at": self.fetched_at, "error": self.error,
                "keys": self.keys, "attempted_at": self.attempted_at}


def _cache_path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "cache" / _CACHE_FILENAME


def read_feed(hub_url: str) -> Optional[HubFeed]:
    """The feed on disk for *hub_url*, fresh or not; None when there is none."""
    try:
        data = json.loads(_cache_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("hub_url") != hub_url.rstrip("/") or not isinstance(data.get("servers"), list):
        return None
    return HubFeed(hub_url=data["hub_url"], servers=[s for s in data["servers"] if isinstance(s, dict)], etag=str(data.get("etag") or ""),
                   fetched_at=float(data.get("fetched_at") or 0.0), error=str(data.get("error") or ""),
                   keys={str(k): str(v) for k, v in (data.get("keys") or {}).items()}, attempted_at=float(data.get("attempted_at") or 0.0))


def _write_feed(feed: HubFeed) -> None:
    """Atomically, readable by this user only (the feed names private servers)."""
    path = _cache_path()
    with _cache_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".mcp_hub_feed.", dir=str(path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(feed.to_json(), handle, ensure_ascii=False)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


def refresh(
    client: Any,
    *,
    bearer: str,
    force: bool = False,
    now: Callable[[], float] = time.time,
    keys: Optional[Callable[[bool], Dict[str, str]]] = None,
) -> HubFeed:
    """The feed of the hub *client* talks to, fetched when the copy on disk
    is older than :data:`FEED_TTL_SECONDS` (or *force*), with its ``ETag``.

    Never raises for the hub's sake: an unreachable hub or a refusal keeps
    the copy on disk and says why in ``error``. *keys* (``refresh -> keys``)
    defaults to :func:`signing_keys`; it is asked again once when a manifest
    names a key it does not know."""
    from hermes_cli.hub_client import HubError

    base_url = client.base_url.rstrip("/")
    cached = read_feed(base_url)
    moment = now()
    if cached is not None and not force and cached.fresh(moment):
        return cached
    get_keys = keys or (lambda again: signing_keys(base_url, transport=getattr(client, "_transport", None), refresh=again))
    try:
        body, etag = client.mcp_catalog(bearer=bearer, etag=cached.etag if cached is not None else "")
    except HubError as exc:
        stale = cached or HubFeed(hub_url=base_url)
        stale.error, stale.attempted_at = str(exc), moment
        _write_feed(stale)
        return stale
    if body is None and cached is not None:  # 304: the same servers
        cached.fetched_at, cached.attempted_at, cached.etag, cached.error = moment, moment, etag or cached.etag, ""
        _write_feed(cached)
        return cached
    servers = [s for s in (body or {}).get("servers") or [] if isinstance(s, dict)]
    known = get_keys(False)
    wanted = {str((s.get("manifest") or {}).get("hub", {}).get(k) or "") for s in servers if isinstance(s.get("manifest"), dict)
              for k in ("kid", "manifest_kid")} - {""}
    if wanted - set(known):
        known = get_keys(True)
    feed = HubFeed(hub_url=base_url, servers=servers, etag=etag, fetched_at=moment, keys=dict(known), attempted_at=moment)
    _write_feed(feed)
    return feed


def checked_servers(hub_url: Optional[str] = None) -> List[Dict[str, Any]]:
    """The servers of the feed on disk, each checked: the feed's entry plus
    ``problem`` (why it cannot be installed, None when it can) and
    ``problem_kind`` (``hub_unsupported`` — Workmate cannot run it as it is;
    ``unverified`` — a signature does not hold). No network call."""
    if hub_url is None:
        from tools.skills_hub import agentx_hub_url

        hub_url = agentx_hub_url()
    feed = read_feed(hub_url.rstrip("/"))
    if feed is None:
        return []
    out: List[Dict[str, Any]] = []
    for server in feed.servers:
        entry = dict(server)
        if not server.get("supported") or not isinstance(server.get("manifest"), dict):
            notes = ", ".join(str(n.get("code")) for n in server.get("notes") or [] if isinstance(n, dict)) or "unsupported"
            entry.update(problem=f"Workmate cannot run this server as it is ({notes})", problem_kind="hub_unsupported")
        else:
            problem = manifest_problem(server["manifest"], feed.keys)
            entry.update(problem=problem, problem_kind="unverified" if problem else None)
        out.append(entry)
    return out


def feed_status(hub_url: Optional[str] = None) -> Dict[str, Any]:
    """When the feed on disk was fetched, and what the last refresh could not do."""
    if hub_url is None:
        from tools.skills_hub import agentx_hub_url

        hub_url = agentx_hub_url()
    feed = read_feed(hub_url.rstrip("/"))
    if feed is None:
        return {"hub_url": hub_url.rstrip("/"), "fetched_at": None, "error": "", "servers": 0}
    return {"hub_url": feed.hub_url, "fetched_at": feed.fetched_at or None, "error": feed.error, "servers": len(feed.servers)}


# ─── The lock on a hub server's tools (Agent Hub P3.8) ───────────────────────

_SURFACES_FILENAME = "mcp_hub_surfaces.json"


@dataclass(frozen=True)
class ToolCheck:
    """What a hub server announced, against the tools the hub approved.

    ``allowed`` — the tools whose canonical hash equals the approved one
    (``hub.tool_hashes``): the only ones registered. ``blocked`` — the others
    (new, or described otherwise): kept off until the hub approves the list
    they belong to. ``surface`` is the canonical list as the hub reads it,
    for the report (``surface_hash`` its hash)."""

    surface_hash: str
    surface: Dict[str, Any]
    allowed: frozenset
    blocked: tuple


def tool_payload(tool: Any) -> Dict[str, Any]:
    """What the server sent for *tool*, as JSON — the keys it set, its nulls
    included: the hub hashed what the author pasted or what its probe read
    the same way (``tools/mcp_surface.py``)."""
    dump = getattr(tool, "model_dump", None)
    if callable(dump):
        return dump(by_alias=True, exclude_unset=True, mode="json")
    if isinstance(tool, Mapping):
        return dict(tool)
    return {"name": str(getattr(tool, "name", "") or "")}


def check_tools(config: Mapping[str, Any], tools: Any) -> Optional[ToolCheck]:
    """The lock of a server installed from the hub (``config["hub"]``), or
    None for any other server. A list that cannot be read tool by tool (a
    tool without a name, two with the same one) turns every tool off."""
    from tools.mcp_surface import surface_from_payload

    hub = config.get("hub")
    if not isinstance(hub, dict):
        return None
    approved = hub.get("tool_hashes") if isinstance(hub.get("tool_hashes"), dict) else {}
    payloads = [tool_payload(tool) for tool in tools or []]
    try:
        surface = surface_from_payload({"tools": payloads})
    except ValueError:
        names = sorted({str(p.get("name") or "") for p in payloads} - {""})
        return ToolCheck(surface_hash="", surface={"tools": payloads}, allowed=frozenset(), blocked=tuple(names))
    hashes = surface.tool_hashes
    allowed = frozenset(name for name, digest in hashes.items() if approved.get(name) == digest)
    return ToolCheck(surface_hash=surface.hash, surface=surface.to_json(), allowed=allowed, blocked=tuple(sorted(set(hashes) - allowed)))


def _surfaces_path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "cache" / _SURFACES_FILENAME


def record_check(server_name: str, config: Mapping[str, Any], check: ToolCheck, *, now: Callable[[], float] = time.time) -> None:
    """Keep what *server_name* announced for the sync's next report
    (:func:`observed`). Never raises: registration must not fail for it."""
    hub = config.get("hub") if isinstance(config.get("hub"), dict) else {}
    try:
        with _cache_lock:
            path = _surfaces_path()
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = {}
            if not isinstance(data, dict):
                data = {}
            data[server_name] = {"slug": hub.get("slug"), "version": hub.get("version"), "surface_hash": check.surface_hash,
                                 "surface": check.surface, "blocked_tools": list(check.blocked), "observed_at": now()}
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".mcp_hub_surfaces.", dir=str(path.parent))
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, ensure_ascii=False)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
    except Exception as exc:  # noqa: BLE001
        logger.debug("mcp hub: could not keep what %s announced: %s", server_name, exc)


def observed(server_name: str) -> Optional[Dict[str, Any]]:
    """What *server_name* last announced when it registered (:func:`record_check`)."""
    try:
        data = json.loads(_surfaces_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    entry = data.get(server_name) if isinstance(data, dict) else None
    return entry if isinstance(entry, dict) else None


def forget_observed(server_name: str) -> None:
    """Drop what *server_name* announced (it was removed)."""
    with _cache_lock:
        path = _surfaces_path()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if isinstance(data, dict) and data.pop(server_name, None) is not None:
            fd, tmp = tempfile.mkstemp(prefix=".mcp_hub_surfaces.", dir=str(path.parent))
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, ensure_ascii=False)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)


# ─── Servers the person removed on this machine ─────────────────────────────

_REMOVED_KEY = "__removed_here__"


def mark_removed_here(slug: str) -> None:
    """The person removed hub server *slug* on this machine: the sync tells
    the hub so, rather than installing it again (:func:`removed_here`)."""
    _update_removed(lambda names: names | {slug})


def clear_removed_here(slug: str) -> None:
    _update_removed(lambda names: names - {slug})


def removed_here() -> set:
    try:
        data = json.loads(_surfaces_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    names = data.get(_REMOVED_KEY) if isinstance(data, dict) else None
    return {str(n) for n in names} if isinstance(names, list) else set()


def _update_removed(change: Callable[[set], set]) -> None:
    with _cache_lock:
        path = _surfaces_path()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        before = data.get(_REMOVED_KEY) if isinstance(data.get(_REMOVED_KEY), list) else []
        data[_REMOVED_KEY] = sorted(change({str(n) for n in before}))
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".mcp_hub_surfaces.", dir=str(path.parent))
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
