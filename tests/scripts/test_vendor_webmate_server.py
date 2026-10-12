"""The vendored bridge must reproduce tracked source plus its downstream patch."""
import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from scripts import vendor_webmate_server as vendor


def test_patched_vendor_build_excludes_dirty_source_and_keeps_provenance(tmp_path, monkeypatch):
    source = tmp_path / "upstream"
    mcp = source / "mcp-server"
    mcp.mkdir(parents=True)
    (source / "brand").mkdir()
    (source / "brand" / "brand.config.json").write_text("{}")
    (mcp / "package.json").write_text(json.dumps({"version": "1.4.0"}))
    (mcp / "source.txt").write_text("baseline\n")
    (mcp / "node_modules").mkdir()
    for command in (
        ["git", "init", "-q"], ["git", "add", "mcp-server", "brand"],
        ["git", "-c", "user.name=Vendor Test", "-c", "user.email=test@localhost", "commit", "-qm", "baseline"],
    ):
        subprocess.run(command, cwd=source, check=True, capture_output=True)
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    (mcp / "source.txt").write_text("patched\n")
    patch = subprocess.check_output(["git", "diff", "--", "mcp-server/source.txt"], cwd=source)
    (mcp / "source.txt").write_text("unrelated dirty work\n")
    entry = tmp_path / "catalog"
    server = entry / "server"
    server.mkdir(parents=True)
    (server / "workmate-lifecycle.patch").write_bytes(patch)
    manifest = entry / "manifest.yaml"
    manifest.write_text(f"install:\n  sha256: {'0' * 64}\n  dev:\n    ref: {'0' * 40}\n")
    monkeypatch.setattr(vendor, "SERVER_DIR", server)
    monkeypatch.setattr(vendor, "MANIFEST", manifest)
    real_run = vendor._run
    built_sources = []

    def run(command, cwd):
        if command[1:] == ["run", "build:skill"]:
            built_sources.append(cwd)
            out = cwd / "release/webmate/scripts" / vendor.BUNDLE_NAME
            out.parent.mkdir(parents=True)
            out.write_bytes((cwd / "source.txt").read_bytes())
            return ""
        return real_run(command, cwd)

    monkeypatch.setattr(vendor, "_run", run)
    for _ in range(2):
        assert vendor.main(["--from", str(source)]) == 0
        bundle = (server / vendor.BUNDLE_NAME).read_bytes()
        assert bundle == b"patched\n"
        assert hashlib.sha256(bundle).hexdigest() in manifest.read_text()
        assert head in manifest.read_text()
        assert hashlib.sha256(patch).hexdigest() in (server / "VERSION").read_text()
        assert (mcp / "source.txt").read_text() == "unrelated dirty work\n"
    assert all(cwd != mcp and not cwd.exists() for cwd in built_sources)
    with pytest.raises(SystemExit, match="cannot verify"):
        vendor.main(["--from", str(source), "--no-build"])
