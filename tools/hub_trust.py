"""Which signing keys of an AgentX Hub this machine trusts (Agent Hub P6.1).

What the hub signs — a skill bundle, an MCP server's manifest, the MCP feed —
is checked with a key the hub publishes at ``/.well-known/agentx-hub.json``.
Fetched from the same address as what it signs, a key proves nothing on its
own: whoever answers for the hub (a proxy that ends TLS, a plain-http
address) could hand out a key of its own with a feed signed by it. So:

* a hub is reached over **https** only (:func:`url_problem`); an address of
  this machine (``localhost``, a loopback IP) is the one exception, for a hub
  run during development;
* **trust on first use**: the keys of the first ``signing_keys`` read from a
  hub's address are pinned for that address, in ``cache/agentx_hub_trust.json``
  (this user only, :func:`trust`);
* afterwards a key the machine has not pinned is trusted only when one of its
  ``endorsements`` verifies with a key already trusted: ``{"kid", "sig"}``,
  the Ed25519 signature of the endorsing key over :func:`endorsement_bytes`
  of the new key. The hub endorses its current key with every retired key it
  still holds, so a rotation carries over. A pinned kid published with
  another public key keeps the pinned one, and the published one is not
  trusted;
* any other key is untrusted (:func:`untrusted`): nothing it signs verifies,
  and the MCP feed says so (``hub_key_untrusted``). The one way to trust it
  is a deliberate :func:`reset` (``agentx mcp hub-keys --reset``): the pins
  of that hub are forgotten, and the keys it publishes next are pinned.

Pins only grow between resets; a key is trusted while the hub publishes it
(a key the hub stopped publishing verifies nothing). The canonical JSON is
the hub's: sorted keys, no whitespace, UTF-8 kept.
"""

from __future__ import annotations

import base64
import ipaddress
import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

#: What an endorsement vouches for (the hub's ``ENDORSEMENT_PURPOSE``).
ENDORSEMENT_PURPOSE = "agentx-hub-signing-key"
SIGNATURE_ALGORITHM = "ed25519"
_TRUST_FILENAME = "agentx_hub_trust.json"
_lock = threading.Lock()


# ─── The hub's address ───────────────────────────────────────────────────────


def _loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def url_problem(url: str) -> Optional[str]:
    """Why this machine does not talk to the hub at *url*, or None: a hub is
    reached over https, or over http on this machine alone (the module
    docstring)."""
    parts = urlsplit((url or "").strip())
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("http", "https") or not host:
        return f"{url!r} is not the address of an AgentX Hub"
    if parts.scheme == "http" and not _loopback(host):
        return (f"the AgentX Hub at {url} is not reached over https: whoever answers there could hand out its own signing keys. "
                "Use its https address (http is for a hub on this machine only).")
    return None


# ─── Signatures ──────────────────────────────────────────────────────────────


def canonical_bytes(value: Any) -> bytes:
    """The hub's canonical JSON: sorted keys, no whitespace, UTF-8 kept."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def endorsement_bytes(kid: str, public_b64: str) -> bytes:
    """What an endorsement of the key *kid* signs."""
    return canonical_bytes({"alg": SIGNATURE_ALGORITHM, "ed25519_pub": public_b64, "kid": kid, "purpose": ENDORSEMENT_PURPOSE})


def _unb64(text: str) -> bytes:
    text = (text or "").strip()
    return base64.b64decode((text + "=" * (-len(text) % 4)).replace("-", "+").replace("_", "/"))


def verify(public_b64: str, message: bytes, signature_b64: str) -> bool:
    """Ed25519: never raises; False unless the signature holds."""
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        Ed25519PublicKey.from_public_bytes(_unb64(public_b64)).verify(_unb64(signature_b64), message)
        return True
    except Exception:  # noqa: BLE001 - any failure is "not verified"
        return False


def published_keys(well_known: Any) -> List[Dict[str, Any]]:
    """The Ed25519 keys of a well-known document: ``[{kid, ed25519_pub, endorsements}]``."""
    out: List[Dict[str, Any]] = []
    entries = well_known.get("signing_keys") if isinstance(well_known, Mapping) else None
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, Mapping) or entry.get("alg", SIGNATURE_ALGORITHM) != SIGNATURE_ALGORITHM:
            continue
        kid, public = entry.get("kid"), entry.get("ed25519_pub")
        if not isinstance(kid, str) or not kid or not isinstance(public, str) or not public:
            continue
        endorsements = [e for e in entry.get("endorsements") or [] if isinstance(e, Mapping) and isinstance(e.get("kid"), str)
                        and isinstance(e.get("sig"), str)]
        out.append({"kid": kid, "ed25519_pub": public, "endorsements": endorsements})
    return out


# ─── The pins on disk ────────────────────────────────────────────────────────


def _trust_path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "cache" / _TRUST_FILENAME


def _read_all() -> Dict[str, Any]:
    try:
        data = json.loads(_trust_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_all(data: Dict[str, Any]) -> None:
    """Atomically, readable by this user only (the pins decide what installs)."""
    path = _trust_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".agentx_hub_trust.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _key(hub_url: str) -> str:
    return (hub_url or "").strip().rstrip("/")


def _entry(data: Mapping[str, Any], hub_url: str) -> Dict[str, Any]:
    entry = data.get(_key(hub_url))
    return entry if isinstance(entry, dict) else {}


def trusted(hub_url: str) -> Dict[str, str]:
    """``{kid: ed25519_pub}`` pinned for *hub_url* (published now or not). No network."""
    pins = _entry(_read_all(), hub_url).get("keys")
    return {str(k): str(v) for k, v in pins.items()} if isinstance(pins, dict) else {}


def untrusted(hub_url: str) -> Dict[str, str]:
    """``{kid: ed25519_pub}`` the hub published last time that this machine does not trust."""
    seen = _entry(_read_all(), hub_url).get("untrusted")
    return {str(k): str(v) for k, v in seen.items()} if isinstance(seen, dict) else {}


def trust(hub_url: str, well_known: Any, *, now: Callable[[], float] = time.time) -> Dict[str, str]:
    """The keys of *well_known* (the hub at *hub_url*'s document) this machine
    trusts, ``{kid: ed25519_pub}`` — pinning them on first use, adding the
    ones a trusted key endorses, and keeping the rest aside as untrusted
    (the module docstring). Only keys the document publishes are returned."""
    published = published_keys(well_known)
    with _lock:
        data = _read_all()
        entry = _entry(data, hub_url)
        pins = {str(k): str(v) for k, v in (entry.get("keys") or {}).items()} if isinstance(entry.get("keys"), dict) else {}
        moment = now()
        if not entry:
            if not published:
                return {}  # nothing to pin yet: the first keys this hub publishes will be
            pins = {key["kid"]: key["ed25519_pub"] for key in published}
            entry = {"keys": pins, "pinned_at": moment}
            logger.info("AgentX Hub %s: pinned its signing keys %s on first use", _key(hub_url), ", ".join(sorted(pins)))
        current = {key["kid"]: key for key in published}
        trusted_now = {kid: pins[kid] for kid, key in current.items() if pins.get(kid) == key["ed25519_pub"]}
        added = True
        while added:  # a key trusted this round may vouch for another
            added = False
            for kid, key in current.items():
                if kid in trusted_now or kid in pins:
                    continue
                vouched = endorsement_bytes(kid, key["ed25519_pub"])
                if any(e["kid"] in trusted_now and verify(trusted_now[e["kid"]], vouched, e["sig"]) for e in key["endorsements"]):
                    pins[kid] = trusted_now[kid] = key["ed25519_pub"]
                    added = True
                    logger.info("AgentX Hub %s: trusts its new signing key %s, endorsed by a key it trusted", _key(hub_url), kid)
        refused = {kid: key["ed25519_pub"] for kid, key in current.items() if kid not in trusted_now}
        if refused and refused != entry.get("untrusted"):
            logger.warning("AgentX Hub %s publishes signing keys this machine does not trust: %s (agentx mcp hub-keys)",
                           _key(hub_url), ", ".join(sorted(refused)))
        entry.update(keys=pins, untrusted=refused, checked_at=moment)
        data[_key(hub_url)] = entry
        try:
            _write_all(data)
        except OSError as exc:
            logger.warning("AgentX Hub %s: the trusted keys could not be kept: %s", _key(hub_url), exc)
        return trusted_now


def reset(hub_url: str) -> bool:
    """Forget every key pinned for *hub_url*: the next well-known document
    read from it is trusted on first use again. True when there was something
    to forget."""
    with _lock:
        data = _read_all()
        if data.pop(_key(hub_url), None) is None:
            return False
        _write_all(data)
    logger.warning("AgentX Hub %s: its pinned signing keys were reset", _key(hub_url))
    return True
