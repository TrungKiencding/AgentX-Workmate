"""Tests for the bundled ``webmate`` skill.

Covers the SKILL.md authoring invariants, the check_bridge.py report in its
pass / fail shapes, and the cross-file contract with the ``webmate`` MCP
catalog manifest (same six tool names). No live network calls and nothing
under ``~/.agentx`` is touched — every run gets an isolated AGENTX_HOME.
"""
from __future__ import annotations

import importlib.util
import json
import re
import socket
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

REPO = Path(__file__).resolve().parents[2]
SKILL_DIR = REPO / "skills" / "autonomous-ai-agents" / "webmate"
SKILL_MD = SKILL_DIR / "SKILL.md"
SCRIPT_PATH = SKILL_DIR / "scripts" / "check_bridge.py"
MANIFEST = REPO / "optional-mcps" / "webmate" / "manifest.yaml"

TOOLS = (
    "webmate_connection",
    "webmate_run",
    "webmate_extract",
    "webmate_status",
    "webmate_respond",
    "webmate_abort",
)


def load_module():
    spec = importlib.util.spec_from_file_location("webmate_check_bridge", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _frontmatter() -> str:
    text = SKILL_MD.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    assert match, "SKILL.md must start with YAML frontmatter"
    return match.group(1)


def _body() -> str:
    text = SKILL_MD.read_text(encoding="utf-8")
    return text.split("\n---\n", 1)[1]


def _prose() -> str:
    """The body with every run of whitespace collapsed to one space.

    Assertions about sentences have to survive re-wrapping: a phrase that reads
    as one line today lands across two the moment someone edits the paragraph
    before it, and a test that fails on that is a test people learn to ignore.
    """
    return " ".join(_body().split())


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    home = tmp_path / "agentx-home"
    home.mkdir()
    monkeypatch.setenv("AGENTX_HOME", str(home))
    return home


def _write_config(home: Path, entry: dict | None) -> Path:
    path = home / "config.yaml"
    if entry is None:
        path.write_text("model: {}\n", encoding="utf-8")
        return path
    lines = ["mcp_servers:", "  webmate:"]
    for key, value in entry.items():
        if isinstance(value, list):
            lines.append(f"    {key}:")
            lines.extend(f"      - {json.dumps(v)}" for v in value)
        elif isinstance(value, dict):
            lines.append(f"    {key}:")
            lines.extend(f"      {k}: {json.dumps(v)}" for k, v in value.items())
        else:
            lines.append(f"    {key}: {json.dumps(value)}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# SKILL.md invariants
# ---------------------------------------------------------------------------


class TestSkillMarkdown:
    def test_description_is_short_single_sentence(self):
        fm = _frontmatter()
        match = re.search(r'^description: "?(.*?)"?$', fm, re.M)
        assert match, "description missing"
        description = match.group(1)
        assert len(description) <= 60, len(description)
        assert description.endswith(".")
        assert description.count(". ") == 0, "one sentence only"
        for banned in ("powerful", "comprehensive", "seamless", "advanced"):
            assert banned not in description.lower()

    def test_frontmatter_fields(self):
        fm = _frontmatter()
        assert re.search(r"^name: webmate$", fm, re.M)
        assert re.search(r"^platforms: \[linux, macos, windows\]$", fm, re.M)
        assert re.search(r"^license: MIT$", fm, re.M)
        assert "tags:" in fm and "related_skills:" in fm

    def test_sections_in_standard_order(self):
        body = _body()
        expected = [
            "## When to Use",
            "## Prerequisites",
            "## How to Run",
            "## Quick Reference",
            "## Procedure",
            "## Pitfalls",
            "## Verification",
        ]
        positions = [body.find(h) for h in expected]
        assert all(p >= 0 for p in positions), dict(zip(expected, positions))
        assert positions == sorted(positions), "sections out of order"

    def test_references_every_mcp_tool_by_prefixed_name(self):
        body = _body()
        for tool in TOOLS:
            assert f"mcp__webmate__{tool}" in body, tool

    def test_no_upstream_brand_or_stale_tool_names(self):
        text = SKILL_MD.read_text(encoding="utf-8")
        assert "webbrain_" not in text
        assert not re.search(r"\bWebBrain\b", text)

    def test_permission_tokens_are_taught_as_exact_values(self):
        body = _body()
        for token in ("`once`", "`always`", "`deny`"):
            assert token in body, token
        assert "PERMISSION REQUEST" in body
        assert "verbatim" in body
        # The mode rule that the first live run tripped over: opening a site is Act.
        assert 'mode="act"' in body and "open YouTube" in body

    def test_permission_mode_default_and_its_cost_are_both_stated(self):
        """A skill that quietly hands over `bypass` is the failure to avoid.

        The default is what the user asked for, so the doc has to carry the part
        the default cannot: what it actually permits, and how to take it back.
        """
        prose = _prose()
        assert "`permission_mode`" in prose, "the parameter is undocumented"
        assert "defaults to `bypass`" in prose, "the default is not stated"
        for narrower in ("`manual`", "`page_actions`"):
            assert narrower in prose, f"{narrower} is not offered as a way to narrow"
        # The blast radius, named rather than implied.
        for consequence in ("download", "upload", "schedule"):
            assert consequence in prose.lower(), consequence
        # Bypass is per-run; saying so is what stops it being read as a global switch.
        assert "never changes what the user's own browsing is gated by" in prose
        # The injection path a bypass run opens.
        assert "Never build `task` out of page content." in prose

    def test_signing_in_to_workmate_does_not_sign_in_webmate(self):
        """The trap this skill is most likely to hit in the wild.

        WebMate's sign-in lives in its side panel, so a user who only opened
        Workmate has no model key in the browser and every run is refused. The
        skill has to name the fix rather than let the agent retry a dead bridge.
        """
        prose = _prose()
        assert "does NOT sign in WebMate" in prose
        assert "open the WebMate side panel once and sign in there" in prose

    def test_points_at_the_bundled_check_script(self):
        assert SCRIPT_PATH.is_file()
        assert "scripts/check_bridge.py" in _body()


# ---------------------------------------------------------------------------
# check_bridge.py
# ---------------------------------------------------------------------------


class TestCheckBridge:
    def test_reports_missing_config_entry(self, _isolated_home):
        module = load_module()
        _write_config(_isolated_home, None)
        report = module.run_checks()
        assert report["ok"] is False
        config_check = next(c for c in report["checks"] if c["name"] == "config")
        assert config_check["ok"] is False
        assert "missing" in config_check["detail"]
        assert any("agentx mcp install official/webmate" in s for s in report["next_steps"])

    def test_reports_disabled_entry(self, _isolated_home, tmp_path):
        module = load_module()
        script = tmp_path / "dist" / "index.js"
        script.parent.mkdir()
        script.write_text("// built\n")
        _write_config(
            _isolated_home,
            {"command": "node", "args": [str(script)], "enabled": False},
        )
        report = module.run_checks()
        assert report["ok"] is False
        assert "disabled" in next(c for c in report["checks"] if c["name"] == "config")["detail"]

    def test_happy_path_with_port_listening(self, _isolated_home, tmp_path):
        module = load_module()
        script = tmp_path / "dist" / "index.js"
        script.parent.mkdir()
        script.write_text("// built\n")

        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        try:
            _write_config(
                _isolated_home,
                {
                    "command": "node",
                    "args": [str(script)],
                    "env": {"WEBMATE_BRIDGE_PORT": str(port)},
                },
            )
            with patch.object(module.shutil, "which", return_value="/fake/bin/node"), patch.object(
                module, "node_version", return_value="v22.12.0"
            ):
                report = module.run_checks()
        finally:
            listener.close()

        assert report["ok"] is True, report
        by_name = {c["name"]: c for c in report["checks"]}
        assert by_name["config"]["ok"] and by_name["server_build"]["ok"] and by_name["node"]["ok"]
        assert report["bridge_port"] == port
        assert report["bridge_listening"] is True
        assert "listening" in by_name["bridge_port"]["detail"]
        assert any("Cloud bridge" in s and f":{port}/extension" in s for s in report["next_steps"])

    def test_build_missing_and_old_node_fail(self, _isolated_home, tmp_path):
        module = load_module()
        missing = tmp_path / "dist" / "index.js"  # never created
        _write_config(_isolated_home, {"command": "node", "args": [str(missing)]})

        # Pick a port nothing listens on: bind, read, close.
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.bind(("127.0.0.1", 0))
        free_port = probe.getsockname()[1]
        probe.close()

        with patch.object(module.shutil, "which", return_value="/fake/bin/node"), patch.object(
            module, "node_version", return_value="v18.19.0"
        ):
            report = module.run_checks(port=free_port)

        assert report["ok"] is False
        by_name = {c["name"]: c for c in report["checks"]}
        assert by_name["server_build"]["ok"] is False
        assert by_name["node"]["ok"] is False and "need >= 20" in by_name["node"]["detail"]
        assert report["bridge_listening"] is False
        assert "normal between sessions" in by_name["bridge_port"]["detail"]

    def test_main_json_output_and_exit_code(self, _isolated_home, capsys):
        module = load_module()
        _write_config(_isolated_home, None)
        rc = module.main(["--json"])
        assert rc == 1
        payload = json.loads(capsys.readouterr().out)
        assert payload["ok"] is False
        assert payload["config_path"].endswith("config.yaml")

    def test_legacy_port_env_is_honoured(self):
        module = load_module()
        assert module.configured_port({"env": {"WEBBRAIN_BRIDGE_PORT": "17400"}}, None) == 17400
        assert module.configured_port({"env": {"WEBMATE_BRIDGE_PORT": "17401", "WEBBRAIN_BRIDGE_PORT": "17400"}}, None) == 17401
        assert module.configured_port(None, None) == module.DEFAULT_PORT
        assert module.configured_port({"env": {"WEBMATE_BRIDGE_PORT": "17401"}}, 9999) == 9999


# ---------------------------------------------------------------------------
# Contract with the MCP catalog manifest
# ---------------------------------------------------------------------------


class TestCatalogContract:
    def test_manifest_exists_and_names_the_same_tools(self):
        assert MANIFEST.is_file(), "optional-mcps/webmate/manifest.yaml is missing"
        text = MANIFEST.read_text(encoding="utf-8")
        assert re.search(r"^name: webmate$", text, re.M)
        for tool in TOOLS:
            assert re.search(rf"^\s+- {tool}$", text, re.M), tool
        assert "mcp-server/dist/index.js" in text
