"""Shared renderers for session export commands.

The CLI, dashboard, and slash-command surfaces all deal with the same
session-shaped data: a session dict with a ``messages`` list. Keep filtering
and human-readable rendering here so each surface only has to load sessions
and write bytes.
"""

from __future__ import annotations

from datetime import datetime, timezone
from html import escape as html_escape
from dataclasses import dataclass
import json
import re
from typing import (
    AbstractSet,
    Any,
    Callable,
    Dict,
    FrozenSet,
    Iterable,
    Iterator,
    List,
    Literal,
    Optional,
    Tuple,
    Union,
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
# share this one predicate. The session store keeps a sticky ``data_hub``
# flag on the session row (hermes_state), set when such a result is
# recorded; the tool rows are the fallback for sessions recorded before it.
# ---------------------------------------------------------------------------

#: The hub server (gateway ``ref``) whose results may only be read in Workmate.
DATA_HUB_SERVER_REF = "agentx-data"

# A hub server becomes the ``mcp_servers`` entry ``agentx-<slug>`` (hub_sync
# ``gateway_entry_name``), whose tools are ``mcp__agentx_agentx_data__<tool>``;
# a second entry for the same server carries a numeric suffix.
_DATA_HUB_TOOL_RE = re.compile(r"^mcp__agentx_agentx_data(?:_\d+)?__\w+$")
_DATA_HUB_ENTRY_NAME_RE = re.compile(r"^agentx[-_]agentx[-_]data(?:[-_]\d+)?$")
# Inside a hub toolset a member's tools are ``<alias>_<tool>``.
_DATA_HUB_TOOL_SUFFIX_RE = re.compile(
    r"(?:^|_)(?:search_knowledge|read_passage_context|list_knowledge_bases)$"
)
# A gateway endpoint's path: ``<hub>/gw/s/<slug>`` (a server), ``<hub>/gw/t/<id>`` (a toolset).
_GATEWAY_PATH_RE = re.compile(r"(?:^|/)gw/(s|t)/([^/]+)/?$")
_MCP_NAME_UNSAFE_RE = re.compile(r"[^A-Za-z0-9_]")
_DATA_HUB_RESULT_KINDS = frozenset({"evidence", "no_evidence", "knowledge_bases"})
_UNTRUSTED_OPEN_RE = re.compile(r"^\s*<untrusted[_-]tool[_-]result\b[^>]*>", re.IGNORECASE)

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


_DATA_HUB_PROFILE_EXPORT_REFUSAL = {
    "vi": (
        "Hồ sơ '{name}' có phiên chứa kết quả từ Data Hub — chỉ được đọc trong "
        "Workmate, nên không xuất được hồ sơ này."
    ),
    "en": (
        "Profile '{name}' has sessions containing Data Hub results, which may "
        "only be read in Workmate; exporting the profile is blocked."
    ),
}
_DATA_HUB_PROFILE_UNCHECKED = {
    "vi": "Không kiểm tra được các phiên của hồ sơ '{name}' ({error}), nên không xuất hồ sơ.",
    "en": "Could not check the sessions of profile '{name}' ({error}); the profile is not exported.",
}


class DataHubExportRefused(Exception):
    """An export of a session that holds a Data Hub result."""

    def __init__(self) -> None:
        super().__init__(data_hub_export_refusal())


class DataHubProfileExportRefused(ValueError):
    """An export of a profile whose sessions hold a Data Hub result (or could
    not be checked). A ValueError: every caller of ``export_profile`` reports one."""


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


def data_hub_profile_export_refusal(name: str) -> str:
    """Why an export of profile *name* is refused."""
    return _DATA_HUB_PROFILE_EXPORT_REFUSAL[_message_language()].format(name=name)


def data_hub_profile_unchecked(name: str, error: Any) -> str:
    """Why an export of profile *name* is refused when its store could not be read."""
    return _DATA_HUB_PROFILE_UNCHECKED[_message_language()].format(name=name, error=error)


def store_file_holds_data_hub(path: Any) -> bool:
    """Whether the session store file at *path* holds a Data Hub result: a
    session flagged ``data_hub``, or — a store not yet opened by a build that
    flags — a tool row of the default ``agentx-agentx-data`` entry. Read only;
    raises ``sqlite3.Error`` when the file cannot be read."""
    import sqlite3
    from pathlib import Path

    db_path = Path(path)
    if not db_path.is_file():
        return False
    conn = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True, timeout=5)
    try:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        if "sessions" in tables:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)")}
            if "data_hub" in columns and conn.execute(
                "SELECT 1 FROM sessions WHERE data_hub = 1 LIMIT 1"
            ).fetchone():
                return True
        if "messages" not in tables:
            return False
        return conn.execute(
            """SELECT 1 FROM messages WHERE role = 'tool' AND (
                   tool_name GLOB 'mcp__agentx_agentx_data__*'
                   OR tool_name GLOB 'mcp__agentx_agentx_data_[0-9]*__*'
               ) LIMIT 1"""
        ).fetchone() is not None
    finally:
        conn.close()


def data_hub_export_skipped(count: int) -> str:
    """What a bulk export says about the sessions it left out."""
    return _DATA_HUB_EXPORT_SKIPPED[_message_language()].format(count=count)


@dataclass(frozen=True)
class DataHubEntries:
    """The ``mcp_servers`` keys that reach the hub's Data Hub server.

    * ``servers`` — the server's own endpoint: every tool is a Data Hub tool;
    * ``toolsets`` — a hub toolset that holds it: its Data Hub tools are;
    * ``unknown`` — a hub toolset whose members are not known here yet (an
      entry added before membership was recorded, or by hand): kept off the
      platforms that may not have Data Hub, until a sync says otherwise.
    """

    servers: FrozenSet[str] = frozenset()
    toolsets: FrozenSet[str] = frozenset()
    unknown: FrozenSet[str] = frozenset()

    def suspects(self) -> FrozenSet[str]:
        """Every key that is, or may be, a Data Hub entry."""
        return self.servers | self.toolsets | self.unknown


def _hub_host() -> str:
    try:
        from urllib.parse import urlsplit

        from hermes_cli.hub_client import hub_base_url

        return (urlsplit(hub_base_url()).hostname or "").lower()
    except Exception:
        return ""


def _entry_kind(name: Any, cfg: Any, hub_host: Callable[[], str]) -> Optional[str]:
    """``server`` / ``toolset`` / ``unknown`` (see :class:`DataHubEntries`), or None."""
    if _DATA_HUB_ENTRY_NAME_RE.match(str(name)):
        return "server"
    if not isinstance(cfg, dict):
        return None
    gateway = cfg.get("gateway") if isinstance(cfg.get("gateway"), dict) else {}
    servers = gateway.get("servers")
    if isinstance(servers, list):
        members = {str(slug) for slug in servers}
    else:
        members = None
    from hermes_cli.hub_sync import GATEWAY_SOURCE

    if cfg.get("source") == GATEWAY_SOURCE:
        kind = gateway.get("kind", "server")
        if kind == "server":
            return "server" if gateway.get("ref") == DATA_HUB_SERVER_REF else None
        if kind == "toolset":
            if members is None:
                return "unknown"
            return "toolset" if DATA_HUB_SERVER_REF in members else None
        return None
    # An entry added by hand that points at the hub's gateway.
    url = cfg.get("url")
    if not isinstance(url, str) or not url:
        return None
    from urllib.parse import urlsplit

    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    found = _GATEWAY_PATH_RE.search(parts.path or "")
    host = (parts.hostname or "").lower()
    if not found or not host or host != hub_host():
        return None
    if found.group(1) == "s":
        return "server" if found.group(2) == DATA_HUB_SERVER_REF else None
    if members is None:
        return "unknown"
    return "toolset" if DATA_HUB_SERVER_REF in members else None


def data_hub_entries(mcp_servers: Any = None) -> DataHubEntries:
    """The Data Hub entries of *mcp_servers* (default: the active profile's config).

    Told by the entry's gateway ref and recorded toolset membership, or by a
    hand-added entry's URL on the hub's gateway — not by its name alone.
    """
    if mcp_servers is None:
        try:
            from hermes_cli.config import load_config_readonly

            mcp_servers = (load_config_readonly() or {}).get("mcp_servers")
        except Exception:
            mcp_servers = None
    if not isinstance(mcp_servers, dict):
        return DataHubEntries()
    host_cache: List[str] = []

    def hub_host() -> str:
        if not host_cache:
            host_cache.append(_hub_host())
        return host_cache[0]

    found: Dict[str, set] = {"server": set(), "toolset": set(), "unknown": set()}
    for name, cfg in mcp_servers.items():
        kind = _entry_kind(name, cfg, hub_host)
        if kind:
            found[kind].add(str(name))
    return DataHubEntries(
        servers=frozenset(found["server"]),
        toolsets=frozenset(found["toolset"]),
        unknown=frozenset(found["unknown"]),
    )


def data_hub_server_keys(mcp_servers: Any = None) -> FrozenSet[str]:
    """The keys that are known to reach the Data Hub server (servers and toolsets)."""
    entries = data_hub_entries(mcp_servers)
    return entries.servers | entries.toolsets


EntriesLike = Optional[Union[DataHubEntries, AbstractSet[str]]]


def _as_entries(entries: EntriesLike) -> DataHubEntries:
    if entries is None:
        return data_hub_entries()
    if isinstance(entries, DataHubEntries):
        return entries
    return DataHubEntries(servers=frozenset(entries))


def _prefix(key: str) -> str:
    return f"mcp__{_MCP_NAME_UNSAFE_RE.sub('_', key)}__"


def is_data_hub_tool_name(name: Any, server_keys: EntriesLike = None) -> bool:
    """Whether *name* is a tool of a Data Hub server.

    The default entry's tool family always counts; *server_keys* (see
    :func:`data_hub_entries`; a plain set is taken as server entries) adds
    the entries the config names differently and the hub toolsets that hold
    the server. Pass them when testing many names.
    """
    if not isinstance(name, str) or not name.startswith("mcp__"):
        return False
    if _DATA_HUB_TOOL_RE.match(name):
        return True
    entries = _as_entries(server_keys)
    if any(name.startswith(_prefix(key)) for key in entries.servers):
        return True
    for key in entries.toolsets:
        prefix = _prefix(key)
        if name.startswith(prefix) and _DATA_HUB_TOOL_SUFFIX_RE.search(name[len(prefix):]):
            return True
    return False


def is_data_hub_suspect_tool(name: Any, server_keys: EntriesLike = None) -> bool:
    """Whether *name* is, or may be, a Data Hub tool: any tool of an entry that
    is or may be a Data Hub entry — what a platform that may not have Data Hub
    is kept from."""
    if not isinstance(name, str) or not name.startswith("mcp__"):
        return False
    if _DATA_HUB_TOOL_RE.match(name):
        return True
    return any(name.startswith(_prefix(key)) for key in _as_entries(server_keys).suspects())


def is_data_hub_server_key(name: Any, server_keys: EntriesLike = None) -> bool:
    """Whether the ``mcp_servers`` key *name* is, or may be, a Data Hub entry."""
    if _DATA_HUB_ENTRY_NAME_RE.match(str(name)):
        return True
    return str(name) in _as_entries(server_keys).suspects()


def _json_layer(value: Any, depth: int = 0) -> Optional[Dict[str, Any]]:
    if depth > 3:
        return None
    if isinstance(value, str):
        text = value
        if _UNTRUSTED_OPEN_RE.match(text):
            start, end = text.find("{"), text.rfind("}")
            text = text[start:end + 1] if 0 <= start < end else text
        text = text.strip()
        if not text.startswith("{"):
            return None
        try:
            value = json.loads(text)
        except ValueError:
            return None
    if not isinstance(value, dict):
        return None
    if (
        value.get("result") in _DATA_HUB_RESULT_KINDS
        and isinstance(value.get("result_id"), str)
        and value["result_id"].startswith("rs_")
        and isinstance(value.get("notice"), str)
    ):
        return value
    inner = value.get("result")
    return _json_layer(inner, depth + 1) if isinstance(inner, (str, dict)) else None


def looks_like_data_hub_result(content: Any) -> bool:
    """Whether a tool row's *content* is a Data Hub result — the contract's
    shape (``result`` verdict, ``rs_`` result id, ``notice``), as the agent
    stores it (``{"result": "<text>"}``, maybe wrapped as untrusted data)."""
    if isinstance(content, list):
        content = "".join(
            part.get("text", "") for part in content if isinstance(part, dict) and isinstance(part.get("text"), str)
        )
    if not isinstance(content, (str, dict)):
        return False
    if isinstance(content, str) and ("result_id" not in content or "rs_" not in content):
        return False
    return _json_layer(content) is not None


def is_data_hub_row(tool_name: Any, content: Any, server_keys: EntriesLike = None) -> bool:
    """Whether a ``tool`` row (its tool's name and its content) is a Data Hub result."""
    if is_data_hub_tool_name(tool_name, server_keys):
        return True
    return (tool_name is None or str(tool_name).startswith("mcp__")) and looks_like_data_hub_result(content)


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


def messages_have_data_hub_result(messages: Any, *, server_keys: EntriesLike = None) -> bool:
    """Whether *messages* hold a ``tool`` row that is a Data Hub result: named
    by its ``tool_name`` or by the assistant call it answers, or shaped as one."""
    if not isinstance(messages, list) or not messages:
        return False
    entries: List[DataHubEntries] = []

    def keys() -> DataHubEntries:
        if not entries:
            entries.append(_as_entries(server_keys))
        return entries[0]

    called: Dict[str, str] = {}
    for message in messages:
        if isinstance(message, dict) and message.get("role") == "assistant":
            called.update(_call_names(message.get("tool_calls")))
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "tool":
            continue
        names = [
            name
            for name in (
                message.get("tool_name"),
                message.get("name"),
                called.get(str(message.get("tool_call_id") or "")),
            )
            if name
        ]
        if any(_DATA_HUB_TOOL_RE.match(str(name)) for name in names):
            return True
        if any(str(name).startswith("mcp__") for name in names) or not names:
            if any(is_data_hub_tool_name(name, keys()) for name in names):
                return True
            if looks_like_data_hub_result(message.get("content")):
                return True
    return False


def session_has_data_hub_result(
    session: Any, *, server_keys: EntriesLike = None
) -> bool:
    """Whether *session* holds a Data Hub result: a session dict flagged by the
    store (``data_hub``, also on a lineage's ``segments``), or whose
    ``messages`` — or a plain message list — hold one (the fallback for
    sessions recorded before the flag)."""
    if isinstance(session, dict):
        if session.get("data_hub"):
            return True
        segments = session.get("segments")
        if isinstance(segments, list) and any(
            isinstance(segment, dict) and segment.get("data_hub") for segment in segments
        ):
            return True
        messages = session.get("messages")
    else:
        messages = session
    return messages_have_data_hub_result(messages, server_keys=server_keys)


def store_flags_data_hub(db: Any, session_id: Any) -> bool:
    """Whether the session store *db* flags *session_id* as holding a Data Hub
    result (``SessionDB.session_has_data_hub``); False for a store without it."""
    # An AsyncSessionDB (gateway) offloads every call; ask the store it wraps.
    store = getattr(db, "_db", None) or db
    check = getattr(store, "session_has_data_hub", None)
    if not callable(check) or not session_id:
        return False
    try:
        return check(session_id) is True
    except Exception:
        return False


def ensure_session_exportable(
    session: Any, *, server_keys: EntriesLike = None
) -> None:
    """Raise :class:`DataHubExportRefused` for a session with a Data Hub result."""
    if session_has_data_hub_result(session, server_keys=server_keys):
        raise DataHubExportRefused()


def partition_exportable_sessions(
    sessions: Iterable[Any], *, server_keys: EntriesLike = None
) -> Tuple[List[Any], int]:
    """``(exportable, left_out)``: a bulk export drops the sessions that hold
    a Data Hub result and counts them."""
    keys = _as_entries(server_keys)
    kept: List[Any] = []
    left_out = 0
    for session in sessions:
        if session_has_data_hub_result(session, server_keys=keys):
            left_out += 1
        else:
            kept.append(session)
    return kept, left_out
