"""Document kinds that live in files rather than in ``state.db``.

Sessions and messages are rows, so their change log comes free: SQLite
triggers append to ``sync_outbox`` and the engine drains it. Memories and
plans are markdown files in the account home, and a filesystem has no
triggers. This module supplies what the triggers supply — a way to ask "what
changed here since last time" — and the export/apply pair for each kind.

The engine does not know what a memory is, and neither does the service.
``kind`` is an opaque string on the wire, in the store, and in the feed, so
adding one of these is a client-side change and nothing else (R8). That is the
boundary Phase 1 drew, and this module is the first thing to test it.

Three things in here are load-bearing.

**A manifest stands in for the triggers.** Each source records the size and
modification time of every file it has seen. A file whose stamp has moved is a
change; a file that has gone is a tombstone. Cruder than a trigger — an edit
that restores a file's exact previous size and mtime is invisible — and it is
the only mechanism available without watching the filesystem, which would cost
a watcher per account for a directory that changes a few times a day.

**Applying must not re-enqueue.** Writing a pulled file changes its mtime, and
the next scan would see that as a local edit and push it straight back —
exactly the loop the outbox watermark prevents on the database side. So the
manifest is updated with the written file's new stamp inside the same apply.

**A ``doc_id`` from the feed is a path another machine chose.** It is checked
against the root before anything is opened. Without that check a document
named ``../../.ssh/authorized_keys`` would be written outside the account home
by a device somebody else controls — the whole point of the check is that the
feed is not a trusted source of filenames, even though it is an authenticated
one.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

logger = logging.getLogger("hermes_cli.sync_engine")

#: Kinds this build carries in files. Opaque strings — nothing on the server
#: knows them, and nothing here needs the server to.
SYNC_KIND_MEMORY = "memory"
SYNC_KIND_PLAN = "plan"

#: Largest file synchronised, in bytes. A memory or a plan is prose; anything
#: past this is something else that happened to land in the directory, and
#: pushing it would cost everybody's bandwidth for a file nobody wrote.
MAX_FILE_BYTES = 1024 * 1024

#: Files never synchronised, whatever directory they turn up in. Locks and
#: swap files are one machine's runtime state; carrying them to another
#: machine would at best confuse it.
_IGNORED_SUFFIXES = (".lock", ".tmp", ".swp", "~")
_IGNORED_NAMES = (".DS_Store",)


def _is_ignored(name: str) -> bool:
    return name in _IGNORED_NAMES or name.startswith(".") or name.endswith(_IGNORED_SUFFIXES)


class JsonManifest:
    """What this device has already seen, kept beside the account's state.

    A JSON file rather than a table because these sources do not otherwise
    need ``state.db`` open, and because losing it is cheap: a missing manifest
    re-pushes every file once, and re-pushing is a no-op the far side settles
    by last-writer-wins.

    Reading is total. A truncated or hand-edited manifest yields an empty one
    rather than raising, for the same reason ``install_device_identity`` reads
    that way — this runs on a background tick, and an unreadable file must
    cost a redundant push rather than stopping synchronisation.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def read(self) -> Dict[str, Dict[str, Any]]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        if not isinstance(data, dict):
            return {}
        entries = data.get("files")
        return entries if isinstance(entries, dict) else {}

    def write(self, entries: Dict[str, Dict[str, Any]]) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # Written through a temporary file: a manifest truncated by a
            # crash mid-write would re-push every file, and on a large history
            # that is a slow, confusing recovery from a very small failure.
            temporary = self.path.with_suffix(self.path.suffix + ".tmp")
            temporary.write_text(
                json.dumps({"files": entries}, indent=1, sort_keys=True), encoding="utf-8"
            )
            os.replace(temporary, self.path)
        except OSError as exc:
            logger.warning("sync: could not write %s: %s", self.path, exc)


class FileTreeSource:
    """One synced kind, backed by a directory of text files.

    ``doc_id`` is the file's path relative to the root, in POSIX form, so two
    machines agree on it whatever their separator. ``updated_at`` is the file's
    modification time, which is what last-writer-wins settles on.
    """

    def __init__(
        self,
        kind: str,
        root: Path,
        manifest: JsonManifest,
        *,
        suffixes: Sequence[str] = (".md",),
        max_bytes: int = MAX_FILE_BYTES,
    ) -> None:
        self.kind = kind
        self.root = Path(root)
        self.manifest = manifest
        self.suffixes = tuple(suffixes)
        self.max_bytes = int(max_bytes)

    @property
    def kinds(self) -> tuple:
        return (self.kind,)

    # -- reading the tree -------------------------------------------------

    def _relative(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()

    def resolve(self, doc_id: str) -> Optional[Path]:
        """Where *doc_id* lands inside the root, or None if it escapes it.

        The feed is authenticated but its filenames are not trusted: a
        document id is a path chosen on another machine, and one shaped like
        ``../../.ssh/authorized_keys`` must resolve to nothing rather than to
        a file outside the account home. Absolute paths and Windows drive
        letters are refused for the same reason.
        """
        candidate = str(doc_id or "").strip()
        if not candidate or candidate.startswith(("/", "\\")) or ":" in candidate:
            return None
        if any(part in ("..", "") for part in candidate.replace("\\", "/").split("/")):
            return None
        if not candidate.endswith(self.suffixes):
            return None

        target = (self.root / candidate).resolve()
        root = self.root.resolve()
        try:
            target.relative_to(root)
        except ValueError:
            return None
        return target

    def scan(self) -> Dict[str, Dict[str, Any]]:
        """Every syncable file under the root, by relative path."""
        found: Dict[str, Dict[str, Any]] = {}
        if not self.root.is_dir():
            return found

        for directory, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [name for name in dirnames if not name.startswith(".")]
            for name in filenames:
                if _is_ignored(name) or not name.endswith(self.suffixes):
                    continue
                path = Path(directory) / name
                try:
                    stat = path.stat()
                except OSError:
                    continue
                if stat.st_size > self.max_bytes:
                    logger.debug("sync: skipping oversized %s", path)
                    continue
                found[self._relative(path)] = {
                    "mtime": float(stat.st_mtime),
                    "size": int(stat.st_size),
                }
        return found

    # -- the source contract ----------------------------------------------

    def pending(self, limit: int = 200) -> List[Dict[str, Any]]:
        """Documents this device has that the feed has not been told about.

        Returns envelopes in the shape ``second_brain/sync.py`` accepts, each
        carrying a ``_manifest`` entry the engine hands back on acknowledgement
        — the source never records a file as sent until the service has said
        it received it, which is the same rule the outbox follows.
        """
        seen = self.manifest.read()
        found = self.scan()
        documents: List[Dict[str, Any]] = []

        for relative, stamp in sorted(found.items()):
            known = seen.get(relative)
            if (
                known
                and float(known.get("mtime") or 0) == stamp["mtime"]
                and int(known.get("size") or -1) == stamp["size"]
            ):
                continue
            document = self._export(relative, stamp)
            if document is not None:
                documents.append(document)
            if len(documents) >= limit:
                return documents

        for relative in sorted(set(seen) - set(found)):
            documents.append(
                {
                    "kind": self.kind,
                    "doc_id": relative,
                    "updated_at": time.time(),
                    "deleted": True,
                    "payload": None,
                    "_manifest": None,
                }
            )
            if len(documents) >= limit:
                break

        return documents

    def _export(self, relative: str, stamp: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        path = self.root / relative
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            # Not text, or gone since the scan. Either way there is nothing to
            # carry; the next scan sees it again if it becomes readable.
            logger.debug("sync: could not read %s", path)
            return None
        return {
            "kind": self.kind,
            "doc_id": relative,
            "updated_at": stamp["mtime"],
            "deleted": False,
            "payload": {"path": relative, "text": text},
            "_manifest": stamp,
        }

    def acknowledge(self, documents: Iterable[Dict[str, Any]]) -> None:
        """Record what the service confirmed it received.

        Called only after the push is acknowledged. A connection that drops
        mid-push leaves the manifest untouched, so the next tick sends the
        same files again rather than losing them.
        """
        entries = self.manifest.read()
        changed = False

        for document in documents or ():
            doc_id = str((document or {}).get("doc_id") or "")
            if not doc_id:
                continue
            stamp = (document or {}).get("_manifest")
            if stamp is None:
                changed = entries.pop(doc_id, None) is not None or changed
            else:
                entries[doc_id] = stamp
                changed = True

        if changed:
            self.manifest.write(entries)

    def apply(self, documents: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
        """Land documents pulled from the feed. Never raises.

        Idempotent: a file already holding the incoming text is left alone,
        which is what keeps a cursor reset free and stops an apply from
        producing a change to push back.
        """
        entries = self.manifest.read()
        result = {"applied": 0, "skipped": 0, "deleted": 0, "errors": []}
        changed = False

        for document in documents or ():
            doc_id = str((document or {}).get("doc_id") or "")
            path = self.resolve(doc_id)
            if path is None:
                logger.warning(
                    "sync: refusing a %s document with an unusable path: %r",
                    self.kind,
                    doc_id,
                )
                result["errors"].append({"doc_id": doc_id, "error": "unusable path"})
                continue

            try:
                if document.get("deleted"):
                    changed = self._remove(path, doc_id, entries, result) or changed
                else:
                    changed = self._write(document, path, doc_id, entries, result) or changed
            except OSError as exc:
                logger.warning("sync: could not apply %s/%s: %s", self.kind, doc_id, exc)
                result["errors"].append({"doc_id": doc_id, "error": str(exc)})

        if changed:
            self.manifest.write(entries)
        return result

    def _remove(self, path: Path, doc_id: str, entries: Dict, result: Dict) -> bool:
        if not path.exists():
            # Already gone. Drop the manifest row so this device does not
            # announce a deletion the feed already carries.
            result["skipped"] += 1
            return entries.pop(doc_id, None) is not None

        path.unlink()
        entries.pop(doc_id, None)
        result["deleted"] += 1
        return True

    def _write(self, document: Dict, path: Path, doc_id: str, entries: Dict, result: Dict) -> bool:
        payload = document.get("payload")
        if not isinstance(payload, dict):
            result["errors"].append({"doc_id": doc_id, "error": "payload must be an object"})
            return False

        text = payload.get("text")
        if not isinstance(text, str):
            result["errors"].append({"doc_id": doc_id, "error": "payload must carry text"})
            return False

        remote_stamp = _stamp(document.get("updated_at"))

        if path.exists():
            local_stamp = float(path.stat().st_mtime)
            if remote_stamp < local_stamp:
                # Last writer wins, and the local file is the last writer.
                result["skipped"] += 1
                return False
            try:
                if path.read_text(encoding="utf-8") == text:
                    # Identical already. Recording the stamp is still worth
                    # doing — it is what stops an unchanged file from looking
                    # like a local edit on the next scan.
                    result["skipped"] += 1
                    entries[doc_id] = _stat_entry(path)
                    return True
            except (OSError, UnicodeDecodeError):
                pass

        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

        # The written file's OWN stamp, read back rather than assumed. This is
        # what stops the write from looking like a local edit on the next
        # scan and bouncing straight back to the feed.
        entries[doc_id] = _stat_entry(path)
        result["applied"] += 1
        return True


def _stat_entry(path: Path) -> Dict[str, Any]:
    stat = path.stat()
    return {"mtime": float(stat.st_mtime), "size": int(stat.st_size)}


def _stamp(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def default_sources(home: Optional[Path] = None) -> List[FileTreeSource]:
    """The file-backed kinds this build synchronises, for one account home.

    Memories and plans, both markdown trees the account home creates at
    sign-in (``hermes_cli.accounts._ACCOUNT_DIRS``).

    The kanban board is deliberately NOT here. It is a SQLite database of work
    items carrying live coordination state — a task's status is what a
    dispatcher compare-and-swaps to claim it, and the claim is what stops two
    workers doing the same job. Settling that across devices by
    last-writer-wins would let two machines claim one task and both start
    work, which is worse than not syncing it at all. It needs a conflict rule
    of its own — per-device claim leases — and that is a design question this
    phase did not answer, so the board stays local rather than being carried
    across on a rule that does not fit it.
    """
    from hermes_constants import get_hermes_home

    root = Path(home) if home is not None else Path(get_hermes_home())
    manifests = root / "sync"

    return [
        FileTreeSource(
            SYNC_KIND_MEMORY, root / "memories", JsonManifest(manifests / "memory.json")
        ),
        FileTreeSource(
            SYNC_KIND_PLAN, root / "plans", JsonManifest(manifests / "plan.json")
        ),
    ]
