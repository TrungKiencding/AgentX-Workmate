"""Config v37: the AgentX Hub moved to agenthub.astralx.com.vn (2026-09-26).

An install from before the move may keep the hub address it shipped with in
config.yaml (``skills.hub_url: https://skills.astralx.com.vn``, or
``https://skills.dev-server.cloud`` before 2026-09-09). The literal was ours:
the migration drops it so the current default takes effect, and moves a
``sync.base_url`` naming the same address along, or the sync plane would stop
being the hub. An address somebody chose is left alone.
"""

from __future__ import annotations

import pytest
import yaml

NEW_HUB = "https://agenthub.astralx.com.vn"


@pytest.fixture()
def hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
    for name in ("AGENTX_SKILLS_HUB_URL", "AGENTX_SYNC_BASE_URL", "AGENTX_SYNC_PROVIDER"):
        monkeypatch.delenv(name, raising=False)
    return tmp_path


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


class TestV37Migration:
    @pytest.mark.parametrize(
        "retired",
        [
            "https://skills.astralx.com.vn",
            "https://skills.astralx.com.vn/",
            "https://Skills.AstralX.com.vn",
            "https://skills.dev-server.cloud",
            " https://skills.dev-server.cloud/ ",
        ],
    )
    def test_a_retired_default_gives_way_to_the_current_one(self, hermes_home, retired):
        path = _write_config(
            hermes_home,
            {"_config_version": 36, "skills": {"hub_url": retired, "hub_realtime": False, "external_dirs": ["~/team-skills"]}},
        )

        results = _run_ladder(36)

        skills = _read(path)["skills"]
        assert "hub_url" not in skills
        # Only the address goes; the rest of the section is somebody's config.
        assert skills["hub_realtime"] is False
        assert skills["external_dirs"] == ["~/team-skills"]
        assert any(line.startswith(f"skills.hub_url={NEW_HUB} (was ") for line in results["config_added"])

        from tools.skills_hub import agentx_hub_url

        assert agentx_hub_url() == NEW_HUB

    def test_a_section_left_empty_is_dropped(self, hermes_home):
        path = _write_config(hermes_home, {"_config_version": 36, "skills": {"hub_url": "https://skills.astralx.com.vn"}})

        _run_ladder(36)

        assert "skills" not in _read(path)

    def test_the_sync_plane_follows_the_hub(self, hermes_home):
        path = _write_config(
            hermes_home,
            {
                "_config_version": 36,
                "skills": {"hub_url": "https://skills.astralx.com.vn"},
                "sync": {"base_url": "https://skills.astralx.com.vn/", "enabled": True},
            },
        )

        results = _run_ladder(36)

        sync = _read(path)["sync"]
        assert sync == {"base_url": NEW_HUB, "enabled": True}
        assert f"sync.base_url={NEW_HUB} (was https://skills.astralx.com.vn/)" in results["config_added"]

        from tools.skills_sync_client import SYNC_PROVIDER_HUB, resolve_sync_provider

        assert resolve_sync_provider() == SYNC_PROVIDER_HUB

    @pytest.mark.parametrize(
        "chosen",
        [
            "https://hub.staging.example",
            "http://127.0.0.1:8820",
            "https://skills.astralx.com.vn:8443",
            "https://skills.astralx.com.vn/base",
            "http://skills.astralx.com.vn",
            "https://agenthub.astralx.com.vn",
        ],
    )
    def test_an_address_somebody_chose_stays(self, hermes_home, chosen):
        path = _write_config(
            hermes_home,
            {"_config_version": 36, "skills": {"hub_url": chosen}, "sync": {"base_url": chosen}},
        )
        before = path.read_text(encoding="utf-8")

        results = _run_ladder(36)

        assert path.read_text(encoding="utf-8") == before
        assert not any(line.startswith(("skills.hub_url", "sync.base_url")) for line in results["config_added"])

    def test_a_config_without_a_hub_address_is_untouched(self, hermes_home):
        for config in (
            {"_config_version": 36},
            {"_config_version": 36, "skills": {"hub_token": ""}},
            {"_config_version": 36, "sync": {"enabled": False}},
            {"_config_version": 36, "skills": "not a section", "sync": ["nor", "this"]},
        ):
            path = _write_config(hermes_home, config)
            before = path.read_text(encoding="utf-8")

            _run_ladder(36)

            assert path.read_text(encoding="utf-8") == before

    def test_is_registered_in_the_ladder_and_the_default_is_the_new_hub(self):
        from hermes_cli.config_defaults import DEFAULT_CONFIG
        from hermes_cli.config_migrations import MIGRATIONS, _is_retired_hub_url
        from tools.skills_hub import DEFAULT_AGENTX_HUB_URL

        targets = [target for target, _ in MIGRATIONS]
        assert 37 in targets
        assert targets == sorted(targets)
        assert DEFAULT_CONFIG["_config_version"] >= 37
        assert DEFAULT_CONFIG["skills"]["hub_url"] == DEFAULT_AGENTX_HUB_URL == NEW_HUB
        assert not _is_retired_hub_url(NEW_HUB)
