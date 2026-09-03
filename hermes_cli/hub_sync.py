"""Keep this machine's skills in step with what the person asked the AgentX
Skill Hub for (plan Phase 3, items 5–7).

The hub holds the *desired* state: "this person wants skill X on this
Workmate", "switch version 1.2 of Y off everywhere it was installed",
"the organisation published Z". This engine makes the disk agree and
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

**Credentials are given, never obtained.** This process holds no refresh
token. The bearer arrives on ``POST /api/skills/hub/tick`` (the desktop's
Hub tab), on ``POST /api/sync/tick`` (the desktop's 30-second timer — the
same mailbox the second-brain sync engine spends), or as a personal hub
token in ``skills.hub_token`` for an install without a desktop.
"""

from __future__ import annotations

import logging
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
NUDGE_EVENTS = ("install.desired", "install.update_available", "org.skill.published", "catalog.version.yanked", "catalog.version.demoted")


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
    org_installed: List[str] = field(default_factory=list)
    updates: List[Dict[str, Any]] = field(default_factory=list)
    cursor: Optional[int] = None
    at: str = ""

    @property
    def ok(self) -> bool:
        return self.status == "ok"

    @property
    def changed(self) -> bool:
        return bool(self.installed or self.updated or self.removed or self.disabled or self.enabled or self.org_installed)

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
            "org_installed": list(self.org_installed),
            "updates": list(self.updates),
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
    org_auto_install: bool = True
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
        org_auto_install=_as_bool(section.get("hub_org_auto_install"), True),
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
        """What the lock file says about *slug*: installed?, version, hash, enabled?."""
        from tools.skills_hub import HubLockFile

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
            }
        return {"installed": False, "name": "", "version": "", "content_hash": "", "install_path": "", "enabled": False}

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
        from tools.skills_hub import uninstall_skill

        ok, message = uninstall_skill(name)
        if ok:
            self.enable(name)  # a stale entry in skills.disabled would shadow a later reinstall
            self._clear_prompt_cache()
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
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._credentials = credentials
        self._settings = settings if settings is not None else load_hub_sync_settings()
        self._client = client
        self._transport = transport
        self._installer = installer if installer is not None else LocalInstaller(transport=transport)
        self._clock = clock
        self._tick_lock = threading.Lock()
        self._last = HubSyncOutcome(status="idle")
        self._last_snapshot: Dict[str, Any] = {}
        self._blocked_until = 0.0
        self._cursor: Optional[int] = None
        self._history: Deque[Dict[str, Any]] = deque(maxlen=HISTORY_SIZE)
        self._revision = 0
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
        outcome.updates = [
            {"install_id": u.get("id"), "slug": u.get("slug"), "name": u.get("name"), "current": u.get("reported_version"), "latest": u.get("latest_version")}
            for u in snapshot.get("updates") or []
        ]
        if self._settings.org_auto_install:
            self._mirror_org(snapshot.get("org") or {}, credentials, client, outcome)

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
                if not local["enabled"]:
                    # Switched off locally while the hub still wants it: leave the person's choice alone.
                    return
                return
            if local["installed"] and (not pinned or local["version"] == wanted_version) and reported in ("pending", "disabled"):
                # The hub re-enabled (or never heard back): make sure it is on and say so.
                self._installer.enable(local["name"])
                report("installed", version=local["version"] or wanted_version)
                outcome.enabled.append(slug)
                self._remember("enabled", slug, local["version"])
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
            if local["installed"]:
                ok, message = self._installer.uninstall(local["name"])
                if not ok:
                    report("failed", version=local["version"] or None, error=message)
                    outcome.failed.append({"slug": slug, "error": message})
                    self._remember("failed", slug, local["version"], message)
                    return
            report("removed")
            outcome.removed.append(slug)
            self._remember("removed", slug, local["version"])
        elif desired == "disabled":
            if reported == "disabled":
                return
            if local["installed"]:
                self._installer.disable(local["name"])
            report("disabled", version=local["version"] or None)
            outcome.disabled.append(slug)
            self._remember("disabled", slug, local["version"], str(install.get("reason") or ""))

    def _mirror_org(self, org: Dict[str, Any], credentials: HubCredentials, client: Any, outcome: HubSyncOutcome) -> None:
        """Bring the organisation's published core skills onto this machine
        (plan Phase 3 item 3). Each becomes an install row of this device so
        the hub can later disable or update it like any other."""
        installs = {str(i.get("slug")): i for i in (self._last_snapshot.get("installs") or [])}
        for skill in org.get("skills") or []:
            slug = str(skill.get("slug") or "")
            if not slug or skill.get("kind") not in (None, "core"):
                continue
            if slug in installs:
                continue  # the install row (this device or "anywhere") is handled by _apply
            local = self._installer.local_state(slug)
            if local["installed"] and local["content_hash"] == _short_hash(str(skill.get("content_hash") or "")):
                continue
            try:
                row = client.create_install(
                    slug, bearer=credentials.bearer, device_id=credentials.device_id, device_name=credentials.device_name,
                    reason="organisation skill mirrored automatically",
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("hub sync: could not register org skill %s: %s", slug, exc)
                outcome.failed.append({"slug": slug, "error": str(exc)})
                continue
            before = len(outcome.installed) + len(outcome.updated)
            self._apply(row, credentials, client, outcome)
            if len(outcome.installed) + len(outcome.updated) > before:
                outcome.org_installed.append(slug)

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
            "org_auto_install": self._settings.org_auto_install,
            "interval_seconds": self._settings.interval_seconds,
            "credentials": credentials.source if credentials else None,
            "device_id": credentials.device_id if credentials else None,
            "stream": self._stream_state,
            "cursor": self._cursor,
            "revision": self._revision,
            "last": self._last.to_json(),
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
            "org": self._last_snapshot.get("org"),
            "history": list(self._history),
            "generated_at": self._last_snapshot.get("generated_at"),
        }

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
            if event.get("type") in NUDGE_EVENTS:
                self.nudge()


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
