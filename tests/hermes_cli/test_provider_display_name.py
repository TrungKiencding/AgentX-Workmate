"""What the account's model proxy is CALLED in every picker.

Sign-in writes a ``providers:`` entry for the proxy that serves the account's
models, and that entry's ``name`` is what people read in Settings → Model, in
the composer's model menu, and in ``agentx model``. It used to carry the name
of the software running the proxy; it now reads ``AI Gateway``.

Two halves have to agree or the label splits across installs:

* new sign-ins get the name from :data:`PROVIDER_DISPLAY_NAME`
* configs written before the rename are relabelled by the v34 migration

Both halves must leave the provider SLUG alone — it keys the ``providers:``
entry, the ``model.provider`` pin, and the ``<SLUG>_API_KEY`` env var, so
renaming it would strand every model choice the user has already made.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest
import yaml

from hermes_cli.account_provisioning import (
    LEGACY_PROVIDER_DISPLAY_NAME,
    PROVIDER_DISPLAY_NAME,
    LiteLLMAccountSettings,
    _write_provider_config,
)


@pytest.fixture()
def hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
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


class TestNewSignIn:
    """The label a first sign-in writes."""

    def test_provider_entry_is_named_ai_gateway(self, hermes_home):
        _write_config(hermes_home, {"_config_version": 34})

        _write_provider_config(
            LiteLLMAccountSettings(provider_name="litellm"),
            "https://proxy.example/v1",
            "LITELLM_API_KEY",
            ("Qwen/Qwen3.5-122B-A10B-FP8",),
        )

        raw = yaml.safe_load((hermes_home / "config.yaml").read_text(encoding="utf-8"))
        entry = raw["providers"]["litellm"]
        assert entry["name"] == PROVIDER_DISPLAY_NAME
        # The slug is the key, and it does NOT follow the label.
        assert entry["key_env"] == "LITELLM_API_KEY"

    def test_a_name_the_user_already_set_is_left_alone(self, hermes_home):
        _write_config(
            hermes_home,
            {
                "_config_version": 34,
                "providers": {"litellm": {"name": "Work proxy"}},
            },
        )

        _write_provider_config(
            LiteLLMAccountSettings(provider_name="litellm"),
            "https://proxy.example/v1",
            "LITELLM_API_KEY",
            (),
        )

        raw = yaml.safe_load((hermes_home / "config.yaml").read_text(encoding="utf-8"))
        assert raw["providers"]["litellm"]["name"] == "Work proxy"


class TestV34Migration:
    """Relabelling configs written before the rename."""

    def test_renames_the_old_default_label(self, hermes_home):
        path = _write_config(
            hermes_home,
            {
                "_config_version": 33,
                "model": {
                    "default": "Qwen/Qwen3.5-122B-A10B-FP8",
                    "provider": "litellm",
                },
                "providers": {
                    "litellm": {
                        "name": LEGACY_PROVIDER_DISPLAY_NAME,
                        "base_url": "https://proxy.example/v1",
                        "key_env": "LITELLM_API_KEY",
                    }
                },
            },
        )

        with patch.dict(os.environ, {"AGENTX_HOME": str(hermes_home)}):
            results = _run_ladder(33)

        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert raw["providers"]["litellm"]["name"] == PROVIDER_DISPLAY_NAME
        # Slug, endpoint, key env, and the saved model pin all survive: the
        # migration moves a label, not an identity.
        assert set(raw["providers"]) == {"litellm"}
        assert raw["providers"]["litellm"]["base_url"] == "https://proxy.example/v1"
        assert raw["providers"]["litellm"]["key_env"] == "LITELLM_API_KEY"
        assert raw["model"] == {
            "default": "Qwen/Qwen3.5-122B-A10B-FP8",
            "provider": "litellm",
        }
        assert any(PROVIDER_DISPLAY_NAME in line for line in results["config_added"])

    def test_leaves_a_hand_written_label_alone(self, hermes_home):
        path = _write_config(
            hermes_home,
            {
                "_config_version": 33,
                "providers": {
                    "mine": {
                        "name": "LiteLLM at home",
                        "base_url": "http://localhost:4000/v1",
                    }
                },
            },
        )

        with patch.dict(os.environ, {"AGENTX_HOME": str(hermes_home)}):
            results = _run_ladder(33)

        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert raw["providers"]["mine"]["name"] == "LiteLLM at home"
        assert not any("providers.mine" in line for line in results["config_added"])

    def test_config_with_no_providers_block_is_untouched(self, hermes_home):
        path = _write_config(hermes_home, {"_config_version": 33, "model": {"default": "x"}})
        before = path.read_text(encoding="utf-8")

        with patch.dict(os.environ, {"AGENTX_HOME": str(hermes_home)}):
            _run_ladder(33)

        assert path.read_text(encoding="utf-8") == before

    def test_is_registered_in_the_ladder(self):
        from hermes_cli.config_defaults import DEFAULT_CONFIG
        from hermes_cli.config_migrations import MIGRATIONS

        targets = [target for target, _ in MIGRATIONS]
        assert 34 in targets
        assert targets == sorted(targets)
        # A step nobody reaches is a step that never runs.
        assert DEFAULT_CONFIG["_config_version"] >= 34
