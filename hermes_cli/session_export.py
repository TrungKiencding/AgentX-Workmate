"""Shared renderers for session export commands.

The CLI, dashboard, and slash-command surfaces all deal with the same
session-shaped data: a session dict with a ``messages`` list. Keep filtering
and human-readable rendering here so each surface only has to load sessions
and write bytes.
"""

from __future__ import annotations

from datetime import datetime, timezone
from html import escape as html_escape
import json
import re
from typing import (
    AbstractSet,
    Any,
    Dict,
    Iterable,
    Iterator,
    List,
    Literal,
    Optional,
    Tuple,
)


ExportFormat = Literal["jsonl", "markdown"]
ExportOnly = Literal["user-prompts"]


def normalize_export_format(fmt: str) -> ExportFormat:
    """Return the canonical export format name."""
    value = (fmt or "jsonl").strip().lower()
    if value == "md":
        value = "markdown"
    if value not in {"jsonl", "markdown"}:
        raise ValueError(f"Unsupported session export format: {fmt}")
    return value  # type: ignore[return-value]


def normalize_export_only(only: Optional[str]) -> Optional[ExportOnly]:
    """Return the canonical export filter name."""
    if only is None:
        return None
    value = only.strip().lower()
    if value in {"user", "prompts", "user-prompts", "user_prompts"}:
        return "user-prompts"
    raise ValueError(f"Unsupported session export filter: {only}")


def render_sessions_export(
    sessions: Iterable[Dict[str, Any]],
    *,
    fmt: str = "jsonl",
    only: Optional[str] = None,
) -> str:
    """Render exported sessions in a stable, reusable format.

    ``fmt=jsonl`` with no filter intentionally preserves the legacy shape:
    one full session object per line. ``only=user-prompts`` switches the unit
    of export to one prompt record per line so the output is easy to pipe into
    review, memory-ingestion, or prompt-library tooling.
    """
    session_list = list(sessions)
    export_format = normalize_export_format(fmt)
    export_only = normalize_export_only(only)

    if export_format == "jsonl":
        return _render_jsonl(session_list, only=export_only)
    return _render_markdown(session_list, only=export_only)


def export_record_count(
    sessions: Iterable[Dict[str, Any]], *, only: Optional[str] = None
) -> Tuple[int, str]:
    """Return ``(count, noun)`` for status messages after an export."""
    session_list = list(sessions)
    export_only = normalize_export_only(only)
    if export_only == "user-prompts":
        return sum(1 for _ in iter_user_prompt_records(session_list)), "prompt"
    return len(session_list), "session"


def iter_user_prompt_records(
    sessions: Iterable[Dict[str, Any]]
) -> Iterator[Dict[str, Any]]:
    """Yield one normalized record for each user-authored prompt."""
    for session in sessions:
        session_id = str(session.get("id") or session.get("session_id") or "")
        index = 0
        for message in _messages(session):
            if message.get("role") != "user":
                continue
            index += 1
            record: Dict[str, Any] = {
                "session_id": session_id,
                "index": index,
                "created_at": _format_timestamp(message.get("timestamp")),
                "role": "user",
                "text": _message_text(message.get("content")),
            }
            message_id = message.get("id")
            if message_id is not None:
                record["message_id"] = message_id
            event_id = message.get("platform_message_id") or message.get("event_id")
            if event_id:
                record["event_id"] = event_id
            yield record


def _render_jsonl(
    sessions: List[Dict[str, Any]], *, only: Optional[ExportOnly]
) -> str:
    if only == "user-prompts":
        rows = iter_user_prompt_records(sessions)
    else:
        rows = iter(sessions)
    lines = [json.dumps(row, ensure_ascii=False) for row in rows]
    return ("\n".join(lines) + "\n") if lines else ""


def _render_markdown(
    sessions: List[Dict[str, Any]], *, only: Optional[ExportOnly]
) -> str:
    if only == "user-prompts":
        return _render_user_prompts_markdown(sessions)
    return _render_full_markdown(sessions)


def _render_user_prompts_markdown(sessions: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    if len(sessions) == 1:
        session = sessions[0]
        lines.append(f"# User prompts for session {_heading_text(_session_id(session))}")
        lines.extend(_session_metadata_lines(session))
        lines.append("")
        _append_prompt_records(lines, session, heading_level=2)
    else:
        lines.append("# User prompts export")
        lines.append("")
        for session in sessions:
            lines.append(f"## Session {_heading_text(_session_id(session))}")
            lines.extend(_session_metadata_lines(session))
            lines.append("")
            _append_prompt_records(lines, session, heading_level=3)
    if not sessions:
        lines.append("_No user prompts found._")
        lines.append("")
    return _finish_markdown(lines)


def _append_prompt_records(
    lines: List[str], session: Dict[str, Any], *, heading_level: int
) -> None:
    prompts = list(iter_user_prompt_records([session]))
    if not prompts:
        lines.append("_No user prompts found._")
        lines.append("")
        return
    marker = "#" * heading_level
    for prompt in prompts:
        timestamp = prompt.get("created_at") or "timestamp unavailable"
        lines.append(f"{marker} {prompt['index']}. {timestamp}")
        message_id = prompt.get("message_id")
        if message_id is not None:
            lines.append(f"Message ID: `{message_id}`")
            lines.append("")
        lines.append(str(prompt.get("text") or ""))
        lines.append("")


def _render_full_markdown(sessions: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    if len(sessions) == 1:
        session = sessions[0]
        lines.append(f"# Session: {_heading_text(_session_title_or_id(session))}")
        lines.extend(_session_metadata_lines(session))
        lines.append("")
        _append_session_messages(lines, session, heading_level=2)
    else:
        lines.append("# AgentX sessions export")
        lines.append("")
        for session in sessions:
            lines.append(f"## Session: {_heading_text(_session_title_or_id(session))}")
            lines.extend(_session_metadata_lines(session))
            lines.append("")
            _append_session_messages(lines, session, heading_level=3)
    return _finish_markdown(lines)


def _append_session_messages(
    lines: List[str], session: Dict[str, Any], *, heading_level: int
) -> None:
    marker = "#" * heading_level
    visible_messages = [
        message for message in _messages(session) if message.get("role") != "system"
    ]
    if not visible_messages:
        lines.append("_No messages found._")
        lines.append("")
        return

    for message in visible_messages:
        role = str(message.get("role") or "unknown")
        timestamp = _format_timestamp(message.get("timestamp"))
        suffix = f" - {timestamp}" if timestamp else ""
        if role == "tool":
            tool_name = str(message.get("tool_name") or message.get("name") or "tool")
            lines.append(f"{marker} Tool: {_heading_text(tool_name)}{suffix}")
            lines.append("")
            lines.append(f"<details><summary>{html_escape(tool_name)}</summary>")
            lines.append("")
            lines.append(_fenced_text(_message_text(message.get("content"))))
            lines.append("")
            lines.append("</details>")
            lines.append("")
            continue

        label = {
            "user": "User",
            "assistant": "Assistant",
        }.get(role, role.title())
        lines.append(f"{marker} {label}{suffix}")
        lines.append("")
        lines.append(_message_text(message.get("content")))
        lines.append("")


def _messages(session: Dict[str, Any]) -> List[Dict[str, Any]]:
    messages = session.get("messages") or []
    return [message for message in messages if isinstance(message, dict)]


def _message_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [_content_part_text(part) for part in content]
        return "\n".join(part for part in parts if part)
    if isinstance(content, dict):
        for key in ("text", "content"):
            value = content.get(key)
            if isinstance(value, str):
                return value
        return json.dumps(content, ensure_ascii=False, sort_keys=True)
    return str(content)


def _content_part_text(part: Any) -> str:
    if isinstance(part, str):
        return part
    if isinstance(part, dict):
        for key in ("text", "content"):
            value = part.get(key)
            if isinstance(value, str):
                return value
        return json.dumps(part, ensure_ascii=False, sort_keys=True)
    return str(part)


def _format_timestamp(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return (
            datetime.fromtimestamp(float(value), tz=timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z")
        )
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace(
            "+00:00", "Z"
        )
    return str(value)


def _session_metadata_lines(session: Dict[str, Any]) -> List[str]:
    lines: List[str] = [f"- Session ID: `{_session_id(session)}`"]
    source = session.get("source")
    if source:
        lines.append(f"- Source: `{source}`")
    model = session.get("model")
    if model:
        lines.append(f"- Model: `{model}`")
    title = session.get("title")
    if title:
        lines.append(f"- Title: {_inline_text(str(title))}")
    started = _format_timestamp(session.get("started_at"))
    if started:
        lines.append(f"- Started: {started}")
    message_count = session.get("message_count")
    if message_count is not None:
        lines.append(f"- Messages: {message_count}")
    return lines


def _session_id(session: Dict[str, Any]) -> str:
    return str(session.get("id") or session.get("session_id") or "unknown")


def _session_title_or_id(session: Dict[str, Any]) -> str:
    title = str(session.get("title") or "").strip()
    return title or _session_id(session)


def _heading_text(value: str) -> str:
    return " ".join(str(value).splitlines()).strip() or "unknown"


def _inline_text(value: str) -> str:
    return " ".join(value.splitlines()).strip()


def _fenced_text(text: str, *, language: str = "text") -> str:
    fence = "```"
    while fence in text:
        fence += "`"
    return f"{fence}{language}\n{text}\n{fence}"


def _finish_markdown(lines: List[str]) -> str:
    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Data Hub results stay in Workmate (Data Hub plan D2.8, §9.3 #22).
#
# The hub's ``agentx-data`` server returns passages from the organisation's
# documents. The hub cannot take back a passage it returned, so a session
# that holds one is never exported — on any surface — and the export paths
# share this one predicate.
# ---------------------------------------------------------------------------

#: The hub server (gateway ``ref``) whose results may only be read in Workmate.
DATA_HUB_SERVER_REF = "agentx-data"

# A hub server becomes the ``mcp_servers`` entry ``agentx-<slug>`` (hub_sync
# ``gateway_entry_name``), whose tools are ``mcp__agentx_agentx_data__<tool>``;
# a second entry for the same server carries a numeric suffix.
_DATA_HUB_TOOL_RE = re.compile(r"^mcp__agentx_agentx_data(?:_\d+)?__\w+$")
_MCP_NAME_UNSAFE_RE = re.compile(r"[^A-Za-z0-9_]")

_DATA_HUB_EXPORT_REFUSAL = {
    "vi": (
        "Phiên này có kết quả từ Data Hub — chỉ được đọc trong Workmate, "
        "nên không xuất được."
    ),
    "en": (
        "This session contains Data Hub results, which may only be read in "
        "Workmate; exporting is blocked."
    ),
}
_DATA_HUB_EXPORT_SKIPPED = {
    "vi": "Đã bỏ qua {count} phiên có kết quả từ Data Hub (chỉ được đọc trong Workmate).",
    "en": "Left out {count} session(s) containing Data Hub results (they may only be read in Workmate).",
}


class DataHubExportRefused(Exception):
    """An export of a session that holds a Data Hub result."""

    def __init__(self) -> None:
        super().__init__(data_hub_export_refusal())


def _message_language() -> str:
    """``en`` when the display language is English, else Vietnamese (the shipped default)."""
    try:
        from agent.i18n import get_language

        return "en" if get_language() == "en" else "vi"
    except Exception:
        return "vi"


def data_hub_export_refusal() -> str:
    """Why an export of a session with a Data Hub result is refused."""
    return _DATA_HUB_EXPORT_REFUSAL[_message_language()]


def data_hub_export_skipped(count: int) -> str:
    """What a bulk export says about the sessions it left out."""
    return _DATA_HUB_EXPORT_SKIPPED[_message_language()].format(count=count)


def data_hub_server_keys(mcp_servers: Any = None) -> frozenset:
    """The ``mcp_servers`` keys whose entry reaches the hub's Data Hub server.

    Told by the entry's gateway ref (``hub_sync.gateway_server_of``), not by
    its name. *mcp_servers* defaults to the active profile's config.
    """
    if mcp_servers is None:
        try:
            from hermes_cli.config import load_config_readonly

            mcp_servers = (load_config_readonly() or {}).get("mcp_servers")
        except Exception:
            mcp_servers = None
    if not isinstance(mcp_servers, dict):
        return frozenset()
    from hermes_cli.hub_sync import gateway_server_of

    return frozenset(
        str(name)
        for name, cfg in mcp_servers.items()
        if gateway_server_of(cfg) == DATA_HUB_SERVER_REF
    )


def is_data_hub_tool_name(
    name: Any, server_keys: Optional[AbstractSet[str]] = None
) -> bool:
    """Whether *name* is a tool of a Data Hub server.

    The default entry's tool family always counts; *server_keys* (see
    :func:`data_hub_server_keys`) adds the entries the config names
    differently. Pass them when testing many names.
    """
    if not isinstance(name, str) or not name.startswith("mcp__"):
        return False
    if _DATA_HUB_TOOL_RE.match(name):
        return True
    keys = data_hub_server_keys() if server_keys is None else server_keys
    return any(
        name.startswith(f"mcp__{_MCP_NAME_UNSAFE_RE.sub('_', key)}__")
        for key in keys
    )


def is_data_hub_server_key(
    name: Any, server_keys: Optional[AbstractSet[str]] = None
) -> bool:
    """Whether the ``mcp_servers`` key *name* reaches the Data Hub server: by
    gateway ref (*server_keys*), or as the default entry's name."""
    return is_data_hub_tool_name(
        f"mcp__{_MCP_NAME_UNSAFE_RE.sub('_', str(name))}__tool", server_keys
    )


def _call_names(tool_calls: Any) -> Iterator[Tuple[str, str]]:
    """``(id, name)`` of each call in an assistant message's ``tool_calls``."""
    if isinstance(tool_calls, str):
        try:
            tool_calls = json.loads(tool_calls)
        except ValueError:
            return
    if not isinstance(tool_calls, list):
        return
    for call in tool_calls:
        if not isinstance(call, dict):
            continue
        function = call.get("function") if isinstance(call.get("function"), dict) else {}
        name = function.get("name") or call.get("name")
        call_id = call.get("id") or call.get("call_id")
        if isinstance(name, str) and isinstance(call_id, str):
            yield call_id, name


def session_has_data_hub_result(
    session: Any, *, server_keys: Optional[AbstractSet[str]] = None
) -> bool:
    """Whether *session* (a session dict with ``messages``, or a message list)
    holds a result of a Data Hub tool.

    A result is a ``tool`` message: named by its ``tool_name``, or by the
    assistant call it answers when the row carries no name.
    """
    messages = session.get("messages") if isinstance(session, dict) else session
    if not isinstance(messages, list) or not messages:
        return False
    keys = data_hub_server_keys() if server_keys is None else server_keys
    called: Dict[str, str] = {}
    for message in messages:
        if isinstance(message, dict) and message.get("role") == "assistant":
            called.update(_call_names(message.get("tool_calls")))
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "tool":
            continue
        names = (
            message.get("tool_name"),
            message.get("name"),
            called.get(str(message.get("tool_call_id") or "")),
        )
        if any(is_data_hub_tool_name(name, keys) for name in names):
            return True
    return False


def ensure_session_exportable(
    session: Any, *, server_keys: Optional[AbstractSet[str]] = None
) -> None:
    """Raise :class:`DataHubExportRefused` for a session with a Data Hub result."""
    if session_has_data_hub_result(session, server_keys=server_keys):
        raise DataHubExportRefused()


def partition_exportable_sessions(
    sessions: Iterable[Any], *, server_keys: Optional[AbstractSet[str]] = None
) -> Tuple[List[Any], int]:
    """``(exportable, left_out)``: a bulk export drops the sessions that hold
    a Data Hub result and counts them."""
    keys = data_hub_server_keys() if server_keys is None else server_keys
    kept: List[Any] = []
    left_out = 0
    for session in sessions:
        if session_has_data_hub_result(session, server_keys=keys):
            left_out += 1
        else:
            kept.append(session)
    return kept, left_out
