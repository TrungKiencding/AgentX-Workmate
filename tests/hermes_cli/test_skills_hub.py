from io import StringIO
from unittest.mock import patch

import pytest
from rich.console import Console

from cli import ChatConsole
from hermes_cli.skills_hub import do_check, do_install, do_list, do_update, handle_skills_slash


class _DummyLockFile:
    def __init__(self, installed):
        self._installed = installed

    def list_installed(self):
        return self._installed


@pytest.fixture()
def hub_env(monkeypatch, tmp_path):
    """Set up isolated hub directory paths and return (monkeypatch, tmp_path)."""
    import tools.skills_hub as hub

    hub_dir = tmp_path / "skills" / ".hub"
    monkeypatch.setattr(hub, "SKILLS_DIR", tmp_path / "skills")
    monkeypatch.setattr(hub, "HUB_DIR", hub_dir)
    monkeypatch.setattr(hub, "LOCK_FILE", hub_dir / "lock.json")
    monkeypatch.setattr(hub, "QUARANTINE_DIR", hub_dir / "quarantine")
    monkeypatch.setattr(hub, "AUDIT_LOG", hub_dir / "audit.log")
    monkeypatch.setattr(hub, "TAPS_FILE", hub_dir / "taps.json")
    monkeypatch.setattr(hub, "INDEX_CACHE_DIR", hub_dir / "index-cache")

    return hub_dir


# ---------------------------------------------------------------------------
# Fixtures for common skill setups
# ---------------------------------------------------------------------------

_HUB_ENTRY = {"name": "hub-skill", "source": "github", "trust_level": "community"}

_ALL_THREE_SKILLS = [
    {"name": "hub-skill", "category": "x", "description": "hub"},
    {"name": "builtin-skill", "category": "x", "description": "builtin"},
    {"name": "local-skill", "category": "x", "description": "local"},
]

_BUILTIN_MANIFEST = {"builtin-skill": "abc123"}


@pytest.fixture()
def three_source_env(monkeypatch, hub_env):
    """Populate hub/builtin/local skills for source-classification tests."""
    import tools.skills_hub as hub
    import tools.skills_sync as skills_sync
    import tools.skills_tool as skills_tool

    monkeypatch.setattr(hub, "HubLockFile", lambda: _DummyLockFile([_HUB_ENTRY]))
    monkeypatch.setattr(skills_tool, "_find_all_skills", lambda **_kwargs: list(_ALL_THREE_SKILLS))
    monkeypatch.setattr(skills_sync, "_read_manifest", lambda: dict(_BUILTIN_MANIFEST))

    return hub_env


def _capture(source_filter: str = "all") -> str:
    """Run do_list into a string buffer and return the output."""
    sink = StringIO()
    console = Console(file=sink, force_terminal=False, color_system=None)
    do_list(source_filter=source_filter, console=console)
    return sink.getvalue()


def _capture_check(monkeypatch, results, name=None) -> str:
    import tools.skills_hub as hub

    sink = StringIO()
    console = Console(file=sink, force_terminal=False, color_system=None)
    monkeypatch.setattr(hub, "check_for_skill_updates", lambda **_kwargs: results)
    do_check(name=name, console=console)
    return sink.getvalue()


def _capture_update(monkeypatch, results) -> tuple[str, list[tuple[str, str, bool]]]:
    import tools.skills_hub as hub
    import hermes_cli.skills_hub as cli_hub

    sink = StringIO()
    console = Console(file=sink, force_terminal=False, color_system=None)
    installs = []

    monkeypatch.setattr(hub, "check_for_skill_updates", lambda **_kwargs: results)
    monkeypatch.setattr(hub, "HubLockFile", lambda: type("L", (), {
        "get_installed": lambda self, name: {"install_path": "category/" + name}
    })())
    monkeypatch.setattr(cli_hub, "do_install", lambda identifier, category="", force=False, console=None, source_id=None: installs.append((identifier, category, force)))

    do_update(console=console)
    return sink.getvalue(), installs


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------




def test_do_list_platform_env_is_ignored(three_source_env, monkeypatch):
    """`agentx skills list` reads the active profile's config via
    AGENTX_HOME (swapped by -p), so it must NOT pass a platform arg to
    ``get_disabled_skill_names`` — otherwise per-platform overrides
    would silently leak in from AGENTX_PLATFORM env."""
    from agent import skill_utils

    seen = {}

    def _fake(platform=None):
        seen["platform"] = platform
        return set()

    monkeypatch.setattr(skill_utils, "get_disabled_skill_names", _fake)
    _capture()

    assert seen["platform"] is None


# ---------------------------------------------------------------------------
# Cross-registry hijack regression tests
#
# An update must never change a skill's source registry. Skill names are not
# namespaced across registries, so an unconstrained name resolve can install a
# different author's same-named skill over the user's files.
# ---------------------------------------------------------------------------




def test_check_for_skill_updates_does_not_fall_back_across_registries():
    """An entry whose source has no adapter reports `unavailable`.

    Previously `candidate_sources ... or sources` fell back to every source, so
    a same-named skill in another registry could satisfy the fetch and be
    reported as this entry's update -- the step that preceded the overwrite.
    The foreign source here returns a *valid* bundle with a different hash, so
    the old code reports `update_available` (sourced from the wrong registry)
    while the fixed code reports `unavailable`.
    """
    from tools.skills_hub import check_for_skill_updates

    class _ForeignBundle:
        name = "reddit"
        files = {"SKILL.md": "# a different author's reddit skill"}
        source = "skills.sh"
        identifier = "skills-sh/someone-else/reddit"
        trust_level = "community"
        metadata: dict = {}

    class _ForeignSource:
        """skills-sh adapter; must NOT be consulted for a clawhub-locked entry."""

        def source_id(self):
            return "skills-sh"

        def fetch(self, identifier):
            return _ForeignBundle()

        def inspect(self, identifier):
            return _ForeignBundle()

    lock = _DummyLockFile([
        {"name": "reddit", "identifier": "reddit", "source": "clawhub",
         "content_hash": "hash-of-the-clawhub-copy"},
    ])

    results = check_for_skill_updates(
        lock=lock,  # type: ignore[arg-type]  # duck-typed double, matches _DummyLockFile usage above
        sources=[_ForeignSource()],  # type: ignore[list-item]
    )

    assert len(results) == 1
    assert results[0]["source"] == "clawhub", "provenance must be preserved"
    assert results[0]["status"] == "unavailable", (
        "a clawhub-locked skill must not be matched against a skills-sh bundle; "
        "reporting update_available here is the cross-registry hijack"
    )
    assert "bundle" not in results[0], "must not carry a foreign registry's bundle"




# ---------------------------------------------------------------------------
# UrlSource-specific install paths: --name override, interactive prompts,
# non-interactive error, existing-category scan.
# ---------------------------------------------------------------------------


def _make_url_bundle_fetcher(name="", awaiting_name=True, url="https://example.com/SKILL.md"):
    """Return a fake source that simulates ``UrlSource.fetch`` for a
    URL-sourced skill whose name hasn't been auto-resolved."""

    class _UrlSource:
        def inspect(self, identifier):
            return type("Meta", (), {
                "extra": {"url": url, "awaiting_name": awaiting_name},
                "identifier": url,
                "name": name,
                "path": name,
            })()

        def fetch(self, identifier):
            return type("Bundle", (), {
                "name": name,
                "files": {"SKILL.md": "---\ndescription: ok\n---\n# body\n"},
                "source": "url",
                "identifier": url,
                "trust_level": "community",
                "metadata": {"url": url, "awaiting_name": awaiting_name},
            })()

    return _UrlSource


def _install_mocks(monkeypatch, tmp_path, source_factory, category_hint=""):
    """Wire the minimum set of monkeypatches for a do_install dry run."""
    import tools.skills_hub as hub
    import tools.skills_guard as guard

    q_path = tmp_path / "skills" / ".hub" / "quarantine" / "pending"
    q_path.mkdir(parents=True)

    install_calls: list = []

    def _install_from_quarantine(q, name, category, bundle, result):
        install_calls.append({"name": name, "category": category})
        install_dir = tmp_path / "skills" / (f"{category}/" if category else "") / name
        install_dir.mkdir(parents=True, exist_ok=True)
        return install_dir

    monkeypatch.setattr(hub, "ensure_hub_dirs", lambda: None)
    monkeypatch.setattr(hub, "create_source_router", lambda auth: [source_factory()])
    monkeypatch.setattr(hub, "quarantine_bundle", lambda bundle: q_path)
    monkeypatch.setattr(hub, "install_from_quarantine", _install_from_quarantine)
    monkeypatch.setattr(
        hub, "HubLockFile",
        lambda: type("Lock", (), {"get_installed": lambda self, n: None})(),
    )
    monkeypatch.setattr(
        guard, "scan_skill",
        lambda skill_path, source="community": guard.ScanResult(
            skill_name="pending", source=source, trust_level="community", verdict="safe",
        ),
    )
    monkeypatch.setattr(guard, "format_scan_report", lambda result: "scan ok")
    monkeypatch.setattr(guard, "should_allow_install", lambda result, force=False: (True, "ok"))
    return install_calls






# ── _existing_categories ────────────────────────────────────────────────────






# ---------------------------------------------------------------------------
# browse_skills — dedup by identifier, not name
# ---------------------------------------------------------------------------




# ---------------------------------------------------------------------------
# Regression: full identifier must be recoverable from `agentx skills search`
# even when the slug is too long to fit the terminal width (issue #33674).
# ---------------------------------------------------------------------------

# A real browse-sh-style slug whose trailing -XXXXXX hash matters for install
_LONG_SLUG = "browse-sh/weather.gov/get-forecast-1uezib"

_LONG_RESULT = type("R", (), {
    "name": "get-forecast",
    "description": "Fetch the forecast",
    "source": "browse-sh",
    "trust_level": "community",
    "identifier": _LONG_SLUG,
})()


def test_do_search_json_flag_emits_full_identifiers(capsys):
    """`--json` must print a parseable array with full identifiers and skip the table."""
    from hermes_cli.skills_hub import do_search

    sink = StringIO()
    console = Console(file=sink, force_terminal=False, color_system=None, width=40)

    with patch("tools.skills_hub.unified_search", return_value=[_LONG_RESULT]), \
         patch("tools.skills_hub.create_source_router", return_value={}), \
         patch("tools.skills_hub.GitHubAuth"):
        do_search("weather", console=console, as_json=True)

    # JSON goes to stdout via print(), not the Rich console sink.
    captured = capsys.readouterr().out
    import json as _json
    payload = _json.loads(captured)
    assert isinstance(payload, list) and len(payload) == 1
    assert payload[0]["identifier"] == _LONG_SLUG
    assert payload[0]["name"] == "get-forecast"
    assert payload[0]["source"] == "browse-sh"
    # Table render must be suppressed — sink should be empty (no "Searching for:" header).
    assert "Searching for:" not in sink.getvalue()



# ---------------------------------------------------------------------------
# Updates never replace an edit made on this machine silently (AgentX Skill Hub §8 #20)
# ---------------------------------------------------------------------------


def _update_result(name: str, *, modified: bool = False) -> dict:
    return {"name": name, "identifier": f"agentx-hub/{name}@1.1.0", "source": "agentx-hub", "status": "update_available",
            "current_hash": f"sha256:{name}-old", "latest_hash": f"sha256:{name}-new", "locally_modified": modified}


def _run_update(monkeypatch, results, *, fail=(), overwrite_local=False):
    """do_update against an in-memory lock that a successful install rewrites, like the real one."""
    import tools.skills_hub as hub
    import hermes_cli.skills_hub as cli_hub

    entries = {r["name"]: {"install_path": f"category/{r['name']}", "content_hash": r["current_hash"]} for r in results}
    installs, backups = [], []

    class _Lock:
        def get_installed(self, name):
            return entries.get(name)

    def _install(identifier, category="", force=False, console=None, source_id=None):
        name = identifier.split("/", 1)[1].split("@")[0]
        installs.append((name, category, force, source_id))
        if name not in fail:
            entries[name]["content_hash"] = f"sha256:{name}-new"

    def _backup(entry):
        backups.append(entry)
        return f"/home/.agentx/skills/.hub/backups/{entry['name']}/20260923T000000Z"

    monkeypatch.setattr(hub, "check_for_skill_updates", lambda **_kwargs: results)
    monkeypatch.setattr(hub, "HubLockFile", _Lock)
    monkeypatch.setattr(hub, "backup_hub_skill", _backup)
    monkeypatch.setattr(cli_hub, "do_install", _install)
    sink = StringIO()
    summary = do_update(console=Console(file=sink, force_terminal=False, color_system=None, width=240), overwrite_local=overwrite_local)
    return summary, sink.getvalue(), installs, backups


def test_update_keeps_a_skill_edited_here_and_says_how_to_take_the_update(monkeypatch):
    summary, out, installs, backups = _run_update(monkeypatch, [_update_result("plain"), _update_result("tuned", modified=True)])
    assert [i[0] for i in installs] == ["plain"] and installs[0][1:] == ("category", True, "agentx-hub")
    assert summary.updated == ["plain"] and summary.kept == ["tuned"] and summary.failed == [] and backups == []
    assert "Updated 1 skill(s)." in out
    assert "Kept 1 skill(s) you edited on this machine: tuned." in out and "--overwrite-local" in out


def test_overwrite_local_backs_the_edit_up_then_updates(monkeypatch):
    summary, out, installs, backups = _run_update(monkeypatch, [_update_result("tuned", modified=True)], overwrite_local=True)
    assert [i[0] for i in installs] == ["tuned"] and summary.updated == ["tuned"] and summary.kept == []
    assert [b["name"] for b in backups] == ["tuned"] and backups[0]["install_path"] == "category/tuned"
    assert summary.backups == {"tuned": "/home/.agentx/skills/.hub/backups/tuned/20260923T000000Z"}
    assert "Your edited copy of tuned is kept in /home/.agentx/skills/.hub/backups/tuned/20260923T000000Z" in out


def test_a_refused_update_is_named_and_fails_the_command(monkeypatch):
    import hermes_cli.skills_hub as cli_hub

    summary, out, _installs, _backups = _run_update(monkeypatch, [_update_result("plain"), _update_result("blocked")], fail={"blocked"})
    assert summary.updated == ["plain"] and summary.failed == ["blocked"]
    assert "Could not update 1 skill(s): blocked" in out
    monkeypatch.setattr(cli_hub, "do_update", lambda **_kwargs: summary)
    with pytest.raises(SystemExit) as exit_info:
        cli_hub.skills_command(type("Args", (), {"skills_action": "update", "name": None, "overwrite_local": False})())
    assert exit_info.value.code == 1


def test_the_check_marks_a_skill_edited_here(monkeypatch):
    out = _capture_check(monkeypatch, [{"name": "tuned", "source": "agentx-hub", "status": "update_available", "locally_modified": True},
                                       {"name": "plain", "source": "agentx-hub", "status": "up_to_date", "locally_modified": False}])
    assert "update_available · edited here" in out
    assert "up_to_date · edited here" not in out


def test_the_slash_command_passes_the_overwrite_flag(monkeypatch):
    import hermes_cli.skills_hub as cli_hub

    seen = []
    monkeypatch.setattr(cli_hub, "do_update", lambda name=None, console=None, overwrite_local=False: seen.append((name, overwrite_local)))
    handle_skills_slash("/skills update tuned --overwrite-local", console=Console(file=StringIO()))
    handle_skills_slash("/skills update", console=Console(file=StringIO()))
    assert seen == [("tuned", True), (None, False)]
