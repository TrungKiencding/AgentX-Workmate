"""Files a turn produced, for the desktop chat's file cards.

The desktop shows a produced document the way Claude desktop or Codex do — a
card with preview and download — instead of a bare path. The structured
signal for that is the ``deliver_file`` tool, but a model does not always call
it (a script prints "Saved to /tmp/report.docx" and the reply just repeats the
path). This module is the safety net: after a turn, it works out which
deliverable-type files the turn actually produced, from two cheap sources —

* paths mentioned in the turn's tool calls, tool results and reply, resolved
  and stat'ed (no directory walk, so a home-directory session costs nothing);
* when the session has an explicit workspace, a bounded walk of that folder
  for files created during the turn.

Everything is filtered on existence, a deliverable extension, a modification
time inside the turn, and a short denylist of places a deliverable never lives
(VCS metadata, dependency trees, hidden folders, the AgentX home). Pure
functions, no server state: ``tui_gateway.server`` calls
:func:`collect_turn_deliverables` and ships the result on ``message.complete``.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import time
from pathlib import Path
from typing import Any, Iterable, Optional

# Extensions a person would want handed to them. Source code is deliberately
# absent: a coding turn's ``.ts`` / ``.py`` edits already render as changed
# files with a diff, and a card per touched source file would be noise.
DELIVERABLE_KINDS: dict[str, frozenset[str]] = {
    "document": frozenset({".doc", ".docx", ".odt", ".rtf", ".epub", ".pages"}),
    "spreadsheet": frozenset({".xls", ".xlsx", ".xlsm", ".ods", ".numbers"}),
    "presentation": frozenset({".ppt", ".pptx", ".odp", ".key"}),
    "pdf": frozenset({".pdf"}),
    "archive": frozenset({".zip", ".tar", ".gz", ".tgz", ".7z", ".rar", ".dmg"}),
    "image": frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".heic", ".tiff", ".tif"}),
    "audio": frozenset({".mp3", ".wav", ".m4a", ".ogg", ".opus", ".flac", ".aac"}),
    "video": frozenset({".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}),
    "data": frozenset({".csv", ".tsv", ".parquet", ".ics", ".vcf"}),
    "text": frozenset({".md", ".txt", ".html", ".htm"}),
}

DELIVERABLE_EXTENSIONS: frozenset[str] = frozenset(
    ext for exts in DELIVERABLE_KINDS.values() for ext in exts
)

# Folders a produced deliverable never lives in. Matched on any path segment.
EXCLUDED_DIR_NAMES: frozenset[str] = frozenset(
    {
        ".git",
        "node_modules",
        "venv",
        ".venv",
        "__pycache__",
        "site-packages",
        ".cache",
        ".next",
        ".turbo",
        "coverage",
    }
)

# Files modified this long before the turn started still count as the turn's
# own: clocks on network volumes and buffered writes are not exact.
MODIFIED_SLACK_SECONDS = 2.0

# Bounds for the workspace walk (only when the session has an explicit
# workspace). Deliberately small: this runs on every turn.
SCAN_MAX_ENTRIES = 3000
SCAN_MAX_DEPTH = 3
SCAN_BUDGET_SECONDS = 0.15

DEFAULT_LIMIT = 20

_EXT_ALTERNATION = "|".join(
    sorted((re.escape(ext.lstrip(".")) for ext in DELIVERABLE_EXTENSIONS), key=len, reverse=True)
)

# Absolute paths: ``/…``, ``~/…`` and ``C:\…`` (or ``C:/…``). The look-behind
# keeps the ``/x/y.pdf`` tail of an ``https://host/x/y.pdf`` URL out: inside a
# URL every slash follows a word character, a colon, or another slash.
_ABSOLUTE_PATH_RE = re.compile(
    r"(?<![\w:/\\.-])"
    r"((?:~|/|[A-Za-z]:[\\/])[^\s\"'`<>|*?\[\]{}]*?\.(?:" + _EXT_ALTERNATION + r"))"
    r"(?=[\s\"'`<>|,;:)\]}]|\.(?:\s|$)|$)",
    re.IGNORECASE,
)

# Relative tokens such as ``out/report.docx`` or ``report.docx`` — a script's
# ``-o`` argument, a printed "Saved report.docx". Resolved against the cwd
# and then stat'ed, which is what keeps prose false positives out.
_RELATIVE_PATH_RE = re.compile(
    r"(?<![\w/\\.~:-])"
    r"((?:[\w\-][\w.\-]*[\\/])*[\w\-][\w.\-]*\.(?:" + _EXT_ALTERNATION + r"))"
    r"(?=[\s\"'`<>|,;:)\]}]|\.(?:\s|$)|$)",
    re.IGNORECASE,
)

_EXTRA_MIME_TYPES = {
    ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".heic": "image/heic",
    ".md": "text/markdown",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".tsv": "text/tab-separated-values",
    ".webp": "image/webp",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


def deliverable_kind(path: str) -> Optional[str]:
    """The card kind for *path*'s extension, or ``None`` when it is not a deliverable."""
    ext = os.path.splitext(path)[1].lower()
    for kind, exts in DELIVERABLE_KINDS.items():
        if ext in exts:
            return kind
    return None


def is_deliverable_path(path: str) -> bool:
    return deliverable_kind(path) is not None


def mime_type_for(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in _EXTRA_MIME_TYPES:
        return _EXTRA_MIME_TYPES[ext]
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


def _has_excluded_segment(path: str) -> bool:
    parts = Path(path).parts
    for part in parts[1:] if len(parts) > 1 else parts:
        if part in EXCLUDED_DIR_NAMES:
            return True
    # A hidden folder anywhere in the path (``~/.agentx/…``, ``.worktrees``)
    # is agent or tool bookkeeping, never a deliverable. The file's own name
    # may start with a dot only if it has a deliverable extension anyway.
    for part in parts[:-1]:
        if part.startswith(".") and part not in (".", ".."):
            return True
    return False


def _under_any(path: str, roots: Iterable[str]) -> bool:
    for root in roots:
        if not root:
            continue
        try:
            Path(path).relative_to(Path(root))
            return True
        except ValueError:
            continue
    return False


def describe_file(path: str) -> Optional[dict[str, Any]]:
    """Stat *path* into a card record, or ``None`` when it is not a real, non-empty file."""
    try:
        stat = os.stat(path)
    except OSError:
        return None
    if not os.path.isfile(path) or stat.st_size <= 0:
        return None
    return {
        "path": path,
        "name": os.path.basename(path),
        "size_bytes": int(stat.st_size),
        "mime_type": mime_type_for(path),
        "modified_at": float(stat.st_mtime),
        "kind": deliverable_kind(path) or "file",
    }


def _resolve_candidate(token: str, cwd: str) -> Optional[str]:
    raw = token.strip().strip("`\"'")
    if not raw:
        return None
    expanded = os.path.expanduser(raw)
    if not os.path.isabs(expanded):
        if not cwd:
            return None
        expanded = os.path.join(cwd, expanded)
    try:
        return os.path.normpath(os.path.abspath(expanded))
    except (OSError, ValueError):
        return None


def _iter_text_fragments(value: Any, depth: int = 0) -> Iterable[str]:
    """Every string reachable inside a message field, bounded in depth."""
    if depth > 4:
        return
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from _iter_text_fragments(child, depth + 1)
    elif isinstance(value, (list, tuple)):
        for child in value:
            yield from _iter_text_fragments(child, depth + 1)


def _tool_call_records(message: dict) -> Iterable[tuple[str, dict]]:
    """``(tool_name, arguments)`` for every tool call on an assistant message."""
    calls = message.get("tool_calls")
    if not isinstance(calls, list):
        return
    for call in calls:
        if not isinstance(call, dict):
            continue
        fn = call.get("function") if isinstance(call.get("function"), dict) else {}
        name = str(fn.get("name") or call.get("name") or "")
        raw_args = fn.get("arguments", call.get("arguments"))
        args: dict = {}
        if isinstance(raw_args, dict):
            args = raw_args
        elif isinstance(raw_args, str) and raw_args.strip():
            try:
                parsed = json.loads(raw_args)
                if isinstance(parsed, dict):
                    args = parsed
            except ValueError:
                args = {"_raw": raw_args}
        yield name, args


def paths_in_text(text: str, cwd: str) -> list[str]:
    """Deliverable-looking paths mentioned in *text*, absolute, in order, deduped."""
    found: list[str] = []
    seen: set[str] = set()

    def push(token: str) -> None:
        resolved = _resolve_candidate(token, cwd)
        if resolved and resolved not in seen:
            seen.add(resolved)
            found.append(resolved)

    for match in _ABSOLUTE_PATH_RE.finditer(text):
        push(match.group(1))
    for match in _RELATIVE_PATH_RE.finditer(text):
        token = match.group(1)
        # ``example.com/x.pdf`` style hosts and dotted package names are not
        # files; a relative token must look like something a script wrote.
        if token.count(".") > 3:
            continue
        push(token)
    return found


def candidate_paths_from_messages(messages: Iterable[dict], cwd: str) -> list[str]:
    """Paths the turn mentioned anywhere: tool arguments, tool results, the reply."""
    found: list[str] = []
    seen: set[str] = set()
    for message in messages:
        if not isinstance(message, dict):
            continue
        fragments: list[str] = []
        for _name, args in _tool_call_records(message):
            fragments.extend(_iter_text_fragments(args))
        for key in ("content", "text", "context"):
            fragments.extend(_iter_text_fragments(message.get(key)))
        for fragment in fragments:
            for path in paths_in_text(fragment, cwd):
                if path not in seen:
                    seen.add(path)
                    found.append(path)
    return found


def delivered_paths_from_messages(messages: Iterable[dict], cwd: str) -> set[str]:
    """Paths already handed over through ``deliver_file`` in this turn."""
    delivered: set[str] = set()
    for message in messages:
        if not isinstance(message, dict):
            continue
        for name, args in _tool_call_records(message):
            if name != "deliver_file":
                continue
            resolved = _resolve_candidate(str(args.get("path") or ""), cwd)
            if resolved:
                delivered.add(resolved)
                real = os.path.realpath(resolved)
                delivered.add(real)
        if message.get("role") == "tool" and message.get("name") == "deliver_file":
            content = message.get("content")
            if isinstance(content, str):
                try:
                    payload = json.loads(content)
                except ValueError:
                    payload = None
                if isinstance(payload, dict) and isinstance(payload.get("path"), str):
                    delivered.add(payload["path"])
    return delivered


def scan_workspace(
    root: str,
    since: float,
    *,
    max_entries: int = SCAN_MAX_ENTRIES,
    max_depth: int = SCAN_MAX_DEPTH,
    budget_seconds: float = SCAN_BUDGET_SECONDS,
    clock=time.monotonic,
) -> list[str]:
    """Deliverable files under *root* modified at or after *since*, bounded.

    Breadth-first so shallow deliverables (``report.docx`` next to the
    project) are found before the budget runs out on a deep tree.
    """
    if not root or not os.path.isdir(root):
        return []
    deadline = clock() + budget_seconds
    visited = 0
    found: list[str] = []
    queue: list[tuple[str, int]] = [(root, 0)]
    cutoff = since - MODIFIED_SLACK_SECONDS
    while queue:
        directory, depth = queue.pop(0)
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    visited += 1
                    if visited > max_entries or clock() > deadline:
                        return found
                    name = entry.name
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if depth < max_depth and not name.startswith(".") and name not in EXCLUDED_DIR_NAMES:
                                queue.append((entry.path, depth + 1))
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        if not is_deliverable_path(name):
                            continue
                        stat = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if stat.st_size <= 0 or stat.st_mtime < cutoff:
                        continue
                    found.append(entry.path)
        except OSError:
            continue
    return found


def collect_turn_deliverables(
    new_messages: Iterable[dict],
    *,
    cwd: str,
    started_at: float,
    workspace_root: Optional[str] = None,
    excluded_roots: Iterable[str] = (),
    limit: int = DEFAULT_LIMIT,
    final_text: str = "",
) -> list[dict[str, Any]]:
    """The deliverable files this turn produced, newest first, capped at *limit*.

    ``new_messages`` are the conversation rows the turn appended (assistant
    text, tool calls, tool results). ``workspace_root`` enables the bounded
    walk and should only be the session's explicit workspace — never a
    launch directory such as ``$HOME``. ``excluded_roots`` (the AgentX home)
    are never reported.
    """
    messages = [m for m in new_messages if isinstance(m, dict)]
    candidates = candidate_paths_from_messages(messages, cwd)
    if final_text:
        for path in paths_in_text(final_text, cwd):
            if path not in candidates:
                candidates.append(path)
    if workspace_root:
        for path in scan_workspace(workspace_root, started_at):
            if path not in candidates:
                candidates.append(path)

    delivered = delivered_paths_from_messages(messages, cwd)
    excluded = [os.path.normpath(os.path.abspath(os.path.expanduser(r))) for r in excluded_roots if r]
    cutoff = started_at - MODIFIED_SLACK_SECONDS

    records: list[dict[str, Any]] = []
    seen_real: set[str] = set()
    for path in candidates:
        if not is_deliverable_path(path) or _has_excluded_segment(path):
            continue
        if path in delivered or _under_any(path, excluded):
            continue
        record = describe_file(path)
        if record is None or record["modified_at"] < cutoff:
            continue
        real = os.path.realpath(path)
        if real in delivered or real in seen_real:
            continue
        seen_real.add(real)
        records.append(record)

    records.sort(key=lambda r: r["modified_at"], reverse=True)
    return records[:limit]
