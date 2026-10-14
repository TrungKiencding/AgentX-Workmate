"""scripts/release.py keeps one product version across every manifest.

``agentx --version`` reads hermes_cli/__init__.py, but the desktop installer
name, the Tauri/Cargo metadata of the bootstrap installer and the npm
workspaces read their own manifests, and the lockfiles repeat every one of
those versions. ``update_version_files`` has to move all of them together,
and the checked-in tree has to already agree.
"""

import json
import sys
import tomllib
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import release  # noqa: E402

CARGO_TOML = (
    '[package]\n'
    'name = "agentx-bootstrap"\n'
    'version = "0.0.1"\n'
    '\n'
    '[dependencies]\n'
    'serde = { version = "1.0" }\n'
    '\n'
    '[dependencies.tauri]\n'
    'version = "2.0"\n'
)


UV_LOCK = (
    'version = 1\n'
    'revision = 3\n'
    'requires-python = ">=3.11, <3.14"\n'
    '\n'
    '[[package]]\n'
    'name = "agentx-workmate"\n'
    'version = "0.1.0"\n'
    'source = { editable = "." }\n'
    '\n'
    '[[package]]\n'
    'name = "anyio"\n'
    'version = "4.9.0"\n'
    'source = { registry = "https://pypi.org/simple" }\n'
)


def _write(root: Path, relative: str, text: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))
    return path


def _lockfile(name: str, version: str, workspaces: dict) -> str:
    """An npm v3 lockfile with a root entry, workspace entries and a decoy dep."""
    packages = {"": {"name": name, "version": version, "dependencies": {"left-pad": "^1.0.0"}}}
    for folder, (pkg_name, ws_version) in workspaces.items():
        entry = {}
        if pkg_name:
            entry["name"] = pkg_name
        entry["version"] = ws_version
        entry["dependencies"] = {"left-pad": "^1.0.0"}
        packages[folder] = entry
    packages["node_modules/left-pad"] = {
        "version": "1.3.0",
        "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
    }
    doc = {"name": name, "version": version, "lockfileVersion": 3, "requires": True, "packages": packages}
    return json.dumps(doc, indent=2) + "\n"


@pytest.fixture
def fake_repo(tmp_path: Path) -> Path:
    _write(tmp_path, "hermes_cli/__init__.py",
           '"""pkg"""\n\n__version__ = "0.1.0"\n__release_date__ = "2026.1.1"\n')
    _write(tmp_path, "pyproject.toml",
           '[project]\nname = "agentx-workmate"\nversion = "0.1.0"\n\n[tool.other]\nversion = "9.9.9"\n')
    for relative in release.JSON_VERSION_MANIFESTS:
        manifest = {"name": relative.replace("/", "-"), "version": "0.0.1", "dependencies": {"decoy": "0.0.1"}}
        _write(tmp_path, relative, json.dumps(manifest, indent=2) + "\n")
    _write(tmp_path, "apps/bootstrap-installer/src-tauri/Cargo.toml", CARGO_TOML)
    _write(tmp_path, "package-lock.json", _lockfile("agentx-agent", "1.0.0", {
        "apps/desktop": ("agentx-workmate", "0.19.1"),
        "apps/shared": ("@agentx/shared", "0.0.0"),
        "apps/bootstrap-installer": ("@agentx/bootstrap-installer", "0.0.1"),
        "ui-tui": ("agentx-tui", "0.0.1"),
        "ui-tui/packages/hermes-ink": ("@agentx/ink", "0.0.1"),
        "web": (None, "0.0.0"),  # npm omits "name" when it equals the folder
    }))
    _write(tmp_path, "website/package-lock.json", _lockfile("website", "0.0.0", {}))
    _write(tmp_path, "uv.lock", UV_LOCK)
    return tmp_path


def test_update_version_files_moves_every_manifest_together(fake_repo: Path):
    touched = release.update_version_files("1.2.3", "2026.9.8", root=fake_repo)

    init = (fake_repo / "hermes_cli/__init__.py").read_text(encoding="utf-8")
    assert '__version__ = "1.2.3"' in init
    assert '__release_date__ = "2026.9.8"' in init

    pyproject = tomllib.loads((fake_repo / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["project"]["version"] == "1.2.3"
    assert pyproject["tool"]["other"]["version"] == "9.9.9", "only [project] moves"

    for relative in release.JSON_VERSION_MANIFESTS:
        data = json.loads((fake_repo / relative).read_text(encoding="utf-8"))
        assert data["version"] == "1.2.3", relative
        assert data["dependencies"]["decoy"] == "0.0.1", relative

    cargo = (fake_repo / "apps/bootstrap-installer/src-tauri/Cargo.toml").read_text(encoding="utf-8")
    assert cargo == CARGO_TOML.replace('version = "0.0.1"', 'version = "1.2.3"', 1)

    lock = json.loads((fake_repo / "package-lock.json").read_text(encoding="utf-8"))
    assert lock["version"] == "1.2.3"
    assert lock["packages"][""]["version"] == "1.2.3"
    for folder in release.NPM_LOCKFILE_WORKSPACES["package-lock.json"]:
        assert lock["packages"][folder]["version"] == "1.2.3", folder
    assert lock["packages"]["node_modules/left-pad"]["version"] == "1.3.0"

    site_lock = json.loads((fake_repo / "website/package-lock.json").read_text(encoding="utf-8"))
    assert site_lock["version"] == "1.2.3"
    assert site_lock["packages"][""]["version"] == "1.2.3"

    uv_lock = (fake_repo / "uv.lock").read_text(encoding="utf-8")
    assert uv_lock == UV_LOCK.replace('version = "0.1.0"', 'version = "1.2.3"', 1)
    assert 'version = "1"\n' not in uv_lock and 'version = "4.9.0"' in uv_lock

    expected = {
        fake_repo / "hermes_cli/__init__.py",
        fake_repo / "pyproject.toml",
        *(fake_repo / relative for relative in release.JSON_VERSION_MANIFESTS),
        *(fake_repo / relative for relative in release.CARGO_VERSION_MANIFESTS),
        *(fake_repo / relative for relative in release.NPM_LOCKFILE_WORKSPACES),
        fake_repo / release.UV_LOCKFILE,
    }
    assert set(touched) == expected


def test_lockfile_edit_changes_one_line_per_entry(fake_repo: Path):
    before = (fake_repo / "package-lock.json").read_text(encoding="utf-8").splitlines()
    release.update_version_files("1.2.3", "2026.9.8", root=fake_repo)
    after = (fake_repo / "package-lock.json").read_text(encoding="utf-8").splitlines()

    assert len(before) == len(after)
    changed = [(old, new) for old, new in zip(before, after) if old != new]
    # header + "" entry + one per workspace, nothing else re-formatted
    assert len(changed) == 2 + len(release.NPM_LOCKFILE_WORKSPACES["package-lock.json"])
    assert all('"version"' in old for old, _ in changed)


def test_missing_optional_manifest_is_skipped(fake_repo: Path):
    (fake_repo / "website/package.json").unlink()
    (fake_repo / "website/package-lock.json").unlink()

    touched = release.update_version_files("1.2.3", "2026.9.8", root=fake_repo)

    assert fake_repo / "website/package.json" not in touched
    assert fake_repo / "website/package-lock.json" not in touched
    assert not (fake_repo / "website/package.json").exists()


def test_manifest_without_version_field_is_an_error(fake_repo: Path):
    (fake_repo / "web/package.json").write_text('{\n  "name": "web",\n  "private": true\n}\n', encoding="utf-8")

    with pytest.raises(release.VersionFieldMissing, match=r"web/package\.json"):
        release.update_version_files("1.2.3", "2026.9.8", root=fake_repo)


def test_lockfile_missing_a_workspace_entry_is_an_error(fake_repo: Path):
    lock_path = fake_repo / "package-lock.json"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    del lock["packages"]["apps/desktop"]
    lock_path.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")

    with pytest.raises(release.VersionFieldMissing, match=r"package-lock\.json"):
        release.update_version_files("1.2.3", "2026.9.8", root=fake_repo)


def test_checked_in_manifests_agree_with_the_cli_version():
    """The tree ships one version.

    A bump applied to only some files fails here instead of surfacing as a
    stale installer name or a surprise lockfile diff. Fix with
    ``python scripts/release.py --sync-versions``.
    """
    expected = release.get_current_version()
    mismatched = {}

    pyproject = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    if pyproject["project"]["version"] != expected:
        mismatched["pyproject.toml"] = pyproject["project"]["version"]

    for relative in release.JSON_VERSION_MANIFESTS:
        path = REPO_ROOT / relative
        if path.exists():
            found = json.loads(path.read_text(encoding="utf-8"))["version"]
            if found != expected:
                mismatched[relative] = found

    for relative in release.CARGO_VERSION_MANIFESTS:
        path = REPO_ROOT / relative
        if path.exists():
            found = tomllib.loads(path.read_text(encoding="utf-8"))["package"]["version"]
            if found != expected:
                mismatched[relative] = found

    uv_lock = REPO_ROOT / release.UV_LOCKFILE
    if uv_lock.exists():
        for package in tomllib.loads(uv_lock.read_text(encoding="utf-8")).get("package", []):
            if package.get("name") == release.UV_PROJECT_NAME and package.get("version") != expected:
                mismatched["uv.lock"] = package.get("version")

    for relative, workspaces in release.NPM_LOCKFILE_WORKSPACES.items():
        path = REPO_ROOT / relative
        if not path.exists():
            continue
        lock = json.loads(path.read_text(encoding="utf-8"))
        entries = {"<header>": lock["version"], "": lock["packages"][""]["version"]}
        for workspace in workspaces:
            if (REPO_ROOT / workspace / "package.json").exists():
                entries[workspace] = lock["packages"][workspace]["version"]
        for key, found in entries.items():
            if found != expected:
                mismatched[f"{relative}:{key}"] = found

    assert not mismatched, (
        f"expected every manifest at v{expected}; run `python scripts/release.py --sync-versions`: "
        f"{mismatched}"
    )
