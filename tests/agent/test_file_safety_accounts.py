"""file_safety on a signed-in desktop, where every home lives in an account.

The desktop runs a signed-in person's agent with
``AGENTX_HOME=<root>/accounts/<slug>`` (or ``…/profiles/<name>`` inside it).
The guards used to protect only the active home and the install root, so an
agent in a profile inside an account could overwrite or read that account's
``.env`` / ``auth.json`` — the credentials every profile of that person
inherits — and another account's too. The cross-profile soft guard measured
profiles from the install root, so it never noticed an agent in ``work``
editing the account's default skills.
"""

from __future__ import annotations

from pathlib import Path

import pytest

SLUG = "xuan-1234abcd"


@pytest.fixture()
def install(tmp_path, monkeypatch):
    from hermes_constants import get_default_hermes_root

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "AppData" / "Local"))
    monkeypatch.delenv("AGENTX_HOME", raising=False)
    monkeypatch.delenv("AGENTX_WRITE_SAFE_ROOT", raising=False)
    root = get_default_hermes_root()
    account = root / "accounts" / SLUG
    work = account / "profiles" / "work"
    other = root / "accounts" / "other-9999"
    for home in (work, other):
        home.mkdir(parents=True)
    return root, account, work, other


def _create(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x", encoding="utf-8")
    return path


def _homes(install):
    root, account, work, other = install
    return {"root": root, "account": account, "work": work, "other": other}


@pytest.mark.parametrize("active", ["account", "work"])
@pytest.mark.parametrize(
    "where,rel",
    [
        ("account", ".env"),
        ("account", ".anthropic_oauth.json"),
        ("account", "cache/bws_cache.enc.json"),
        ("account", "mcp-tokens/github.json"),
        ("account", "platforms/pairing/telegram-approved.json"),
        ("account", "state.db"),
        ("account", "sessions/s1.json"),
        ("other", ".env"),
        ("other", "mcp-tokens/github.json"),
        ("work", "platforms/pairing/telegram-pending.json"),
        ("root", ".env"),
    ],
)
def test_writes_to_account_secrets_are_denied(install, monkeypatch, active, where, rel):
    from agent.file_safety import is_write_denied

    homes = _homes(install)
    monkeypatch.setenv("AGENTX_HOME", str(homes[active]))
    target = _create(homes[where] / rel)

    assert is_write_denied(str(target)) is True


@pytest.mark.parametrize("active", ["account", "work"])
@pytest.mark.parametrize(
    "where,rel,marker",
    [
        ("account", "auth.json", "credential store"),
        ("account", "webhook_subscriptions.json", "credential store"),
        ("account", "auth/google_oauth.json", "credential store"),
        ("account", "mcp-tokens/github.json", "MCP token"),
        ("account", "skills/.hub/index-cache/x.json", "internal AgentX cache"),
        ("other", "auth.json", "credential store"),
    ],
)
def test_reads_of_account_secrets_are_blocked(install, monkeypatch, active, where, rel, marker):
    from agent.file_safety import get_read_block_error

    homes = _homes(install)
    monkeypatch.setenv("AGENTX_HOME", str(homes[active]))
    target = _create(homes[where] / rel)

    assert marker in (get_read_block_error(str(target)) or "")


def test_ordinary_account_files_stay_writable_and_readable(install, monkeypatch):
    from agent.file_safety import get_read_block_error, is_write_denied

    root, account, work, other = install
    monkeypatch.setenv("AGENTX_HOME", str(work))
    notes = _create(account / "notes" / "todo.md")
    skill = _create(work / "skills" / "mine" / "SKILL.md")

    assert is_write_denied(str(notes)) is False
    assert get_read_block_error(str(notes)) is None
    assert is_write_denied(str(skill)) is False


def test_cross_profile_guard_measures_profiles_inside_the_account(install, monkeypatch):
    from agent.file_safety import classify_cross_profile_target

    root, account, work, other = install

    monkeypatch.setenv("AGENTX_HOME", str(work))
    info = classify_cross_profile_target(str(account / "skills" / "x" / "SKILL.md"))
    assert info is not None
    assert (info["active_profile"], info["target_profile"], info["area"]) == (
        "work",
        "default",
        "skills",
    )
    assert classify_cross_profile_target(str(work / "skills" / "x" / "SKILL.md")) is None

    monkeypatch.setenv("AGENTX_HOME", str(account))
    info = classify_cross_profile_target(str(work / "memories" / "MEMORY.md"))
    assert info is not None
    assert (info["active_profile"], info["target_profile"]) == ("default", "work")
    assert classify_cross_profile_target(str(account / "skills" / "x" / "SKILL.md")) is None


def test_unsigned_install_keeps_its_old_shape(install, monkeypatch):
    """No account: the user root is the install root, nothing else changes."""
    from agent.file_safety import classify_cross_profile_target, is_write_denied

    root, account, work, other = install
    coder = root / "profiles" / "coder"
    coder.mkdir(parents=True)
    monkeypatch.setenv("AGENTX_HOME", str(coder))

    assert is_write_denied(str(_create(root / ".env"))) is True
    assert is_write_denied(str(_create(coder / ".env"))) is True
    info = classify_cross_profile_target(str(root / "skills" / "x" / "SKILL.md"))
    assert info is not None and info["active_profile"] == "coder"
