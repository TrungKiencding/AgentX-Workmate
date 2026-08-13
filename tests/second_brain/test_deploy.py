"""The deploy directory's invariants, checked from Python so they cannot rot.

Three of these are the kind of thing that is true on the day it is written and
quietly false a year later:

* the allowlist ``.gitignore`` still ignoring a secret-shaped filename that
  nobody thought of;
* ``.env.example`` still listing every variable the service reads;
* the compose file still passing no secret through anything but ``.env``.

The fourth — that the secret scanner is actually looking — is a shell script
CI runs, exercised here so a developer who breaks the allowlist finds out from
``pytest`` rather than from a pull request.

None of these needs Postgres, so this module is the one in the suite that runs
anywhere.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_DIR = REPO_ROOT / "deploy" / "second-brain"


def _read(name: str) -> str:
    return (DEPLOY_DIR / name).read_text(encoding="utf-8")


class TestGitignoreAllowlist:
    """Everything is ignored until somebody names it on purpose."""

    @pytest.mark.parametrize(
        "filename",
        [
            ".env",
            ".env.local",
            "secrets.yaml",
            "kek.txt",
            "admin-key.json",
            "backup-20260813T101500Z.sql",
            "postgres-dump.tar.gz",
            "notes-with-the-password.md",
        ],
    )
    def test_a_secret_shaped_file_is_ignored(self, filename):
        # `git check-ignore` exits 0 when the path IS ignored. The point of an
        # allowlist is that this holds for names nobody anticipated, which is
        # why the list above includes some that no denylist would cover.
        result = subprocess.run(
            ["git", "check-ignore", "-q", f"deploy/second-brain/{filename}"],
            cwd=REPO_ROOT,
            check=False,
        )

        assert result.returncode == 0, (
            f"deploy/second-brain/{filename} is NOT ignored. The allowlist in "
            "deploy/second-brain/.gitignore has a hole in it."
        )

    @pytest.mark.parametrize(
        "filename",
        [
            ".gitignore",
            "docker-compose.yml",
            "Dockerfile",
            "Caddyfile",
            "Makefile",
            ".env.example",
            "README.md",
        ],
    )
    def test_the_files_that_must_ship_are_not_ignored(self, filename):
        result = subprocess.run(
            ["git", "check-ignore", "-q", f"deploy/second-brain/{filename}"],
            cwd=REPO_ROOT,
            check=False,
        )

        # Exit 1 means "not ignored", which is what these need.
        assert result.returncode == 1, f"{filename} is ignored but must be committed"

    def test_every_shipped_file_exists(self):
        for filename in (
            ".gitignore",
            "docker-compose.yml",
            "Dockerfile",
            "Caddyfile",
            "Makefile",
            ".env.example",
            "README.md",
        ):
            assert (DEPLOY_DIR / filename).is_file(), f"{filename} is missing"


class TestEnvExample:
    """The operator's only complete list of what the service reads."""

    def test_it_names_every_variable_settings_resolves(self):
        from second_brain import settings as settings_module

        example = _read(".env.example")
        declared = {
            value
            for name, value in vars(settings_module).items()
            if name.endswith("_ENV_VAR") and isinstance(value, str)
        }

        missing = sorted(name for name in declared if name not in example)
        assert not missing, (
            "second_brain/settings.py reads these and .env.example does not "
            f"mention them: {missing}. An operator has no other complete list."
        )

    def test_it_names_the_realm_variables_the_service_verifies_against(self):
        # Not read through `settings.py` — the Keycloak provider reads them
        # itself — so nothing above would catch their absence.
        example = _read(".env.example")

        for name in (
            "AGENTX_DASHBOARD_KEYCLOAK_BASE_URL",
            "AGENTX_DASHBOARD_KEYCLOAK_REALM",
            "AGENTX_DASHBOARD_KEYCLOAK_CLIENT_ID",
        ):
            assert name in example

    def test_it_carries_no_real_looking_secret(self):
        example = _read(".env.example")
        values = [
            line.split("=", 1)[1].strip()
            for line in example.splitlines()
            if "=" in line and not line.lstrip().startswith("#")
        ]

        for value in values:
            assert not value.startswith("sk-"), f"a real-looking key is in .env.example: {value}"
            # 32 bytes of base64 is 44 characters. Anything that shape in a
            # template is either a real KEK or an invitation to reuse one.
            assert not re.fullmatch(r"[A-Za-z0-9+/]{43}=", value), (
                "a real-looking KEK is in .env.example"
            )

    def test_the_kek_placeholder_is_not_a_usable_kek(self):
        from second_brain.errors import BrainConfigError
        from second_brain.settings import decode_kek

        placeholder = next(
            line.split("=", 1)[1].strip()
            for line in _read(".env.example").splitlines()
            if line.startswith("AGENTX_BRAIN_KEK=")
        )

        # Non-empty so `docker compose config` validates, invalid so the
        # service refuses to start with a message naming the fix.
        assert placeholder
        with pytest.raises(BrainConfigError):
            decode_kek(placeholder)


class TestComposeFile:
    def test_no_secret_is_inlined(self):
        compose = _read("docker-compose.yml")

        # Every secret must arrive through .env, which the allowlist keeps out
        # of git. A value written into this file is a value that gets
        # committed.
        for line in compose.splitlines():
            if "AGENTX_BRAIN_KEK:" in line or "AGENTX_LITELLM_ADMIN_KEY:" in line:
                assert "${" in line, f"secret inlined in compose: {line.strip()}"

    def test_only_the_tls_terminator_publishes_ports(self):
        import yaml

        compose = yaml.safe_load(_read("docker-compose.yml"))

        publishing = {
            name
            for name, service in compose["services"].items()
            if service.get("ports")
        }

        # Publishing 8811 "just for testing" publishes an endpoint that mints
        # model keys.
        assert publishing == {"caddy"}

    def test_the_api_waits_for_a_healthy_database(self):
        import yaml

        compose = yaml.safe_load(_read("docker-compose.yml"))

        assert compose["services"]["brain"]["depends_on"]["postgres"] == {
            "condition": "service_healthy"
        }

    @pytest.mark.skipif(
        shutil.which("docker") is None, reason="docker is not installed"
    )
    def test_it_validates(self):
        result = subprocess.run(
            ["docker", "compose", "--env-file", ".env.example", "config", "--quiet"],
            cwd=DEPLOY_DIR,
            capture_output=True,
            check=False,
            text=True,
        )

        if result.returncode != 0 and "Cannot connect to the Docker daemon" in (
            result.stderr or ""
        ):
            pytest.skip("the Docker daemon is not running")

        assert result.returncode == 0, result.stderr


class TestSecretScanning:
    @pytest.mark.skipif(
        shutil.which("gitleaks") is None,
        reason="gitleaks is not installed (brew install gitleaks)",
    )
    def test_the_canary_proves_the_scanner_is_awake(self):
        # The same script CI runs: plant a secret, require it to be found,
        # take it away. A green scan means "nothing found", not "nothing
        # looked for".
        result = subprocess.run(
            [str(REPO_ROOT / "scripts" / "check-secret-scanning.sh")],
            cwd=REPO_ROOT,
            capture_output=True,
            check=False,
            text=True,
        )

        assert result.returncode == 0, result.stdout + result.stderr

    def test_the_canary_file_is_never_left_behind(self):
        # It lives under deploy/, which is ignored by the allowlist, so a
        # leftover would not be committed — but it would sit on a developer's
        # disk containing a token shape, which is a poor thing to leave lying
        # around.
        assert not (DEPLOY_DIR / ".secret-scanning-canary").exists()
