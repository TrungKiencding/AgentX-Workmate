"""Regression: installer/bootstrap must recover from diverged managed clones.

When ``~/.agentx/agentx-agent`` has local-only commits (or diverged history),
``git pull --ff-only`` fails with exit 128 and bootstrap aborts at the
repository stage. ``agentx update`` already resets to ``origin/$BRANCH`` in
that case; both installer scripts must do the same.

Fixes the bootstrap failure seen in #53257 and desktop update paths that run
``install.ps1`` / ``install.sh`` non-interactively.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"
INSTALL_PS1 = REPO_ROOT / "scripts" / "install.ps1"


def _extract_install_ps1_branch_update_block() -> str:
    text = INSTALL_PS1.read_text()
    match = re.search(
        r"(?P<block>git -c windows\.appendAtomically=false checkout \$Branch.*?elseif \(\$Tag\))",
        text,
        re.DOTALL,
    )
    assert match is not None, "branch update block not found in install.ps1"
    return match["block"]


def test_install_sh_resets_when_ff_only_pull_fails(tmp_path: Path) -> None:
    def git(root: Path, *args: str) -> str:
        return subprocess.check_output(
            ["git", "-c", "user.email=t@t", "-c", "user.name=t", *args],
            cwd=root,
            text=True,
        ).strip()

    origin = tmp_path / "origin"
    origin.mkdir()
    git(origin, "init", "-b", "main")
    (origin / "f").write_text("base")
    git(origin, "add", ".")
    git(origin, "commit", "-m", "base")
    repo = tmp_path / "agentx-agent"
    git(tmp_path, "clone", origin.as_uri(), str(repo))
    (repo / "local").write_text("local commit")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "local")
    (origin / "remote").write_text("remote commit")
    git(origin, "add", ".")
    git(origin, "commit", "-m", "remote")
    result = subprocess.run(
        [
            "bash",
            str(INSTALL_SH),
            "--stage",
            "repository",
            "--non-interactive",
            "--dir",
            str(repo),
            "--agentx-home",
            str(tmp_path / "home"),
        ],
        env={**os.environ, "AGENTX_REPO_URL": origin.as_uri()},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert git(repo, "rev-parse", "HEAD") == git(origin, "rev-parse", "HEAD")


def test_install_ps1_resets_when_ff_only_pull_fails() -> None:
    block = _extract_install_ps1_branch_update_block()

    assert "pull --ff-only origin $Branch" in block
    assert 'reset --hard "origin/$Branch"' in block
    assert "Fast-forward not possible" in block

    pull_idx = block.find("pull --ff-only origin $Branch")
    reset_idx = block.find('reset --hard "origin/$Branch"')
    assert pull_idx != -1 and reset_idx != -1
    assert pull_idx < reset_idx, "ff-only pull must be attempted before reset fallback"
