"""Config v36: a stale ``accounts.litellm.mode`` the installer wrote moves to the service.

Until 2026-08-13 AgentX shipped ``mode: "direct"`` and the example config
recommended ``"broker"``. A machine that still pins one of those but holds
neither the admin key nor a broker URL cannot sign in at all. The literal was
ours; the migration rewrites it. A machine that does hold what its mode needs
is a choice, and is left alone.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest
import yaml

from hermes_cli.account_provisioning import ADMIN_KEY_ENV_VAR


@pytest.fixture()
def hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
    monkeypatch.delenv(ADMIN_KEY_ENV_VAR, raising=False)
    return tmp_path


def _write_config(home, config: dict):
    path = home / "config.yaml"
    path.write_text(yaml.safe_dump(config), encoding="utf-8")
    return path


def _run_ladder(current_ver: int) -> dict:
    from hermes_cli.config_migrations import run_migrations

    results: dict = {"env_added": [], "config_added": [], "warnings": []}
    run_migrations(current_ver, results, quiet=True)
    return results


def _litellm(path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))["accounts"]["litellm"]


class TestV36Migration:
    def test_direct_without_an_admin_key_moves_to_the_service(self, hermes_home):
        path = _write_config(
            hermes_home,
            {
                "_config_version": 35,
                "accounts": {"litellm": {"mode": "direct", "base_url": "https://proxy.example"}},
            },
        )

        with patch.dict(os.environ, {"AGENTX_HOME": str(hermes_home)}):
            results = _run_ladder(35)

        litellm = _litellm(path)
        assert litellm["mode"] == "second_brain"
        # Only the mode moves; the rest of the section is somebody's config.
        assert litellm["base_url"] == "https://proxy.example"
        assert any("accounts.litellm.mode=second_brain" in line for line in results["config_added"])

    def test_direct_with_the_admin_key_in_dotenv_is_a_choice_and_stays(self, hermes_home):
        (hermes_home / ".env").write_text(f"{ADMIN_KEY_ENV_VAR}=sk-admin\n", encoding="utf-8")
        path = _write_config(
            hermes_home, {"_config_version": 35, "accounts": {"litellm": {"mode": "direct"}}}
        )

        with patch.dict(os.environ, {"AGENTX_HOME": str(hermes_home)}):
            results = _run_ladder(35)

        assert _litellm(path)["mode"] == "direct"
        assert not any("accounts.litellm.mode" in line for line in results["config_added"])

    def test_broker_without_a_url_moves_to_the_service(self, hermes_home):
        path = _write_config(
            hermes_home,
            {"_config_version": 35, "accounts": {"litellm": {"mode": "broker", "broker_url": ""}}},
        )

        with patch.dict(os.environ, {"AGENTX_HOME": str(hermes_home)}):
            _run_ladder(35)

        assert _litellm(path)["mode"] == "second_brain"

    def test_broker_with_a_url_stays(self, hermes_home):
        path = _write_config(
            hermes_home,
            {
                "_config_version": 35,
                "accounts": {"litellm": {"mode": "broker", "broker_url": "https://keys.example"}},
            },
        )

        with patch.dict(os.environ, {"AGENTX_HOME": str(hermes_home)}):
            _run_ladder(35)

        assert _litellm(path)["mode"] == "broker"

    def test_a_config_already_on_the_service_or_without_a_mode_is_untouched(self, hermes_home):
        for accounts in (
            {"litellm": {"mode": "second_brain"}},
            {"litellm": {"enabled": True}},
            {"second_brain": {"base_url": "https://brain.example"}},
        ):
            path = _write_config(hermes_home, {"_config_version": 35, "accounts": accounts})
            before = path.read_text(encoding="utf-8")

            with patch.dict(os.environ, {"AGENTX_HOME": str(hermes_home)}):
                results = _run_ladder(35)

            assert path.read_text(encoding="utf-8") == before
            assert not any("accounts.litellm.mode" in line for line in results["config_added"])

    def test_is_registered_in_the_ladder(self):
        from hermes_cli.config_defaults import DEFAULT_CONFIG
        from hermes_cli.config_migrations import MIGRATIONS

        targets = [target for target, _ in MIGRATIONS]
        assert 36 in targets
        assert targets == sorted(targets)
        assert DEFAULT_CONFIG["_config_version"] >= 36
