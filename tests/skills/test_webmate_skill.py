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

    def test_structured_codes_are_taught_with_the_user_facing_fix(self):
        """Failures come back as WEBMATE_* codes (also shown by Workmate as a
        card). The skill must map each to what to tell the user, and must not
        send the user to change bridge settings by hand on a Workmate install.
        """
        prose = _prose()
        for code in (
            "WEBMATE_NOT_INSTALLED",
            "WEBMATE_NOT_CONNECTED",
            "WEBMATE_NOT_SIGNED_IN",
            "WEBMATE_OUTDATED",
            "WEBMATE_PORT_IN_USE",
            "WEBMATE_DISABLED",
        ):
            assert code in prose, code
        assert "Workmate → Settings → Browser" in prose
        # Not signed in is relayed once, never retried in a loop.
        assert "stop rather than retrying" in prose
        # The old ritual — a separate manual sign-in as a prerequisite — is gone.
        assert "does NOT sign in WebMate" not in prose
        assert "open the WebMate side panel once and sign in there" not in prose

    def test_install_instructions_describe_the_bundled_server(self):
        prose = _prose()
        assert "agentx mcp install webmate" in prose
        assert "no clone, no npm" in prose
        assert "agentx-webmate-mcp.mjs" in prose
        assert "npm ci && npm run build" not in prose, "users never build the server themselves"

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
        assert any("agentx mcp install webmate" in s for s in report["next_steps"])
        # Informational lines exist even before anything is installed.
        by_name = {c["name"]: c for c in report["checks"]}
        assert by_name["extension"]["informational"] and "no extension folder" in by_name["extension"]["detail"]
        assert by_name["bridge_state"]["informational"] and "has not run yet" in by_name["bridge_state"]["detail"]

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
        # Bundled server shipped with AgentX, launched by the managed Node; the
        # checkout build is the --dev fallback only.
        assert re.search(r"^\s+type: bundled$", text, re.M)
        assert "${INSTALL_DIR}/server/agentx-webmate-mcp.mjs" in text
        assert 'command: "${NODE}"' in text
        assert 'WEBMATE_DIR: "${AGENTX_ROOT}/webmate"' in text
        assert "entry: mcp-server/dist/index.js" in text
        assert (MANIFEST.parent / "server" / "agentx-webmate-mcp.mjs").is_file()


# ---------------------------------------------------------------------------
# check_bridge.py — the Workmate-managed folder and state.json
# ---------------------------------------------------------------------------


class TestCheckBridgeWorkmateState:
    def _configure(self, home: Path, tmp_path: Path, script_name: str = "agentx-webmate-mcp.mjs") -> Path:
        script = tmp_path / "server" / script_name
        script.parent.mkdir(exist_ok=True)
        script.write_text("// bundled\n")
        _write_config(home, {"command": "/opt/agentx/node/bin/node", "args": [str(script)], "env": {"WEBMATE_DIR": str(tmp_path / "webmate")}})
        return script

    def test_bundled_mjs_counts_as_the_server_build(self, _isolated_home, tmp_path):
        module = load_module()
        script = self._configure(_isolated_home, tmp_path)
        with patch.object(module.shutil, "which", return_value="/fake/bin/node"), patch.object(
            module, "node_version", return_value="v22.12.0"
        ):
            report = module.run_checks(port=1)
        by_name = {c["name"]: c for c in report["checks"]}
        assert by_name["server_build"]["ok"] is True
        assert by_name["server_build"]["detail"] == str(script)
        assert report["webmate_dir"] == str(tmp_path / "webmate"), "WEBMATE_DIR from the entry env wins"

    def test_reports_extension_and_bridge_state(self, _isolated_home, tmp_path):
        module = load_module()
        self._configure(_isolated_home, tmp_path)
        root = tmp_path / "webmate"
        (root / "AgentX WebMate").mkdir(parents=True)
        (root / "AgentX WebMate" / "manifest.json").write_text(json.dumps({"version": "1.0.4"}))
        (root / "pairing.json").write_text(json.dumps({"schema": 1, "token": "x" * 44}))
        (root / "state.json").write_text(json.dumps({
            "schema": 1, "pid": 0, "listening": True, "connected": True, "browser": "Chrome 152",
            "extensionVersion": "1.0.4", "installType": "workmate", "signedIn": False, "protocolVersion": 3,
        }))
        with patch.object(module.shutil, "which", return_value="/fake/bin/node"), patch.object(
            module, "node_version", return_value="v22.12.0"
        ):
            report = module.run_checks(port=1)
        by_name = {c["name"]: c for c in report["checks"]}
        assert report["extension_version"] == "1.0.4"
        assert "1.0.4" in by_name["extension"]["detail"]
        assert "connected — Chrome 152" in by_name["bridge_state"]["detail"]
        assert "NOT signed in" in by_name["bridge_state"]["detail"]
        assert report["bridge_state"]["connected"] is True
        assert any("sign in" in s for s in report["next_steps"])

    def test_paired_but_detached_points_at_workmate_settings(self, _isolated_home, tmp_path):
        module = load_module()
        self._configure(_isolated_home, tmp_path)
        root = tmp_path / "webmate"
        root.mkdir()
        (root / "pairing.json").write_text(json.dumps({"schema": 1, "token": "x" * 44}))
        (root / "state.json").write_text(json.dumps({"schema": 1, "pid": 2_147_000_000, "listening": True, "connected": True}))
        with patch.object(module.shutil, "which", return_value="/fake/bin/node"), patch.object(
            module, "node_version", return_value="v22.12.0"
        ):
            report = module.run_checks(port=1)
        by_name = {c["name"]: c for c in report["checks"]}
        assert "no longer running" in by_name["bridge_state"]["detail"], "a dead pid must not read as connected"
        assert any("Workmate → Settings → Browser" in s for s in report["next_steps"])
        assert not any("Cloud bridge" in s for s in report["next_steps"]), "paired installs are not sent to the Settings URL"

    def test_webmate_dir_falls_back_to_the_install_root(self, _isolated_home, tmp_path, monkeypatch):
        module = load_module()
        monkeypatch.delenv("WEBMATE_DIR", raising=False)
        account_home = _isolated_home / "accounts" / "kien"
        monkeypatch.setenv("AGENTX_HOME", str(account_home))
        assert module.webmate_dir(None) == _isolated_home / "webmate"
        monkeypatch.setenv("AGENTX_HOME", str(account_home / "profiles" / "work"))
        assert module.webmate_dir(None) == _isolated_home / "webmate"
        monkeypatch.setenv("WEBMATE_DIR", str(tmp_path / "elsewhere"))
        assert module.webmate_dir({"env": {"WEBMATE_DIR": "/ignored"}}) == tmp_path / "elsewhere", "the process env wins over the entry env"
