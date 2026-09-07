"""What the account's model proxy is CALLED in every picker.

Sign-in writes a ``providers:`` entry for the proxy that serves the account's
models, and that entry's ``name`` is what people read in Settings → Model, in
the composer's model menu, and in ``agentx model``. It used to carry the name
of the software running the proxy, then a bare ``AI Gateway`` that read as
Vercel's row of the same name; it now reads ``AgentX AI Gateway``.

Four writers have to agree or the label splits across installs:

* new sign-ins get the name from :data:`PROVIDER_DISPLAY_NAME`
* a sign-in that rewrites the entry upgrades an OLDER default of ours in place
* so does the reuse path, which is what a launch with a valid key takes
* configs written before the rename are relabelled by the v34/v35 migrations

Every one of them must leave the provider SLUG alone — it keys the ``providers:``
entry, the ``model.provider`` pin, and the ``<SLUG>_API_KEY`` env var, so
renaming it would strand every model choice the user has already made.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest
import yaml

from hermes_cli.account_provisioning import (
    LEGACY_PROVIDER_DISPLAY_NAMES,
    PROVIDER_DISPLAY_NAME,
    LiteLLMAccountSettings,
    _ensure_vision_follows_main,
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

    def test_provider_entry_carries_the_current_label(self, hermes_home):
        _write_config(hermes_home, {"_config_version": 35})

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
                "_config_version": 35,
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

    @pytest.mark.parametrize("stale", LEGACY_PROVIDER_DISPLAY_NAMES)
    def test_an_older_default_of_ours_is_upgraded_in_place(self, hermes_home, stale):
        # The migration ladder only reaches a machine on update/doctor; a
        # sign-in happens every launch. A label WE wrote follows the rename
        # here so people are not left reading last release's name.
        _write_config(
            hermes_home,
            {
                "_config_version": 35,
                "providers": {"litellm": {"name": stale, "extra_headers": {"x": "1"}}},
            },
        )

        _write_provider_config(
            LiteLLMAccountSettings(provider_name="litellm"),
            "https://proxy.example/v1",
            "LITELLM_API_KEY",
            (),
        )

        entry = yaml.safe_load((hermes_home / "config.yaml").read_text(encoding="utf-8"))[
            "providers"
        ]["litellm"]
        assert entry["name"] == PROVIDER_DISPLAY_NAME
        # A rename touches the label and nothing else the user put here.
        assert entry["extra_headers"] == {"x": "1"}


class TestReusedKey:
    """The path a launch actually takes when the stored key is still good."""

    @pytest.mark.parametrize("stale", LEGACY_PROVIDER_DISPLAY_NAMES)
    def test_a_reused_key_still_gets_the_current_label(self, hermes_home, stale):
        # Reuse writes no provider entry, so without this the rename would
        # only land on machines that happened to re-fetch a key.
        _write_config(
            hermes_home,
            {
                "_config_version": 35,
                "providers": {
                    "litellm": {
                        "name": stale,
                        "base_url": "https://proxy.example/v1",
                        "key_env": "LITELLM_API_KEY",
                    }
                },
            },
        )

        _ensure_vision_follows_main(LiteLLMAccountSettings(provider_name="litellm"), ())

        raw = yaml.safe_load((hermes_home / "config.yaml").read_text(encoding="utf-8"))
        assert raw["providers"]["litellm"]["name"] == PROVIDER_DISPLAY_NAME
        assert raw["providers"]["litellm"]["key_env"] == "LITELLM_API_KEY"

    def test_a_reused_key_on_a_current_config_writes_nothing(self, hermes_home):
        # Every launch takes this path; it must not rewrite config.yaml when
        # there is nothing to change.
        path = _write_config(
            hermes_home,
            {
                "_config_version": 35,
                "providers": {"litellm": {"name": PROVIDER_DISPLAY_NAME}},
            },
        )
        before = path.read_text(encoding="utf-8")

        _ensure_vision_follows_main(LiteLLMAccountSettings(provider_name="litellm"), ())

        assert path.read_text(encoding="utf-8") == before


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
                        "name": LEGACY_PROVIDER_DISPLAY_NAMES[0],
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
        assert 35 in targets
        assert targets == sorted(targets)
        # A step nobody reaches is a step that never runs.
        assert DEFAULT_CONFIG["_config_version"] >= 35


class TestV35Migration:
    """Configs that already took the v34 label, which collided with Vercel's."""

    def test_renames_the_bare_ai_gateway_label(self, hermes_home):
        path = _write_config(
            hermes_home,
            {
                "_config_version": 34,
                "model": {"default": "Qwen/Qwen3.5-122B-A10B-FP8", "provider": "litellm"},
                "providers": {
                    "litellm": {
                        "name": "AI Gateway",
                        "base_url": "https://proxy.example/v1",
                        "key_env": "LITELLM_API_KEY",
                    }
                },
            },
        )

        with patch.dict(os.environ, {"AGENTX_HOME": str(hermes_home)}):
            results = _run_ladder(34)

        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert raw["providers"]["litellm"]["name"] == PROVIDER_DISPLAY_NAME
        assert raw["providers"]["litellm"]["key_env"] == "LITELLM_API_KEY"
        assert raw["model"] == {
            "default": "Qwen/Qwen3.5-122B-A10B-FP8",
            "provider": "litellm",
        }
        assert any(PROVIDER_DISPLAY_NAME in line for line in results["config_added"])

    def test_a_config_below_34_lands_on_the_current_label_once(self, hermes_home):
        # v34 relabels it, then v35 runs on the same file and must find nothing
        # left to change rather than reporting a second rename.
        path = _write_config(
            hermes_home,
            {
                "_config_version": 33,
                "providers": {"litellm": {"name": LEGACY_PROVIDER_DISPLAY_NAMES[0]}},
            },
        )

        with patch.dict(os.environ, {"AGENTX_HOME": str(hermes_home)}):
            results = _run_ladder(33)

        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert raw["providers"]["litellm"]["name"] == PROVIDER_DISPLAY_NAME
        renames = [line for line in results["config_added"] if "providers.litellm.name" in line]
        assert len(renames) == 1

    def test_vercels_own_gateway_row_is_not_the_one_being_renamed(self, hermes_home):
        # The collision this rename resolves: the picker also carries Vercel's
        # ai-gateway. Its entry is not ours and the ladder must not touch it.
        path = _write_config(
            hermes_home,
            {
                "_config_version": 34,
                "providers": {
                    "ai-gateway": {"name": "Vercel AI Gateway"},
                    "litellm": {"name": "AI Gateway"},
                },
            },
        )

        with patch.dict(os.environ, {"AGENTX_HOME": str(hermes_home)}):
            _run_ladder(34)

        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert raw["providers"]["ai-gateway"]["name"] == "Vercel AI Gateway"
        assert raw["providers"]["litellm"]["name"] == PROVIDER_DISPLAY_NAME


class TestLabelConstants:
    def test_the_current_label_is_not_also_a_legacy_one(self):
        # If it were, every sign-in and both migrations would "upgrade" the
        # current name onto itself forever.
        assert PROVIDER_DISPLAY_NAME not in LEGACY_PROVIDER_DISPLAY_NAMES
