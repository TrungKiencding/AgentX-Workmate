"""Which desktop backend runs scheduled work.

Pilot feedback 2026-11: an assistant's scheduled task "did not run until I
opened its conversation". Its jobs were ticked by the assistant's pool backend
— which the app stops after ten idle minutes, even mid-run — and that
backend's last heartbeat then kept the primary's sweeper away for minutes.
"""

from __future__ import annotations

import yaml

from hermes_cli import web_server
from tools.bot_mode_protocol import UI_META_KEY


def _assistant(home):
    home.mkdir(parents=True, exist_ok=True)
    (home / "profile.yaml").write_text(
        yaml.safe_dump({"ui_meta": {UI_META_KEY: {"title": "Bot tài chính"}}})
    )
    return home


def test_the_primary_backend_ticks_its_own_jobs_and_sweeps_assistants(tmp_path):
    assert web_server._desktop_cron_roles({"AGENTX_DESKTOP": "1"}, tmp_path) == (True, True)


def test_a_pool_backend_for_an_assistant_leaves_its_routines_to_the_primary(tmp_path):
    env = {"AGENTX_DESKTOP": "1", "AGENTX_DESKTOP_POOL": "1"}

    assert web_server._desktop_cron_roles(env, _assistant(tmp_path / "bot")) == (False, False)


def test_a_pool_backend_for_an_ordinary_profile_still_ticks_but_never_sweeps(tmp_path):
    env = {"AGENTX_DESKTOP": "1", "AGENTX_DESKTOP_POOL": "1"}
    home = tmp_path / "work"
    home.mkdir()
    (home / "profile.yaml").write_text("description: plain profile\n")

    assert web_server._desktop_cron_roles(env, home) == (True, False)
    # No profile.yaml at all: same.
    assert web_server._desktop_cron_roles(env, tmp_path / "missing") == (True, False)


def test_an_unreadable_profile_keeps_ticking(tmp_path, monkeypatch):
    """When unsure, tick: a missed run is worse than a redundant ticker (the
    tick lock already keeps two tickers from firing one job twice)."""
    import tools.bot_mode_protocol as protocol

    def boom(_home):
        raise RuntimeError("yaml exploded")

    monkeypatch.setattr(protocol, "read_bots_meta", boom)
    env = {"AGENTX_DESKTOP": "1", "AGENTX_DESKTOP_POOL": "1"}

    assert web_server._desktop_cron_roles(env, tmp_path) == (True, False)
