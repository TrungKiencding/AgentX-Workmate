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
import tempfile
import time
from collections import deque
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

# Files a turn can hand over that are not documents: data, configuration and
# scripts ("export it as JSON", "save the script so I can reuse it"). They are
# not deliverable *kinds* (no card kind, no preview rail of their own), and a
# coding turn touches dozens of them, so they are held to a stricter bar: the
# turn must name the path, a file tool must not have written it (the
# transcript already shows that edit as a diff), and the file must be NEW to
# the turn — a formatter, ``sed -i``, ``npm install`` or a ``git status``
# listing names pre-existing project files the turn merely changed (see
# :func:`collect_turn_deliverables`).
# Never picked up by the workspace walk.
SECONDARY_OUTPUT_EXTENSIONS: frozenset[str] = frozenset(
    {
        # data and configuration
        ".json", ".jsonl", ".ndjson", ".geojson", ".xml", ".yaml", ".yml", ".toml",
        ".ini", ".cfg", ".conf", ".sql", ".sqlite", ".db", ".ipynb", ".srt", ".vtt",
        ".log", ".kml", ".gpx", ".eml",
        # scripts and source a person asked to keep
        ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".sh", ".bash", ".zsh",
        ".ps1", ".bat", ".cmd", ".rb", ".php", ".java", ".kt", ".go", ".rs", ".c",
        ".cpp", ".h", ".hpp", ".cs", ".swift", ".r", ".lua", ".pl", ".css", ".scss",
        ".vue", ".svelte",
    }
)

OUTPUT_EXTENSIONS: frozenset[str] = DELIVERABLE_EXTENSIONS | SECONDARY_OUTPUT_EXTENSIONS

# Tools whose writes the transcript already renders as an edit with a diff.
FILE_EDIT_TOOLS: frozenset[str] = frozenset({"write_file", "patch", "apply_patch", "edit_file", "multi_edit"})

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

# Build and tool output folders. A project chat that runs ``npm run build``
# fills ``dist/`` with an index.html, icons and images, none of which the
# person asked to be handed. The workspace walk never enters them, and a file
# inside one (relative to the session's folder) that the turn only named in a
# command or its output counts only once the reply names it — "build it and
# give me the zip in dist/" still gets the zip. ``out/`` is deliberately not
# here: it is where scripts are told to put what they make (``python make.py
# -o out/report.xlsx``, ``-d out``), so it holds exactly the files a person
# asked for — Next.js' static export there is the price.
BUILD_OUTPUT_DIR_NAMES: frozenset[str] = frozenset(
    {
        "dist",
        "build",
        "target",
        "_build",
        "storybook-static",
        ".svelte-kit",
        ".nuxt",
        ".output",
        ".parcel-cache",
        ".gradle",
        "Pods",
        "DerivedData",
    }
)

WALK_EXCLUDED_DIR_NAMES: frozenset[str] = EXCLUDED_DIR_NAMES | BUILD_OUTPUT_DIR_NAMES

# Whether a named script/data file was already in the project before the turn
# is asked of git (tracked files pre-existed): one bounded ``git ls-files``
# per folder holding such a candidate, which most turns never have.
GIT_PROBE_MAX_DIRS = 8
GIT_PROBE_BUDGET_SECONDS = 1.5

# Files modified this long before the turn started still count as the turn's
# own: clocks on network volumes and buffered writes are not exact.
MODIFIED_SLACK_SECONDS = 2.0

# Bounds for the workspace walk (only when the session has an explicit
# workspace). Names come from one readdir per folder and only files with a
# deliverable extension are stat'ed, so 20k entries stay well under the budget
# on a local disk; the budget is what bounds a slow network volume.
SCAN_MAX_ENTRIES = 20000
SCAN_MAX_DEPTH = 6
SCAN_BUDGET_SECONDS = 0.25

# A turn that splits a table into dozens of files should still list them all;
# the card scrolls. Bounded so one runaway turn cannot bloat the reply row.
DEFAULT_LIMIT = 50

# Paths with spaces cannot be cut out of prose by a pattern alone ("Saved to
# /Users/me/Báo cáo tháng 11.docx"): every candidate start is tried against
# the disk instead. Bounded per extension match and per collection.
SPACED_MAX_STARTS = 8
SPACED_MAX_PROBES = 400
SPACED_MAX_SEGMENT = 400

_EXT_ALTERNATION = "|".join(
    sorted((re.escape(ext.lstrip(".")) for ext in OUTPUT_EXTENSIONS), key=len, reverse=True)
)

# Absolute paths: ``/…``, ``~/…`` and ``C:\…`` (or ``C:/…``). The look-behind
# keeps the ``/x/y.pdf`` tail of an ``https://host/x/y.pdf`` URL out: inside a
# URL every slash follows a word character, a colon, or another slash.
_ABSOLUTE_PATH_RE = re.compile(
    r"(?<![\w:/\\.-])"
    r"((?:~|/|[A-Za-z]:[\\/])[^\s\"'`<>|*?\[\]{}]*?\.(?:" + _EXT_ALTERNATION + r"))"
    r"(?=[\s\"'`<>|,;:)\]}\\]|\.(?:\s|$)|$)",
    re.IGNORECASE,
)

# Relative tokens such as ``out/report.docx`` or ``report.docx`` — a script's
# ``-o`` argument, a printed "Saved report.docx". Resolved against the cwd
# and then stat'ed, which is what keeps prose false positives out.
_RELATIVE_PATH_RE = re.compile(
    r"(?<![\w/\\.~:-])"
    r"((?:[\w\-][\w.\-]*[\\/])*[\w\-][\w.\-]*\.(?:" + _EXT_ALTERNATION + r"))"
    r"(?=[\s\"'`<>|,;:)\]}\\]|\.(?:\s|$)|$)",
    re.IGNORECASE,
)

# The end of a path in prose: an output extension followed by a boundary.
_EXT_END_RE = re.compile(
    r"\.(?:" + _EXT_ALTERNATION + r")(?=[\s\"'`<>|,;:)\]}\\]|\.(?:\s|$)|$)",
    re.IGNORECASE,
)

_PATCH_FILE_HEADER_RE = re.compile(r"^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$", re.MULTILINE)

# Characters no path in prose runs across.
_SEGMENT_STOPS = frozenset("\n\r\t\"'`<>|*?")

# Punctuation that can open a path in prose without being part of it.
_LEADING_PUNCTUATION = "([{<=:"

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


def is_secondary_output_path(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in SECONDARY_OUTPUT_EXTENSIONS


def changed_time(path: str, stat: os.stat_result) -> float:
    """When the file last came into being or changed here (not its content date).

    A file a turn extracted, downloaded or copied keeps the mtime it was
    archived with (``unzip``, ``wget``, ``cp -p``) — and on macOS the birth
    time follows that mtime back too. The inode change time does not: POSIX
    sets it on every create, write, rename or metadata change; on Windows the
    creation time plays that part. ``path`` is for tests that need a file to
    look older than the disk says.
    """
    if os.name == "nt":
        # Windows' creation time; st_ctime still means that there but is
        # deprecated in its favor from Python 3.12.
        return float(getattr(stat, "st_birthtime", None) or stat.st_ctime)
    return float(stat.st_ctime)


def created_time(path: str, stat: os.stat_result) -> Optional[float]:
    """When the file at *path* was created, where the platform records it.

    macOS / BSD and Windows (``st_birthtime`` from Python 3.12, ``st_ctime``
    before) keep a creation time; Linux exposes none through ``os.stat`` —
    ``None`` there. ``path`` is for tests, as in :func:`changed_time`.
    """
    born = getattr(stat, "st_birthtime", None)
    if born:
        return float(born)
    if os.name == "nt":
        return float(stat.st_ctime)
    return None


def _born_during(path: str, stat: os.stat_result, cutoff: float) -> Optional[bool]:
    """Whether the file was created at or after *cutoff*; ``None`` when unknowable.

    A pre-existing file a formatter rewrote in place keeps its creation time,
    which is what tells it apart from a file the turn made. Careful on macOS:
    setting an mtime older than the birth time pulls the birth time back with
    it (``unzip``, ``cp -p``, ``tar x`` all do), so a file just placed with
    its archived dates has birth == mtime, both old, while its change time is
    new. That reads as "unknown", never as "pre-existing".
    """
    born = created_time(path, stat)
    if born is None:
        return None
    if born >= cutoff:
        return True
    if os.name != "nt" and stat.st_mtime < cutoff and abs(born - stat.st_mtime) < 1.0:
        return None
    return False


def git_tracked_paths(paths: Iterable[str]) -> set[str]:
    """The *paths* git tracks (so they existed before the turn), best effort.

    One ``git ls-files`` per containing folder, bounded in folders and time,
    through the shared hardened probe (repository config cannot run code, a
    killed git cannot hang the turn). No git, no repository, a timeout or any
    error: nothing is tracked.
    """
    by_dir: dict[str, list[str]] = {}
    for path in paths:
        by_dir.setdefault(os.path.dirname(path), []).append(path)
    if not by_dir:
        return set()
    try:
        from hermes_cli._subprocess_compat import bounded_git_probe
    except Exception:
        return set()
    deadline = time.monotonic() + GIT_PROBE_BUDGET_SECONDS
    tracked: set[str] = set()
    for directory, members in list(by_dir.items())[:GIT_PROBE_MAX_DIRS]:
        left = deadline - time.monotonic()
        if left <= 0.05 or not os.path.isdir(directory):
            continue
        names = sorted({os.path.basename(member) for member in members})
        try:
            out = bounded_git_probe(
                ["git", "--literal-pathspecs", "-C", directory, "ls-files", "-z", "--", *names],
                timeout=left,
            )
        except Exception:
            continue
        for name in out.split("\0"):
            if name:
                tracked.add(os.path.normpath(os.path.join(directory, name)))
    return tracked


def _arrived_during(path: str, stat: os.stat_result, cutoff: float, parent_mtime: Optional[float] = None) -> bool:
    """Whether the file was written, or newly placed, at or after *cutoff*.

    Written: its mtime says so. Placed (extracted, downloaded, copied with
    its dates, moved in): its change time is new AND its folder gained an
    entry during the turn. The folder check keeps out files whose inode
    merely changed under a sync client or an xattr write.
    """
    if stat.st_mtime >= cutoff:
        return True
    if changed_time(path, stat) < cutoff:
        return False
    if parent_mtime is None:
        try:
            parent_mtime = os.stat(os.path.dirname(path) or ".").st_mtime
        except OSError:
            return False
    return parent_mtime >= cutoff


def _temp_roots() -> list[str]:
    roots = {tempfile.gettempdir(), "/tmp", "/var/tmp", "/var/folders"}
    for name in ("TMPDIR", "TEMP", "TMP"):
        value = os.environ.get(name)
        if value:
            roots.add(value)
    resolved: set[str] = set()
    for root in roots:
        try:
            resolved.add(os.path.normpath(os.path.abspath(root)))
            resolved.add(os.path.realpath(root))
        except (OSError, ValueError):
            continue
    return sorted(resolved)


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


def _in_build_output(path: str, roots: Iterable[str]) -> bool:
    """Whether *path* sits in a build output folder below one of *roots*.

    Only the part below the session's folder is looked at: a project that
    itself lives under ``~/build/…`` is not build output, and a path the turn
    named outside the session's folder was put there on purpose.
    """
    for root in roots:
        if not root:
            continue
        try:
            relative = Path(path).relative_to(Path(root))
        except ValueError:
            continue
        if any(part in BUILD_OUTPUT_DIR_NAMES for part in relative.parts[:-1]):
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
    """Every string reachable inside a message field, bounded in depth.

    Tool results arrive as JSON *strings* (``{"output": "…\\n…"}``): scanned
    raw, every newline is the two characters ``\\n`` and a file name at the
    end of a line is glued to a backslash. A string that parses as JSON is
    therefore walked as the structure it encodes.
    """
    if depth > 4:
        return
    if isinstance(value, str):
        stripped = value.lstrip()
        if stripped[:1] in "{[":
            try:
                parsed = json.loads(value)
            except ValueError:
                parsed = None
            if isinstance(parsed, (dict, list)):
                yield from _iter_text_fragments(parsed, depth + 1)
                return
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


class _ProbeBudget:
    """How many more existence checks the spaced-path pass may spend."""

    def __init__(self, probes: int = SPACED_MAX_PROBES) -> None:
        self.left = probes

    def take(self) -> bool:
        if self.left <= 0:
            return False
        self.left -= 1
        return True


def spaced_paths_in_text(text: str, cwd: str, budget: Optional[_ProbeBudget] = None) -> list[str]:
    """Existing files whose path, as written in *text*, contains a space.

    ``paths_in_text`` stops at whitespace, which loses the paths people (and
    Vietnamese file names) are full of: ``~/Desktop/Báo cáo tháng 11.docx``.
    For each output extension in the text, the words before it are tried as
    path starts, nearest first, and the first one that exists on disk wins.
    The disk is the arbiter, so prose ("đã lưu báo cáo.docx") costs a failed
    stat and nothing else.
    """
    if not text or " " not in text:
        return []
    budget = budget or _ProbeBudget()
    found: list[str] = []
    for match in _EXT_END_RE.finditer(text):
        end = match.end()
        start = end - 1
        floor = max(0, end - SPACED_MAX_SEGMENT)
        while start > floor and text[start - 1] not in _SEGMENT_STOPS:
            start -= 1
        segment = text[start:end]
        if " " not in segment:
            continue
        starts = [0] + [i for i in range(1, len(segment)) if segment[i - 1] == " " and segment[i] != " "]
        tried = 0
        for index in reversed(starts):
            candidate = segment[index:].lstrip(_LEADING_PUNCTUATION)
            if " " not in candidate:
                continue  # the plain pattern already covers it
            if tried >= SPACED_MAX_STARTS or not budget.take():
                break
            tried += 1
            resolved = _resolve_candidate(candidate, cwd)
            if resolved and os.path.isfile(resolved):
                if resolved not in found:
                    found.append(resolved)
                break
    return found


def candidate_paths_from_messages(
    messages: Iterable[dict],
    cwd: str,
    budget: Optional[_ProbeBudget] = None,
    from_args: Optional[set[str]] = None,
) -> list[str]:
    """Paths the turn mentioned anywhere: tool arguments, tool results, the reply.

    ``from_args``, when given, collects the ones a tool call's arguments named
    (``-o out/report.docx``) as opposed to ones only printed by a tool.
    """
    budget = budget or _ProbeBudget()
    found: list[str] = []
    seen: set[str] = set()
    for message in messages:
        if not isinstance(message, dict):
            continue
        fragments: list[tuple[str, bool]] = []
        for _name, args in _tool_call_records(message):
            fragments.extend((fragment, True) for fragment in _iter_text_fragments(args))
        for key in ("content", "text", "context"):
            fragments.extend((fragment, False) for fragment in _iter_text_fragments(message.get(key)))
        for fragment, is_args in fragments:
            for path in [*paths_in_text(fragment, cwd), *spaced_paths_in_text(fragment, cwd, budget)]:
                if is_args and from_args is not None:
                    from_args.add(path)
                if path not in seen:
                    seen.add(path)
                    found.append(path)
    return found


def edited_paths_from_messages(messages: Iterable[dict], cwd: str) -> set[str]:
    """Paths a file tool wrote in this turn (rendered as edits with a diff)."""
    edited: set[str] = set()
    for message in messages:
        if not isinstance(message, dict):
            continue
        for name, args in _tool_call_records(message):
            if name not in FILE_EDIT_TOOLS:
                continue
            targets = [args.get(key) for key in ("path", "file_path", "filepath", "file")]
            # A multi-file patch names its files inside the patch text.
            for value in args.values():
                if isinstance(value, str) and "*** " in value:
                    targets.extend(_PATCH_FILE_HEADER_RE.findall(value))
            for value in targets:
                if isinstance(value, str) and value.strip():
                    resolved = _resolve_candidate(value, cwd)
                    if resolved:
                        edited.add(resolved)
                        edited.add(os.path.realpath(resolved))
    return edited


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
    """Deliverable files under *root* written or created at or after *since*, bounded.

    Breadth-first so shallow deliverables (``report.docx`` next to the
    project) are found before the budget runs out on a deep tree. A file
    extracted or downloaded during the turn keeps an old mtime but has a new
    change time (see :func:`changed_time`).
    """
    if not root or not os.path.isdir(root):
        return []
    deadline = clock() + budget_seconds
    visited = 0
    found: list[str] = []
    queue: deque[tuple[str, int]] = deque([(root, 0)])
    cutoff = since - MODIFIED_SLACK_SECONDS
    while queue:
        directory, depth = queue.popleft()
        try:
            directory_mtime = os.stat(directory).st_mtime
        except OSError:
            continue
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    visited += 1
                    if visited > max_entries or clock() > deadline:
                        return found
                    name = entry.name
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if depth < max_depth and not name.startswith(".") and name not in WALK_EXCLUDED_DIR_NAMES:
                                queue.append((entry.path, depth + 1))
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        if not is_deliverable_path(name):
                            continue
                        stat = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if stat.st_size <= 0:
                        continue
                    if not _arrived_during(entry.path, stat, cutoff, directory_mtime):
                        continue
                    found.append(entry.path)
        except OSError:
            continue
    return found


# A folder the turn named ("unzip x.zip -d tai-lieu", "saved everything to
# ~/Desktop/out") stands in for the files it did not name one by one. Only
# its direct children are read: a named folder is often a busy one (Desktop,
# Downloads), and a deeper look would pick up whatever else lives there.
NAMED_DIR_LIMIT = 12
NAMED_DIR_MAX_ENTRIES = 400
# Distinct candidate words stat'ed per turn while looking for named folders.
NAMED_DIR_MAX_PROBES = 256

_ABSOLUTE_TOKEN_RE = re.compile(r"(?<![\w:/\\.-])((?:~|/|[A-Za-z]:[\\/])[^\s\"'`<>|*?\[\]{}]+)")


def named_directories(messages: Iterable[dict], cwd: str, final_text: str = "") -> list[str]:
    """Existing folders the turn's commands or reply named, nearest-first, bounded.

    Absolute paths anywhere in the turn's text; relative ones only as shell
    words of a tool command (``-d tai-lieu``), resolved against *cwd*. The
    session's own folder, its ancestors and the filesystem root are not
    "named" — the workspace walk owns the first, and the others are too big
    to stand for anything.
    """
    def absolute_tokens(texts: Iterable[str]) -> list[str]:
        return [m.group(1) for text in texts for m in _ABSOLUTE_TOKEN_RE.finditer(text)]

    # Most telling first, since the probe budget can run out: what the reply
    # handed over, then what commands were told, then what tools printed.
    reply_tokens = absolute_tokens([final_text] if final_text else [])
    command_tokens: list[str] = []
    command_words: list[str] = []
    printed: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        for name, args in _tool_call_records(message):
            # A file tool's arguments are a file body or a patch, not a
            # command: thousands of words, none of them a folder it named.
            if name in FILE_EDIT_TOOLS:
                continue
            for fragment in _iter_text_fragments(args):
                command_tokens.extend(absolute_tokens([fragment]))
                command_words.extend(w for w in fragment.split() if not w.startswith("-") and len(w) < 200)
        for key in ("content", "text"):
            printed.extend(absolute_tokens(_iter_text_fragments(message.get(key))))
    tokens = [*reply_tokens, *command_tokens, *command_words, *printed]

    home = os.path.realpath(os.path.expanduser("~"))
    base = os.path.realpath(cwd) if cwd else ""
    found: list[str] = []
    probed: set[str] = set()
    for token in tokens:
        if len(found) >= NAMED_DIR_LIMIT or len(probed) >= NAMED_DIR_MAX_PROBES:
            break
        resolved = _resolve_candidate(token.rstrip(".,;:)]}"), cwd)
        # Every distinct candidate costs one stat (a round trip on a network
        # drive); a command output listing thousands of paths must not.
        if not resolved or resolved in probed:
            continue
        probed.add(resolved)
        if not os.path.isdir(resolved):
            continue
        real = os.path.realpath(resolved)
        if real in (home, os.path.realpath(os.sep), base) or (base and _under_any(base, [real])):
            continue
        found.append(resolved)
    return found


def files_arrived_in(directory: str, cutoff: float) -> list[str]:
    """Direct children of *directory* that are deliverables and arrived after *cutoff*."""
    try:
        directory_mtime = os.stat(directory).st_mtime
    except OSError:
        return []
    if directory_mtime < cutoff:
        return []  # nothing was added, renamed or removed here this turn
    found: list[str] = []
    try:
        with os.scandir(directory) as entries:
            for index, entry in enumerate(entries):
                if index >= NAMED_DIR_MAX_ENTRIES:
                    break
                try:
                    if not entry.is_file(follow_symlinks=False) or not is_deliverable_path(entry.name):
                        continue
                    stat = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if stat.st_size > 0 and _arrived_during(entry.path, stat, cutoff, directory_mtime):
                    found.append(entry.path)
    except OSError:
        return []
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
    """The files this turn produced, newest first, capped at *limit*.

    ``new_messages`` are the conversation rows the turn appended (assistant
    text, tool calls, tool results). ``workspace_root`` enables the bounded
    walk and should only be the session's explicit workspace — never a
    launch directory such as ``$HOME``. ``excluded_roots`` (the AgentX home)
    are never reported.

    What counts:

    * a deliverable (document, sheet, image …) the turn named, the walk
      found, or that arrived directly inside a folder the turn named,
      written or placed there during the turn;
    * a data / config / script file (``SECONDARY_OUTPUT_EXTENSIONS``) only
      when the turn named it, no file tool wrote it (that edit already shows
      as a diff), and it is new to the turn: not tracked by git, and created
      during the turn where the platform keeps a creation time. Where it does
      not (Linux, or a macOS file placed with its archived dates), the reply
      must name it — a ``git status`` listing or a formatter's output naming
      a pre-existing ``src/a.py`` is not a hand-over;
    * nothing inside a build output folder of the session's folder
      (``dist/``, ``build/`` …) that only a tool printed: the reply has to
      name it or its folder, or a command has to have named the file itself;
    * nothing in the temp folder (outside the session's own folder) unless
      the reply names it — that is where models keep their scratch renders
      and checks;
    * once the model has handed files over with ``deliver_file``, only the
      other files its reply names: the hand-over is its own account of what
      the turn produced, and the rest are working files.
    """
    messages = [m for m in new_messages if isinstance(m, dict)]
    budget = _ProbeBudget()
    named_in_args: set[str] = set()
    named = candidate_paths_from_messages(messages, cwd, budget, named_in_args)
    final_paths: list[str] = []
    if final_text:
        final_paths = [*paths_in_text(final_text, cwd), *spaced_paths_in_text(final_text, cwd, budget)]
        for path in final_paths:
            if path not in named:
                named.append(path)
    named_set = set(named)
    walked: list[str] = []
    if workspace_root:
        walked = [path for path in scan_workspace(workspace_root, started_at) if path not in named_set]
    for directory in named_directories(messages, cwd, final_text):
        for path in files_arrived_in(directory, started_at - MODIFIED_SLACK_SECONDS):
            if path not in named_set and path not in walked:
                walked.append(path)

    delivered = delivered_paths_from_messages(messages, cwd)
    edited = edited_paths_from_messages(messages, cwd)
    excluded = [os.path.normpath(os.path.abspath(os.path.expanduser(r))) for r in excluded_roots if r]
    temp_roots = _temp_roots()
    # The session's own folders are never "scratch", even when they live
    # under the temp folder themselves.
    workspace = [r for root in (workspace_root, cwd) if root for r in (root, os.path.realpath(root))]
    mentioned_in_reply = set(final_paths) | {os.path.realpath(p) for p in final_paths}
    if not final_paths:
        # The reply row is among the messages when final_text is not passed.
        for message in messages:
            if message.get("role") == "assistant" and isinstance(message.get("content"), str):
                for path in paths_in_text(message["content"], cwd) + spaced_paths_in_text(
                    message["content"], cwd, budget
                ):
                    mentioned_in_reply.update((path, os.path.realpath(path)))
    # "Extracted into /tmp/x" names the folder, and that is the hand-over.
    reply_dirs = {r for d in named_directories([], cwd, final_text) for r in (d, os.path.realpath(d))}
    cutoff = started_at - MODIFIED_SLACK_SECONDS

    records: list[tuple[float, dict[str, Any]]] = []
    # Script / data files waiting on the git check: (produced, record, path).
    secondary_records: list[tuple[float, dict[str, Any], str]] = []
    seen_real: set[str] = set()
    for path in [*named, *walked]:
        was_named = path in named_set
        secondary = is_secondary_output_path(path)
        if not (is_deliverable_path(path) or (secondary and was_named)):
            continue
        if _has_excluded_segment(path) or path in delivered or _under_any(path, excluded):
            continue
        real = os.path.realpath(path)
        if real in delivered or real in seen_real:
            continue
        if secondary and (path in edited or real in edited):
            continue
        try:
            stat = os.stat(path)
        except OSError:
            continue
        record = describe_file(path)
        if record is None:
            continue
        if not _arrived_during(path, stat, cutoff):
            continue
        produced = max(stat.st_mtime, changed_time(path, stat))
        in_reply = (
            path in mentioned_in_reply
            or real in mentioned_in_reply
            or os.path.dirname(path) in reply_dirs
            or os.path.dirname(real) in reply_dirs
        )
        if not in_reply:
            if delivered:
                continue
            if (_under_any(path, temp_roots) or _under_any(real, temp_roots)) and not (
                _under_any(path, workspace) or _under_any(real, workspace)
            ):
                continue
            if path not in named_in_args and (
                _in_build_output(path, workspace) or _in_build_output(real, workspace)
            ):
                continue
        if secondary:
            born = _born_during(path, stat, cutoff)
            if born is False or (born is None and not in_reply):
                continue
            seen_real.add(real)
            secondary_records.append((produced, record, path))
            continue
        seen_real.add(real)
        records.append((produced, record))

    if secondary_records:
        tracked = git_tracked_paths(path for _produced, _record, path in secondary_records)
        records.extend((produced, record) for produced, record, path in secondary_records if path not in tracked)

    records.sort(key=lambda item: item[0], reverse=True)
    return [record for _produced, record in records[:limit]]


# Rows the desktop shows as timeline events, not as a user or assistant
# message (see toChatMessages in apps/desktop/src/lib/chat-messages.ts).
_EVENT_DISPLAY_KINDS = frozenset({"model_switch", "async_delegation_complete", "auto_continue", "compaction", "hidden"})


def branch_cut_index(history: list[dict], count: int) -> int:
    """Where to cut *history* to branch at the client's *count*-th message.

    The desktop counts the messages it shows: each user prompt, and each
    assistant turn as ONE message however many rows it took (a tool call, its
    result, the text before and after). The history holds every one of those
    rows. Cutting it at *count* rows dropped the later turns — and the files
    they produced — of any conversation that used a tool. The cut lands right
    after the *count*-th shown message: after the prompt, or after the whole
    assistant turn.
    """

    def text_of(message: dict) -> str:
        content = message.get("content")
        return content if isinstance(content, str) else (json.dumps(content) if content else "")

    def shown(message: Any, roles: tuple[str, ...]) -> bool:
        return (
            isinstance(message, dict)
            and message.get("role") in roles
            and message.get("display_kind") not in _EVENT_DISPLAY_KINDS
        )

    seen = 0
    index = 0
    while index < len(history):
        message = history[index]
        if shown(message, ("user",)) and text_of(message).strip():
            seen += 1
            if seen >= count:
                return index + 1
            index += 1
        elif shown(message, ("assistant", "tool")):
            end = index
            has_text = False
            while end < len(history) and shown(history[end], ("assistant", "tool")):
                has_text = has_text or (history[end].get("role") == "assistant" and bool(text_of(history[end]).strip()))
                end += 1
            if has_text:
                seen += 1
                if seen >= count:
                    return end
            index = end
        else:
            index += 1
    return len(history)


def branch_cut_at_user_turn(history: list[dict], user_ordinal: int, include_reply: bool) -> Optional[int]:
    """Where to cut *history* to branch at a message the client addressed by user turn.

    A message count is ambiguous: while a reply streams, the desktop shows a
    turn that used tools as an interim bubble plus the answer — two messages
    where the history (and the reloaded transcript) hold one turn — so a
    count taken from a live chat cut one turn too late. A user turn's ordinal
    is not: ``user_ordinal`` counts user rows the way ``prompt.submit``'s
    rewind does (``truncate_before_user_ordinal``: role ``user``, no
    ``display_kind``), the same turns the desktop numbers, compaction offsets
    included.

    ``include_reply`` False cuts right after that prompt; True keeps its whole
    reply, up to the next prompt (``user_ordinal`` -1 then addresses a reply
    that came before any prompt). ``None`` when the ordinal is out of range.
    """
    users = [
        index
        for index, message in enumerate(history)
        if isinstance(message, dict) and message.get("role") == "user" and not message.get("display_kind")
    ]
    if not include_reply:
        if not 0 <= user_ordinal < len(users):
            return None
        return users[user_ordinal] + 1
    if not -1 <= user_ordinal < len(users):
        return None
    cut = users[user_ordinal + 1] if user_ordinal + 1 < len(users) else len(history)
    # Notices that lead into the next prompt (a model switch) are not part of
    # this reply.
    floor = users[user_ordinal] + 1 if user_ordinal >= 0 else 0
    while cut > floor:
        message = history[cut - 1]
        if isinstance(message, dict) and message.get("role") == "user" and message.get("display_kind"):
            cut -= 1
            continue
        break
    return cut


def branch_seed_rows(history: Iterable[dict]) -> list[dict]:
    """The rows a branch stores for its copied history.

    A branch keeps the conversation text and drops the tool traffic: cutting
    a copy mid tool exchange (``/branch`` at an earlier message) must never
    leave the model a call without its result. What it must not drop is what
    the person was handed. A file handed over with ``deliver_file`` lived in
    that tool traffic, so it is folded into its turn's reply as
    ``files_created`` — the copy then shows it the way any other produced
    file shows — and every row keeps its presentation fields
    (``display_kind`` / ``display_metadata``) so the files the original turn
    listed, compaction dividers and reactions survive the copy too.
    """
    rows: list[dict] = []
    pending: list[dict] = []
    reply_index: Optional[int] = None

    def flush() -> None:
        nonlocal pending, reply_index
        if pending and reply_index is not None:
            row = rows[reply_index]
            metadata = dict(row.get("display_metadata") or {})
            listed = list(metadata.get("files_created") or [])
            known = {record.get("path") for record in listed if isinstance(record, dict)}
            listed.extend(record for record in pending if record["path"] not in known)
            metadata["files_created"] = listed
            row["display_metadata"] = metadata
        pending = []
        reply_index = None

    for message in history:
        if not isinstance(message, dict):
            continue
        role = message.get("role", "user")
        if role == "user":
            flush()
        if role == "tool" and (message.get("name") or message.get("tool_name")) == "deliver_file":
            record = _delivered_record(message.get("content"))
            if record is not None:
                pending.append(record)
        row: dict[str, Any] = {
            "role": role,
            "content": message.get("content"),
            # The parent's timestamps: a copy is history, not new activity.
            "timestamp": message.get("timestamp"),
        }
        for key in ("display_kind", "display_metadata"):
            if message.get(key):
                row[key] = message[key]
        rows.append(row)
        if role == "assistant" and isinstance(message.get("content"), str) and message["content"].strip():
            reply_index = len(rows) - 1
    flush()
    return rows


def _delivered_record(content: Any) -> Optional[dict[str, Any]]:
    """A ``files_created`` record for one ``deliver_file`` result, or ``None``."""
    payload: Any = content
    if isinstance(content, str):
        try:
            payload = json.loads(content)
        except ValueError:
            return None
    if not isinstance(payload, dict) or not isinstance(payload.get("path"), str) or payload.get("success") is False:
        return None
    path = payload["path"]
    record = describe_file(path)
    if record is not None:
        return record
    # Gone since: still worth a row that says so when opened.
    return {
        "path": path,
        "name": str(payload.get("name") or os.path.basename(path)),
        "size_bytes": int(payload.get("size_bytes") or 0),
        "mime_type": str(payload.get("mime_type") or mime_type_for(path)),
        "modified_at": 0.0,
        "kind": deliverable_kind(path) or "file",
    }
