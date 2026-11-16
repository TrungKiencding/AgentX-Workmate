"""Tests for the per-turn file-mutation verifier footer.

Covers the three moving pieces:

1. ``_extract_file_mutation_targets`` — pulls file paths from write_file /
   patch (replace + V4A) tool-call argument dicts.
2. ``AIAgent._record_file_mutation_result`` — builds the per-turn state
   dict, removing entries when a later success supersedes an earlier
   failure for the same path.
3. ``AIAgent._format_file_mutation_failure_footer`` — renders the dict
   as a user-visible advisory.

Regression target: the "Ben Eng llm-wiki" session where grok-4.1-fast
batched parallel patches, half failed, and the model summarised the
turn claiming every file was edited.  This verifier makes over-claiming
structurally impossible past the model: the user always sees the real
list of files that did NOT change.
"""

from __future__ import annotations

import json

import pytest

from run_agent import (
    AIAgent,
    _FILE_MUTATING_TOOLS,
    _extract_error_preview,
    _extract_file_mutation_targets,
    _extract_landed_file_mutation_paths,
)


# ---------------------------------------------------------------------------
# _extract_file_mutation_targets
# ---------------------------------------------------------------------------


class TestExtractFileMutationTargets:
    def test_non_mutating_tool_returns_empty(self):
        assert _extract_file_mutation_targets("read_file", {"path": "/x"}) == []
        assert _extract_file_mutation_targets("terminal", {"command": "ls"}) == []



    def test_patch_replace_mode_returns_path(self):
        args = {"mode": "replace", "path": "/tmp/a.md", "old_string": "x", "new_string": "y"}
        assert _extract_file_mutation_targets("patch", args) == ["/tmp/a.md"]



    def test_patch_v4a_multi_file(self):
        body = (
            "*** Begin Patch\n"
            "*** Update File: /tmp/a.md\n"
            "@@ @@\n-a\n+b\n"
            "*** Add File: /tmp/new.md\n"
            "+fresh\n"
            "*** Delete File: /tmp/old.md\n"
            "*** End Patch\n"
        )
        args = {"mode": "patch", "patch": body}
        paths = _extract_file_mutation_targets("patch", args)
        assert paths == ["/tmp/a.md", "/tmp/new.md", "/tmp/old.md"]


    def test_patch_v4a_accepts_no_space_after_asterisks(self):
        """Match patch_parser / file_tools: ``***Update File:`` (no space)."""
        body = "***Update File: nospace.py\n"
        assert _extract_file_mutation_targets(
            "patch", {"mode": "patch", "patch": body}
        ) == ["nospace.py"]


# ---------------------------------------------------------------------------
# _extract_error_preview
# ---------------------------------------------------------------------------


class TestExtractErrorPreview:
    def test_json_error_field_preferred(self):
        raw = json.dumps({"success": False, "error": "Could not find old_string in /tmp/x"})
        assert _extract_error_preview(raw) == "Could not find old_string in /tmp/x"

    def test_plain_string_falls_through(self):
        assert _extract_error_preview("Error executing tool: boom") == "Error executing tool: boom"

    def test_long_preview_truncated(self):
        long = "x" * 500
        out = _extract_error_preview(long, max_len=50)
        assert len(out) <= 50
        assert out.endswith("…")



# ---------------------------------------------------------------------------
# _record_file_mutation_result — state transitions
# ---------------------------------------------------------------------------


def _bare_agent() -> AIAgent:
    """Skip __init__ and only attach the per-turn state dict.

    AIAgent.__init__ takes ~60 parameters and touches network, auth, and
    the filesystem.  For these tests we only need the two methods —
    ``_record_file_mutation_result`` and ``_format_file_mutation_failure_footer``.
    Using ``object.__new__`` mirrors the gateway-test pattern documented in
    the agent pitfalls list.
    """
    agent = object.__new__(AIAgent)
    agent._turn_failed_file_mutations = {}
    agent._turn_file_mutation_paths = set()
    return agent


class TestRecordFileMutationResult:
    def test_non_mutating_tool_ignored(self):
        agent = _bare_agent()
        agent._record_file_mutation_result(
            "read_file", {"path": "/tmp/x"}, "{}", is_error=True,
        )
        assert agent._turn_failed_file_mutations == {}

    def test_failure_recorded(self):
        agent = _bare_agent()
        result = json.dumps({"success": False, "error": "Could not find old_string"})
        agent._record_file_mutation_result(
            "patch", {"mode": "replace", "path": "/tmp/a.md", "old_string": "x", "new_string": "y"},
            result, is_error=True,
        )
        state = agent._turn_failed_file_mutations
        assert "/tmp/a.md" in state
        assert state["/tmp/a.md"]["tool"] == "patch"
        assert "Could not find old_string" in state["/tmp/a.md"]["error_preview"]

    def test_success_removes_prior_failure(self):
        agent = _bare_agent()
        # First attempt fails
        agent._record_file_mutation_result(
            "patch", {"mode": "replace", "path": "/tmp/a.md", "old_string": "x", "new_string": "y"},
            json.dumps({"error": "not found"}), is_error=True,
        )
        assert "/tmp/a.md" in agent._turn_failed_file_mutations
        # Second attempt with corrected old_string succeeds
        agent._record_file_mutation_result(
            "patch", {"mode": "replace", "path": "/tmp/a.md", "old_string": "real", "new_string": "fixed"},
            json.dumps({"success": True, "diff": "..."}), is_error=False,
        )
        assert agent._turn_failed_file_mutations == {}
        assert agent._turn_file_mutation_paths == {"/tmp/a.md"}


    def test_landed_paths_prefer_resolved_tool_result(self):
        paths = _extract_landed_file_mutation_paths(
            "patch",
            {"mode": "replace", "path": "src/app.py"},
            json.dumps({
                "success": True,
                "files_modified": ["/tmp/project/src/app.py"],
            }),
        )

        assert paths == ["/tmp/project/src/app.py"]

    def test_write_file_with_lint_error_counts_as_landed(self):
        agent = _bare_agent()
        agent._record_file_mutation_result(
            "write_file",
            {"path": "/tmp/a.py", "content": "bad"},
            json.dumps({"error": "write failed"}),
            is_error=True,
        )
        assert "/tmp/a.py" in agent._turn_failed_file_mutations

        result = json.dumps({
            "bytes_written": 24,
            "lint": {"status": "error", "output": "SyntaxError: invalid syntax"},
        })

        agent._record_file_mutation_result(
            "write_file",
            {"path": "/tmp/a.py", "content": "def nope(:\n"},
            result,
            is_error=True,
        )

        assert agent._turn_failed_file_mutations == {}

    def test_patch_with_lsp_diagnostics_counts_as_landed(self):
        agent = _bare_agent()
        agent._record_file_mutation_result(
            "patch",
            {"mode": "replace", "path": "/tmp/a.py", "old_string": "x", "new_string": "y"},
            json.dumps({"error": "Could not find old_string"}),
            is_error=True,
        )
        assert "/tmp/a.py" in agent._turn_failed_file_mutations

        result = json.dumps({
            "success": True,
            "diff": "--- a/tmp.py\n+++ b/tmp.py\n",
            "files_modified": ["/tmp/a.py"],
            "lsp_diagnostics": "<diagnostics>ERROR [1:1] type mismatch</diagnostics>",
        })

        agent._record_file_mutation_result(
            "patch",
            {"mode": "replace", "path": "/tmp/a.py", "old_string": "x", "new_string": "y"},
            result,
            is_error=True,
        )

        assert agent._turn_failed_file_mutations == {}

    def test_repeated_failure_keeps_first_error(self):
        agent = _bare_agent()
        agent._record_file_mutation_result(
            "patch", {"mode": "replace", "path": "/tmp/a.md", "old_string": "v1", "new_string": "y"},
            json.dumps({"error": "first error"}), is_error=True,
        )
        agent._record_file_mutation_result(
            "patch", {"mode": "replace", "path": "/tmp/a.md", "old_string": "v2", "new_string": "y"},
            json.dumps({"error": "second error"}), is_error=True,
        )
        # Keep the original error — swapping to the latest would obscure
        # the initial root cause.
        assert "first error" in agent._turn_failed_file_mutations["/tmp/a.md"]["error_preview"]





# ---------------------------------------------------------------------------
# _format_file_mutation_failure_footer
# ---------------------------------------------------------------------------


class TestFormatFooter:
    def test_empty_returns_empty_string(self):
        assert AIAgent._format_file_mutation_failure_footer({}) == ""

    def test_single_failure(self):
        out = AIAgent._format_file_mutation_failure_footer(
            {"/tmp/a.md": {"tool": "patch", "error_preview": "Could not find old_string"}},
        )
        assert "1 file(s) were NOT modified" in out
        assert "/tmp/a.md" in out
        assert "Could not find old_string" in out
        assert "git status" in out  # user-actionable hint

    def test_truncation_at_10_entries(self):
        failed = {
            f"/tmp/f{i}.md": {"tool": "patch", "error_preview": "err"}
            for i in range(15)
        }
        out = AIAgent._format_file_mutation_failure_footer(failed)
        assert "15 file(s) were NOT modified" in out
        assert "… and 5 more" in out
        # Ten file bullets + header + "and X more" line
        lines = out.split("\n")
        bullet_lines = [ln for ln in lines if ln.lstrip().startswith("•")]
        assert len(bullet_lines) == 11  # 10 shown + 1 summary


    def test_footer_path_not_extracted_by_gateway(self):
        """End-to-end: the gateway's extract_local_files must NOT pull a
        config.yaml path out of the rendered footer (#35584)."""
        import os
        import tempfile
        from gateway.platforms.base import BasePlatformAdapter

        tmp = tempfile.mkdtemp(prefix="hermes_footer_")
        try:
            cfg = os.path.join(tmp, "config.yaml")
            with open(cfg, "w") as fh:
                fh.write("openrouter_api_key: sk-LEAK\n")
            footer = AIAgent._format_file_mutation_failure_footer(
                {cfg: {
                    "tool": "patch",
                    "error_preview": (
                        f"Write denied: '{cfg}' is a protected "
                        "system/credential file."
                    ),
                }},
            )
            response = "I updated your config.\n\n" + footer
            paths, _ = BasePlatformAdapter.extract_local_files(response)
            assert paths == [], f"footer leaked deliverable path(s): {paths}"
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
# _file_mutation_verifier_enabled — env + config precedence
# ---------------------------------------------------------------------------


class TestVerifierEnabled:
    def test_default_is_enabled(self, monkeypatch):
        monkeypatch.delenv("AGENTX_FILE_MUTATION_VERIFIER", raising=False)
        agent = _bare_agent()
        # With no env and no config present, safe default is True.
        # load_config may surface a user config.yaml in some envs — stub it.
        import hermes_cli.config as _cfg_mod
        monkeypatch.setattr(_cfg_mod, "load_config", lambda: {})
        assert agent._file_mutation_verifier_enabled() is True

    @pytest.mark.parametrize("value", ["0", "false", "FALSE", "no", "off"])
    def test_env_disables(self, monkeypatch, value):
        monkeypatch.setenv("AGENTX_FILE_MUTATION_VERIFIER", value)
        agent = _bare_agent()
        assert agent._file_mutation_verifier_enabled() is False

    def test_config_read_once_then_cached(self, monkeypatch):
        """Measured-work pin: the config lookup happens once per agent.

        The footer gate runs at the end of every turn, so a fresh
        ``load_config()`` per call is wasted work (~1 ms deepcopy per turn,
        see #74211 for the sibling per-turn-config kill).  The config read
        must be cached after the first call; the env-var override must still
        win on every call, cached or not.
        """
        monkeypatch.delenv("AGENTX_FILE_MUTATION_VERIFIER", raising=False)
        agent = _bare_agent()
        calls = {"n": 0}

        import hermes_cli.config as _cfg_mod

        def counting_load():
            calls["n"] += 1
            return {"display": {"file_mutation_verifier": True}}

        monkeypatch.setattr(_cfg_mod, "load_config", counting_load)

        # First call reads config and caches the result.
        assert agent._file_mutation_verifier_enabled() is True
        assert calls["n"] == 1
        # Subsequent calls must not re-read config.
        assert agent._file_mutation_verifier_enabled() is True
        assert agent._file_mutation_verifier_enabled() is True
        assert calls["n"] == 1
        # Env override stays authoritative even after the cache is warm.
        monkeypatch.setenv("AGENTX_FILE_MUTATION_VERIFIER", "0")
        assert agent._file_mutation_verifier_enabled() is False
        assert calls["n"] == 1  # env path never touches config

    def test_cache_respects_config_value(self, monkeypatch):
        """A disabled config value is cached as False, not re-read."""
        monkeypatch.delenv("AGENTX_FILE_MUTATION_VERIFIER", raising=False)
        agent = _bare_agent()

        import hermes_cli.config as _cfg_mod
        monkeypatch.setattr(
            _cfg_mod, "load_config", lambda: {"display": {"file_mutation_verifier": False}}
        )
        assert agent._file_mutation_verifier_enabled() is False
        # Warm cache: flip the underlying config; the agent still reports the
        # cached value (same next-session semantics as _credits_notices_enabled).
        monkeypatch.setattr(
            _cfg_mod, "load_config", lambda: {"display": {"file_mutation_verifier": True}}
        )
        assert agent._file_mutation_verifier_enabled() is False




# ---------------------------------------------------------------------------
# Module-level invariants
# ---------------------------------------------------------------------------


def test_file_mutating_tools_set_shape():
    """write_file + patch are the only tools the verifier tracks.

    Guard rail: if someone adds a third file-mutating tool (e.g. a new
    ``append_file``), they should also audit whether the verifier should
    track it.  This test fails loudly on unilateral additions.
    """
    assert _FILE_MUTATING_TOOLS == frozenset({"write_file", "patch"})


# ── who the footer is for, and what it should not report ───────────────────
#
# Pilot feedback 2026-11 (Telegram, a Vietnamese non-developer): a reply about
# editing a reminder ended with the English footer, tool tags and "Run git
# status or read_file" — about two scratch scripts the reply never mentioned.


class TestFooterAudience:
    FAILED = {
        "/Users/x/report.md": {"tool": "write_file", "error_preview": "[Errno 13] Permission denied"},
    }

    def test_developer_surfaces_keep_the_full_english_footer(self):
        from run_agent import AIAgent

        out = AIAgent._format_file_mutation_failure_footer(self.FAILED, lang="en")

        assert out.startswith("⚠️ File-mutation verifier: 1 file(s) were NOT modified")
        assert "`git status`" in out
        assert "[write_file] [Errno 13] Permission denied" in out

    def test_plain_footer_drops_tool_tags_raw_errors_and_cli_advice(self):
        from run_agent import AIAgent

        out = AIAgent._format_file_mutation_failure_footer(self.FAILED, plain=True, lang="en")

        assert "could not be saved" in out
        assert "`/Users/x/report.md`" in out
        for jargon in ("write_file", "Errno", "git status", "read_file"):
            assert jargon not in out

    def test_footer_is_written_in_the_readers_language(self):
        from run_agent import AIAgent

        out = AIAgent._format_file_mutation_failure_footer(self.FAILED, plain=True, lang="vi")

        assert out.startswith("⚠️ Kiểm tra tệp: 1 tệp chưa lưu được")
        assert "`/Users/x/report.md`" in out

    def test_overflow_line_is_translated_too(self):
        from run_agent import AIAgent

        failed = {f"/Users/x/f{i}.md": {"tool": "patch", "error_preview": ""} for i in range(12)}
        out = AIAgent._format_file_mutation_failure_footer(failed, lang="vi")

        assert "… và 2 tệp nữa" in out
        assert "[patch] thất bại" in out

    @pytest.mark.parametrize("platform, plain", [
        ("cli", False), ("tui", False), ("acp", False), ("", False), (None, False),
        ("telegram", True), ("desktop", True), ("cron", True), ("Discord", True),
    ])
    def test_only_developer_surfaces_get_the_technical_form(self, platform, plain):
        from run_agent import AIAgent

        agent = AIAgent.__new__(AIAgent)
        agent.platform = platform

        assert agent._verifier_footer_is_plain() is plain

    def test_tts_never_speaks_a_translated_footer(self):
        from run_agent import AIAgent
        from tools.tts_text_normalize import strip_nonspoken_blocks

        footer = AIAgent._format_file_mutation_failure_footer(self.FAILED, plain=True, lang="vi")
        spoken = strip_nonspoken_blocks("Xong rồi anh.\n\n" + footer)

        assert "Xong rồi anh." in spoken
        assert "Kiểm tra tệp" not in spoken
        assert "report.md" not in spoken


class TestScratchFilesAreNotClaims:
    def test_an_unmentioned_temp_file_is_not_reported(self):
        import tempfile

        from run_agent import AIAgent

        scratch = f"{tempfile.gettempdir()}/verify_tools.py"
        failed = {
            scratch: {"tool": "write_file", "error_preview": "x"},
            "/tmp/other_helper.py": {"tool": "write_file", "error_preview": "x"},
        }

        kept = AIAgent._file_mutations_worth_reporting(failed, "Xong anh Hùng. Em đã bỏ tìm kiếm khỏi lịch nhắc.")

        assert kept == {}

    def test_a_temp_file_the_reply_names_is_reported(self):
        from run_agent import AIAgent

        failed = {"/tmp/verify_tools.py": {"tool": "write_file", "error_preview": "x"}}

        assert AIAgent._file_mutations_worth_reporting(failed, "I wrote verify_tools.py to check it.") == failed
        assert AIAgent._file_mutations_worth_reporting(failed, "See /tmp/verify_tools.py") == failed

    def test_a_file_outside_temp_is_always_reported(self):
        """The over-claim the footer exists for needs no file name: "all files
        updated" is enough."""
        from run_agent import AIAgent

        failed = {"/Users/x/project/app.py": {"tool": "patch", "error_preview": "Could not find old_string"}}

        assert AIAgent._file_mutations_worth_reporting(failed, "All files updated.") == failed

    def test_a_scratch_path_is_judged_by_location_not_by_name(self):
        from run_agent import AIAgent

        assert AIAgent._is_scratch_path("/tmp/a.py")
        assert AIAgent._is_scratch_path("/private/tmp/deep/a.py")
        assert not AIAgent._is_scratch_path("/Users/x/tmp_notes.md")
        assert not AIAgent._is_scratch_path("/tmpfiles/a.py")


def test_finalizer_stays_silent_when_only_unmentioned_scratch_writes_failed():
    """End to end through the finalizer's own gate."""
    from run_agent import AIAgent

    agent = AIAgent.__new__(AIAgent)
    agent.platform = "telegram"
    failed = {"/tmp/verify_tools.py": {"tool": "write_file", "error_preview": "[Errno 2] No such file or directory"}}

    reportable = agent._file_mutations_worth_reporting(failed, "Xong anh Hùng.")

    assert agent._format_file_mutation_failure_footer(reportable, plain=agent._verifier_footer_is_plain()) == ""
