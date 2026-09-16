#!/usr/bin/env python3
"""Hand a finished file to the person in the AgentX desktop app.

The desktop chat renders this tool's result as a file card — icon, name, size,
"Xem" / "Tải xuống" / "Hiện trong Finder" — the way Claude desktop or Codex
present a produced document, instead of a bare path the person has to go and
find on disk.

Gated on ``AGENTX_DESKTOP`` (like ``open_preview`` / ``react_to_message``) so
it costs nothing on every other surface: messaging platforms already deliver
files natively through ``MEDIA:`` tags, and the CLI has no attachment channel.

The tool never moves, copies, or reads the file's bytes. It validates that the
path names a real, readable, non-empty regular file outside the credential /
system denylist shared with gateway media delivery, and returns the file's
identity (absolute path, name, size, MIME type) for the renderer. Delivery to
the screen happens through the ordinary ``tool.complete`` event.
"""

import json
import mimetypes
import os
import time
from typing import Optional

from tools.registry import registry, tool_error
from utils import env_var_enabled

# Ceiling on what the desktop hands over as a single card. There is no
# transport limit (previews and copies go through Electron on the same
# machine); this only stops a runaway build artifact from being "delivered"
# by mistake.
MAX_DELIVER_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB

# A caption is one line under the file name, not a second reply.
MAX_CAPTION_CHARS = 200

# Office and data types that Python's mimetypes table misses on some hosts.
# Kept explicit so a .docx never shows up as ``application/octet-stream``.
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


def mime_type_for(path: str) -> str:
    """Best-effort MIME type for *path*, never empty."""
    ext = os.path.splitext(path)[1].lower()
    if ext in _EXTRA_MIME_TYPES:
        return _EXTRA_MIME_TYPES[ext]
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


def _absolute_path(raw: str) -> str:
    """Expand ``~`` and anchor a relative path on the session's working directory.

    Tools run with the session cwd exported as ``TERMINAL_CWD``; a model that
    hands back ``report.docx`` means the file it just wrote there, not one
    relative to wherever the gateway process happens to live.
    """
    expanded = os.path.expanduser(raw)
    if os.path.isabs(expanded):
        return os.path.normpath(expanded)
    base = os.getenv("TERMINAL_CWD") or os.getcwd()
    return os.path.normpath(os.path.join(base, expanded))


def _safe_delivery_path(absolute: str) -> Optional[str]:
    """Return the resolved path when the gateway's media denylist allows it.

    Reuses ``validate_media_delivery_path`` so the desktop refuses exactly the
    files messaging platforms refuse (``~/.ssh``, ``/etc``, the AgentX
    credential stores, …). Imported lazily: ``gateway.platforms.base`` is a
    heavy module and this tool only runs on the desktop.
    """
    from gateway.platforms.base import validate_media_delivery_path

    return validate_media_delivery_path(absolute)


def deliver_file_tool(path: str, caption: str = "") -> str:
    """Validate *path* and describe it for the desktop's file card."""
    raw = (path or "").strip().strip("`\"'")
    if not raw:
        return tool_error("path is required — the absolute path of the file you created for the user.")

    absolute = _absolute_path(raw)

    if not os.path.exists(absolute):
        return tool_error(
            f"No file at {absolute}. Create it first (write_file or a script), then deliver it."
        )
    if os.path.isdir(absolute):
        return tool_error(
            f"{absolute} is a folder. Deliver one file at a time — zip a folder first if the "
            "user needs all of it."
        )
    if not os.path.isfile(absolute):
        return tool_error(f"{absolute} is not a regular file.")

    resolved = _safe_delivery_path(absolute)
    if not resolved:
        return tool_error(
            f"{absolute} cannot be delivered: it sits in a credential or system location. "
            "Copy the content the user needs into a new file in the workspace instead."
        )

    try:
        stat = os.stat(resolved)
    except OSError as exc:
        return tool_error(f"Could not read {resolved}: {exc}")

    if stat.st_size <= 0:
        return tool_error(f"{resolved} is empty — write its content before delivering it.")
    if stat.st_size > MAX_DELIVER_BYTES:
        return tool_error(
            f"{resolved} is {stat.st_size} bytes, above the {MAX_DELIVER_BYTES}-byte delivery "
            "ceiling. Split or compress it first."
        )
    if not os.access(resolved, os.R_OK):
        return tool_error(f"{resolved} is not readable.")

    clean_caption = " ".join((caption or "").split())[:MAX_CAPTION_CHARS]

    return json.dumps(
        {
            "success": True,
            "delivered": True,
            "path": resolved,
            "name": os.path.basename(resolved),
            "size_bytes": stat.st_size,
            "mime_type": mime_type_for(resolved),
            "modified_at": stat.st_mtime,
            "caption": clean_caption,
            "delivered_at": time.time(),
            # Steers the reply: the card already carries the path, the name,
            # and the download — repeating them in prose is noise.
            "note": (
                "The user now sees this file as a card with preview and download. "
                "Do not repeat the path or add a MEDIA: tag for it; just tell them what it contains."
            ),
        },
        ensure_ascii=False,
    )


def check_deliver_file_requirements() -> bool:
    """Desktop GUI only — AGENTX_DESKTOP is set on the gateway the app spawns."""
    return env_var_enabled("AGENTX_DESKTOP")


DELIVER_FILE_SCHEMA = {
    "name": "deliver_file",
    "description": (
        "Hand a file you produced to the user. In the AgentX desktop app the file "
        "appears in the chat as a card the user can open in the preview pane, save, "
        "or reveal in their file manager — call this whenever a task ends in a "
        "document, spreadsheet, presentation, PDF, image, archive, or any other file "
        "the user asked for (one call per file), right after the file is written and "
        "verified. Do not use it for source files you edited as part of a coding "
        "task; those are already shown as changed files. Pass the ABSOLUTE path. "
        "After delivering, describe the content in one or two sentences and do not "
        "paste the path again."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute path of the finished file (e.g. /Users/me/Documents/report.docx).",
            },
            "caption": {
                "type": "string",
                "description": (
                    "Optional one-line description shown under the file name "
                    "(e.g. 'Q3 sales summary, 4 pages'). Keep it under 200 characters."
                ),
            },
        },
        "required": ["path"],
    },
}


registry.register(
    name="deliver_file",
    toolset="terminal",
    schema=DELIVER_FILE_SCHEMA,
    handler=lambda args, **kw: deliver_file_tool(
        path=args.get("path", ""), caption=args.get("caption", "")
    ),
    check_fn=check_deliver_file_requirements,
    emoji="📎",
)
