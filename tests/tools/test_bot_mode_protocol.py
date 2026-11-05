"""Bot Mode teammate protocol: built by the backend, gated to "Bot Chat".

The desktop's Bot Mode used to append this section to every profile's
SOUL.md. These tests pin the replacement: the section is assembled from the
live roster, appears only in a bot's canonical "Bot Chat" session, stays
silent until Bot Mode is actually in use, and can be switched off.
"""

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from agent.system_prompt import build_system_prompt_parts
from tools import bot_mode_protocol as bmp


def _row(name, title="", description="", managed=True):
    return {"name": name, "title": title, "description": description, "managed": "1" if managed else ""}


class TestBuildProtocolSection:
    def test_silent_until_a_profile_is_bot_managed(self):
        roster = [_row("default", managed=False), _row("writer", managed=False)]

        assert bmp.build_protocol_section("default", roster) == ""

    def test_lists_teammates_but_not_self(self):
        roster = [
            _row("default"),
            _row("writer", "Biên tập", "Soạn bài đăng"),
            _row("research", managed=False),
        ]

        section = bmp.build_protocol_section("writer", roster)

        assert section.startswith(bmp.PROTOCOL_HEADING)
        assert "You are `@writer`" in section
        assert "- `@agentx`" in section
        assert "- `@research`" in section
        assert "`@writer` (Biên tập)" not in section

    def test_default_profile_answers_to_agentx(self):
        section = bmp.build_protocol_section("default", [_row("default"), _row("writer", "Biên tập", "Soạn bài")])

        assert "You are `@agentx`" in section
        assert "Message from 🤖 agentx (@agentx)" in section
        assert "- `@writer` (Biên tập) — Soạn bài" in section

    def test_sender_prefix_uses_the_display_title(self):
        section = bmp.build_protocol_section("writer", [_row("default"), _row("writer", 'Biên "tập"')])

        assert "Message from 🤖 Biên 'tập' (@writer)" in section

    def test_send_command_targets_the_bot_chat(self):
        section = bmp.build_protocol_section("default", [_row("default"), _row("writer")])

        assert f'chat --in ~ -c "{bmp.BOT_CHAT_TITLE}" -Q -q' in section

    def test_lone_bot_says_no_teammates(self):
        assert "- (no teammates yet)" in bmp.build_protocol_section("default", [_row("default")])


class TestReadBotsMeta:
    def test_reads_ui_meta_block(self, tmp_path):
        (tmp_path / "profile.yaml").write_text(
            "description: Soạn bài\nui_meta:\n  agentx-bots:\n    title: Biên tập\n    color: '#ec4899'\n",
            encoding="utf-8",
        )

        assert bmp.read_bots_meta(tmp_path) == {"title": "Biên tập", "color": "#ec4899"}

    def test_unmanaged_profile_is_none(self, tmp_path):
        (tmp_path / "profile.yaml").write_text("description: plain\n", encoding="utf-8")

        assert bmp.read_bots_meta(tmp_path) is None
        assert bmp.read_bots_meta(tmp_path / "missing") is None

    def test_corrupt_yaml_is_none(self, tmp_path):
        (tmp_path / "profile.yaml").write_text("ui_meta: [agentx-bots: {", encoding="utf-8")

        assert bmp.read_bots_meta(tmp_path) is None

    def test_roster_marks_managed_profiles(self, tmp_path, monkeypatch):
        plain, bot = tmp_path / "default", tmp_path / "writer"
        plain.mkdir()
        bot.mkdir()
        (bot / "profile.yaml").write_text("ui_meta:\n  agentx-bots:\n    title: Biên tập\n", encoding="utf-8")
        infos = [
            SimpleNamespace(name="default", path=plain, description=""),
            SimpleNamespace(name="writer", path=bot, description="Soạn bài"),
        ]
        monkeypatch.setattr("hermes_cli.profiles.list_profiles", lambda: infos)

        assert bmp._roster() == [
            {"name": "default", "title": "", "description": "", "managed": ""},
            {"name": "writer", "title": "Biên tập", "description": "Soạn bài", "managed": "1"},
        ]


class TestCachedEntryPoint:
    def test_cached_within_ttl_and_refreshable(self):
        calls = []

        def roster():
            calls.append(1)
            return [_row("default"), _row("writer")]

        bmp._cache.clear()
        with patch.object(bmp, "_roster", side_effect=roster):
            first = bmp.get_bot_mode_protocol_section("default")
            second = bmp.get_bot_mode_protocol_section("default")
            bmp.get_bot_mode_protocol_section("default", force_refresh=True)

        assert first == second and first
        assert len(calls) == 2
        bmp._cache.clear()

    def test_never_raises(self):
        bmp._cache.clear()
        with patch.object(bmp, "_roster", side_effect=RuntimeError("disk gone")):
            assert bmp.get_bot_mode_protocol_section("default") == ""
        bmp._cache.clear()


class TestSessionTitle:
    def test_pending_hint_wins(self):
        agent = SimpleNamespace(_session_title_hint="Bot Chat", _session_db=None, session_id="s1")

        assert bmp.session_title_for(agent) == "Bot Chat"

    def test_falls_back_to_stored_title(self):
        db = SimpleNamespace(get_session_title=lambda sid: "Bot Chat" if sid == "s1" else None)

        assert bmp.session_title_for(SimpleNamespace(_session_db=db, session_id="s1")) == "Bot Chat"

    def test_unknown_is_empty(self):
        assert bmp.session_title_for(SimpleNamespace()) == ""


def _agent(**overrides):
    base = dict(
        load_soul_identity=False,
        skip_context_files=False,
        valid_tool_names=[],
        _task_completion_guidance=False,
        _tool_use_enforcement=False,
        _environment_probe=False,
        _kanban_worker_guidance="",
        _memory_store=None,
        _memory_manager=None,
        _platform_hint_overrides={},
        model="",
        provider="",
        platform="",
        pass_session_id=False,
        session_id="",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _prompt(agent):
    with (
        patch("run_agent.load_soul_md", return_value=""),
        patch("run_agent.build_nous_subscription_prompt", return_value=""),
        patch("run_agent.build_environment_hints", return_value=""),
        patch("run_agent.build_context_files_prompt", return_value=""),
        patch.object(bmp, "_roster", return_value=[_row("default"), _row("writer", "Biên tập")]),
    ):
        bmp._cache.clear()
        parts = build_system_prompt_parts(agent)
        bmp._cache.clear()
        return "\n".join(str(v) for v in parts.values())


class TestSystemPromptIntegration:
    def test_bot_chat_gets_the_section(self):
        assert bmp.PROTOCOL_HEADING in _prompt(_agent(_session_title_hint="Bot Chat"))

    @pytest.mark.parametrize("title", ["", "Kế hoạch tuần", "bot chat"])
    def test_other_chats_do_not(self, title):
        assert bmp.PROTOCOL_HEADING not in _prompt(_agent(_session_title_hint=title))

    def test_config_toggle_switches_it_off(self):
        assert bmp.PROTOCOL_HEADING not in _prompt(_agent(_session_title_hint="Bot Chat", _bot_mode_protocol=False))
