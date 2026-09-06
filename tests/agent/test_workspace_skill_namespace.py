"""Workspace-skill namespace: gated resolution, provenance, collisions.

The hub's decision §8 #11 moved sharing from the organisation to workspaces;
the local mirror follows (``_workspaces/<id>/``):
 1. GATED discovery — only the mirrors named in ``.active_workspaces``
    resolve; mirrors of workspaces the person left and marker-less trees
    never load.
 2. Fail-loud collisions — a personal/workspace name clash lists BOTH sides
    flagged; skill_view's existing multi-candidate guard refuses the bare name.
 3. Load-time provenance header — shared content announces workspace + author.
 4. Mirrors are editable in place, deletion is refused, curation is allowed.
"""

import json

import pytest

from agent import skill_utils as sku
from agent.prompt_builder import _build_snapshot_entry


def _mk_skill(root, rel, name=None, body="# body\n"):
    d = root
    for part in rel.split("/"):
        d = d / part
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name or rel.split('/')[-1]}\ndescription: d\n---\n{body}",
        encoding="utf-8",
    )
    return d


def _mark_active(skills, *workspace_ids):
    root = skills / sku.WORKSPACE_MIRROR_DIR_NAME
    root.mkdir(parents=True, exist_ok=True)
    (root / sku.WORKSPACE_ACTIVE_MARKER).write_text(json.dumps(list(workspace_ids)), encoding="utf-8")


class TestGatedDiscovery:
    def test_no_marker_no_workspace_skills(self, tmp_path):
        skills = tmp_path / "skills"
        _mk_skill(skills, "personal-a")
        _mk_skill(skills, f"{sku.WORKSPACE_MIRROR_DIR_NAME}/ws-1/shared-x", name="shared-x")
        found = [p.parent.name for p in sku.iter_skill_index_files(skills, "SKILL.md")]
        assert "personal-a" in found
        assert "shared-x" not in found  # unmarked mirror never resolves

    def test_marker_gates_to_active_workspaces_only(self, tmp_path):
        skills = tmp_path / "skills"
        _mk_skill(skills, f"{sku.WORKSPACE_MIRROR_DIR_NAME}/ws-1/shared-x", name="shared-x")
        _mk_skill(skills, f"{sku.WORKSPACE_MIRROR_DIR_NAME}/ws-2/other-z", name="other-z")
        _mk_skill(skills, f"{sku.WORKSPACE_MIRROR_DIR_NAME}/ws-OLD/stale-y", name="stale-y")
        _mark_active(skills, "ws-1", "ws-2")
        found = [p.parent.name for p in sku.iter_skill_index_files(skills, "SKILL.md")]
        assert "shared-x" in found and "other-z" in found
        assert "stale-y" not in found  # a workspace the person left is pruned at resolution

    def test_leaving_a_workspace_flips_resolution(self, tmp_path):
        skills = tmp_path / "skills"
        _mk_skill(skills, f"{sku.WORKSPACE_MIRROR_DIR_NAME}/ws-1/shared-x", name="shared-x")
        _mk_skill(skills, f"{sku.WORKSPACE_MIRROR_DIR_NAME}/ws-2/other-z", name="other-z")
        _mark_active(skills, "ws-2")
        found = [p.parent.name for p in sku.iter_skill_index_files(skills, "SKILL.md")]
        assert found and "other-z" in found and "shared-x" not in found

    def test_helpers(self, tmp_path):
        skills = tmp_path / "skills"
        d = _mk_skill(skills, f"{sku.WORKSPACE_MIRROR_DIR_NAME}/ws-9/cat/sk", name="sk")
        assert sku.is_workspace_mirror_path(d, skills) is True
        assert sku.workspace_id_of_path(d, skills) == "ws-9"
        p = _mk_skill(skills, "plain")
        assert sku.is_workspace_mirror_path(p, skills) is False
        assert sku.read_active_workspace_ids(skills) == []
        _mark_active(skills, "ws-9")
        assert sku.read_active_workspace_ids(skills) == ["ws-9"]
        # A marker from before the JSON list (one bare id) still reads.
        (skills / sku.WORKSPACE_MIRROR_DIR_NAME / sku.WORKSPACE_ACTIVE_MARKER).write_text("ws-8", encoding="utf-8")
        assert sku.read_active_workspace_ids(skills) == ["ws-8"]


class TestSnapshotEntryProvenance:
    def test_workspace_entry_strips_prefix_and_carries_provenance(self, tmp_path):
        skills = tmp_path / "skills"
        d = _mk_skill(skills, f"{sku.WORKSPACE_MIRROR_DIR_NAME}/ws-1/devops/beta", name="beta")
        (skills / sku.WORKSPACE_MIRROR_DIR_NAME / "ws-1" / sku.WORKSPACE_PROVENANCE_FILE).write_text(
            json.dumps({"author_device": "bens-macbook-a1b2c3", "author_user_id": "u1", "workspace": "team"}),
            encoding="utf-8",
        )
        entry = _build_snapshot_entry(d / "SKILL.md", skills, {"name": "beta"}, "d")
        assert entry["workspace_id"] == "ws-1"
        assert entry["workspace_author"] == "bens-macbook-a1b2c3"
        assert entry["workspace_slug"] == "team"
        # Category derives from the path WITHIN the mirror, not _workspaces/ws-1/...
        assert entry["category"] == "devops"
        assert entry["skill_name"] == "beta"

    def test_personal_entry_unchanged(self, tmp_path):
        skills = tmp_path / "skills"
        d = _mk_skill(skills, "devops/beta", name="beta")
        entry = _build_snapshot_entry(d / "SKILL.md", skills, {"name": "beta"}, "d")
        assert "workspace_id" not in entry
        assert entry["category"] == "devops"


class TestListingCollisionsAndLabels:
    def _render(self, tmp_path, monkeypatch):
        from agent import prompt_builder as pb

        skills = tmp_path / "skills"
        skills.mkdir(parents=True, exist_ok=True)
        monkeypatch.setattr(pb, "get_skills_dir", lambda: skills, raising=True)
        monkeypatch.setattr(pb, "get_all_skills_dirs", lambda: [skills], raising=True)
        monkeypatch.setattr(pb, "get_disabled_skill_names", lambda *a, **k: set())
        monkeypatch.setattr(pb, "_skills_prompt_snapshot_path", lambda: tmp_path / "snap.json")
        pb.clear_skills_system_prompt_cache()
        return skills, pb

    def test_workspace_skill_listed_with_provenance_tag(self, tmp_path, monkeypatch):
        skills, pb = self._render(tmp_path, monkeypatch)
        _mk_skill(skills, "personal-a")
        _mk_skill(skills, f"{sku.WORKSPACE_MIRROR_DIR_NAME}/ws-1/shared-x", name="shared-x")
        (skills / sku.WORKSPACE_MIRROR_DIR_NAME / "ws-1" / sku.WORKSPACE_PROVENANCE_FILE).write_text(
            json.dumps({"author_device": "bens-macbook", "workspace": "team"}), encoding="utf-8"
        )
        _mark_active(skills, "ws-1")
        out = pb.build_skills_system_prompt()
        assert "workspace:team" in out
        assert "[workspace-shared: by bens-macbook]" in out
        assert "personal-a" in out

    def test_collision_flags_both_sides(self, tmp_path, monkeypatch):
        skills, pb = self._render(tmp_path, monkeypatch)
        _mk_skill(skills, "k8s-debug", body="personal version\n")
        _mk_skill(skills, f"{sku.WORKSPACE_MIRROR_DIR_NAME}/ws-1/k8s-debug", name="k8s-debug")
        _mark_active(skills, "ws-1")
        out = pb.build_skills_system_prompt()
        # BOTH entries flagged — neither silently wins.
        assert out.count("[name collision") == 2

    def test_no_collision_flag_when_unique(self, tmp_path, monkeypatch):
        skills, pb = self._render(tmp_path, monkeypatch)
        _mk_skill(skills, "personal-a")
        _mk_skill(skills, f"{sku.WORKSPACE_MIRROR_DIR_NAME}/ws-1/shared-x", name="shared-x")
        _mark_active(skills, "ws-1")
        out = pb.build_skills_system_prompt()
        assert "[name collision" not in out


class TestWorkspaceSkillsAreEditableInPlace:
    """The learning loop must work ON shared skills, not around them: edits
    land in place, pulls never clobber them, the user (or auto-propose)
    shares them back."""

    def _shared_skill(self, tmp_path, monkeypatch):
        from tools import skill_manager_tool as smt
        from agent import skill_utils as _sku

        skills = tmp_path / "skills"
        d = _mk_skill(skills, f"{sku.WORKSPACE_MIRROR_DIR_NAME}/ws-1/shared-x", name="shared-x")
        _mark_active(skills, "ws-1")
        monkeypatch.setattr(smt, "_skills_dir", lambda: skills)
        monkeypatch.setattr(_sku, "get_all_skills_dirs", lambda: [skills], raising=True)
        return smt, skills, d

    def test_patch_is_allowed_and_applied(self, tmp_path, monkeypatch):
        smt, _skills, d = self._shared_skill(tmp_path, monkeypatch)
        result = smt._patch_skill("shared-x", "body", "improved")
        assert result["success"] is True, result.get("error")
        assert "improved" in (d / "SKILL.md").read_text(encoding="utf-8")

    def test_edit_tells_the_user_how_to_share_it_back(self, tmp_path, monkeypatch):
        smt, _skills, _d = self._shared_skill(tmp_path, monkeypatch)
        result = smt._patch_skill("shared-x", "body", "improved")
        # Without auto-propose the edit stays local, and the tool result must
        # say so AND name the command (with the workspace) — otherwise the
        # improvement is stranded.
        note = result.get("workspace_sharing") or ""
        assert "propose" in note and "--workspace ws-1" in note

    def test_delete_is_still_refused(self, tmp_path, monkeypatch):
        smt, _skills, d = self._shared_skill(tmp_path, monkeypatch)
        guard = smt._workspace_mirror_write_guard("shared-x", d, "delete")
        assert guard is not None and guard["success"] is False
        assert "owner" in guard["error"]

    def test_curation_is_allowed(self, tmp_path, monkeypatch):
        from tools import skill_usage as su

        skills = tmp_path / "skills"
        d = _mk_skill(skills, f"{sku.WORKSPACE_MIRROR_DIR_NAME}/ws-1/shared-x", name="shared-x")
        monkeypatch.setattr(su, "_skills_dir", lambda: skills)
        assert su.is_curation_eligible("shared-x", d) is True


class TestWorkspacePullIsWiredIn:
    """Guards the integration gap that unit tests structurally cannot catch:
    the pull must have runtime call sites, or shared skills never load."""

    def test_session_startup_calls_maybe_pull_workspace_skills(self):
        import pathlib

        cli_src = (pathlib.Path(__file__).resolve().parents[2] / "cli.py").read_text(encoding="utf-8")
        assert "maybe_pull_workspace_skills" in cli_src, (
            "cli.py session startup must call maybe_pull_workspace_skills() — "
            "without a call site the mirrors are never populated and shared "
            "skills never load (the function being importable is not enough)."
        )
        assert "maybe_pull_skills" in cli_src
        assert "maybe_pull_org_skills" not in cli_src

    def test_sync_pull_command_refreshes_the_mirrors(self):
        import pathlib

        main_src = (pathlib.Path(__file__).resolve().parents[2] / "hermes_cli" / "main.py").read_text(encoding="utf-8")
        assert "maybe_pull_workspace_skills" in main_src, "`agentx sync pull` must also refresh the workspace mirrors."

    def test_sync_status_exposes_workspace_state(self):
        from tools import skills_sync_client as ssc

        status = ssc.sync_status()
        for key in ("workspaces_available", "workspaces", "workspace_skills", "workspace_skills_modified"):
            assert key in status, f"sync status must expose {key!r}"

    def test_no_internal_jargon_in_user_facing_strings(self):
        """User-visible help/errors must not leak internal design coordinates."""
        import pathlib
        import re

        root = pathlib.Path(__file__).resolve().parents[2]
        targets = [
            root / "hermes_cli" / "subcommands" / "sync.py",
            root / "hermes_cli" / "subcommands" / "skills.py",
        ]
        banned = re.compile(r"\(M[12]\)|\bHSP\b|HSP/1|§[0-9]|DEV-PHASE|hsp-1-contract")
        for path in targets:
            for i, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
                if "help=" in line or "description=" in line:
                    assert not banned.search(line), f"{path.name}:{i} leaks internal jargon to users: {line.strip()}"


class TestSkillSyncIsOneCommand:
    """Every Skill Sync verb lives under `agentx sync`; `propose` takes the workspace."""

    def _src(self, *parts):
        import pathlib

        return (pathlib.Path(__file__).resolve().parents[2].joinpath(*parts)).read_text(encoding="utf-8")

    def test_propose_is_a_sync_subcommand_with_a_workspace_flag(self):
        sync_src = self._src("hermes_cli", "subcommands", "sync.py")
        assert '"propose"' in sync_src and '"--workspace"' in sync_src

    def test_propose_is_not_under_skills(self):
        skills_src = self._src("hermes_cli", "subcommands", "skills.py")
        assert '"propose"' not in skills_src

    def test_sync_usage_lists_propose(self):
        main_src = self._src("hermes_cli", "main.py")
        usage_start = main_src.index("usage: agentx sync ")
        usage_block = main_src[usage_start : usage_start + 1400]
        assert "propose" in usage_block and "--workspace" in usage_block


class TestLocalEditsSurviveWorkspaceUpdates:
    """Local edits are never silently overwritten by a pull."""

    def _mirror(self, tmp_path, monkeypatch, body="original\n"):
        from tools import skills_sync_client as ssc

        skills = tmp_path / "skills"
        d = _mk_skill(skills, f"{sku.WORKSPACE_MIRROR_DIR_NAME}/ws-1/shared-x", name="shared-x", body=body)
        _mark_active(skills, "ws-1")
        monkeypatch.setattr(ssc, "_skills_dir", lambda: skills)
        monkeypatch.setattr(ssc, "_workspaces_dir", lambda: skills / sku.WORKSPACE_MIRROR_DIR_NAME)
        return ssc, skills, d

    def test_unmodified_skill_is_not_flagged(self, tmp_path, monkeypatch):
        ssc, _skills, d = self._mirror(tmp_path, monkeypatch)
        ssc._write_workspace_baseline("ws-1", {"shared-x": {"fingerprint": ssc._skill_dir_fingerprint(d), "tree": "t1"}})
        assert ssc.workspace_skill_is_locally_modified("shared-x", "ws-1") is False
        assert ssc.list_locally_modified_workspace_skills("ws-1") == []
        assert ssc.list_locally_modified_workspace_skills() == []

    def test_edited_skill_is_detected(self, tmp_path, monkeypatch):
        ssc, _skills, d = self._mirror(tmp_path, monkeypatch)
        ssc._write_workspace_baseline("ws-1", {"shared-x": {"fingerprint": ssc._skill_dir_fingerprint(d), "tree": "t1"}})
        (d / "SKILL.md").write_text("---\nname: shared-x\n---\nEDITED\n", encoding="utf-8")
        assert ssc.workspace_skill_is_locally_modified("shared-x", "ws-1") is True
        assert ssc.list_locally_modified_workspace_skills("ws-1") == ["shared-x"]
        assert ssc.list_locally_modified_workspace_skills() == ["ws-1/shared-x"]
        assert ssc.list_workspace_skill_names() == {"ws-1": ["shared-x"]}

    def test_missing_baseline_does_not_cry_wolf(self, tmp_path, monkeypatch):
        ssc, _skills, _d = self._mirror(tmp_path, monkeypatch)
        assert ssc.workspace_skill_is_locally_modified("shared-x", "ws-1") is False

    def test_fingerprint_is_content_based_not_mtime(self, tmp_path, monkeypatch):
        import os
        import time

        ssc, _skills, d = self._mirror(tmp_path, monkeypatch)
        before = ssc._skill_dir_fingerprint(d)
        time.sleep(0.01)
        os.utime(d / "SKILL.md", None)  # touch: mtime changes, content doesn't
        assert ssc._skill_dir_fingerprint(d) == before

    def test_auto_propose_defaults_off(self, monkeypatch):
        from tools import skills_sync_client as ssc

        monkeypatch.delenv("AGENTX_SYNC_WORKSPACE_AUTO_PROPOSE", raising=False)
        monkeypatch.setattr("hermes_cli.config.load_config", lambda: {}, raising=False)
        # Default must be OFF: silently pushing every agent edit to the whole
        # workspace is not a safe default.
        assert ssc.sync_workspace_auto_propose() is False

    def test_auto_propose_can_be_enabled_by_env(self, monkeypatch):
        from tools import skills_sync_client as ssc

        monkeypatch.setenv("AGENTX_SYNC_WORKSPACE_AUTO_PROPOSE", "1")
        assert ssc.sync_workspace_auto_propose() is True


class TestLoadTimeProvenanceHeader:
    """A workspace-shared skill announces its provenance IN the content the
    model consumes (skill_view), not only in the listing."""

    def _view(self, tmp_path, name):
        from unittest.mock import patch

        from tools import skills_tool

        with patch("tools.skills_tool.SKILLS_DIR", tmp_path / "skills"):
            return json.loads(skills_tool.skill_view(name, preprocess=False))

    def test_workspace_skill_carries_the_header_and_provenance(self, tmp_path):
        skills = tmp_path / "skills"
        _mk_skill(skills, f"{sku.WORKSPACE_MIRROR_DIR_NAME}/ws-1/shared-x", name="shared-x", body="do the thing\n")
        (skills / sku.WORKSPACE_MIRROR_DIR_NAME / "ws-1" / sku.WORKSPACE_PROVENANCE_FILE).write_text(
            json.dumps({"author_device": "bens-macbook", "workspace": "team", "ts": "2026-09-06T10:00:00Z"}),
            encoding="utf-8",
        )
        _mark_active(skills, "ws-1")
        result = self._view(tmp_path, "shared-x")
        assert result["success"] is True, result.get("error")
        content = result["content"]
        assert content.startswith("> [!NOTE] WORKSPACE-SHARED SKILL")
        assert "workspace `team` (id `ws-1`" in content and "bens-macbook" in content and "2026-09-06T10:00:00Z" in content
        assert "sync propose --workspace" in content
        assert "do the thing" in content
        assert result["workspace_provenance"] == {
            "workspace_id": "ws-1",
            "workspace": "team",
            "shared_by": "bens-macbook",
            "as_of": "2026-09-06T10:00:00Z",
        }
        assert "org" not in content.lower().replace("organi", "")  # no leftover organisation wording

    def test_personal_skill_has_no_header(self, tmp_path):
        _mk_skill(tmp_path / "skills", "personal-a", body="mine\n")
        result = self._view(tmp_path, "personal-a")
        assert result["success"] is True
        assert "[!NOTE]" not in result["content"]
        assert result["workspace_provenance"] is None
