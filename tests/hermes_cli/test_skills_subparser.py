"""Test that skills subparser doesn't conflict (regression test for #898)."""

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_no_duplicate_skills_subparser():
    """Ensure 'skills' subparser is only registered once to avoid Python 3.11+ crash.

    Python 3.11 changed argparse to raise an exception on duplicate subparser
    names instead of silently overwriting (see CPython #94331).

    This test will fail with:
        argparse.ArgumentError: argument command: conflicting subparser: skills

    if the duplicate 'skills' registration is reintroduced.

    The fresh import runs in a child interpreter. Deleting
    ``sys.modules['hermes_cli.main']`` and re-importing it in this process (as
    this test used to) left every other test module holding the old module:
    their ``PROJECT_ROOT`` / helper patches no longer reached the update flow,
    which ran ``npm ci``, ``git stash`` and ``git checkout main`` against the
    developer's checkout (2026-10-01).
    """
    result = subprocess.run(
        [sys.executable, "-c", "import hermes_cli.main"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert "conflicting subparser" not in result.stderr, (
        f"Duplicate subparser detected. See issue #898 for details.\n{result.stderr}"
    )
    assert result.returncode == 0, result.stderr
