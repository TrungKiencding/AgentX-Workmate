"""Config v39: the second brain's account settings take the keys service's names.

Until 1.1.1 the settings of the service that issues model keys lived under
``accounts.second_brain`` (with the conversation sync it also carried), and the
mode that collects a key from it was ``accounts.litellm.mode: second_brain``.
The service is the keys service of AgentX SSO and sync is retired, so the
names move: ``accounts.keys`` and ``mode: keys``. Only the names — the URL, the
timeout and the alias prefix keep their values as written, so a machine keeps
the key it holds and the service that issued it. A retired default among them
(the old host, the old ``second-brain`` prefix) reads as the current default
where it is read.

A desktop install never runs the migration ladder, and an administrator's
managed file is never rewritten, so ``load_config`` reads the old names under
the new ones as well.
"""

from __future__ import annotations

import pytest
import yaml

from hermes_cli.config_defaults import DEPLOYMENT_KEY_ALIAS_PREFIX, DEPLOYMENT_KEYS_URL

CUSTOM = "https://sso.customer.example/keys"


@pytest.fixture()
def hermes_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("AGENTX_HOME", str(home))
    return home


def _write_config(home, config: dict):
    path = home / "config.yaml"
    path.write_text(yaml.safe_dump(config), encoding="utf-8")
    return path


def _read(path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _run_ladder(current_ver: int) -> dict:
    from hermes_cli.config_migrations import run_migrations

    results: dict = {"env_added": [], "config_added": [], "warnings": []}
    run_migrations(current_ver, results, quiet=True)
    return results


#: What a 1.1.0 machine can hold: a service chosen by its administrator, the
#: sync switch dev-fresh and Settings wrote, and the mode an older build wrote out.
LEGACY = {
    "_config_version": 38,
    "accounts": {
        "second_brain": {
            "base_url": CUSTOM,
            "request_timeout_seconds": 9,
            "sync": {"enabled": False, "interval_seconds": 30, "realtime": True},
        },
        "litellm": {"enabled": True, "mode": "second_brain", "key_alias_prefix": "second-brain"},
    },
    "display": {"language": "vi"},
}


class TestV39Migration:
    def test_an_old_config_takes_the_new_names(self, hermes_home):
        path = _write_config(hermes_home, LEGACY)

        results = _run_ladder(38)

        accounts = _read(path)["accounts"]
        assert accounts["keys"] == {"base_url": CUSTOM, "request_timeout_seconds": 9}
        assert "second_brain" not in accounts
        assert accounts["litellm"] == {
            "enabled": True,
            "mode": "keys",
            # Kept as written; it reads as the current default (the next test).
            "key_alias_prefix": "second-brain",
        }
        assert _read(path)["display"] == {"language": "vi"}
        assert results["config_added"] == [
            "accounts.second_brain → accounts.keys (base_url, request_timeout_seconds)",
            "accounts.second_brain.sync removed (conversation sync is retired)",
            "accounts.litellm.mode=keys (was second_brain)",
        ]

    def test_the_migrated_machine_asks_the_same_service(self, hermes_home):
        from hermes_cli.account_provisioning import keys_service, load_settings

        _write_config(hermes_home, LEGACY)
        _run_ladder(38)

        settings = load_settings()
        assert (settings.mode, settings.keys_url) == ("keys", CUSTOM)
        assert settings.key_alias_prefix == DEPLOYMENT_KEY_ALIAS_PREFIX == "agentx"
        assert keys_service() == (CUSTOM, 9.0)

    @pytest.mark.parametrize(
        "written",
        [
            DEPLOYMENT_KEYS_URL,
            # The retired default an older build wrote out before 2026-10-01.
            "https://brain.dev-server.cloud",
        ],
    )
    def test_a_default_an_older_build_wrote_out_still_reads_as_the_keys_url(
        self, hermes_home, written
    ):
        from hermes_cli.account_provisioning import keys_service

        _write_config(
            hermes_home,
            {"_config_version": 38, "accounts": {"second_brain": {"base_url": written}}},
        )
        _run_ladder(38)

        # The URL a stored key was issued by does not change.
        assert keys_service()[0] == DEPLOYMENT_KEYS_URL == "https://agentx.astralx.com.vn/keys"

    def test_a_value_under_the_new_name_wins(self, hermes_home):
        path = _write_config(
            hermes_home,
            {
                "_config_version": 38,
                "accounts": {
                    "keys": {"base_url": CUSTOM},
                    "second_brain": {"base_url": "https://old.example", "request_timeout_seconds": 7},
                },
            },
        )

        _run_ladder(38)

        assert _read(path)["accounts"] == {
            "keys": {"base_url": CUSTOM, "request_timeout_seconds": 7}
        }

    def test_a_sync_switch_alone_leaves_nothing_behind(self, hermes_home):
        path = _write_config(
            hermes_home,
            {"_config_version": 38, "accounts": {"second_brain": {"sync": {"enabled": False}}}},
        )

        _run_ladder(38)

        assert "accounts" not in _read(path)

    def test_a_config_already_on_the_new_names_is_untouched(self, hermes_home):
        path = _write_config(
            hermes_home,
            {"_config_version": 38, "accounts": {"keys": {"base_url": CUSTOM}, "litellm": {"mode": "keys"}}},
        )
        before = path.read_text(encoding="utf-8")

        results = _run_ladder(38)

        assert path.read_text(encoding="utf-8") == before
        assert results["config_added"] == []

    def test_is_registered_in_the_ladder(self):
        from hermes_cli.config_defaults import DEFAULT_CONFIG
        from hermes_cli.config_migrations import MIGRATIONS

        targets = [target for target, _ in MIGRATIONS]
        assert targets[-1] == 39
        assert DEFAULT_CONFIG["_config_version"] == 39
        assert "second_brain" not in DEFAULT_CONFIG["accounts"]
        assert DEFAULT_CONFIG["accounts"]["keys"]["base_url"] == DEPLOYMENT_KEYS_URL
        assert DEFAULT_CONFIG["accounts"]["litellm"]["mode"] == "keys"


class TestReadTime:
    """A desktop install never runs the ladder: the old names are read as the new."""

    def test_an_unmigrated_config_reads_under_the_new_names(self, hermes_home):
        from hermes_cli.account_provisioning import keys_service, load_settings
        from hermes_cli.config import load_config

        path = _write_config(hermes_home, LEGACY)
        before = path.read_text(encoding="utf-8")

        accounts = load_config()["accounts"]
        settings = load_settings()

        assert accounts["keys"]["base_url"] == CUSTOM
        assert "second_brain" not in accounts
        assert (settings.mode, settings.keys_url, settings.key_alias_prefix) == (
            "keys",
            CUSTOM,
            # The default an older build wrote out reads as today's.
            DEPLOYMENT_KEY_ALIAS_PREFIX,
        )
        assert keys_service() == (CUSTOM, 9.0)
        # Reading is not migrating: the file is the ladder's to rewrite.
        assert path.read_text(encoding="utf-8") == before

    def test_a_retired_host_under_the_old_name_still_reads_as_the_keys_url(self, hermes_home):
        from hermes_cli.account_provisioning import keys_service

        _write_config(
            hermes_home,
            {"accounts": {"second_brain": {"base_url": "https://brain.dev-server.cloud"}}},
        )

        assert keys_service()[0] == DEPLOYMENT_KEYS_URL

    def test_an_administrators_managed_file_is_read_under_the_new_names(
        self, hermes_home, tmp_path, monkeypatch
    ):
        from hermes_cli import managed_scope
        from hermes_cli.account_provisioning import keys_service, load_settings

        managed = tmp_path / "managed"
        managed.mkdir()
        (managed / "config.yaml").write_text(
            yaml.safe_dump(
                {
                    "accounts": {
                        "second_brain": {"base_url": CUSTOM},
                        "litellm": {"mode": "second_brain", "key_alias_prefix": "second-brain"},
                    }
                }
            ),
            encoding="utf-8",
        )
        monkeypatch.setenv("AGENTX_MANAGED_DIR", str(managed))
        managed_scope._CONFIG_CACHE.clear()
        _write_config(hermes_home, {"accounts": {"keys": {"base_url": "https://user.example/keys"}}})

        # Managed wins at the leaf, under whichever name it was written.
        assert keys_service()[0] == CUSTOM
        settings = load_settings()
        assert (settings.mode, settings.key_alias_prefix) == ("keys", DEPLOYMENT_KEY_ALIAS_PREFIX)

    def test_a_prefix_somebody_chose_is_kept(self, hermes_home):
        from hermes_cli.account_provisioning import load_settings

        _write_config(hermes_home, {"accounts": {"litellm": {"key_alias_prefix": "acme-lab"}}})

        assert load_settings().key_alias_prefix == "acme-lab"
