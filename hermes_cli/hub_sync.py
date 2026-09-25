"""Keep this machine's skills in step with what the person asked the AgentX
Skill Hub for (plan Phase 3, items 5–7).

The hub holds the *desired* state: "this person wants skill X on this
Workmate", "switch version 1.2 of Y off everywhere it was installed",
"a workspace published Z". This engine makes the disk agree and
reports back, so the web can say "installed on máy A".

Four rules, inherited from :mod:`hermes_cli.sync_engine`:

**The hub decides nothing about files this machine already has.** A skill
is installed through the same quarantine → ``skills_guard`` → lock-file path
``agentx skills install`` uses (the second belt of plan section 0), a
removal goes through ``uninstall_skill``, and a *disable* only adds the name
to ``skills.disabled`` — the files stay.

**Unreachable is not an error the person has to see.** The hub being down
leaves every installed skill exactly as it is; the tick records
``offline`` and tries again later. Only a refused token (``401``) stops
the loop, and then it waits for the desktop to deliver a fresh one.

**The snapshot is the truth; events are a nudge.** Every tick reads
``/v1/me/changes`` and reconciles the whole list, so a dropped SSE frame
never loses an install. The stream only decides *when* the next tick runs.

**MCP servers too (Agent Hub Phase 3).** The snapshot's ``mcp`` block
lists the MCP servers the person installed from the hub on this machine.
:class:`McpLocalInstaller` installs one from the hub's signed feed
(``tools/mcp_hub.py``; never a manifest nobody signed) without asking —
a required value this machine does not hold is reported, not prompted for —
switches one off (``enabled: false``, the config stays) and removes one
(its tokens and cached tools too). A server edited on this machine is never
overwritten; the report says so once. When the hub approves another tool
list for the version a machine runs, its lock (``hub.tool_hashes``, and
``prompt_hashes`` and ``template_hashes`` since P6.1) is refreshed from the
feed: what it approved opens on the next reload.
Each report carries what the server announced when it last registered
(``tools/mcp_tool.py``) and the tools kept off.

**The AgentX Gateway too (Agent Hub Phase 5).** The MCP tab lists the
person's gateway endpoints (``GET /v1/mcp/me/endpoints``) and adds one:
this machine asks the hub for its gateway token (only a signed-in session
may), keeps it in the profile's ``.env`` as ``AGENTX_GATEWAY_TOKEN`` and
writes an entry ``{url, headers: {Authorization: "Bearer
${AGENTX_GATEWAY_TOKEN}"}, protocol: auto, source: hub-gateway}``
(:class:`GatewayDevice`, :func:`add_gateway_endpoint`). Each tick renews the
token when it has under :data:`GATEWAY_ROTATE_DAYS` days left, with the
person's session; without one, the desktop is told to open Workmate and
sign in again.

**Credentials are given, never obtained.** This process holds no refresh
token. The bearer arrives on ``POST /api/skills/hub/tick`` (the desktop's
Hub tab), on ``POST /api/sync/tick`` (the desktop's 30-second timer — the
same mailbox the second-brain sync engine spends), or as a personal hub
token in ``skills.hub_token`` for an install without a desktop.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Deque, Dict, List, Optional

logger = logging.getLogger("hermes_cli.hub_sync")

DEFAULT_INTERVAL_SECONDS = 60.0
STREAM_RECONNECT_SECONDS = 5.0
REAUTH_BACKOFF_SECONDS = 300.0
HISTORY_SIZE = 30
PRODUCT = "workmate"
SOURCE = "agentx-hub"
#: Events on the stream that mean "something on this machine may need to change".
NUDGE_EVENTS = ("install.desired", "install.update_available", "workspace.skill.published", "catalog.version.yanked", "catalog.version.demoted",
                "mcp.install.desired", "mcp.install.update_available", "mcp.endpoint.changed")
#: Of those, the ones after which the MCP feed is fetched again at once (a new manifest, a new tool list).
FEED_EVENTS = ("mcp.install.desired", "mcp.install.update_available", "mcp.endpoint.changed")
#: What a hub server's lock is made of (``hub`` block of its config): its approved tools, prompts and resource templates.
HUB_LOCK_KEYS = ("tool_hashes", "prompt_hashes", "template_hashes")
#: Why a skill the hub wants replaced stays as it is (reported as ``failed``).
LOCAL_CHANGES = "local_changes: edited on this machine — replace it from the Hub tab (the edit is backed up first) or keep it"


@dataclass(frozen=True)
class HubCredentials:
    """Who is syncing, from which machine, and until when."""

    bearer: str
    device_id: str
    device_name: str = ""
    expires_at: float = 0.0
    #: Where the bearer came from: ``session`` (a request), ``mailbox`` (the
    #: desktop's sync tick), ``token`` (``skills.hub_token``).
    source: str = "session"

    @property
    def usable(self) -> bool:
        if not (self.bearer and self.device_id):
            return False
        if self.expires_at and self.expires_at <= time.time():
            return False
        return True


@dataclass
class HubSyncOutcome:
    """What one tick did.

    ``status``: ``ok`` · ``disabled`` (config) · ``unconfigured`` (no hub URL)
    · ``signed_out`` (no credentials) · ``offline`` (hub unreachable — not an
    error) · ``reauth`` (token refused) · ``error`` (the hub answered and refused).
    """

    status: str = "ok"
    detail: str = ""
    installed: List[str] = field(default_factory=list)
    updated: List[str] = field(default_factory=list)
    removed: List[str] = field(default_factory=list)
    disabled: List[str] = field(default_factory=list)
    enabled: List[str] = field(default_factory=list)
    failed: List[Dict[str, Any]] = field(default_factory=list)
    updates: List[Dict[str, Any]] = field(default_factory=list)
    #: What the tick did to MCP servers: ``{installed, updated, removed, disabled, enabled, failed}``.
    mcp: Dict[str, List[Any]] = field(default_factory=lambda: {k: [] for k in ("installed", "updated", "removed", "disabled", "enabled", "failed")})
    #: The gateway token of this machine (:meth:`GatewayDevice.status`), and whether this tick renewed it.
    gateway: Dict[str, Any] = field(default_factory=dict)
    cursor: Optional[int] = None
    at: str = ""

    @property
    def ok(self) -> bool:
        return self.status == "ok"

    @property
    def changed(self) -> bool:
        return bool(self.installed or self.updated or self.removed or self.disabled or self.enabled) or self.mcp_changed

    @property
    def mcp_changed(self) -> bool:
        """An MCP server was installed, updated, removed or switched — or the
        gateway token changed under the servers that send it: the desktop reloads MCP."""
        return any(self.mcp[key] for key in ("installed", "updated", "removed", "disabled", "enabled")) or bool(self.gateway.get("renewed"))

    def to_json(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "detail": self.detail,
            "installed": list(self.installed),
            "updated": list(self.updated),
            "removed": list(self.removed),
            "disabled": list(self.disabled),
            "enabled": list(self.enabled),
            "failed": list(self.failed),
            "updates": list(self.updates),
            "mcp": {key: list(value) for key, value in self.mcp.items()},
            "mcp_changed": self.mcp_changed,
            "gateway": dict(self.gateway),
            "cursor": self.cursor,
            "at": self.at,
        }


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HubSyncSettings:
    base_url: str = ""
    enabled: bool = True
    realtime: bool = True
    interval_seconds: float = DEFAULT_INTERVAL_SECONDS
    request_timeout_seconds: float = 20.0

    @property
    def configured(self) -> bool:
        return bool(self.base_url)


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    return default


def load_hub_sync_settings() -> HubSyncSettings:
    """``skills.hub_*`` from config.yaml (plus the env overrides the source adapter honours)."""
    from hermes_cli.hub_client import hub_base_url

    section: Dict[str, Any] = {}
    try:
        from hermes_cli.config import load_config

        raw = (load_config() or {}).get("skills")
        if isinstance(raw, dict):
            section = raw
    except Exception as exc:  # noqa: BLE001 - a config that cannot be read means defaults
        logger.debug("hub sync: config read failed: %s", exc)
    try:
        interval = float(section.get("hub_sync_interval_seconds") or DEFAULT_INTERVAL_SECONDS)
    except (TypeError, ValueError):
        interval = DEFAULT_INTERVAL_SECONDS
    try:
        base_url = hub_base_url()
    except Exception:  # noqa: BLE001
        base_url = ""
    return HubSyncSettings(
        base_url=base_url,
        enabled=_as_bool(section.get("hub_sync_enabled"), True),
        realtime=_as_bool(section.get("hub_realtime"), True),
        interval_seconds=interval if interval > 0 else DEFAULT_INTERVAL_SECONDS,
    )


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------


class HubMailbox:
    """The most recent bearer this process was handed for the hub. In memory only."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._held: Optional[HubCredentials] = None

    def remember(self, credentials: Optional[HubCredentials]) -> None:
        if credentials is None or not credentials.usable:
            return
        with self._lock:
            self._held = credentials

    def current(self) -> Optional[HubCredentials]:
        with self._lock:
            held = self._held
            if held is not None and not held.usable:
                self._held = None
                return None
            return held

    def forget(self) -> None:
        with self._lock:
            self._held = None


def resolve_credentials() -> Optional[HubCredentials]:
    """The best bearer available right now, or None.

    Order: this engine's mailbox (fed by ``/api/skills/hub/tick``), the
    second-brain sync mailbox (fed every 30 s by the desktop's
    ``/api/sync/tick`` — same person, same device, same ID token), a personal
    hub token from ``skills.hub_token`` paired with the install's device id.
    """
    held = _MAILBOX.current()
    if held is not None:
        return held
    try:
        from hermes_cli.sync_engine import mailbox as sync_mailbox

        shared = sync_mailbox().current()
    except Exception:  # noqa: BLE001 - the sync engine is optional
        shared = None
    if shared is not None and getattr(shared, "usable", False):
        return HubCredentials(
            bearer=shared.bearer, device_id=shared.device_id, device_name=getattr(shared, "device_name", "") or "",
            expires_at=float(getattr(shared, "expires_at", 0.0) or 0.0), source="mailbox",
        )
    try:
        from hermes_cli.hub_client import hub_api_token, install_device_identity

        token = hub_api_token()
        if token:
            device_id, device_name = install_device_identity()
            return HubCredentials(bearer=token, device_id=device_id, device_name=device_name, source="token")
    except Exception as exc:  # noqa: BLE001
        logger.debug("hub sync: token credentials unavailable: %s", exc)
    return None


# ---------------------------------------------------------------------------
# The disk side — injectable so the engine is testable without a skills tree
# ---------------------------------------------------------------------------


@dataclass
class InstallResult:
    ok: bool
    name: str = ""
    version: str = ""
    content_hash: str = ""
    verdict: str = ""
    error: str = ""
    #: The local guard refused (or wants a person to confirm): not retried
    #: automatically, reported to the hub as ``failed`` with the reason.
    blocked: bool = False


class LocalInstaller:
    """Installs, removes, enables and disables hub skills on this machine
    through the same primitives ``agentx skills`` uses."""

    def __init__(self, transport: Any | None = None) -> None:
        self._transport = transport

    # -- reads --------------------------------------------------------------

    def local_state(self, slug: str) -> Dict[str, Any]:
        """What the lock file says about *slug*: installed?, version, hash,
        enabled?, and whether the copy was edited on this machine since."""
        from tools.skills_hub import HubLockFile, hub_skill_local_changes

        prefix = f"{SOURCE}/{slug}"
        for entry in HubLockFile().list_installed():
            identifier = str(entry.get("identifier") or "")
            if entry.get("source") != SOURCE or not (identifier == prefix or identifier.startswith(prefix + "@")):
                continue
            metadata = entry.get("metadata") or {}
            return {
                "installed": True,
                "name": entry.get("name", ""),
                "version": str(metadata.get("hub_version") or identifier.partition("@")[2] or ""),
                "content_hash": str(entry.get("content_hash") or ""),
                "install_path": entry.get("install_path", ""),
                "enabled": entry.get("name", "") not in self._disabled(),
                "modified": hub_skill_local_changes(entry),
            }
        return {"installed": False, "name": "", "version": "", "content_hash": "", "install_path": "", "enabled": False, "modified": False}

    def _disabled(self) -> set:
        from hermes_cli.config import load_config
        from hermes_cli.skills_config import get_disabled_skills

        try:
            return set(get_disabled_skills(load_config()))
        except Exception as exc:  # noqa: BLE001
            logger.debug("hub sync: could not read skills.disabled: %s", exc)
            return set()

    # -- writes -------------------------------------------------------------

    def install(self, identifier: str, *, base_url: str, token: str) -> InstallResult:
        import shutil

        from tools.skills_guard import scan_skill_cached, should_allow_install
        from tools.skills_hub import (
            AgentXHubSource,
            HubLockFile,
            append_audit_log,
            ensure_hub_dirs,
            install_from_quarantine,
            quarantine_bundle,
            source_url_for_bundle,
        )
        from tools.skills_hub import HUB_DIR as _hub_dir

        ensure_hub_dirs()
        source = AgentXHubSource(base_url, token=token, transport=self._transport)
        bundle = source.fetch(identifier)
        if bundle is None:
            return InstallResult(ok=False, error=f"could not fetch {identifier} from the hub")
        try:
            q_path = quarantine_bundle(bundle)
        except ValueError as exc:
            append_audit_log("BLOCKED", bundle.name, bundle.source, bundle.trust_level, "invalid_path", str(exc))
            return InstallResult(ok=False, name=bundle.name, error=str(exc), blocked=True)
        try:
            result, provenance = scan_skill_cached(
                q_path, source=bundle.trust_level or "community", source_url=source_url_for_bundle(bundle), cache_dir=_hub_dir / "scan-cache",
            )
            allowed, reason = should_allow_install(result, force=False)
            if allowed is not True:
                shutil.rmtree(q_path, ignore_errors=True)
                append_audit_log("BLOCKED", bundle.name, bundle.source, bundle.trust_level, result.verdict, f"{len(result.findings)}_findings")
                why = reason if allowed is False else f"the local guard wants a person to confirm this install ({reason}); install it from the app"
                return InstallResult(ok=False, name=bundle.name, verdict=result.verdict, error=why, blocked=True)
            hub_meta = bundle.metadata or {}
            provenance = dict(provenance)
            provenance["hub"] = {
                "hub_url": hub_meta.get("hub_url", ""),
                "hub_scan_id": hub_meta.get("hub_scan_id", ""),
                "signature": hub_meta.get("signature", ""),
                "kid": hub_meta.get("kid", ""),
                "signature_verified": bool(hub_meta.get("signature_verified")),
                "hub_verdict": hub_meta.get("verdict", ""),
                "content_hash": hub_meta.get("content_hash", ""),
                "installed_by": "hub-sync",
            }
            result.scan_provenance = provenance
            existing = HubLockFile().get_installed(bundle.name)
            category = ""
            if existing:
                path = str(existing.get("install_path") or "")
                if "/" in path:
                    category = path.rsplit("/", 1)[0]
            install_dir = install_from_quarantine(q_path, bundle.name, category, bundle, result, provenance)
        except ValueError as exc:
            shutil.rmtree(q_path, ignore_errors=True)
            return InstallResult(ok=False, name=bundle.name, error=str(exc), blocked=True)
        except Exception as exc:  # noqa: BLE001 - reported, never raised
            shutil.rmtree(q_path, ignore_errors=True)
            return InstallResult(ok=False, name=bundle.name, error=f"install failed: {exc}")
        self.enable(bundle.name)
        self._clear_prompt_cache()
        logger.info("hub sync: installed %s → %s", identifier, install_dir)
        return InstallResult(
            ok=True, name=bundle.name, version=str(hub_meta.get("hub_version") or ""), content_hash=str(hub_meta.get("content_hash") or ""),
            verdict=result.verdict,
        )

    def uninstall(self, name: str) -> tuple[bool, str]:
        """Remove a hub skill because the hub asked. A copy edited on this
        machine is copied aside first: the removal came from elsewhere."""
        from tools.skills_hub import HubLockFile, backup_hub_skill, hub_skill_local_changes, uninstall_skill

        entry = HubLockFile().get_installed(name)
        backup = None
        if entry is not None and hub_skill_local_changes({**entry, "name": name}):
            backup = backup_hub_skill({**entry, "name": name})
        ok, message = uninstall_skill(name)
        if ok:
            self.enable(name)  # a stale entry in skills.disabled would shadow a later reinstall
            self._clear_prompt_cache()
            if backup is not None:
                message = f"{message}; the copy edited on this machine is kept in {backup}"
        return ok, message

    def disable(self, name: str) -> bool:
        return self._set_enabled(name, False)

    def enable(self, name: str) -> bool:
        return self._set_enabled(name, True)

    def _set_enabled(self, name: str, enabled: bool) -> bool:
        from hermes_cli.config import load_config
        from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills

        try:
            config = load_config()
            disabled = set(get_disabled_skills(config))
            if enabled and name not in disabled:
                return True
            if not enabled and name in disabled:
                return True
            (disabled.discard if enabled else disabled.add)(name)
            save_disabled_skills(config, disabled)
        except Exception as exc:  # noqa: BLE001
            logger.warning("hub sync: could not %s %s: %s", "enable" if enabled else "disable", name, exc)
            return False
        self._clear_prompt_cache()
        return True

    @staticmethod
    def _clear_prompt_cache() -> None:
        try:
            from agent.prompt_builder import clear_skills_system_prompt_cache

            clear_skills_system_prompt_cache(clear_snapshot=True)
        except Exception:  # noqa: BLE001 - the cache is an optimisation
            pass


class McpLocalInstaller:
    """Installs, removes and switches MCP servers from the hub on this
    machine, through the catalog (``hermes_cli/mcp_catalog.py``): the entry
    from the hub's signed feed, installed without asking."""

    def local_state(self, slug: str) -> Dict[str, Any]:
        """The server installed from hub server *slug*, as config.yaml has it."""
        from hermes_cli import mcp_catalog

        for name, cfg in mcp_catalog.raw_servers().items():
            if mcp_catalog.hub_slug_of(cfg) != slug:
                continue
            hub = cfg.get("hub") or {}
            return {
                "installed": True, "name": name, "version": str(hub.get("version") or ""), "enabled": mcp_catalog.is_enabled(name),
                "modified": mcp_catalog.edited_locally(cfg), **{key: dict(hub.get(key) or {}) for key in HUB_LOCK_KEYS},
            }
        return {"installed": False, "name": "", "version": "", "enabled": False, "modified": False, **{key: {} for key in HUB_LOCK_KEYS}}

    def feed_entry(self, slug: str) -> Any:
        """The verified entry of hub server *slug* in the feed on disk, or None."""
        from hermes_cli import mcp_catalog

        return mcp_catalog.get_entry(f"{mcp_catalog.HUB_PREFIX}{slug}")

    def install(self, slug: str, *, version: str = "") -> InstallResult:
        import contextlib
        import io

        from hermes_cli import mcp_catalog

        entry = self.feed_entry(slug)
        if entry is None or entry.hub is None:
            return InstallResult(ok=False, error="not_in_feed: the hub's feed on this machine has no verified entry for it", blocked=True)
        if version and entry.hub.version != version:
            return InstallResult(ok=False, name=entry.name, error=f"pinned: the hub serves {entry.hub.version}, not {version}", blocked=True)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                mcp_catalog.install_entry(entry, enable=True, interactive=False)
        except mcp_catalog.NeedsSecrets as exc:
            return InstallResult(ok=False, name=entry.name, error=f"needs_secrets: {', '.join(exc.missing)}", blocked=True)
        except mcp_catalog.CatalogError as exc:
            return InstallResult(ok=False, name=entry.name, error=str(exc), blocked=True)
        except Exception as exc:  # noqa: BLE001 - reported, never raised
            return InstallResult(ok=False, name=entry.name, error=f"install failed: {exc}")
        return InstallResult(ok=True, name=entry.name, version=entry.hub.version, content_hash=entry.hub.content_hash, verdict=entry.hub.verdict or "")

    def uninstall(self, name: str) -> tuple[bool, str]:
        from hermes_cli import mcp_catalog
        from tools import mcp_hub

        try:
            mcp_catalog.uninstall_entry(name)
        except Exception as exc:  # noqa: BLE001
            return False, f"could not remove {name}: {exc}"
        mcp_hub.forget_observed(name)
        return True, f"removed {name}"

    def disable(self, name: str) -> bool:
        return self._set_enabled(name, False)

    def enable(self, name: str) -> bool:
        return self._set_enabled(name, True)

    @staticmethod
    def _set_enabled(name: str, enabled: bool) -> bool:
        from hermes_cli.config import load_config, save_config

        try:
            config = load_config()
            servers = config.get("mcp_servers") or {}
            if name not in servers or not isinstance(servers[name], dict):
                return False
            if bool(servers[name].get("enabled", True)) == enabled:
                return True
            servers[name]["enabled"] = enabled
            config["mcp_servers"] = servers
            save_config(config)
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("hub sync: could not %s MCP %s: %s", "enable" if enabled else "disable", name, exc)
            return False

    @staticmethod
    def observed(name: str) -> Optional[Dict[str, Any]]:
        """What the server announced when it last registered (``tools/mcp_tool.py``)."""
        from tools import mcp_hub

        return mcp_hub.observed(name)

    @staticmethod
    def removed_here() -> set:
        """The hub servers the person removed on this machine, not yet said to the hub."""
        from tools import mcp_hub

        return mcp_hub.removed_here()

    @staticmethod
    def forget_removed(slug: str) -> None:
        from tools import mcp_hub

        mcp_hub.clear_removed_here(slug)


# ---------------------------------------------------------------------------
# The engine
# ---------------------------------------------------------------------------


def _short_hash(hub_hash: str) -> str:
    """The hub's full ``sha256:<64>`` in the lock file's ``sha256:<16>`` form."""
    digest = (hub_hash or "").split(":", 1)[-1]
    return f"sha256:{digest[:16]}" if digest else ""


class HubSyncEngine:
    def __init__(
        self,
        *,
        credentials: Callable[[], Optional[HubCredentials]],
        settings: Optional[HubSyncSettings] = None,
        client: Any | None = None,
        transport: Any | None = None,
        installer: Any | None = None,
        mcp_installer: Any | None = None,
        gateway: Any | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._credentials = credentials
        self._settings = settings if settings is not None else load_hub_sync_settings()
        self._client = client
        self._transport = transport
        self._installer = installer if installer is not None else LocalInstaller(transport=transport)
        self._mcp = mcp_installer if mcp_installer is not None else McpLocalInstaller()
        self._gateway = gateway if gateway is not None else GatewayDevice()
        #: The next tick fetches the MCP feed even if it is fresh (an event said it changed).
        self._feed_stale = False
        self._clock = clock
        self._tick_lock = threading.Lock()
        self._last = HubSyncOutcome(status="idle")
        self._last_snapshot: Dict[str, Any] = {}
        self._blocked_until = 0.0
        self._cursor: Optional[int] = None
        self._history: Deque[Dict[str, Any]] = deque(maxlen=HISTORY_SIZE)
        self._revision = 0
        #: Bumped when a tick changed an MCP server here: the desktop reloads MCP.
        self._mcp_revision = 0
        self._stream_state = "off"
        self._wake: Any | None = None
        self._loop: Any | None = None

    @property
    def settings(self) -> HubSyncSettings:
        return self._settings

    def reload_settings(self) -> None:
        self._settings = load_hub_sync_settings()

    # -- one tick -------------------------------------------------------------

    def tick(self) -> HubSyncOutcome:
        """Read the desired state and make the disk agree. Never raises."""
        with self._tick_lock:
            outcome = self._tick()
            outcome.at = datetime.now(timezone.utc).isoformat()
            self._last = outcome
            if outcome.changed or outcome.failed:
                self._revision += 1
            if outcome.mcp_changed:
                self._mcp_revision += 1
            return outcome

    def _tick(self) -> HubSyncOutcome:
        from hermes_cli.hub_client import HubError

        if not self._settings.enabled:
            return HubSyncOutcome(status="disabled", detail="Hub sync is switched off (skills.hub_sync_enabled).")
        if not self._settings.configured:
            return HubSyncOutcome(status="unconfigured", detail="No AgentX Skill Hub URL is configured (skills.hub_url).")
        if self._clock() < self._blocked_until:
            return self._last
        credentials = self._resolve_credentials()
        if credentials is None:
            return HubSyncOutcome(status="signed_out", detail="Nobody is signed in on this machine, so there is nothing to sync with the hub.")
        client = self._session_client()
        outcome = HubSyncOutcome()
        try:
            snapshot = client.changes(
                bearer=credentials.bearer, device_id=credentials.device_id, device_name=credentials.device_name, product=PRODUCT, cursor=None,
            )
            if not isinstance(snapshot, dict):
                raise ValueError("the hub returned an unexpected changes page")
            self._last_snapshot = snapshot
            self._cursor = snapshot.get("cursor", self._cursor)
            outcome.cursor = self._cursor
            self._reconcile(snapshot, credentials, client, outcome)
            if isinstance(snapshot.get("mcp"), dict):
                self._reconcile_mcp(snapshot["mcp"], credentials, client, outcome)
            outcome.gateway = self._keep_gateway(credentials, client)
        except HubError as exc:
            return self._from_error(exc)
        except Exception as exc:  # noqa: BLE001 - reported, never raised
            logger.warning("hub sync: tick failed: %s", exc)
            return HubSyncOutcome(status="error", detail=str(exc), cursor=self._cursor)
        return outcome

    def _resolve_credentials(self) -> Optional[HubCredentials]:
        try:
            found = self._credentials()
        except Exception as exc:  # noqa: BLE001
            logger.debug("hub sync: no credentials available: %s", exc)
            return None
        return found if found is not None and found.usable else None

    def _session_client(self) -> Any:
        if self._client is None:
            from hermes_cli.hub_client import HubClient

            self._client = HubClient(self._settings.base_url, timeout=self._settings.request_timeout_seconds, transport=self._transport)
        return self._client

    # -- reconcile ----------------------------------------------------------

    def _reconcile(self, snapshot: Dict[str, Any], credentials: HubCredentials, client: Any, outcome: HubSyncOutcome) -> None:
        for install in snapshot.get("installs") or []:
            try:
                self._apply(install, credentials, client, outcome)
            except Exception as exc:  # noqa: BLE001 - one skill must not stop the others
                logger.warning("hub sync: %s: %s", install.get("slug"), exc)
                outcome.failed.append({"slug": install.get("slug"), "error": str(exc)})
        outcome.updates = []
        for u in snapshot.get("updates") or []:
            local = self._installer.local_state(str(u.get("slug") or ""))
            # The snapshot was read before this tick reported: a skill updated on
            # this machine meanwhile is no longer an update to offer.
            if local["installed"] and local["version"] and local["version"] == str(u.get("latest_version") or ""):
                continue
            outcome.updates.append({
                "install_id": u.get("id"), "slug": u.get("slug"), "name": u.get("name"),
                "current": local["version"] or u.get("reported_version"), "latest": u.get("latest_version"),
                "modified": bool(local.get("modified")),
            })
        # Workspace skills are listed (``snapshot["workspaces"]``) for the Hub
        # tab to show; nothing is installed until the person asks (hub
        # decision §8 #11 — no automatic mirror).

    def _apply(self, install: Dict[str, Any], credentials: HubCredentials, client: Any, outcome: HubSyncOutcome) -> None:
        slug = str(install.get("slug") or "")
        if not slug or install.get("kind") not in (None, "core"):
            return
        desired = str(install.get("desired_state") or "installed")
        reported = str(install.get("reported_state") or "pending")
        install_id = str(install.get("id") or "")
        wanted_version = str(install.get("version") or install.get("latest_version") or "")
        pinned = bool(install.get("version"))
        local = self._installer.local_state(slug)
        report = self._reporter(client, credentials, install_id)

        if desired == "installed":
            if reported == "installed" and local["installed"] and (not pinned or local["version"] == wanted_version):
                # Switched off locally while the hub still wants it: the person's choice stands.
                if local["version"] and local["version"] != str(install.get("reported_version") or ""):
                    # Updated on this machine since the last report (the Update
                    # button, `agentx skills update`): say so, or the hub keeps
                    # offering an update this machine already has.
                    report("installed", version=local["version"])
                    self._remember("updated", slug, local["version"])
                return
            if local["installed"] and (not pinned or local["version"] == wanted_version) and reported in ("pending", "disabled"):
                # The hub re-enabled (or never heard back): make sure it is on and say so.
                self._installer.enable(local["name"])
                report("installed", version=local["version"] or wanted_version)
                outcome.enabled.append(slug)
                self._remember("enabled", slug, local["version"])
                return
            if local["installed"] and local.get("modified"):
                # Edited on this machine: never replaced behind the person's
                # back. They choose in the Hub tab, and replacing backs the edit
                # up first. Said once, not every tick.
                if reported != "failed" or str(install.get("error") or "") != LOCAL_CHANGES:
                    report("failed", version=local["version"] or None, error=LOCAL_CHANGES)
                    outcome.failed.append({"slug": slug, "error": LOCAL_CHANGES, "blocked": True})
                    self._remember("failed", slug, wanted_version, LOCAL_CHANGES)
                return
            identifier = f"{SOURCE}/{slug}@{wanted_version}" if pinned and wanted_version else f"{SOURCE}/{slug}"
            result = self._installer.install(identifier, base_url=self._settings.base_url, token=credentials.bearer)
            if result.ok:
                report("installed", version=result.version or wanted_version)
                (outcome.updated if local["installed"] else outcome.installed).append(slug)
                self._remember("updated" if local["installed"] else "installed", slug, result.version or wanted_version)
            else:
                report("failed", version=local["version"] or None, error=result.error)
                outcome.failed.append({"slug": slug, "error": result.error, "blocked": result.blocked})
                self._remember("failed", slug, wanted_version, result.error)
        elif desired == "removed":
            if reported == "removed":
                return
            detail = ""
            if local["installed"]:
                ok, message = self._installer.uninstall(local["name"])
                if not ok:
                    report("failed", version=local["version"] or None, error=message)
                    outcome.failed.append({"slug": slug, "error": message})
                    self._remember("failed", slug, local["version"], message)
                    return
                # An edited copy was backed up first: the history says where.
                detail = message if local.get("modified") else ""
            report("removed")
            outcome.removed.append(slug)
            self._remember("removed", slug, local["version"], detail)
        elif desired == "disabled":
            if reported == "disabled":
                return
            if local["installed"]:
                self._installer.disable(local["name"])
            report("disabled", version=local["version"] or None)
            outcome.disabled.append(slug)
            self._remember("disabled", slug, local["version"], str(install.get("reason") or ""))

    # -- MCP servers (Agent Hub Phase 3) ----------------------------------------

    def _reconcile_mcp(self, block: Dict[str, Any], credentials: HubCredentials, client: Any, outcome: HubSyncOutcome) -> None:
        installs = [row for row in block.get("installs") or [] if isinstance(row, dict) and row.get("slug")]
        if installs:
            self._refresh_feed(client, credentials)
        for install in installs:
            try:
                self._apply_mcp(install, credentials, client, outcome)
            except Exception as exc:  # noqa: BLE001 - one server must not stop the others
                logger.warning("hub sync: MCP %s: %s", install.get("slug"), exc)
                outcome.mcp["failed"].append({"slug": install.get("slug"), "error": str(exc)})

    def _refresh_feed(self, client: Any, credentials: HubCredentials) -> None:
        from tools import mcp_hub

        feed = mcp_hub.refresh(client, bearer=credentials.bearer, force=self._feed_stale)
        if not feed.error:
            self._feed_stale = False

    def _apply_mcp(self, install: Dict[str, Any], credentials: HubCredentials, client: Any, outcome: HubSyncOutcome) -> None:
        slug = str(install["slug"])
        desired = str(install.get("desired_state") or "installed")
        reported = str(install.get("reported_state") or "pending")
        install_id = str(install.get("id") or "")
        pinned = str(install.get("version") or "")
        local = self._mcp.local_state(slug)
        report = self._mcp_reporter(client, credentials, install_id, install)
        done = outcome.mcp

        if desired == "removed":
            if reported == "removed":
                self._mcp.forget_removed(slug)
                return
            if local["installed"]:
                ok, message = self._mcp.uninstall(local["name"])
                if not ok:
                    report("failed", error=message)
                    done["failed"].append({"slug": slug, "error": message})
                    return
            report("removed")
            done["removed"].append(slug)
            self._remember("removed", f"mcp:{slug}", local["version"])
            return
        if desired == "disabled":
            if local["installed"] and local["enabled"]:
                self._mcp.disable(local["name"])
                done["disabled"].append(slug)
                self._remember("disabled", f"mcp:{slug}", local["version"], str(install.get("reason") or ""))
            if reported != "disabled":
                report("disabled", version=local["version"] or None)
            return

        # desired == "installed"
        if not local["installed"] and (reported == "installed" or slug in self._mcp.removed_here()):
            # It ran here and is gone: the person removed it on this machine.
            # Say so to the hub — installing it again would undo their choice.
            try:
                client.remove_mcp_install(install_id, bearer=credentials.bearer, device_id=credentials.device_id,
                                          device_name=credentials.device_name)
            except Exception as exc:  # noqa: BLE001 - asked again next tick
                logger.warning("hub sync: could not tell the hub MCP %s was removed here: %s", slug, exc)
                return
            report("removed")
            self._mcp.forget_removed(slug)
            done["removed"].append(slug)
            self._remember("removed", f"mcp:{slug}", "", "removed on this machine")
            return
        if local["installed"] and local["modified"]:
            # Edited on this machine: never replaced from here; said once.
            if reported != "failed" or str(install.get("error") or "") != LOCAL_CHANGES:
                report("failed", version=local["version"] or None, error=LOCAL_CHANGES)
                done["failed"].append({"slug": slug, "error": LOCAL_CHANGES, "blocked": True})
            return
        entry = self._mcp.feed_entry(slug)
        feed_version = entry.hub.version if entry is not None and entry.hub is not None else ""
        if local["installed"] and (not pinned or local["version"] == pinned):
            same_version = entry is not None and feed_version == local["version"]
            if same_version and any(dict(getattr(entry.hub, key, None) or {}) != (local.get(key) or {}) for key in HUB_LOCK_KEYS):
                # The hub approved another tool list for this version: the lock follows it.
                result = self._mcp.install(slug, version=local["version"])
                if result.ok:
                    done["updated"].append(slug)
                    self._remember("updated", f"mcp:{slug}", result.version, "tool list approved on the hub")
                else:
                    report("failed", version=local["version"] or None, error=result.error)
                    done["failed"].append({"slug": slug, "error": result.error, "blocked": result.blocked})
                    return
            if not local["enabled"] and reported in ("pending", "disabled"):
                self._mcp.enable(local["name"])
                done["enabled"].append(slug)
            if reported != "installed" or self._mcp_surface_news(local["name"], install):
                report("installed", version=local["version"] or None)
            return
        result = self._mcp.install(slug, version=pinned)
        if result.ok:
            report("installed", version=result.version)
            (done["updated"] if local["installed"] else done["installed"]).append(slug)
            self._remember("updated" if local["installed"] else "installed", f"mcp:{slug}", result.version)
        elif reported != "failed" or str(install.get("error") or "") != result.error:
            report("failed", version=local["version"] or None, error=result.error)
            done["failed"].append({"slug": slug, "error": result.error, "blocked": result.blocked})
            self._remember("failed", f"mcp:{slug}", pinned or feed_version, result.error)

    def _mcp_surface_news(self, name: str, install: Dict[str, Any]) -> bool:
        """The server announced a list the hub has not heard from this machine."""
        seen = self._mcp.observed(name)
        return bool(seen and seen.get("surface_hash") and seen.get("surface_hash") != install.get("reported_surface_hash"))

    def _mcp_reporter(self, client: Any, credentials: HubCredentials, install_id: str, install: Dict[str, Any]) -> Callable[..., None]:
        from hermes_cli.hub_client import HubError

        slug = str(install.get("slug") or "")

        def report(state: str, *, version: Optional[str] = None, error: str = "") -> None:
            if not install_id:
                return
            name = self._mcp.local_state(slug)["name"]
            seen = self._mcp.observed(name) if name and state == "installed" else None
            fields: Dict[str, Any] = {"version": version or None, "error": error}
            if seen and seen.get("surface_hash"):
                fields["blocked_tools"] = list(seen.get("blocked_tools") or [])
                if seen["surface_hash"] != install.get("reported_surface_hash"):
                    fields.update(surface=seen.get("surface"), surface_hash=seen["surface_hash"])
                else:
                    fields["surface_hash"] = seen["surface_hash"]
            send = dict(bearer=credentials.bearer, device_id=credentials.device_id, device_name=credentials.device_name)
            try:
                client.report_mcp_install(install_id, state, **send, **fields)
            except HubError as exc:
                if "surface" in fields and exc.status_code in (413, 422):
                    # The hub would not read the list (too large): the state still counts.
                    fields.pop("surface", None)
                    fields.pop("surface_hash", None)
                    try:
                        client.report_mcp_install(install_id, state, **send, **fields)
                    except Exception as again:  # noqa: BLE001
                        logger.warning("hub sync: could not report MCP %s for %s: %s", state, install_id, again)
                else:
                    logger.warning("hub sync: could not report MCP %s for %s: %s", state, install_id, exc)
            except Exception as exc:  # noqa: BLE001 - the next tick reports again
                logger.warning("hub sync: could not report MCP %s for %s: %s", state, install_id, exc)

        return report

    def _reporter(self, client: Any, credentials: HubCredentials, install_id: str) -> Callable[..., None]:
        def report(state: str, *, version: Optional[str] = None, error: str = "") -> None:
            if not install_id:
                return
            try:
                client.report_install(
                    install_id, state, bearer=credentials.bearer, device_id=credentials.device_id, device_name=credentials.device_name,
                    version=version or None, error=error,
                )
            except Exception as exc:  # noqa: BLE001 - the next tick reports again
                logger.warning("hub sync: could not report %s for %s: %s", state, install_id, exc)

        return report

    def _remember(self, action: str, slug: str, version: str = "", detail: str = "") -> None:
        self._history.appendleft({"action": action, "slug": slug, "version": version or None, "detail": detail, "at": datetime.now(timezone.utc).isoformat()})

    # -- the gateway token --------------------------------------------------

    def _keep_gateway(self, credentials: HubCredentials, client: Any) -> Dict[str, Any]:
        """Renew this machine's gateway token while it has under
        :data:`GATEWAY_ROTATE_DAYS` days left — and only while a gateway entry
        uses it. The hub gives one to a signed-in session alone: with a personal
        token, the desktop is told to sign in (``sign_in``). A refusal other
        than a lapsed session is kept for the tab, the tick goes on."""
        from hermes_cli.hub_client import HubError

        device = self._gateway
        entries = device.entries()
        status = device.status(len(entries))
        if not entries or not device.needs_rotation():
            return status
        if credentials.source not in SESSION_SOURCES:
            return {**status, "sign_in": True}
        try:
            device.issue(client, credentials)
        except HubError as exc:
            if getattr(exc, "reauth", False):
                raise
            logger.warning("hub sync: the gateway token could not be renewed: %s", exc)
            return {**status, "error": str(exc), "error_code": getattr(exc, "code", "") or ""}
        self._remember("gateway_token", GATEWAY_TOKEN_ENV, detail="renewed")
        return {**device.status(len(entries)), "renewed": True}

    # -- failures ----------------------------------------------------------

    def _from_error(self, exc: Any) -> HubSyncOutcome:
        detail = str(exc)
        if getattr(exc, "unreachable", False) or getattr(exc, "identity_unavailable", False):
            # Never an error the person has to see; installed skills keep working.
            logger.info("hub sync: the hub is unreachable (%s)", detail)
            return HubSyncOutcome(status="offline", detail="The AgentX Skill Hub could not be reached. Installed skills keep working; changes catch up when it returns.", cursor=self._cursor)
        if getattr(exc, "reauth", False):
            self._blocked_until = self._clock() + REAUTH_BACKOFF_SECONDS
            logger.warning("hub sync: stopping until re-authentication: %s", detail)
            return HubSyncOutcome(status="reauth", detail="The hub refused this machine's token. Sign in again.", cursor=self._cursor)
        logger.warning("hub sync: the hub refused: %s", detail)
        return HubSyncOutcome(status="error", detail=detail, cursor=self._cursor)

    # -- status for the desktop --------------------------------------------

    def status(self) -> Dict[str, Any]:
        credentials = self._resolve_credentials()
        return {
            "enabled": self._settings.enabled,
            "configured": self._settings.configured,
            "base_url": self._settings.base_url,
            "realtime": self._settings.realtime,
            "interval_seconds": self._settings.interval_seconds,
            "credentials": credentials.source if credentials else None,
            "device_id": credentials.device_id if credentials else None,
            "stream": self._stream_state,
            "cursor": self._cursor,
            "revision": self._revision,
            "mcp_revision": self._mcp_revision,
            "last": self._last.to_json(),
            "gateway": self._gateway.status(len(self._gateway.entries())),
        }

    def changes(self) -> Dict[str, Any]:
        """What ``GET /api/skills/hub/changes`` answers: the last snapshot,
        each install paired with its local state. No network call."""
        installs = []
        for row in self._last_snapshot.get("installs") or []:
            local = self._installer.local_state(str(row.get("slug") or ""))
            installs.append({**row, "local": local})
        return {
            **self.status(),
            "installs": installs,
            "updates": list(self._last.updates),
            "workspaces": list(self._last_snapshot.get("workspaces") or []),
            "mcp": self._mcp_changes(),
            "history": list(self._history),
            "generated_at": self._last_snapshot.get("generated_at"),
        }

    def _mcp_changes(self) -> Dict[str, Any]:
        """The ``mcp`` block of the last snapshot, each install with its local state."""
        block = self._last_snapshot.get("mcp") if isinstance(self._last_snapshot.get("mcp"), dict) else {}
        rows = []
        for row in block.get("installs") or []:
            if isinstance(row, dict):
                local = self._mcp.local_state(str(row.get("slug") or ""))
                rows.append({**row, "local": {k: v for k, v in local.items() if k not in HUB_LOCK_KEYS}})
        return {"installs": rows, "updates": list(block.get("updates") or []), "workspaces": list(block.get("workspaces") or []),
                "endpoints_changed_at": block.get("endpoints_changed_at")}

    # -- the loop ------------------------------------------------------------

    def nudge(self) -> None:
        wake, loop = self._wake, self._loop
        if wake is None or loop is None:
            return
        try:
            loop.call_soon_threadsafe(wake.set)
        except RuntimeError:
            pass

    async def run_forever(self) -> None:
        import asyncio

        from starlette.concurrency import run_in_threadpool

        self._wake = asyncio.Event()
        self._loop = asyncio.get_running_loop()
        if not (self._settings.enabled and self._settings.configured):
            logger.info("hub sync: not running (%s)", "switched off" if not self._settings.enabled else "no hub configured")
            return
        logger.info("hub sync: every %.0fs against %s", self._settings.interval_seconds, self._settings.base_url)
        watcher = asyncio.create_task(self._watch_stream()) if self._settings.realtime else None
        try:
            while True:
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=self._settings.interval_seconds)
                except asyncio.TimeoutError:
                    pass
                self._wake.clear()
                outcome = await run_in_threadpool(self.tick)
                if outcome.status not in ("ok", "offline", "signed_out", "idle"):
                    logger.info("hub sync: %s — %s", outcome.status, outcome.detail)
        except asyncio.CancelledError:
            raise
        finally:
            if watcher is not None:
                watcher.cancel()
            self._wake = None
            self._loop = None

    async def _watch_stream(self) -> None:
        """Hold ``/v1/events`` open and nudge on every relevant event. Best-effort."""
        import asyncio

        while True:
            credentials = self._resolve_credentials()
            if credentials is None or self._clock() < self._blocked_until:
                self._stream_state = "waiting"
                await asyncio.sleep(min(self._settings.interval_seconds, 15.0))
                continue
            try:
                await self._stream_once(credentials)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - realtime is optional
                logger.debug("hub sync: event stream unavailable: %s", exc)
                if getattr(exc, "reauth", False):
                    self._blocked_until = self._clock() + REAUTH_BACKOFF_SECONDS
            self._stream_state = "reconnecting"
            await asyncio.sleep(STREAM_RECONNECT_SECONDS)

    async def _stream_once(self, credentials: HubCredentials) -> None:
        client = self._session_client()
        self._stream_state = "connected"
        logger.info("hub sync: watching %s/v1/events for changes", self._settings.base_url)
        async for event in client.aiter_events(
            bearer=credentials.bearer, device_id=credentials.device_id, device_name=credentials.device_name, product=PRODUCT, cursor=self._cursor,
        ):
            event_id = event.get("id")
            if isinstance(event_id, int):
                self._cursor = max(self._cursor or 0, event_id)
            if event.get("type") in FEED_EVENTS:
                self._feed_stale = True
            if event.get("type") in NUDGE_EVENTS:
                self.nudge()


# ---------------------------------------------------------------------------
# MCP servers installed or removed here by the person
# ---------------------------------------------------------------------------


def announce_mcp_install(slug: str) -> bool:
    """The person installed AgentX Hub server *slug* on this machine (the MCP
    tab, ``agentx mcp``): tell the hub — it keeps the desired state from now
    on, a yank reaches this machine — and wake the sync, which reports what
    the server announces. Offline: False, and the sync registers it later."""
    from hermes_cli.hub_client import HubClient, HubError, hub_base_url
    from tools import mcp_hub

    mcp_hub.clear_removed_here(slug)
    registered = False
    credentials = resolve_credentials()
    base_url = hub_base_url()
    if credentials is not None and base_url:
        try:
            HubClient(base_url).create_mcp_install(slug, bearer=credentials.bearer, device_id=credentials.device_id,
                                                   device_name=credentials.device_name)
            registered = True
        except HubError as exc:
            logger.warning("hub sync: could not tell the hub about MCP %s: %s", slug, exc)
    engine().nudge()
    return registered


def announce_mcp_removal(slug: str) -> None:
    """The person removed AgentX Hub server *slug* here: the sync tells the hub."""
    from tools import mcp_hub

    mcp_hub.mark_removed_here(slug)
    engine().nudge()



# ---------------------------------------------------------------------------
# The AgentX Gateway: this machine's token and the entries that send it
# ---------------------------------------------------------------------------

#: The ``.env`` key of this machine's gateway token (the entries read ``${AGENTX_GATEWAY_TOKEN}``).
GATEWAY_TOKEN_ENV = "AGENTX_GATEWAY_TOKEN"
#: What an entry added from the gateway carries as ``source`` — never ``hub:``,
#: which is the tool-hash lock of a server installed from the hub's feed.
GATEWAY_SOURCE = "hub-gateway"
#: Renew the token when it has fewer days left than this.
GATEWAY_ROTATE_DAYS = 30
#: The bearers that are a signed-in session (the hub gives a gateway token to nothing else).
SESSION_SOURCES = ("session", "mailbox")
_GATEWAY_STATE_FILENAME = "mcp_hub_gateway.json"
_GATEWAY_NAME_RE = re.compile(r"[^a-z0-9_-]+")


def gateway_entry_name(ref: str) -> str:
    """The ``mcp_servers`` key of a gateway endpoint: ``agentx-<ref>`` (a server's slug, a toolset's ``ts_…`` id)."""
    tail = _GATEWAY_NAME_RE.sub("-", str(ref or "").lower()).strip("-")[:48] or "endpoint"
    return f"agentx-{tail}"


def gateway_entry(endpoint: Dict[str, Any]) -> Dict[str, Any]:
    """The entry that reaches *endpoint* through the gateway with this machine's token."""
    return {
        "url": str(endpoint["url"]),
        "headers": {"Authorization": f"Bearer ${{{GATEWAY_TOKEN_ENV}}}"},
        "protocol": "auto",
        "enabled": True,
        "source": GATEWAY_SOURCE,
        "gateway": {"kind": str(endpoint.get("kind") or "server"), "ref": str(endpoint.get("ref") or ""), "label": str(endpoint.get("label") or "")},
    }


def gateway_entries() -> Dict[str, dict]:
    """The entries added from the gateway, in the profile the sync runs in."""
    from hermes_cli import mcp_catalog

    return {name: cfg for name, cfg in mcp_catalog.raw_servers().items() if isinstance(cfg, dict) and cfg.get("source") == GATEWAY_SOURCE}


class GatewaySignInNeeded(Exception):
    """A gateway token is asked for by a signed-in session only: this bearer is a personal token."""


class GatewayDevice:
    """This machine's gateway token: the secret in the profile's ``.env``
    (:data:`GATEWAY_TOKEN_ENV`), its id and expiry beside the MCP feed
    (``cache/mcp_hub_gateway.json`` — no secret there). Injectable for tests."""

    def __init__(self, *, state_path: Any | None = None, write_env: Callable[[str, str], Any] | None = None,
                 list_entries: Callable[[], Dict[str, dict]] | None = None, clock: Callable[[], float] = time.time) -> None:
        self._state_path = state_path
        self._write_env = write_env
        self._list_entries = list_entries or gateway_entries
        self._clock = clock
        self._lock = threading.Lock()

    def _path(self) -> Any:
        if self._state_path is not None:
            return self._state_path
        from hermes_constants import get_hermes_home

        return get_hermes_home() / "cache" / _GATEWAY_STATE_FILENAME

    def entries(self) -> Dict[str, dict]:
        try:
            return self._list_entries()
        except Exception as exc:  # noqa: BLE001 - a broken config lists nothing, the tab says so
            logger.debug("hub sync: gateway entries unreadable: %s", exc)
            return {}

    def state(self) -> Dict[str, Any]:
        import json

        try:
            data = json.loads(self._path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _expires_at(self) -> float:
        raw = self.state().get("expires_at")
        try:
            return datetime.fromisoformat(str(raw)).timestamp() if raw else 0.0
        except ValueError:
            return 0.0

    def needs_rotation(self) -> bool:
        expires = self._expires_at()
        return not expires or expires - self._clock() < GATEWAY_ROTATE_DAYS * 86400

    def status(self, entries: int = 0) -> Dict[str, Any]:
        """``{entries, token, expires_at, days_left, state: none|ok|renew|expired}`` — never the token."""
        held = self.state()
        expires = self._expires_at()
        if not held or not expires:
            return {"entries": entries, "token": False, "expires_at": None, "days_left": None, "state": "none"}
        left = expires - self._clock()
        state = "expired" if left <= 0 else "renew" if left < GATEWAY_ROTATE_DAYS * 86400 else "ok"
        return {"entries": entries, "token": True, "expires_at": held.get("expires_at"), "days_left": max(0, int(left // 86400)), "state": state,
                "device_id": held.get("device_id")}

    def issue(self, client: Any, credentials: HubCredentials) -> Dict[str, Any]:
        """Ask the hub for a new token of this machine (the earlier one is revoked there), keep it."""
        import json
        import os
        import tempfile

        if credentials.source not in SESSION_SOURCES:
            raise GatewaySignInNeeded("the hub gives a gateway token to a signed-in session only")
        with self._lock:
            answer = client.gateway_device_token(bearer=credentials.bearer, device_id=credentials.device_id, device_name=credentials.device_name)
            write = self._write_env
            if write is None:
                from hermes_cli.config import save_env_value as write
            write(GATEWAY_TOKEN_ENV, str(answer["token"]))
            held = {"token_id": answer.get("id"), "prefix": answer.get("prefix"), "expires_at": answer.get("expires_at"), "device_id": answer.get("device_id"),
                    "gateway_url": answer.get("gateway_url"), "issued_at": datetime.now(timezone.utc).isoformat()}
            path = self._path()
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp = tempfile.mkstemp(dir=str(path.parent), prefix=".gateway-", suffix=".json")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(held, handle, indent=2)
            os.replace(temp, path)
            return held


def add_gateway_endpoint(endpoint: Dict[str, Any], *, client: Any, credentials: HubCredentials, device: GatewayDevice | None = None) -> str:
    """Add *endpoint* (one of ``GET /v1/mcp/me/endpoints``) to this machine:
    a gateway token first when there is none worth keeping, then the entry.
    Returns the entry's name. The desktop reloads MCP after."""
    from hermes_cli import mcp_catalog
    from hermes_cli.mcp_config import _save_mcp_server

    if not str(endpoint.get("url") or "").startswith(("https://", "http://")):
        raise ValueError("the endpoint has no address")
    name = gateway_entry_name(str(endpoint.get("ref") or ""))
    existing = mcp_catalog.raw_servers().get(name)
    if isinstance(existing, dict) and existing.get("source") != GATEWAY_SOURCE:
        # Somebody's own server under that name stays theirs: the gateway never writes over it.
        raise ValueError(f"an MCP server named {name} is already set up here, not by the gateway: rename or remove it first")
    device = device or engine()._gateway
    if device.needs_rotation():
        device.issue(client, credentials)
    if not _save_mcp_server(name, gateway_entry(endpoint)):
        raise ValueError(f"the entry {name} was refused by the MCP config checks")
    engine().nudge()
    return name

# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------

_MAILBOX = HubMailbox()
_ENGINE: Optional[HubSyncEngine] = None
_ENGINE_LOCK = threading.Lock()


def mailbox() -> HubMailbox:
    return _MAILBOX


def engine() -> HubSyncEngine:
    global _ENGINE
    with _ENGINE_LOCK:
        if _ENGINE is None:
            _ENGINE = HubSyncEngine(credentials=resolve_credentials)
        return _ENGINE


def shutdown() -> None:
    global _ENGINE
    with _ENGINE_LOCK:
        _ENGINE = None
