"""Bot Mode teammate protocol — the system-prompt section of a bot's "Bot Chat".

Bot Mode (the desktop's "Trợ lý" page, plugin ``agentx-bots``) treats every
AgentX profile as a named teammate with ONE canonical conversation titled
``BOT_CHAT_TITLE``. Inside that conversation — and only there — the agent is
told how to message its teammates (``agentx -p <name> chat --in ~ -c "Bot
Chat" -Q -q …``) and who they are.

The section used to be appended to every profile's SOUL.md by the desktop
plugin, which silently rewrote user-owned identity files. Building it here
keeps SOUL.md untouched, keeps the roster live (a bot created after another
one still shows up), and stays out of ordinary chats entirely.

Gate: silent (``""``) until at least one profile carries Bot Mode metadata
(``ui_meta['agentx-bots']`` in profile.yaml), i.e. the user actually uses Bot
Mode. Never raises — a prompt build must not fail because of this probe.
Toggle: ``agent.bot_mode_protocol`` in config.yaml (default on).
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

# The only session title that receives the section. Must match the desktop
# plugin's canonical-chat title and the CLI resume target `-c "Bot Chat"`.
BOT_CHAT_TITLE = "Bot Chat"

# ui_meta namespace the desktop plugin writes into profile.yaml.
UI_META_KEY = "agentx-bots"

# The primary profile's callable handle (the desktop never shows "default").
DEFAULT_HANDLE = "agentx"

PROTOCOL_HEADING = "## Messaging other agents"

# The roster is read from disk; a short cache keeps compression rebuilds and
# bursts of new sessions from re-walking every profile.yaml, while a bot
# created a minute ago still reaches the next Bot Chat that starts.
_CACHE_TTL_S = 30.0
_lock = threading.Lock()
_cache: dict[str, tuple[float, str]] = {}


def handle_for(name: str) -> str:
    """The @handle a profile answers to in Bot Mode."""
    return DEFAULT_HANDLE if (name or "").strip().lower() == "default" else name


def _bots_meta(meta: Any) -> dict | None:
    ui_meta = meta.get("ui_meta") if isinstance(meta, dict) else None
    bots = ui_meta.get(UI_META_KEY) if isinstance(ui_meta, dict) else None
    return bots if isinstance(bots, dict) else None


def read_bots_meta(profile_dir: Path) -> dict | None:
    """``ui_meta['agentx-bots']`` from a profile's profile.yaml, or None.

    Read directly (like ``profiles.list`` does): ``read_profile_meta`` only
    surfaces the description fields. Cheap substring precheck first — the
    dominant case is a profile Bot Mode never touched."""
    path = Path(profile_dir) / "profile.yaml"
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    if UI_META_KEY not in raw:
        return None
    try:
        import yaml

        return _bots_meta(yaml.safe_load(raw))
    except Exception:
        return None


def _roster() -> list[dict[str, str]]:
    """Every local profile as ``{name, title, description, managed}``."""
    from hermes_cli.profiles import list_profiles

    rows: list[dict[str, str]] = []
    for info in list_profiles():
        bots = read_bots_meta(Path(info.path))
        title = str((bots or {}).get("title") or "").strip()
        rows.append(
            {
                "name": info.name,
                "title": title,
                "description": str(getattr(info, "description", "") or "").strip(),
                "managed": "1" if bots is not None else "",
            }
        )
    return rows


def _bullet(row: dict[str, str]) -> str:
    label = f"`@{handle_for(row['name'])}`"
    if row["title"]:
        label += f" ({row['title']})"
    return f"- {label}" + (f" — {row['description']}" if row["description"] else "")


def build_protocol_section(me: str, roster: list[dict[str, str]]) -> str:
    """The section for profile ``me`` given a roster; ``""`` when Bot Mode is unused."""
    if not any(row.get("managed") for row in roster):
        return ""

    me_handle = handle_for(me)
    me_row = next((row for row in roster if row["name"] == me), None)
    # Quotes would end the shell string the agent is told to build.
    me_label = ((me_row or {}).get("title") or me_handle).replace('"', "'")
    teammates = [row for row in roster if row["name"] != me]
    roster_block = "\n".join(_bullet(row) for row in teammates) or "- (no teammates yet)"
    send = (
        f'agentx -p <agent-name> chat --in ~ -c "{BOT_CHAT_TITLE}" -Q -q '
        f'"Message from 🤖 {me_label} (@{me_handle}): <your message>"'
    )

    return (
        f"{PROTOCOL_HEADING}\n"
        "You are one of several named agents on this machine (Bot Mode). Each agent "
        f'has ONE canonical conversation titled "{BOT_CHAT_TITLE}" — this is yours. '
        "To message a teammate, run exactly one terminal command, in the background "
        "with notify_on_complete=true so the user is never blocked:\n"
        f"`{send}`\n"
        "Use the agent's profile name (`default` for @agentx). COMPOSE the message "
        "yourself — say what you need from that agent; never forward the user's words "
        "verbatim and never reveal private chat content. After dispatching, tell the "
        "user the message was sent and end your turn; the reply arrives later as the "
        "background process's completion notification — relay it then, naming which "
        "agent answered. If the command fails with 'No session found', send once "
        "without `-c`, then run `agentx -p <agent-name> sessions rename <session-id> "
        f'"{BOT_CHAT_TITLE}"`.\n'
        'A message in YOUR chat that starts with "Message from 🤖 <name>" comes from a '
        "teammate, not the user: answer it directly and briefly; never ping-pong "
        "acknowledgements. When the user writes @<agent> or says \"ask <agent> …\", that "
        "is a handoff: message the ONE relevant teammate and report back.\n"
        f"You are `@{me_handle}`. Teammates (run `agentx profile list` for the live list):\n"
        f"{roster_block}"
    )


def get_bot_mode_protocol_section(me: str, *, force_refresh: bool = False) -> str:
    """Cached entry point for the system prompt. Never raises."""
    key = (me or "default").strip() or "default"
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and not force_refresh and now - hit[0] < _CACHE_TTL_S:
            return hit[1]
    try:
        section = build_protocol_section(key, _roster())
    except Exception:
        section = ""
    with _lock:
        _cache[key] = (now, section)
    return section


def session_title_for(agent: Any) -> str:
    """The title of the agent's session: the gateway's pending-title hint first
    (a new chat's title is only persisted after its first message), else the
    stored title. ``""`` when unknown."""
    hint = str(getattr(agent, "_session_title_hint", "") or "").strip()
    if hint:
        return hint
    db = getattr(agent, "_session_db", None)
    sid = getattr(agent, "session_id", None)
    if db is None or not sid:
        return ""
    try:
        return str(db.get_session_title(sid) or "").strip()
    except Exception:
        return ""
