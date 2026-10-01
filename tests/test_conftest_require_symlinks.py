"""The conftest ``require_symlinks`` skip must reach pytest.

``tests/conftest.py`` skips a test marked ``require_symlinks`` when the host
cannot create symbolic links (Windows without developer mode). The skip lives
in the module's ``pytest_runtest_setup``. When a second ``def
pytest_runtest_setup`` was added further down the file, it rebound the name,
pytest registered only that one, and the marked tests in
test_atomic_replace_symlinks.py and test_hermes_constants.py ran on such hosts
instead of skipping. macOS and Linux can create symlinks, so nothing there
noticed.

These tests run a real pytest session rather than calling the hook: a child
pytest registers the real conftest as a plugin, the symlink probe answers no
(and, as the control, yes), and the outcome is read from the child's JUnit
report — what pytest itself reported for the marked test.
"""

import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

_MARKED_TEST = """\
import pytest


@pytest.mark.require_symlinks
def test_marked():
    pass
"""


def _run_marked_test(tmp_path, *, symlinks_supported):
    """Run one ``require_symlinks`` test under the real conftest.

    Returns the test's JUnit ``<testcase>`` element and the child's output.
    """
    # An ini of its own makes tmp_path the child's rootdir: the repo's
    # pyproject (addopts, markers) stays out, and conftest discovery stops here.
    (tmp_path / "pytest.ini").write_text("[pytest]\n", encoding="utf-8")
    (tmp_path / "conftest.py").write_text(
        "import tests.conftest\n"
        "\n"
        f"tests.conftest._check_symlink_support = lambda: {symlinks_supported!r}\n",
        encoding="utf-8",
    )
    (tmp_path / "test_marked.py").write_text(_MARKED_TEST, encoding="utf-8")

    env = dict(os.environ)
    env.pop("PYTEST_ADDOPTS", None)
    env["PYTHONPATH"] = os.pathsep.join(
        p for p in (str(REPO_ROOT), env.get("PYTHONPATH")) if p
    )
    # Registered by PYTEST_PLUGINS, not ``-p``: hermes_cli.main reads a ``-p``
    # in sys.argv as --profile.
    env["PYTEST_PLUGINS"] = ",".join(
        p for p in (env.get("PYTEST_PLUGINS"), "tests.conftest") if p
    )

    report = tmp_path / "report.xml"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "test_marked.py",
            f"--basetemp={tmp_path / 'basetemp'}",
            f"--junitxml={report}",
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    (case,) = ET.parse(report).getroot().iter("testcase")
    return case, output


def test_require_symlinks_skips_where_symlinks_are_unsupported(tmp_path):
    case, output = _run_marked_test(tmp_path, symlinks_supported=False)

    skipped = case.find("skipped")
    assert skipped is not None, f"require_symlinks test was not skipped:\n{output}"
    assert "does not support symbolic links" in skipped.get("message", ""), output


def test_require_symlinks_runs_where_symlinks_work(tmp_path):
    case, output = _run_marked_test(tmp_path, symlinks_supported=True)

    outcomes = [child.tag for child in case if child.tag in ("skipped", "failure", "error")]
    assert outcomes == [], f"require_symlinks test did not pass:\n{output}"
