"""Slow slash commands (``/skills …``, ``/reload-skills``, ``/reload-mcp``) run
inside ``HermesCLI._busy_command``, which prints ``⏳ <status>`` so a live
terminal shows the command has started. The slash worker hands back output only
once the command has finished, so that line must not reach the desktop or TUI,
where it would sit above the result and read as still running."""

from __future__ import annotations

from cli import HermesCLI
from hermes_cli.write_approval_commands import handle_pending_subcommand
from tools import write_approval as wa
from tui_gateway import slash_worker


def _make_cli() -> HermesCLI:
    cli = HermesCLI.__new__(HermesCLI)
    cli._app = None
    cli._last_invalidate = 0.0
    cli._command_running = False
    cli._command_status = ""
    return cli


def test_skills_pending_returns_only_the_result():
    record = wa.stage_write(
        wa.SKILLS,
        {"action": "create", "name": "release-notes"},
        summary="create 'release-notes'",
        origin="foreground",
    )

    out = slash_worker._run(_make_cli(), "/skills pending")

    assert "⏳" not in out
    assert out.startswith("Pending skills writes (1):")
    assert record["id"] in out
    # Exactly the handler's text: nothing above it, nothing lost.
    assert out == handle_pending_subcommand(wa.SKILLS, ["pending"])
