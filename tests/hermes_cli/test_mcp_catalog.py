"""Tests for hermes_cli.mcp_catalog and hermes_cli.mcp_picker.

Manifest parsing, install/uninstall config writes, and picker plumbing
are exercised here. Anything that would actually clone a repo or
launch an MCP is mocked.
"""

from __future__ import annotations

import re
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _default_mock_probe(monkeypatch):
    """By default tests run the probe-fails path so install_entry() doesn\'t
    try to talk to a real MCP server.

    Individual tests that exercise probe-success behaviour patch
    ``hermes_cli.mcp_catalog._probe_tools`` themselves.
    """
    # Patch the catalog\'s probe wrapper, not the underlying
    # mcp_config._probe_single_server (so tests stay decoupled from that
    # module\'s plumbing).
    import hermes_cli.mcp_catalog as mc

    monkeypatch.setattr(mc, "_probe_tools", lambda name: None)


@pytest.fixture
def catalog_dir(tmp_path, monkeypatch):
    """Provide an isolated optional-mcps/ directory."""
    cat = tmp_path / "optional-mcps"
    cat.mkdir()
    monkeypatch.setenv("AGENTX_OPTIONAL_MCPS", str(cat))
    return cat


@pytest.fixture(autouse=True)
def _isolate_hermes_home(tmp_path, monkeypatch):
    """Redirect all config I/O to a temp AGENTX_HOME."""
    hh = tmp_path / "agentx-home"
    hh.mkdir()
    monkeypatch.setenv("AGENTX_HOME", str(hh))
    monkeypatch.setattr(
        "hermes_cli.config.get_hermes_home", lambda: hh
    )
    monkeypatch.setattr(
        "hermes_cli.config.get_config_path", lambda: hh / "config.yaml"
    )
    monkeypatch.setattr(
        "hermes_cli.config.get_env_path", lambda: hh / ".env"
    )
    # mcp_catalog grabs get_hermes_home() lazily through hermes_constants
    monkeypatch.setattr(
        "hermes_constants.get_hermes_home", lambda: hh
    )
    return hh


def _write_manifest(catalog_dir: Path, name: str, body: dict) -> Path:
    entry_dir = catalog_dir / name
    entry_dir.mkdir(exist_ok=True)
    path = entry_dir / "manifest.yaml"
    with open(path, "w") as f:
        yaml.safe_dump(body, f)
    return path


def _basic_manifest(name: str = "demo", **overrides) -> dict:
    body = {
        "manifest_version": 1,
        "name": name,
        "description": "Demo MCP",
        "source": "https://example.com",
        "transport": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "demo-mcp"],
        },
        "auth": {"type": "none"},
    }
    body.update(overrides)
    return body


def _entry(name: str):
    """Wrapper that asserts entry exists (satisfies type-checker + nicer failure msg)."""
    from hermes_cli.mcp_catalog import get_entry

    e = get_entry(name)
    assert e is not None, f"catalog entry {name!r} missing"
    return e


# ---------------------------------------------------------------------------
# Manifest parsing
# ---------------------------------------------------------------------------


class TestManifestParsing:
    def test_minimal_valid(self, catalog_dir):
        _write_manifest(catalog_dir, "demo", _basic_manifest())
        from hermes_cli.mcp_catalog import list_catalog

        entries = list_catalog()
        assert len(entries) == 1
        e = entries[0]
        assert e.name == "demo"
        assert e.transport.type == "stdio"
        assert e.transport.command == "npx"
        assert e.transport.args == ["-y", "demo-mcp"]
        assert e.auth.type == "none"
        assert e.install is None

    def test_api_key_auth(self, catalog_dir):
        body = _basic_manifest(
            auth={
                "type": "api_key",
                "env": [
                    {"name": "DEMO_KEY", "prompt": "API key", "secret": True},
                    {"name": "DEMO_URL", "prompt": "Base URL", "secret": False, "required": False},
                ],
            }
        )
        _write_manifest(catalog_dir, "demo", body)
        from hermes_cli.mcp_catalog import list_catalog

        e = list_catalog()[0]
        assert e.auth.type == "api_key"
        assert len(e.auth.env) == 2
        assert e.auth.env[0].name == "DEMO_KEY"
        assert e.auth.env[0].secret is True
        assert e.auth.env[1].required is False
        assert e.auth.env[1].secret is False

    def test_http_api_key_builds_bearer_headers_template(self, catalog_dir):
        body = _basic_manifest(
            transport={"type": "http", "url": "https://mcp.example.com/sse"},
            auth={
                "type": "api_key",
                "env": [{"name": "MCP_DEMO_API_KEY", "prompt": "key", "secret": True}],
            },
        )
        _write_manifest(catalog_dir, "demo", body)
        from hermes_cli.mcp_catalog import _build_server_config

        cfg = _build_server_config(_entry("demo"), None)
        assert cfg["url"] == "https://mcp.example.com/sse"
        assert cfg["headers"] == {"Authorization": "Bearer ${MCP_DEMO_API_KEY}"}

    def test_http_api_key_requires_matching_env_declaration(self, catalog_dir):
        """http+api_key manifests must declare the env key the header references.

        install_entry only persists auth.env-declared vars; a manifest naming
        its key e.g. N8N_API_KEY would install cleanly but send a literal
        ${MCP_DEMO_API_KEY} placeholder at connect time (silent 401).
        """
        body = _basic_manifest(
            transport={"type": "http", "url": "https://mcp.example.com/sse"},
            auth={
                "type": "api_key",
                "env": [{"name": "DEMO_API_KEY", "prompt": "key", "secret": True}],
            },
        )
        path = _write_manifest(catalog_dir, "demo", body)
        from hermes_cli.mcp_catalog import CatalogError, _parse_manifest

        with pytest.raises(CatalogError, match="MCP_DEMO_API_KEY"):
            _parse_manifest(path)








# ---------------------------------------------------------------------------
# Install flow
# ---------------------------------------------------------------------------


class TestInstall:
    def test_install_simple_stdio_writes_config(self, catalog_dir):
        _write_manifest(catalog_dir, "demo", _basic_manifest())
        from hermes_cli.mcp_catalog import install_entry
        from hermes_cli.config import load_config

        install_entry(_entry("demo"), enable=True)

        cfg = load_config()
        servers = cfg["mcp_servers"]
        assert "demo" in servers
        assert servers["demo"]["command"] == "npx"
        assert servers["demo"]["args"] == ["-y", "demo-mcp"]
        assert servers["demo"]["enabled"] is True



    def test_install_with_api_key_prompts_and_saves(self, catalog_dir, monkeypatch):
        body = _basic_manifest(
            auth={
                "type": "api_key",
                "env": [{"name": "DEMO_KEY", "prompt": "key", "secret": True}],
            }
        )
        _write_manifest(catalog_dir, "demo", body)

        from hermes_cli import mcp_catalog

        monkeypatch.setattr(mcp_catalog, "_prompt_input", lambda *a, **kw: "secret-val")

        from hermes_cli.mcp_catalog import install_entry
        from hermes_cli.config import get_env_value, load_config

        install_entry(_entry("demo"), enable=True)

        assert get_env_value("DEMO_KEY") == "secret-val"
        assert "demo" in load_config()["mcp_servers"]

    def test_install_http_api_key_writes_bearer_headers(self, catalog_dir, monkeypatch):
        body = _basic_manifest(
            transport={"type": "http", "url": "https://mcp.example.com/sse"},
            auth={
                "type": "api_key",
                "env": [{"name": "MCP_DEMO_API_KEY", "prompt": "key", "secret": True}],
            },
        )
        _write_manifest(catalog_dir, "demo", body)

        from hermes_cli import mcp_catalog

        monkeypatch.setattr(mcp_catalog, "_prompt_input", lambda *a, **kw: "secret-val")

        from hermes_cli.mcp_catalog import install_entry
        from hermes_cli.config import load_config

        install_entry(_entry("demo"), enable=True)

        server = load_config()["mcp_servers"]["demo"]
        assert server["url"] == "https://mcp.example.com/sse"
        assert server["headers"] == {"Authorization": "Bearer secret-val"}
        # The raw file must carry the ${...} template, never the secret —
        # load_config resolves it; config.yaml itself stays secret-free.
        from hermes_cli.config import get_config_path

        raw = get_config_path().read_text()
        assert "${MCP_DEMO_API_KEY}" in raw
        assert "secret-val" not in raw




# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------


class TestUninstall:
    def test_uninstall_removes_server_block(self, catalog_dir):
        _write_manifest(catalog_dir, "demo", _basic_manifest())
        from hermes_cli.mcp_catalog import install_entry, uninstall_entry
        from hermes_cli.config import load_config

        install_entry(_entry("demo"), enable=True)
        assert "demo" in load_config().get("mcp_servers", {})

        assert uninstall_entry("demo") is True
        assert "demo" not in load_config().get("mcp_servers", {})

    def test_uninstall_missing_returns_false(self):
        from hermes_cli.mcp_catalog import uninstall_entry

        assert uninstall_entry("nonexistent") is False


# ---------------------------------------------------------------------------
# Picker (non-TTY paths only — interactive curses is integration-tested)
# ---------------------------------------------------------------------------


class TestPicker:
    def test_show_catalog_empty(self, catalog_dir, capsys):
        from hermes_cli.mcp_picker import show_catalog

        show_catalog()
        out = capsys.readouterr().out
        assert "No MCPs in the catalog or configured" in out


    def test_install_by_name_success(self, catalog_dir):
        _write_manifest(catalog_dir, "demo", _basic_manifest())
        from hermes_cli.mcp_picker import install_by_name
        from hermes_cli.config import load_config

        rc = install_by_name("demo")
        assert rc == 0
        assert "demo" in load_config().get("mcp_servers", {})

    def test_run_picker_non_tty_falls_back(self, catalog_dir, capsys, monkeypatch):
        _write_manifest(catalog_dir, "demo", _basic_manifest())
        # Force isatty false
        import sys as _sys
        monkeypatch.setattr(_sys.stdin, "isatty", lambda: False)
        from hermes_cli.mcp_picker import run_picker

        run_picker()
        out = capsys.readouterr().out
        assert "MCP Catalog + configured servers" in out


# ---------------------------------------------------------------------------
# Shipped catalog (sanity: every manifest in the repo's optional-mcps/ parses)
# ---------------------------------------------------------------------------


class TestToolSelection:
    def _make_probed(self, *names):
        """Return a list of (tool_name, description) tuples for mocking."""
        return [(n, f"description of {n}") for n in names]


    def test_probe_fail_with_default_applies_directly(self, catalog_dir):
        body = _basic_manifest(
            tools={"default_enabled": ["a", "b", "c"]},
        )
        _write_manifest(catalog_dir, "demo", body)
        from hermes_cli.mcp_catalog import install_entry
        from hermes_cli.config import load_config

        install_entry(_entry("demo"), enable=True)
        server = load_config()["mcp_servers"]["demo"]
        assert server["tools"]["include"] == ["a", "b", "c"]




    def test_reinstall_preserves_prior_user_selection(
        self, catalog_dir, monkeypatch
    ):
        """Second install of the same entry uses the user\'s prior
        tools.include as the pre-check, NOT the manifest default."""
        body = _basic_manifest(
            tools={"default_enabled": ["alpha"]},
        )
        _write_manifest(catalog_dir, "demo", body)

        import hermes_cli.mcp_catalog as mc
        probed = self._make_probed("alpha", "beta", "gamma")
        monkeypatch.setattr(mc, "_probe_tools", lambda name: probed)
        import sys as _sys
        monkeypatch.setattr(_sys.stdin, "isatty", lambda: False)

        from hermes_cli.mcp_catalog import install_entry
        from hermes_cli.config import load_config, save_config

        # First install
        install_entry(_entry("demo"), enable=True)
        # Simulate user opening configure and choosing beta+gamma
        cfg = load_config()
        cfg["mcp_servers"]["demo"]["tools"]["include"] = ["beta", "gamma"]
        save_config(cfg)

        # Reinstall (non-TTY honors prior_selection over manifest default)
        install_entry(_entry("demo"), enable=True)
        server = load_config()["mcp_servers"]["demo"]
        assert server["tools"]["include"] == ["beta", "gamma"], server


# ---------------------------------------------------------------------------
# Forward-compat / diagnostics
# ---------------------------------------------------------------------------


class TestCatalogDiagnostics:
    def test_future_manifest_version_skipped_with_diagnostic(self, catalog_dir):
        """A manifest with a newer manifest_version is skipped, but the skip
        is reported via catalog_diagnostics so the UI can tell the user."""
        body = _basic_manifest()
        body["manifest_version"] = 999  # Future version
        _write_manifest(catalog_dir, "futuristic", body)
        # Plus one valid entry
        _write_manifest(catalog_dir, "demo", _basic_manifest())

        from hermes_cli.mcp_catalog import list_catalog, catalog_diagnostics

        entries = list_catalog()
        assert [e.name for e in entries] == ["demo"]

        diags = catalog_diagnostics()
        # At least one future_manifest diagnostic for the futuristic entry
        future = [d for d in diags if d[1] == "future_manifest"]
        assert len(future) == 1
        assert future[0][0] == "futuristic"

    def test_invalid_manifest_diagnostic(self, catalog_dir):
        body = _basic_manifest()
        body["transport"] = {"type": "unsupported"}
        _write_manifest(catalog_dir, "broken", body)

        from hermes_cli.mcp_catalog import list_catalog, catalog_diagnostics

        entries = list_catalog()
        assert entries == []
        diags = catalog_diagnostics()
        invalid = [d for d in diags if d[1] == "invalid"]
        assert len(invalid) == 1


# ---------------------------------------------------------------------------
# Picker — custom (non-catalog) MCP rows
# ---------------------------------------------------------------------------


class TestCustomMcpRows:
    def test_custom_mcp_shown_alongside_catalog(self, catalog_dir, capsys):
        """Servers in mcp_servers that aren't in the catalog show up in the
        picker text dump with a 'custom' status."""
        _write_manifest(catalog_dir, "demo", _basic_manifest())

        from hermes_cli.config import load_config, save_config
        cfg = load_config()
        cfg.setdefault("mcp_servers", {})["my-custom"] = {
            "command": "npx",
            "args": ["-y", "my-custom-mcp"],
            "enabled": True,
        }
        save_config(cfg)

        from hermes_cli.mcp_picker import show_catalog
        show_catalog()
        out = capsys.readouterr().out
        assert "demo" in out
        assert "my-custom" in out
        assert "custom" in out  # The status badge


# ---------------------------------------------------------------------------
# Git install — SHA ref detection
# ---------------------------------------------------------------------------


class TestGitInstallShaRef:
    def test_sha_ref_skips_branch_attempt(self, catalog_dir, monkeypatch, tmp_path):
        """When install.ref is a SHA-shaped hex string, _do_git_install
        skips the `git clone --branch <ref>` attempt (which would always fail
        noisily for SHAs) and goes straight to clone + checkout."""
        body = _basic_manifest(
            install={
                "type": "git",
                "url": "https://example.com/x.git",
                "ref": "abc1234567890abcdef1234567890abcdef12345",  # 40-char SHA
                "bootstrap": [],
            },
            transport={
                "type": "stdio",
                "command": "${INSTALL_DIR}/run.sh",
                "args": [],
            },
        )
        _write_manifest(catalog_dir, "demo", body)

        from hermes_cli import mcp_catalog
        from hermes_cli.mcp_catalog import _do_git_install

        calls = []

        class _FakeProc:
            def __init__(self, returncode):
                self.returncode = returncode

        def fake_run(argv, *args, **kwargs):
            calls.append(list(argv))
            # Make every command succeed
            return _FakeProc(returncode=0)

        monkeypatch.setattr(mcp_catalog.subprocess, "run", fake_run)
        monkeypatch.setattr(mcp_catalog.shutil, "which", lambda x: "/usr/bin/git")

        from hermes_cli.mcp_catalog import get_entry
        entry = get_entry("demo")
        assert entry is not None
        _do_git_install(entry)

        # Should have called clone (no --branch) then checkout — NOT clone --branch
        branch_attempts = [c for c in calls if "--branch" in c]
        assert branch_attempts == [], (
            "SHA refs must NOT trigger a --branch clone attempt — that would "
            "always fail noisily before falling back. Calls were: " + repr(calls)
        )
        # Confirm we DID do plain clone + checkout
        clone_calls = [c for c in calls if "clone" in c and "--branch" not in c]
        checkout_calls = [c for c in calls if "checkout" in c]
        assert len(clone_calls) == 1, calls
        assert len(checkout_calls) == 1, calls


# ---------------------------------------------------------------------------
# Existing tools_config converged to tools.include
# ---------------------------------------------------------------------------


class TestToolsConfigIncludeMode:
    def test_configure_mcp_writes_include_not_exclude(self, monkeypatch, tmp_path):
        """`_configure_mcp_tools_interactive` in tools_config.py must write
        `tools.include` (whitelist), matching the rest of the codebase. The
        old behavior wrote `tools.exclude`, which produced inconsistent
        on-disk shapes depending on which UI the user used last."""
        # Build a minimal mcp_servers config + mock probe + checklist
        cfg = {
            "_config_version": 23,
            "mcp_servers": {
                "demo": {
                    "command": "npx",
                    "args": ["-y", "demo-mcp"],
                    "enabled": True,
                }
            },
        }

        import hermes_cli.tools_config as tc
        # Mock the probe to return three tools
        monkeypatch.setattr(
            "tools.mcp_tool.probe_mcp_server_tools",
            lambda: {"demo": [("a", "desc"), ("b", "desc"), ("c", "desc")]},
        )
        # Mock the checklist to return just the first tool
        monkeypatch.setattr(
            "hermes_cli.curses_ui.curses_checklist",
            lambda title, labels, pre_selected, **kw: {0},
        )
        # Mock save_config so we can inspect the write
        saved = {}

        def fake_save(config):
            saved.update(config)

        monkeypatch.setattr(tc, "save_config", fake_save)

        tc._configure_mcp_tools_interactive(cfg)

        # Must have written include, not exclude
        srv = saved["mcp_servers"]["demo"]["tools"]
        assert srv.get("include") == ["a"], srv
        assert "exclude" not in srv, srv


class TestShippedCatalog:
    def test_all_shipped_manifests_parse(self, monkeypatch):
        """Every manifest in optional-mcps/ must parse cleanly.

        This is a contract test — CI will fail if a PR adds a malformed
        manifest. Intentionally NOT a snapshot of catalog names (those are
        expected to change as PRs land).
        """
        # Use the actual repo's optional-mcps directory (no AGENTX_OPTIONAL_MCPS
        # override) so this test catches real manifests.
        monkeypatch.delenv("AGENTX_OPTIONAL_MCPS", raising=False)
        from hermes_cli.mcp_catalog import _catalog_root, _parse_manifest

        root = _catalog_root()
        if not root.exists():
            pytest.skip("optional-mcps/ not present in this checkout")

        manifests = list(root.glob("*/manifest.yaml"))
        # Don't assert minimum count — change-detector test rule. Just parse
        # whatever exists.
        for m in manifests:
            entry = _parse_manifest(m)
            assert entry.name
            assert entry.description
            assert entry.transport.type in ("stdio", "http")

    def test_all_shipped_manifests_are_version_locked(self, monkeypatch):
        """Contract: catalog entries follow the same supply-chain rules as
        pyproject dependencies — everything AgentX fetches/launches is pinned
        to an exact version.

        - git installs must pin a full 40-char commit SHA (branches and tags
          can be moved by the upstream owner; SHAs cannot).
        - package-launcher stdio transports (uvx/npx and their pkg-manager
          equivalents) must carry an exact version specifier on the package
          arg (``pkg==X`` for Python, ``pkg@X`` for npm).

        http transports and ${INSTALL_DIR}-anchored commands have nothing to
        pin at the transport layer (the server runs elsewhere / comes from the
        SHA-pinned clone), so they're exempt.
        """
        monkeypatch.delenv("AGENTX_OPTIONAL_MCPS", raising=False)
        from hermes_cli.mcp_catalog import _catalog_root, _parse_manifest

        root = _catalog_root()
        if not root.exists():
            pytest.skip("optional-mcps/ not present in this checkout")

        launcher_commands = {"uvx", "npx", "pipx", "bunx", "pnpx"}
        problems = []
        for m in root.glob("*/manifest.yaml"):
            entry = _parse_manifest(m)

            if entry.install is not None and entry.install.type == "bundled":
                # A bundled server is pinned by content, and its optional dev
                # checkout by commit — nothing here may float either.
                if not re.fullmatch(r"[0-9a-f]{64}", entry.install.sha256 or ""):
                    problems.append(
                        f"{entry.name}: install.sha256 is not a 64-hex SHA-256 "
                        "(bundled servers must pin the shipped file)"
                    )
                elif not (m.parent / entry.install.bundle).is_file():
                    problems.append(f"{entry.name}: install.bundle {entry.install.bundle!r} is missing")
                if entry.install.dev is not None and not re.fullmatch(
                    r"[0-9a-f]{40}", entry.install.dev.ref
                ):
                    problems.append(
                        f"{entry.name}: install.dev.ref {entry.install.dev.ref!r} is not "
                        "a full 40-char commit SHA"
                    )
            elif entry.install is not None:
                if not re.fullmatch(r"[0-9a-f]{40}", entry.install.ref):
                    problems.append(
                        f"{entry.name}: install.ref {entry.install.ref!r} is not "
                        "a full 40-char commit SHA"
                    )

            t = entry.transport
            if t.type == "stdio" and (t.command or "") in launcher_commands:
                pkg_args = [a for a in t.args if not a.startswith("-")]
                if not pkg_args:
                    problems.append(f"{entry.name}: launcher {t.command} has no package arg")
                    continue
                pkg = pkg_args[0]
                # Exact-pin shapes: pkg==1.2.3 (uvx/pipx) or pkg@1.2.3 /
                # @scope/pkg@1.2.3 (npx/bunx/pnpx). The version must start
                # with a digit — a bare name, a range operator, or an npm
                # dist-tag (@latest, @next) floats and is rejected.
                exact = re.fullmatch(r"[^=@\s]+==\d[\w.\-+]*", pkg) or re.fullmatch(
                    r"(@[\w.\-]+/)?[\w.\-]+@\d[\w.\-+]*", pkg
                )
                if not exact:
                    problems.append(
                        f"{entry.name}: package arg {pkg!r} is not pinned to an "
                        "exact version (expected pkg==X or pkg@X)"
                    )

        assert not problems, "unpinned catalog entries:\n" + "\n".join(problems)


# ---------------------------------------------------------------------------
# Bundled installs (install.type: bundled) — the WebMate shape
# ---------------------------------------------------------------------------


def _bundled_manifest(name: str = "bundledemo", **overrides) -> dict:
    body = _basic_manifest(
        name,
        transport={
            "type": "stdio",
            "command": "${NODE}",
            "args": ["${INSTALL_DIR}/server/demo-mcp.mjs"],
            "env": {"DEMO_DIR": "${AGENTX_ROOT}/demo"},
        },
        install={
            "type": "bundled",
            "bundle": "server/demo-mcp.mjs",
            "dev": {
                "type": "git",
                "url": "https://example.com/demo.git",
                "ref": "a" * 40,
                "entry": "mcp-server/dist/index.js",
                "bootstrap": ["npm ci"],
            },
        },
    )
    body.update(overrides)
    return body


def _write_bundle(catalog_dir: Path, name: str, content: bytes = b"console.log('demo');\n") -> Path:
    import hashlib

    server_dir = catalog_dir / name / "server"
    server_dir.mkdir(parents=True, exist_ok=True)
    bundle = server_dir / "demo-mcp.mjs"
    bundle.write_bytes(content)
    return bundle


class TestBundledInstall:
    def test_parse_bundled_with_dev_fallback(self, catalog_dir):
        _write_manifest(catalog_dir, "bundledemo", _bundled_manifest())
        e = _entry("bundledemo")
        assert e.install is not None
        assert e.install.type == "bundled"
        assert e.install.bundle == "server/demo-mcp.mjs"
        assert e.install.sha256 == ""
        assert e.install.dev is not None and e.install.dev.type == "git"
        assert e.install.dev.ref == "a" * 40
        assert e.install.dev.entry == "mcp-server/dist/index.js"

    def test_bundled_rejects_traversal_and_bad_sha(self, catalog_dir):
        from hermes_cli.mcp_catalog import CatalogError, _parse_manifest

        bad_path = _write_manifest(
            catalog_dir, "bad1", _bundled_manifest("bad1", install={"type": "bundled", "bundle": "../x.mjs"})
        )
        with pytest.raises(CatalogError, match="relative path"):
            _parse_manifest(bad_path)

        bad_sha = _write_manifest(
            catalog_dir,
            "bad2",
            _bundled_manifest("bad2", install={"type": "bundled", "bundle": "s.mjs", "sha256": "nothex"}),
        )
        with pytest.raises(CatalogError, match="SHA-256"):
            _parse_manifest(bad_sha)

        missing_bundle = _write_manifest(
            catalog_dir, "bad3", _bundled_manifest("bad3", install={"type": "bundled"})
        )
        with pytest.raises(CatalogError, match="install.bundle is required"):
            _parse_manifest(missing_bundle)

        nested_bundled = _write_manifest(
            catalog_dir,
            "bad4",
            _bundled_manifest(
                "bad4",
                install={"type": "bundled", "bundle": "s.mjs", "dev": {"type": "bundled", "bundle": "t.mjs"}},
            ),
        )
        with pytest.raises(CatalogError, match="install.dev.type must be 'git'"):
            _parse_manifest(nested_bundled)

        unknown = _write_manifest(catalog_dir, "bad5", _bundled_manifest("bad5", install={"type": "pip"}))
        with pytest.raises(CatalogError, match="'git' or 'bundled'"):
            _parse_manifest(unknown)

    def test_install_points_at_the_shipped_file_with_managed_node(
        self, catalog_dir, _isolate_hermes_home, monkeypatch
    ):
        """No clone, no npm: the config launches the bundled file next to the
        manifest with the Node AgentX manages, and ${AGENTX_ROOT} lands in env."""
        import hashlib
        import subprocess as _sp

        bundle = _write_bundle(catalog_dir, "bundledemo")
        digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
        body = _bundled_manifest()
        body["install"]["sha256"] = digest
        _write_manifest(catalog_dir, "bundledemo", body)

        # A managed Node under the install root, the way install.sh lays it out.
        import hermes_cli.mcp_catalog as mc

        node_dir = _isolate_hermes_home / "node" / "bin"
        node_dir.mkdir(parents=True)
        node_bin = node_dir / "node"
        node_bin.write_text("#!/bin/sh\n")
        monkeypatch.setattr(mc, "get_default_hermes_root", lambda: _isolate_hermes_home)
        monkeypatch.setattr(mc, "iter_hermes_node_dirs", lambda root=None: [node_dir, _isolate_hermes_home / "node"])
        monkeypatch.setattr(mc.sys, "platform", "darwin")

        calls: list = []
        monkeypatch.setattr(_sp, "run", lambda *a, **k: calls.append(a) or pytest.fail("bundled installs must not shell out"))

        from hermes_cli.mcp_catalog import install_entry, installed_servers

        install_entry(_entry("bundledemo"), enable=True)

        cfg = installed_servers()["bundledemo"]
        assert cfg["command"] == str(node_bin)
        assert cfg["args"] == [str(catalog_dir / "bundledemo" / "server" / "demo-mcp.mjs")]
        assert cfg["env"] == {"DEMO_DIR": str(_isolate_hermes_home / "demo")}
        assert cfg["enabled"] is True
        assert not (_isolate_hermes_home / "mcp-installs" / "bundledemo").exists(), "nothing is cloned or copied"

    def test_install_falls_back_to_bare_node_without_a_managed_runtime(self, catalog_dir, _isolate_hermes_home, monkeypatch):
        _write_bundle(catalog_dir, "bundledemo")
        _write_manifest(catalog_dir, "bundledemo", _bundled_manifest())
        import hermes_cli.mcp_catalog as mc

        monkeypatch.setattr(mc, "iter_hermes_node_dirs", lambda root=None: [_isolate_hermes_home / "node" / "bin"])
        from hermes_cli.mcp_catalog import install_entry, installed_servers

        install_entry(_entry("bundledemo"), enable=False)
        cfg = installed_servers()["bundledemo"]
        assert cfg["command"] == "node", "a bare name lets the gateway PATH decide"
        assert cfg["enabled"] is False

    def test_install_refuses_a_bundle_that_does_not_match_its_pin(self, catalog_dir, _isolate_hermes_home):
        _write_bundle(catalog_dir, "bundledemo", b"tampered\n")
        body = _bundled_manifest()
        body["install"]["sha256"] = "0" * 64
        _write_manifest(catalog_dir, "bundledemo", body)
        from hermes_cli.mcp_catalog import CatalogError, install_entry, installed_servers

        with pytest.raises(CatalogError, match="does not match the manifest sha256"):
            install_entry(_entry("bundledemo"), enable=True)
        assert "bundledemo" not in installed_servers()

    def test_install_refuses_a_missing_bundle_and_names_the_dev_way_out(self, catalog_dir, _isolate_hermes_home):
        _write_manifest(catalog_dir, "bundledemo", _bundled_manifest())
        from hermes_cli.mcp_catalog import CatalogError, install_entry

        with pytest.raises(CatalogError, match="--dev"):
            install_entry(_entry("bundledemo"), enable=True)

    def test_dev_install_clones_and_launches_the_checkout_entry(self, catalog_dir, _isolate_hermes_home, monkeypatch):
        _write_manifest(catalog_dir, "bundledemo", _bundled_manifest())
        import hermes_cli.mcp_catalog as mc

        cloned: list = []

        def fake_git_install(entry, install=None):
            cloned.append((entry.name, install.type, install.ref))
            dest = _isolate_hermes_home / "mcp-installs" / entry.name
            dest.mkdir(parents=True, exist_ok=True)
            return dest

        monkeypatch.setattr(mc, "_do_git_install", fake_git_install)
        monkeypatch.setattr(mc, "iter_hermes_node_dirs", lambda root=None: [])
        from hermes_cli.mcp_catalog import install_entry, installed_servers

        install_entry(_entry("bundledemo"), enable=True, dev=True)
        assert cloned == [("bundledemo", "git", "a" * 40)]
        cfg = installed_servers()["bundledemo"]
        assert cfg["args"] == [str(_isolate_hermes_home / "mcp-installs" / "bundledemo" / "mcp-server" / "dist" / "index.js")]

    def test_dev_install_without_a_dev_block_is_refused(self, catalog_dir, _isolate_hermes_home):
        _write_bundle(catalog_dir, "bundledemo")
        _write_manifest(catalog_dir, "bundledemo", _bundled_manifest(install={"type": "bundled", "bundle": "server/demo-mcp.mjs"}))
        from hermes_cli.mcp_catalog import CatalogError, install_entry

        with pytest.raises(CatalogError, match="install.dev"):
            install_entry(_entry("bundledemo"), enable=True, dev=True)

    def test_picker_install_by_name_accepts_the_official_alias(self, catalog_dir, _isolate_hermes_home, monkeypatch):
        _write_bundle(catalog_dir, "bundledemo")
        _write_manifest(catalog_dir, "bundledemo", _bundled_manifest())
        import hermes_cli.mcp_catalog as mc

        monkeypatch.setattr(mc, "iter_hermes_node_dirs", lambda root=None: [])
        from hermes_cli.mcp_picker import install_by_name
        from hermes_cli.mcp_catalog import installed_servers

        assert install_by_name("official/bundledemo") == 0
        assert "bundledemo" in installed_servers()

    def test_shipped_webmate_entry_is_bundled_and_pinned(self, monkeypatch):
        """The real optional-mcps/webmate manifest: bundled, sha256 matches the
        shipped file, dev checkout pinned, six tools, WEBMATE_DIR anchored at
        the install root."""
        import hashlib

        monkeypatch.delenv("AGENTX_OPTIONAL_MCPS", raising=False)
        from hermes_cli.mcp_catalog import _catalog_root, _parse_manifest

        manifest = _catalog_root() / "webmate" / "manifest.yaml"
        if not manifest.is_file():
            pytest.skip("optional-mcps/webmate not present in this checkout")
        e = _parse_manifest(manifest)
        assert e.install is not None and e.install.type == "bundled"
        bundle = manifest.parent / e.install.bundle
        assert bundle.is_file()
        assert hashlib.sha256(bundle.read_bytes()).hexdigest() == e.install.sha256
        sums = (manifest.parent / "server" / "SHA256SUMS").read_text().split()[0]
        assert sums == e.install.sha256, "server/SHA256SUMS must match the manifest pin"
        assert e.install.dev is not None and re.fullmatch(r"[0-9a-f]{40}", e.install.dev.ref)
        assert e.transport.command == "${NODE}"
        assert e.transport.args == ["${INSTALL_DIR}/server/agentx-webmate-mcp.mjs"]
        assert e.transport.env == {"WEBMATE_DIR": "${AGENTX_ROOT}/webmate"}
        assert e.tools.default_enabled == [
            "webmate_connection", "webmate_run", "webmate_extract",
            "webmate_status", "webmate_respond", "webmate_abort",
        ]
