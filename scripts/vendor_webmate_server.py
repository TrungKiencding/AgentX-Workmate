#!/usr/bin/env python3
"""Refresh the bundled AgentX WebMate MCP server from a WebMate checkout.

The catalog entry ``optional-mcps/webmate`` ships the MCP server as one file
(``server/agentx-webmate-mcp.mjs``) so a user machine needs neither git nor
npm. That file is produced in the WebMate repository by
``npm --prefix mcp-server run build:skill`` and copied here; this script does
the copy and keeps the three places that pin it in step:

* ``optional-mcps/webmate/server/agentx-webmate-mcp.mjs``  the bundle itself
* ``optional-mcps/webmate/server/SHA256SUMS`` and ``VERSION``  provenance
* ``optional-mcps/webmate/manifest.yaml`` → ``install.sha256`` (enforced at
  install time) and ``install.dev.ref`` (the checkout's HEAD)

Usage::

    python scripts/vendor_webmate_server.py --from ../AgentX-WebMate [--no-build]

Stdlib only. Never touches anything outside this repository.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ENTRY_DIR = REPO / "optional-mcps" / "webmate"
SERVER_DIR = ENTRY_DIR / "server"
BUNDLE_NAME = "agentx-webmate-mcp.mjs"
MANIFEST = ENTRY_DIR / "manifest.yaml"


def _run(cmd: list[str], cwd: Path) -> str:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd),
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        check=False,
    )
    if proc.returncode != 0:
        raise SystemExit(f"{' '.join(cmd)} failed in {cwd}:\n{proc.stderr or proc.stdout}")
    return proc.stdout.strip()


def _replace_once(text: str, pattern: str, replacement: str, label: str) -> str:
    new_text, count = re.subn(pattern, replacement, text, count=1, flags=re.M)
    if count != 1:
        raise SystemExit(f"could not update {label} in {MANIFEST}: pattern not found")
    return new_text


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--from", dest="source", required=True, type=Path, help="path to an AgentX-WebMate checkout")
    parser.add_argument("--no-build", action="store_true", help="copy the existing mcp-server/release bundle without rebuilding")
    args = parser.parse_args(argv)

    source = args.source.expanduser().resolve()
    mcp_dir = source / "mcp-server"
    if not (mcp_dir / "package.json").is_file():
        raise SystemExit(f"{source} is not an AgentX-WebMate checkout (no mcp-server/package.json)")

    if not args.no_build:
        npm = shutil.which("npm")
        if not npm:
            raise SystemExit("npm is required to build the bundle (or pass --no-build)")
        print(f"building the bundle in {mcp_dir} …")
        _run([npm, "run", "build:skill"], mcp_dir)

    built = mcp_dir / "release" / "webmate" / "scripts" / BUNDLE_NAME
    if not built.is_file():
        raise SystemExit(f"bundle not found at {built}; run `npm --prefix mcp-server run build:skill` in the WebMate checkout")

    version = json.loads((mcp_dir / "package.json").read_text(encoding="utf-8"))["version"]
    head = _run(["git", "rev-parse", "HEAD"], source)
    dirty = bool(_run(["git", "status", "--porcelain", "--", "mcp-server", "brand/brand.config.json"], source))
    if dirty:
        print("WARNING: the WebMate checkout has uncommitted mcp-server changes; install.dev.ref will not reproduce this bundle", file=sys.stderr)

    SERVER_DIR.mkdir(parents=True, exist_ok=True)
    target = SERVER_DIR / BUNDLE_NAME
    tmp = target.with_suffix(".mjs.tmp")
    shutil.copyfile(built, tmp)
    tmp.replace(target)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()

    (SERVER_DIR / "SHA256SUMS").write_text(f"{digest}  {BUNDLE_NAME}\n", encoding="utf-8")
    built_at = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (SERVER_DIR / "VERSION").write_text(
        f"{version}\n"
        f"source: https://github.com/astralxkienlt/agentx-webmate/tree/{head}/mcp-server\n"
        f"built: {built_at} with `npm run build:skill` (esbuild single-file ESM bundle, Node >= 20)\n",
        encoding="utf-8",
    )

    manifest = MANIFEST.read_text(encoding="utf-8")
    manifest = _replace_once(manifest, r"^(\s+sha256:\s*)[0-9a-f]{64}\s*$", rf"\g<1>{digest}", "install.sha256")
    manifest = _replace_once(manifest, r"^(\s+ref:\s*)[0-9a-f]{40}\s*$", rf"\g<1>{head}", "install.dev.ref")
    MANIFEST.write_text(manifest, encoding="utf-8")

    print(f"vendored {BUNDLE_NAME} v{version} ({target.stat().st_size // 1024} KB) sha256 {digest[:12]}… from {head[:10]}")
    print("next: run `pytest tests/hermes_cli/test_mcp_catalog.py tests/skills/test_webmate_skill.py` and commit optional-mcps/webmate")
    return 0


if __name__ == "__main__":
    sys.exit(main())
