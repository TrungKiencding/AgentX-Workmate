"""Tests for tools/skills_sync_client.py — the Skill Sync client.

Covers, against the frozen contract (~/src/specs/collective-wisdom/
the sync wire contract):
  * content addressing (full 64-hex) + canonical JSON (§2.1, §2.5)
  * the access gate (Nous admin) making sync inert
  * the M1-D opt-in default (nothing syncs without the sync flag)
  * object building (blob/tree/commit, exec mode, size limit)
  * push (upload + CAS), pull (materialize), and the three-way merge / 409
    conflict paths — all against an in-process mock sync server.

The mock server implements the contract §3/§4 endpoint shapes with an
in-memory object store + ref table. No live server, no network.
"""

import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

# Imported at module load ON PURPOSE: ``tools.skill_usage`` binds
# ``get_hermes_home`` at import time, so importing it for the first time
# inside a fixture that has monkeypatched the home would pin that fixture's
# tempdir into the module for the rest of the session.
import tools.skill_usage as su
import tools.skills_sync_client as ssc


# ---------------------------------------------------------------------------
# In-process mock sync server (read + write endpoints)
# ---------------------------------------------------------------------------

class _MockState:
    def __init__(self):
        self.objects = {}   # hash -> (kind, bytes)
        self.refs = {}      # name -> commit hash
        self.hsp_version = "1"
        self.max_object_bytes = 26214400
        self.force_conflict_once = False  # inject a 409 on the next CAS
        # Workspace behaviour (contract §11.5, hub decision §8 #11): advertise
        # the "workspace" feature and, when workspace_owner is False, convert
        # a workspace-HEAD CAS to a 202 proposal. workspace_member False
        # answers the workspace routes with 403 not_a_member.
        self.workspace_feature = True
        self.workspace_owner = True
        self.workspace_member = True
        # Workspace objects live in a SEPARATE scope from personal ones,
        # mirroring production's `workspace:<id>` scope key. Keeping them in a
        # distinct dict is what makes a personal-route read of shared content
        # 404 in tests exactly as it does against the real plane.
        self.workspace_objects = {}
        self.proposals = []  # [{n, to, base}]


def _make_handler(state: _MockState):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):  # silence
            pass

        def _json(self, code, obj, extra_headers=None):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            for k, v in (extra_headers or {}).items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            query = ""
            if "?" in self.path:
                query = self.path.split("?", 1)[1]

            if path == "/v1/sync/capabilities":
                features = ["personal"] + (["workspace", "proposals"] if state.workspace_feature else [])
                return self._json(200, {
                    "hsp_version": state.hsp_version,
                    "features": features,
                    "max_object_bytes": state.max_object_bytes,
                    "hash_alg": "sha256",
                    "auth": "bearer",
                })

            if path == "/v1/sync/refs":
                prefix = ""
                for part in query.split("&"):
                    if part.startswith("prefix="):
                        from urllib.parse import unquote
                        prefix = unquote(part[len("prefix="):])
                # FAITHFUL TO PRODUCTION: the personal refs route is scoped to
                # the caller's own owner and does NOT serve workspace refs.
                # Asking it for a `refs/workspace/...` prefix yields the
                # caller's personal refs, not an error — the exact trap that
                # let a broken client look healthy against a permissive mock.
                refs = [
                    {"name": n, "hash": h}
                    for n, h in state.refs.items()
                    if n.startswith(prefix) and not n.startswith("refs/workspace/")
                ]
                return self._json(200, {"refs": refs})

            if path.startswith("/v1/sync/workspaces/") and path.endswith("/refs"):
                if not state.workspace_feature:
                    return self._json(404, {"error": "unknown"})
                if not state.workspace_member:
                    return self._json(403, {"code": "not_a_member"})
                refs = [
                    {"name": n, "hash": h}
                    for n, h in state.refs.items()
                    if n.startswith("refs/workspace/")
                ]
                return self._json(200, {"refs": refs})

            if path.startswith("/v1/sync/workspaces/") and "/objects/" in path:
                if not state.workspace_member:
                    return self._json(403, {"code": "not_a_member"})
                obj_hash = path.rsplit("/objects/", 1)[1]
                if obj_hash not in state.workspace_objects:
                    return self._json(404, {"error": "not_found"})
                return self._send_object(*state.workspace_objects[obj_hash])

            if path.startswith("/v1/sync/objects/"):
                obj_hash = path[len("/v1/sync/objects/"):]
                # Workspace-scoped objects are NOT readable through the
                # personal route (production scopes it to the token owner).
                if obj_hash not in state.objects:
                    return self._json(404, {"error": "not_found"})
                return self._send_object(*state.objects[obj_hash])

            self._json(404, {"error": "unknown"})

        def _send_object(self, kind, data):
            self.send_response(200)
            self.send_header(
                "Content-Type",
                "application/octet-stream" if kind == ssc.KIND_BLOB else "application/json",
            )
            self.send_header("X-HSP-Object-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b""
            path = self.path.split("?", 1)[0]  # e.g. /v1/sync/objects?scope=workspace&workspace=ws-1

            if path == "/v1/sync/objects":
                return self._handle_put_objects(raw, workspace="scope=workspace" in self.path)

            if path.startswith("/v1/sync/refs/"):
                return self._handle_cas(raw)

            self._json(404, {"error": "unknown"})

        def _handle_put_objects(self, raw, workspace=False):
            # multipart/form-data: parse parts (field=hash, filename=type,
            # body=raw bytes). The server recomputes each hash and 422s on
            # mismatch (contract §4.2).
            ctype = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in ctype:
                return self._json(400, {"error": "expected multipart"})
            boundary = ctype.split("boundary=", 1)[1].encode("ascii")
            accepted, already = [], []
            parts = raw.split(b"--" + boundary)
            for part in parts:
                # Only trim the delimiter framing: a leading CRLF and a
                # trailing CRLF. Do NOT strip() the whole part -- that would
                # also eat legitimate trailing newlines from the object bytes.
                if part.startswith(b"\r\n"):
                    part = part[2:]
                if part.endswith(b"\r\n"):
                    part = part[:-2]
                if not part or part == b"--":
                    continue
                if b"\r\n\r\n" not in part:
                    continue
                headers_blob, body = part.split(b"\r\n\r\n", 1)
                hdr_text = headers_blob.decode("utf-8", "replace")
                claimed_hash = None
                kind = None
                for line in hdr_text.split("\r\n"):
                    if line.lower().startswith("content-disposition"):
                        for token in line.split(";"):
                            token = token.strip()
                            if token.startswith('name="'):
                                claimed_hash = token[len('name="'):-1]
                            elif token.startswith('filename="'):
                                kind = token[len('filename="'):-1]
                if claimed_hash is None:
                    continue
                real = "sha256:" + hashlib.sha256(body).hexdigest()
                if real != claimed_hash:
                    return self._json(422, {
                        "error": "hash_mismatch", "claimed": claimed_hash,
                    })
                store = state.workspace_objects if workspace else state.objects
                if claimed_hash in store:
                    already.append(claimed_hash)
                else:
                    store[claimed_hash] = (kind, body)
                    accepted.append(claimed_hash)
            return self._json(200, {"accepted": accepted, "already_present": already})

        def _handle_cas(self, raw):
            from urllib.parse import unquote
            name = unquote(self.path[len("/v1/sync/refs/"):])
            body = json.loads(raw.decode("utf-8")) if raw else {}
            frm = body.get("from")
            to = body.get("to")
            # Contract §11.5: a member's CAS on a workspace HEAD is
            # accept-always converted to a proposal → 202.
            if name.startswith("refs/workspace/") and not state.workspace_owner:
                n = len(state.proposals) + 1
                state.proposals.append({"n": n, "to": to, "base": frm})
                ws = name.split("/")[2]
                prop_ref = f"refs/workspace/{ws}/proposals/{n}"
                state.refs[prop_ref] = to
                return self._json(202, {"proposal_id": n, "ref": prop_ref})
            if state.force_conflict_once:
                state.force_conflict_once = False
                return self._json(409, {"actual": state.refs.get(name, "")})
            current = state.refs.get(name)
            if current != frm:
                return self._json(409, {"actual": current or ""})
            state.refs[name] = to
            return self._json(200, {"ref": name, "hash": to})

    return Handler


@pytest.fixture
def mock_server():
    state = _MockState()
    server = HTTPServer(("127.0.0.1", 0), _make_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        yield base, state
    finally:
        server.shutdown()
        server.server_close()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _write_skill(skills_dir: Path, name: str, body: str = "# skill\n", *, category=None):
    """Create a minimal skill dir under skills_dir; return its path."""
    parent = skills_dir / category if category else skills_dir
    d = parent / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: test\n---\n{body}", encoding="utf-8"
    )
    return d


def _jwt(claims: dict) -> str:
    import jwt as _pyjwt
    return _pyjwt.encode(claims, "x" * 32, algorithm="HS256")


# ---------------------------------------------------------------------------
# Content addressing & canonicalization (contract §2.1, §2.5, OI-5)
# ---------------------------------------------------------------------------

class TestAddressing:
    def test_full_64_hex_address(self):
        addr = ssc.wire_address(b"")
        # sha256 of empty is the well-known e3b0... digest, full 64 hex.
        assert addr == (
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )
        assert len(addr.split(":", 1)[1]) == 64

    def test_address_differs_from_local_truncated_namespace(self):
        # The wire full-64-hex must NOT equal the local truncated 16-hex form.
        data = b"hello world"
        full = ssc.wire_address(data)
        truncated = "sha256:" + hashlib.sha256(data).hexdigest()[:16]
        assert full != truncated
        assert len(full.split(":")[1]) == 64
        assert len(truncated.split(":")[1]) == 16

    def test_canonical_json_sorted_no_whitespace(self):
        out = ssc.canonical_json_bytes({"b": 1, "a": 2})
        assert out == b'{"a":2,"b":1}'
        assert b" " not in out
        assert not out.endswith(b"\n")

    def test_canonical_json_stable(self):
        obj = {"type": "tree", "entries": [{"name": "x", "hash": "sha256:aa"}]}
        assert ssc.canonical_json_bytes(obj) == ssc.canonical_json_bytes(dict(obj))


# ---------------------------------------------------------------------------
# Access gate (Nous admin) + per-skill opt-in
# ---------------------------------------------------------------------------

class TestDevGate:
    def test_gate_open_with_claim(self, monkeypatch):
        token = _jwt({"sub": "user1", "tool_gateway_admin": True})
        monkeypatch.setattr(
            ssc, "resolve_nous_runtime_credentials",
            lambda **kw: {"api_key": token, "base_url": "https://x"}, raising=False,
        )
        # patch the lazily-imported symbol used inside resolve_identity
        import hermes_cli.auth as auth_mod
        monkeypatch.setattr(auth_mod, "resolve_nous_runtime_credentials",
                            lambda **kw: {"api_key": token, "base_url": "https://x"})
        ident = ssc.resolve_identity()
        assert ident["nous_admin"] is True
        assert ident["owner"] == "user1"

    def test_gate_closed_without_claim(self, monkeypatch):
        token = _jwt({"sub": "user1"})  # no tool_gateway_admin
        import hermes_cli.auth as auth_mod
        monkeypatch.setattr(auth_mod, "resolve_nous_runtime_credentials",
                            lambda **kw: {"api_key": token, "base_url": "https://x"})
        ident = ssc.resolve_identity()
        assert ident["nous_admin"] is False

    def test_gate_closed_when_claim_false(self, monkeypatch):
        token = _jwt({"sub": "u", "tool_gateway_admin": False})
        import hermes_cli.auth as auth_mod
        monkeypatch.setattr(auth_mod, "resolve_nous_runtime_credentials",
                            lambda **kw: {"api_key": token, "base_url": "https://x"})
        assert ssc.dev_gate_open() is False

    def test_maybe_push_inert_when_gate_closed(self, monkeypatch):
        token = _jwt({"sub": "u"})
        import hermes_cli.auth as auth_mod
        monkeypatch.setattr(auth_mod, "resolve_nous_runtime_credentials",
                            lambda **kw: {"api_key": token})
        monkeypatch.setattr(ssc, "resolve_sync_base_url", lambda: "http://x")
        # gate closed -> None (inert), never attempts a push
        assert ssc.maybe_push_skills() is None

    def test_maybe_pull_inert_when_not_logged_in(self, monkeypatch):
        import hermes_cli.auth as auth_mod

        def _raise(**kw):
            raise RuntimeError("not logged in")

        monkeypatch.setattr(auth_mod, "resolve_nous_runtime_credentials", _raise)
        assert ssc.maybe_pull_skills() is None


# ---------------------------------------------------------------------------
# Object building (contract §2.2-§2.4)
# ---------------------------------------------------------------------------

class TestObjectBuilding:
    def test_build_tree_blob_and_exec(self, tmp_path):
        d = tmp_path / "skill"
        d.mkdir()
        (d / "SKILL.md").write_text("hello", encoding="utf-8")
        script = d / "run.sh"
        script.write_text("#!/bin/sh\necho hi\n", encoding="utf-8")
        script.chmod(0o755)

        objects = ssc.ObjectSet()
        tree_hash = ssc.build_tree(d, objects, max_object_bytes=ssc.DEFAULT_MAX_OBJECT_BYTES)
        assert tree_hash.startswith("sha256:")
        # tree object present and canonical
        kind, data = objects.objects[tree_hash]
        assert kind == ssc.KIND_TREE
        tree = json.loads(data)
        entries = {e["name"]: e for e in tree["entries"]}
        assert entries["SKILL.md"]["mode"] == ssc.MODE_FILE
        assert entries["run.sh"]["mode"] == ssc.MODE_EXEC
        # entries sorted by name (byte order)
        names = [e["name"] for e in tree["entries"]]
        assert names == sorted(names)

    def test_build_tree_dedups_identical_blobs(self, tmp_path):
        d = tmp_path / "skill"
        (d / "a").mkdir(parents=True)
        (d / "b").mkdir(parents=True)
        (d / "a" / "f.txt").write_text("same", encoding="utf-8")
        (d / "b" / "f.txt").write_text("same", encoding="utf-8")
        objects = ssc.ObjectSet()
        ssc.build_tree(d, objects, max_object_bytes=ssc.DEFAULT_MAX_OBJECT_BYTES)
        blob_hashes = [h for h, (k, _) in objects.objects.items() if k == ssc.KIND_BLOB]
        # only one unique blob for the identical "same" content
        assert len(set(blob_hashes)) == 1

    def test_build_tree_skips_symlink(self, tmp_path):
        d = tmp_path / "skill"
        d.mkdir()
        (d / "real.txt").write_text("x", encoding="utf-8")
        try:
            (d / "link.txt").symlink_to(d / "real.txt")
        except (OSError, NotImplementedError):
            pytest.skip("symlinks unsupported here")
        objects = ssc.ObjectSet()
        tree_hash = ssc.build_tree(d, objects, max_object_bytes=ssc.DEFAULT_MAX_OBJECT_BYTES)
        tree = json.loads(objects.objects[tree_hash][1])
        names = [e["name"] for e in tree["entries"]]
        assert "link.txt" not in names
        assert "real.txt" in names

    def test_build_tree_rejects_oversize_blob(self, tmp_path):
        d = tmp_path / "skill"
        d.mkdir()
        (d / "big").write_bytes(b"x" * 100)
        objects = ssc.ObjectSet()
        with pytest.raises(ValueError):
            ssc.build_tree(d, objects, max_object_bytes=10)

    def test_build_commit_shape(self):
        objects = ssc.ObjectSet()
        c = ssc.build_commit(
            "sha256:tree", ["sha256:p"], owner="o", device="dev",
            message="m", objects=objects, ts="2026-07-18T00:00:00Z",
        )
        commit = json.loads(objects.objects[c][1])
        assert commit["type"] == "commit"
        assert commit["tree"] == "sha256:tree"
        assert commit["parents"] == ["sha256:p"]
        assert commit["author"] == {"owner": "o", "device": "dev"}
        assert commit["artifact_type"] == "skill"


# ---------------------------------------------------------------------------
# Three-way merge decision (contract §4.4, M1-C; mirrors skills_sync.py:619)
# ---------------------------------------------------------------------------

class TestMergeDecision:
    def test_no_change(self):
        assert ssc._merge_skill("b", "b", "b") == "either"

    def test_ours_only_changed(self):
        assert ssc._merge_skill("b", "o", "b") == "ours"

    def test_theirs_only_changed(self):
        assert ssc._merge_skill("b", "b", "t") == "theirs"

    def test_both_converged(self):
        assert ssc._merge_skill("b", "x", "x") == "either"

    def test_true_overlap(self):
        assert ssc._merge_skill("b", "o", "t") == "overlap"

    def test_deleted_both(self):
        assert ssc._merge_skill(None, None, None) == "none"


# ---------------------------------------------------------------------------
# End-to-end push / pull / conflict against the mock server
# ---------------------------------------------------------------------------

@pytest.fixture
def synced_env(tmp_path, monkeypatch):
    """A AGENTX_HOME with two opted-in skills + a token-carrying identity."""
    home = tmp_path / "agentx"
    skills = home / "skills"
    skills.mkdir(parents=True)
    # Redirect the home through the environment (what the hermetic autouse
    # fixture does) rather than by replacing ``get_hermes_home`` on the
    # module: a replaced function leaks into every module first imported
    # while the patch is active, and lives on after the fixture is torn down.
    monkeypatch.setenv("AGENTX_HOME", str(home))
    monkeypatch.setattr(ssc, "_skills_dir", lambda: skills)

    _write_skill(skills, "alpha", body="alpha v1\n")
    _write_skill(skills, "beta", body="beta v1\n", category="devops")

    # Opt both into sync + treat them as eligible (bypass bundled/hub checks).
    monkeypatch.setattr(ssc, "list_synced_skill_names", lambda: ["alpha", "beta"])

    def _rel(name):
        from pathlib import PurePosixPath
        return {"alpha": PurePosixPath("alpha"),
                "beta": PurePosixPath("devops/beta")}.get(name)

    monkeypatch.setattr(ssc, "_skill_rel_path", _rel)

    def _find(name):
        return {"alpha": skills / "alpha",
                "beta": skills / "devops" / "beta"}.get(name)

    monkeypatch.setattr(su, "_find_skill_dir", _find)

    token = _jwt({"sub": "owner1", "tool_gateway_admin": True})
    identity = {"api_key": token, "base_url": "http://x", "owner": "owner1",
                "nous_admin": True, "claims": {}}
    return home, skills, identity


class TestEndToEnd:
    def test_capabilities_version_check(self, mock_server):
        base, state = mock_server
        client = ssc.SyncClient(base, "tok")
        caps = client.capabilities()
        assert caps["hsp_version"] == "1"
        ssc._check_version(caps)  # no raise

    def test_version_mismatch_raises(self, mock_server):
        base, state = mock_server
        state.hsp_version = "2"
        client = ssc.SyncClient(base, "tok")
        with pytest.raises(ssc.SyncError):
            ssc._check_version(client.capabilities())

    def test_push_uploads_and_cas(self, mock_server, synced_env):
        base, state = mock_server
        home, skills, identity = synced_env
        client = ssc.SyncClient(base, identity["api_key"])
        result = ssc.push_skills(client, identity=identity)
        assert result["ok"] is True
        # HEAD ref advanced to our commit
        head = state.refs["refs/user/owner1/HEAD"]
        assert head == result["head"]
        # commit object is present and well-formed
        kind, data = state.objects[head]
        assert kind == ssc.KIND_COMMIT
        commit = json.loads(data)
        assert commit["author"]["owner"] == "owner1"
        assert commit["parents"] == []  # first commit

    def test_push_then_pull_materializes(self, mock_server, synced_env, tmp_path, monkeypatch):
        base, state = mock_server
        home, skills, identity = synced_env
        client = ssc.SyncClient(base, identity["api_key"])
        ssc.push_skills(client, identity=identity)

        # Simulate a fresh device: new skills dir, same server, same opt-in.
        dev2 = tmp_path / "hermes2" / "skills"
        dev2.mkdir(parents=True)
        monkeypatch.setattr(ssc, "_skills_dir", lambda: dev2)
        monkeypatch.setattr(ssc, "read_sync_state", lambda: {"head": None, "skills": {}})
        saved = {}
        monkeypatch.setattr(ssc, "write_sync_state", lambda d: saved.update(d))

        result = ssc.pull_skills(client, identity=identity)
        assert result["ok"] is True
        assert "alpha" in result["updated"]
        assert "devops/beta" in result["updated"]
        # content materialized to disk
        assert (dev2 / "alpha" / "SKILL.md").read_text().endswith("alpha v1\n")
        assert (dev2 / "devops" / "beta" / "SKILL.md").read_text().endswith("beta v1\n")

    def test_push_idempotent_reupload(self, mock_server, synced_env):
        base, state = mock_server
        home, skills, identity = synced_env
        client = ssc.SyncClient(base, identity["api_key"])
        r1 = ssc.push_skills(client, identity=identity)
        n_objects = len(state.objects)
        # push again with no local change -> same head, objects already_present
        r2 = ssc.push_skills(client, identity=identity)
        assert r2["ok"] is True
        assert r2["head"] == r1["head"]
        assert len(state.objects) == n_objects  # nothing new stored

    def test_conflict_nonoverlap_merges(self, mock_server, synced_env, monkeypatch):
        base, state = mock_server
        home, skills, identity = synced_env
        client = ssc.SyncClient(base, identity["api_key"])
        # First push establishes a base head we record locally.
        first = ssc.push_skills(client, identity=identity)
        # Inject a divergent server head: change beta server-side so the next
        # CAS loses. We simulate by forcing one 409 whose actual == current head
        # (the server keeps the same tree, so no overlap on alpha which we edit).
        (skills / "alpha" / "SKILL.md").write_text(
            "---\nname: alpha\ndescription: test\n---\nalpha v2\n", encoding="utf-8"
        )
        state.force_conflict_once = True
        result = ssc.push_skills(client, identity=identity)
        # actual == our own head -> both-sides identical -> merge commit succeeds
        assert result.get("ok") is True
        assert result.get("merged") is True

    def test_conflict_true_overlap_writes_conflict_ref(self, mock_server, synced_env, monkeypatch):
        base, state = mock_server
        home, skills, identity = synced_env
        client = ssc.SyncClient(base, identity["api_key"])
        ssc.push_skills(client, identity=identity)

        # Build a DIFFERENT server-side head for the SAME skill (alpha) so the
        # three-way merge sees a true overlap. We construct it via a second
        # snapshot after editing alpha differently, push it directly, then make
        # our local head stale and edit alpha a third way.
        (skills / "alpha" / "SKILL.md").write_text(
            "---\nname: alpha\ndescription: test\n---\nSERVER edit\n", encoding="utf-8"
        )
        objs, root, _ = ssc.snapshot_profile(["alpha", "beta"])
        their_commit = ssc.build_commit(
            root, [], owner="owner1", device="other", message="theirs", objects=objs
        )
        client.put_objects(objs.objects)
        state.refs["refs/user/owner1/HEAD"] = their_commit

        # Our local edit to the same skill, from the OLD base -> true overlap.
        (skills / "alpha" / "SKILL.md").write_text(
            "---\nname: alpha\ndescription: test\n---\nLOCAL edit\n", encoding="utf-8"
        )
        result = ssc.push_skills(client, identity=identity)
        assert result.get("conflict") is True
        assert result["conflict_ref"].startswith("refs/user/owner1/conflict/")
        assert "alpha" in result["overlapping_skills"]
        # a conflict ref head was written server-side
        assert result["conflict_ref"] in state.refs


# ---------------------------------------------------------------------------
# M1-D opt-in sidecar flag (tools/skill_usage.set_sync / is_sync_enabled)
# ---------------------------------------------------------------------------

class TestOptInFlag:
    def test_set_and_read_sync_flag(self, tmp_path, monkeypatch):
        import tools.skill_usage as su
        monkeypatch.setattr(su, "_skills_dir", lambda: tmp_path)
        # Make the skill curation-eligible so the gated mutator writes.
        monkeypatch.setattr(su, "is_curation_eligible", lambda name, *a, **k: True)

        assert su.is_sync_enabled("foo") is False
        su.set_sync("foo", True)
        assert su.is_sync_enabled("foo") is True
        su.set_sync("foo", False)
        assert su.is_sync_enabled("foo") is False

    def test_sync_flag_ignored_for_ineligible(self, tmp_path, monkeypatch):
        import tools.skill_usage as su
        monkeypatch.setattr(su, "_skills_dir", lambda: tmp_path)
        # Bundled/hub/external skills are not curation-eligible -> mutator no-ops.
        monkeypatch.setattr(su, "is_curation_eligible", lambda name, *a, **k: False)
        su.set_sync("bundled-skill", True)
        assert su.is_sync_enabled("bundled-skill") is False


# ---------------------------------------------------------------------------
# §2.8 sync-manifest — opt-in as content in the sync plane (cross-device)
# ---------------------------------------------------------------------------

class TestSyncManifest:
    def test_build_parse_roundtrip(self):
        data = ssc.build_sync_manifest_bytes({"beta": True, "alpha": False})
        parsed = ssc.parse_sync_manifest(data)
        assert parsed == {"alpha": False, "beta": True}

    def test_manifest_wire_shape(self):
        # Must match gateway-gateway src/sync/manifest.ts: type + version:1 +
        # skills:[{name,enabled}]. Skills sorted by name for a stable address.
        import json
        data = ssc.build_sync_manifest_bytes({"z": True, "a": True})
        obj = json.loads(data.decode("utf-8"))
        assert obj["type"] == "sync-manifest"
        assert obj["version"] == 1
        assert obj["skills"] == [
            {"name": "a", "enabled": True},
            {"name": "z", "enabled": True},
        ]

    def test_parse_rejects_malformed(self):
        # Strict: unknown type, bad version, non-array skills, malformed entry.
        assert ssc.parse_sync_manifest(b"not json") is None
        assert ssc.parse_sync_manifest(b'{"type":"nope","version":1,"skills":[]}') is None
        assert ssc.parse_sync_manifest(b'{"type":"sync-manifest","version":2,"skills":[]}') is None
        assert ssc.parse_sync_manifest(b'{"type":"sync-manifest","version":1,"skills":{}}') is None
        assert (
            ssc.parse_sync_manifest(
                b'{"type":"sync-manifest","version":1,"skills":[{"name":"x"}]}'
            )
            is None
        )
        # A malformed manifest must NOT be mistaken for "no skills opted in".
        assert ssc.parse_sync_manifest(b'{"type":"sync-manifest","version":1,"skills":[]}') == {}

    def test_snapshot_embeds_manifest_root_blob(self, mock_server, synced_env):
        # snapshot_profile must add a root-level `sync-manifest` blob recording
        # the opted-in set, alongside the skill subtrees, so opt-in is durable
        # plane content. Read it back via read_manifest_of_root.
        base, state = mock_server
        home, skills, identity = synced_env
        client = ssc.SyncClient(base, identity["api_key"])

        objs, root_hash, skill_map = ssc.snapshot_profile(["alpha", "beta"])
        client.put_objects(objs.objects)

        manifest = ssc.read_manifest_of_root(client, root_hash)
        assert manifest == {"alpha": True, "beta": True}

        # The manifest is a root-level BLOB, not a skill subtree, so the skill
        # walk must not surface it as a skill.
        trees = ssc._skill_trees_of_root(client, root_hash)
        assert "sync-manifest" not in trees
        assert set(trees) == {"alpha", "devops/beta"}

    def test_pull_adopts_opt_in_from_manifest(self, mock_server, synced_env, monkeypatch):
        # A skill opted in on device A (present + enabled in the plane manifest)
        # becomes opted in locally on pull, even if this device had it disabled.
        base, state = mock_server
        home, skills, identity = synced_env
        client = ssc.SyncClient(base, identity["api_key"])

        # Device A pushes alpha+beta (manifest enables both).
        ssc.push_skills(client, identity=identity)

        # Simulate device B: local opt-in intent is EMPTY, but eligibility passes.
        adopted = {}
        import tools.skill_usage as su
        monkeypatch.setattr(su, "is_curation_eligible", lambda name, *a, **k: True)
        monkeypatch.setattr(su, "is_sync_enabled", lambda name: False)
        monkeypatch.setattr(su, "set_sync", lambda name, val: adopted.__setitem__(name, val))
        # Local head unknown so the pull actually runs.
        monkeypatch.setattr(ssc, "read_sync_state", lambda: {"head": None, "skills": {}})
        monkeypatch.setattr(ssc, "write_sync_state", lambda d: None)
        # No local opt-in gate (so materialize isn't the thing under test).
        monkeypatch.setattr(ssc, "_opted_in_rel_paths", lambda: [])

        result = ssc.pull_skills(client, identity=identity)
        assert result["ok"] is True
        # Both skills from the plane manifest were adopted into local opt-in.
        assert adopted == {"alpha": True, "beta": True}
        assert set(result["opt_in_adopted"]) == {"alpha", "beta"}


# ---------------------------------------------------------------------------
# Env-var configuration (AgentX Cloud "on by default" via environment)
# ---------------------------------------------------------------------------

class TestEnvConfig:
    def test_base_url_env_wins(self, monkeypatch):
        monkeypatch.setenv("AGENTX_SYNC_BASE_URL", "https://plane.example/")
        assert ssc.resolve_sync_base_url() == "https://plane.example"

    def test_base_url_defaults_to_production(self, monkeypatch):
        # With nothing configured a user must still reach the real plane —
        # otherwise every sync command fails with "no base URL configured".
        monkeypatch.delenv("AGENTX_SYNC_BASE_URL", raising=False)
        monkeypatch.setattr("hermes_cli.config.load_config", lambda: {}, raising=False)
        assert ssc.resolve_sync_base_url() == ssc.DEFAULT_SYNC_BASE_URL

    def test_default_is_a_bare_https_origin(self):
        # The client appends /v1/sync/, so the default must be a scheme+host
        # origin with no trailing slash and no path.
        from urllib.parse import urlparse

        parsed = urlparse(ssc.DEFAULT_SYNC_BASE_URL)
        assert parsed.scheme == "https"
        assert parsed.netloc
        assert parsed.path == ""
        assert not ssc.DEFAULT_SYNC_BASE_URL.endswith("/")

    def test_config_overrides_default(self, monkeypatch):
        monkeypatch.delenv("AGENTX_SYNC_BASE_URL", raising=False)
        monkeypatch.setattr(
            "hermes_cli.config.load_config",
            lambda: {"sync": {"base_url": "https://cfg.example/"}},
            raising=False,
        )
        assert ssc.resolve_sync_base_url() == "https://cfg.example"

    def test_feature_enabled_env(self, monkeypatch):
        # Default off.
        monkeypatch.delenv("AGENTX_SYNC_ENABLED", raising=False)
        monkeypatch.setattr("hermes_cli.config.load_config", lambda: {}, raising=False)
        assert ssc.sync_feature_enabled() is False
        for truthy in ("1", "true", "YES", "on"):
            monkeypatch.setenv("AGENTX_SYNC_ENABLED", truthy)
            assert ssc.sync_feature_enabled() is True
        for falsy in ("0", "false", "off"):
            monkeypatch.setenv("AGENTX_SYNC_ENABLED", falsy)
            assert ssc.sync_feature_enabled() is False

    def test_default_opt_in_env(self, monkeypatch):
        monkeypatch.delenv("AGENTX_SYNC_DEFAULT_OPT_IN", raising=False)
        monkeypatch.setattr("hermes_cli.config.load_config", lambda: {}, raising=False)
        assert ssc.sync_default_opt_in() is False
        monkeypatch.setenv("AGENTX_SYNC_DEFAULT_OPT_IN", "true")
        assert ssc.sync_default_opt_in() is True

    def test_config_yaml_fallback_when_no_env(self, monkeypatch):
        monkeypatch.delenv("AGENTX_SYNC_ENABLED", raising=False)
        monkeypatch.setattr(
            "hermes_cli.config.load_config",
            lambda: {"sync": {"enabled": True}},
            raising=False,
        )
        assert ssc.sync_feature_enabled() is True

    def test_env_overrides_config_yaml(self, monkeypatch):
        # Env wins over config.yaml (operator override precedence).
        monkeypatch.setenv("AGENTX_SYNC_ENABLED", "false")
        monkeypatch.setattr(
            "hermes_cli.config.load_config",
            lambda: {"sync": {"enabled": True}},
            raising=False,
        )
        assert ssc.sync_feature_enabled() is False

    def test_opt_out_policy_syncs_all_eligible(self, monkeypatch):
        # With opt-out on, every eligible skill syncs even with no `sync:true`
        # flag; an explicit `sync:false` still excludes.
        monkeypatch.setattr(ssc, "sync_default_opt_in", lambda: True)
        monkeypatch.setattr(ssc, "_all_local_skill_names", lambda: ["alpha", "beta", "gamma"])
        monkeypatch.setattr(ssc, "is_sync_eligible", lambda n: n in {"alpha", "beta", "gamma"})
        import tools.skill_usage as su
        # gamma explicitly opted out; alpha/beta have no flag.
        monkeypatch.setattr(su, "load_usage", lambda: {"gamma": {"sync": False}})
        assert ssc.list_synced_skill_names() == ["alpha", "beta"]

    def test_opt_in_policy_requires_flag(self, monkeypatch):
        # With opt-out OFF (default opt-in), only explicitly-enabled skills sync.
        monkeypatch.setattr(ssc, "sync_default_opt_in", lambda: False)
        monkeypatch.setattr(ssc, "is_sync_eligible", lambda n: True)
        import tools.skill_usage as su
        monkeypatch.setattr(
            su, "load_usage",
            lambda: {"alpha": {"sync": True}, "beta": {}, "gamma": {"sync": False}},
        )
        assert ssc.list_synced_skill_names() == ["alpha"]


class TestDeviceName:
    def test_default_is_hostname_seeded(self, tmp_path, monkeypatch):
        monkeypatch.setattr(ssc, "_skills_dir", lambda: tmp_path)
        monkeypatch.delenv("AGENTX_SYNC_DEVICE_NAME", raising=False)
        monkeypatch.setattr(
            "socket.gethostname", lambda: "bens-macbook.local", raising=False
        )
        val = ssc.stable_device_id()
        # short hostname + short suffix, NOT a bare 32-char hash
        assert val.startswith("bens-macbook-")
        assert val != "bens-macbook-"
        # persisted + stable across calls
        assert (tmp_path / ".sync_device_id").read_text() == val
        assert ssc.stable_device_id() == val

    def test_existing_file_wins_over_default_and_env(self, tmp_path, monkeypatch):
        monkeypatch.setattr(ssc, "_skills_dir", lambda: tmp_path)
        (tmp_path / ".sync_device_id").write_text("Explicit Name", encoding="utf-8")
        monkeypatch.setenv("AGENTX_SYNC_DEVICE_NAME", "cloud-seed")
        assert ssc.stable_device_id() == "Explicit Name"

    def test_env_seeds_first_use(self, tmp_path, monkeypatch):
        # AgentX Cloud path: AGENTX_SYNC_DEVICE_NAME seeds the first-use label.
        monkeypatch.setattr(ssc, "_skills_dir", lambda: tmp_path)
        monkeypatch.setenv("AGENTX_SYNC_DEVICE_NAME", "agentx-cloud-ben-1")
        assert ssc.stable_device_id() == "agentx-cloud-ben-1"
        # persisted so it stays stable even if the env later changes
        assert (tmp_path / ".sync_device_id").read_text() == "agentx-cloud-ben-1"
        monkeypatch.setenv("AGENTX_SYNC_DEVICE_NAME", "changed")
        assert ssc.stable_device_id() == "agentx-cloud-ben-1"

    def test_set_device_name_overwrites(self, tmp_path, monkeypatch):
        monkeypatch.setattr(ssc, "_skills_dir", lambda: tmp_path)
        (tmp_path / ".sync_device_id").write_text("old", encoding="utf-8")
        stored = ssc.set_device_name("  Ben's Laptop  ")
        assert stored == "Ben's Laptop"  # trimmed
        assert ssc.stable_device_id() == "Ben's Laptop"

    def test_set_device_name_rejects_empty(self, tmp_path, monkeypatch):
        monkeypatch.setattr(ssc, "_skills_dir", lambda: tmp_path)
        import pytest

        with pytest.raises(ValueError):
            ssc.set_device_name("   ")


# ---------------------------------------------------------------------------
# Workspace-shared skills (contract §11.5): identity gate, pull, propose (202/merge)
# ---------------------------------------------------------------------------

WS_OWNER = {"id": "ws-1", "slug": "team", "name": "Team", "role": "owner"}
WS_MEMBER = {**WS_OWNER, "role": "member"}


def _with_workspace(identity, workspace=WS_OWNER, *workspaces):
    """*identity* as the hub would describe it: a member of *workspace* (and *workspaces*)."""
    every = [workspace, *workspaces]
    claims = {**(identity.get("claims") or {}), "workspaces": every}
    return {**identity, "claims": claims, "workspaces": every, "workspace": workspace}


class TestWorkspaceIdentityGate:
    def test_identity_without_workspaces_is_inert(self, monkeypatch):
        # The Nous plane knows no workspaces; a hub account in none is the same.
        token = _jwt({"sub": "u", "org_id": "org-1"})
        import hermes_cli.auth as auth_mod
        monkeypatch.setattr(auth_mod, "resolve_nous_runtime_credentials",
                            lambda **kw: {"api_key": token, "base_url": "https://x"})
        with pytest.raises(ssc.SyncInertError):
            ssc.resolve_workspace_identity()
        assert ssc.workspace_sync_available() is False

    def test_the_only_workspace_is_picked_and_a_named_one_must_exist(self, monkeypatch):
        base = {"api_key": "t", "base_url": "https://x", "owner": "u", "claims": {"sub": "u"}}
        monkeypatch.setattr(ssc, "resolve_identity", lambda: _with_workspace(dict(base), WS_MEMBER))
        ident = ssc.resolve_workspace_identity()
        assert ident["workspace"]["id"] == "ws-1" and ident["workspace"]["role"] == "member"
        assert ssc.resolve_workspace_identity("team")["workspace"]["id"] == "ws-1"
        assert ssc.workspace_sync_available() is True
        with pytest.raises(ssc.SyncInertError) as unknown:
            ssc.resolve_workspace_identity("nope")
        assert "not a member" in str(unknown.value)
        # Several workspaces: one must be named.
        two = _with_workspace(dict(base), WS_OWNER, {"id": "ws-2", "slug": "qa", "name": "QA", "role": "member"})
        monkeypatch.setattr(ssc, "resolve_identity", lambda: two)
        with pytest.raises(ssc.SyncInertError) as ambiguous:
            ssc.resolve_workspace_identity()
        assert "--workspace" in str(ambiguous.value)
        assert ssc.resolve_workspace_identity("qa")["workspace"]["id"] == "ws-2"

    def test_workspace_mirror_excluded_from_personal_sync(self, tmp_path, monkeypatch):
        # A skill under _workspaces/<id>/ must never be personal-sync eligible.
        skills = tmp_path / "skills"
        shared = skills / "_workspaces" / "ws-1" / "shared-x"
        shared.mkdir(parents=True)
        (shared / "SKILL.md").write_text("---\nname: shared-x\n---\n")
        monkeypatch.setattr(ssc, "_skills_dir", lambda: skills)
        import tools.skill_usage as su
        monkeypatch.setattr(su, "is_bundled", lambda n: False)
        monkeypatch.setattr(su, "is_hub_installed", lambda n: False)
        monkeypatch.setattr(su, "_find_skill_dir", lambda n: shared)
        import agent.skill_utils as sku
        monkeypatch.setattr(sku, "is_external_skill_path", lambda p: False)
        assert ssc.is_sync_eligible("shared-x") is False


class TestWorkspaceEndToEnd:
    def test_owner_propose_merges_directly(self, mock_server, synced_env):
        base, state = mock_server
        home, skills, identity = synced_env
        owner = _with_workspace(identity, WS_OWNER)
        client = ssc.SyncClient(base, identity["api_key"])
        result = ssc.propose_skill("alpha", client, identity=owner)
        assert result["ok"] is True and result.get("merged") is True
        assert result["workspace_id"] == "ws-1" and result["workspace"] == "team"
        head = state.refs["refs/workspace/ws-1/HEAD"]
        assert head == result["head"]
        # Shared content lands in the WORKSPACE object scope, not the personal one.
        assert head not in state.objects, "workspace commit must not be personal-scoped"
        commit = json.loads(state.workspace_objects[head][1])
        assert commit["parents"] == []  # first commit of the workspace

    def test_member_propose_becomes_202_proposal(self, mock_server, synced_env):
        base, state = mock_server
        home, skills, identity = synced_env
        client = ssc.SyncClient(base, identity["api_key"])
        seeded = ssc.propose_skill("alpha", client, identity=_with_workspace(identity, WS_OWNER))

        # A member edits beta and proposes: the server converts to 202.
        state.workspace_owner = False
        (skills / "devops" / "beta" / "SKILL.md").write_text(
            "---\nname: beta\n---\nbeta v2 member edit\n", encoding="utf-8"
        )
        result = ssc.propose_skill("beta", client, identity=_with_workspace(identity, WS_MEMBER))
        assert result["ok"] is True and result.get("proposal_pending") is True
        assert result["proposal_id"] == 1
        # HEAD untouched; proposal ref parked at the member's commit.
        assert state.refs["refs/workspace/ws-1/HEAD"] == seeded["head"]
        assert state.refs["refs/workspace/ws-1/proposals/1"] == result["commit"]
        # NEVER reported as merged.
        assert "merged" not in result

    def test_member_proposal_splices_not_replaces(self, mock_server, synced_env):
        # The proposed root must keep the OTHER skills from HEAD (per-skill
        # delta, not a wholesale replace).
        base, state = mock_server
        home, skills, identity = synced_env
        owner = _with_workspace(identity, WS_OWNER)
        client = ssc.SyncClient(base, identity["api_key"])
        ssc.propose_skill("alpha", client, identity=owner)
        ssc.propose_skill("beta", client, identity=owner)

        state.workspace_owner = False
        result = ssc.propose_skill("alpha", client, identity=_with_workspace(identity, WS_MEMBER))
        commit = json.loads(state.workspace_objects[result["commit"]][1])
        root = json.loads(state.workspace_objects[commit["tree"]][1])
        names = {e["name"] for e in root["entries"]}
        assert "alpha" in names and "devops" in names

    def test_pull_workspace_skills_materializes_mirror(self, mock_server, synced_env):
        base, state = mock_server
        home, skills, identity = synced_env
        owner = _with_workspace(identity, WS_OWNER)
        client = ssc.SyncClient(base, identity["api_key"])
        ssc.propose_skill("alpha", client, identity=owner)

        result = ssc.pull_workspace_skills(client, identity=owner)
        assert result["ok"] is True and result["workspace_id"] == "ws-1"
        assert "alpha" in result["updated"]
        mirrored = skills / "_workspaces" / "ws-1" / "alpha" / "SKILL.md"
        assert mirrored.exists()
        assert mirrored.read_text().endswith("alpha v1\n")
        # pull_all covers every workspace and writes the marker that gates resolution.
        everything = ssc.pull_all_workspace_skills(client, identity=owner)
        assert everything["ok"] is True and everything["workspaces"]["ws-1"]["head"] == state.refs["refs/workspace/ws-1/HEAD"]
        from agent.skill_utils import read_active_workspace_ids

        assert read_active_workspace_ids(skills) == ["ws-1"]

    def test_pull_noop_when_no_head(self, mock_server, synced_env):
        base, state = mock_server
        home, skills, identity = synced_env
        client = ssc.SyncClient(base, identity["api_key"])
        result = ssc.pull_workspace_skills(client, identity=_with_workspace(identity, WS_MEMBER))
        assert result["ok"] is True and result["head"] is None and result["updated"] == []

    def test_propose_requires_the_workspace_feature(self, mock_server, synced_env):
        base, state = mock_server
        home, skills, identity = synced_env
        state.workspace_feature = False
        client = ssc.SyncClient(base, identity["api_key"])
        with pytest.raises(ssc.SyncInertError):
            ssc.propose_skill("alpha", client, identity=_with_workspace(identity, WS_OWNER))

    def test_maybe_pull_inert_without_workspaces(self, monkeypatch):
        # An account in no workspace: None, never raises.
        token = _jwt({"sub": "u", "org_id": "org-1"})
        import hermes_cli.auth as auth_mod
        monkeypatch.setattr(auth_mod, "resolve_nous_runtime_credentials",
                            lambda **kw: {"api_key": token})
        assert ssc.maybe_pull_workspace_skills() is None


class TestWorkspaceEndpointScoping:
    """Workspace reads must use the WORKSPACE endpoints, not the personal ones.

    The personal refs route is scoped to the caller's own owner: asked for a
    ``refs/workspace/...`` prefix it returns the caller's PERSONAL refs rather
    than erroring. A client reading shared state through it therefore
    concludes "this workspace has no content" and every subsequent CAS races a
    head it never saw.
    """

    def test_workspace_head_is_not_visible_on_the_personal_route(
        self, mock_server, synced_env
    ):
        base, state = mock_server
        home, skills, identity = synced_env
        state.refs["refs/workspace/ws-1/HEAD"] = "sha256:" + "a" * 64
        client = ssc.SyncClient(base, identity["api_key"])

        personal = client.get_refs("refs/workspace/ws-1/")
        assert personal == [], (
            "the personal refs route must not serve workspace refs — if it does, "
            "the mock is more permissive than production and will hide bugs"
        )
        shared = client.get_refs("refs/workspace/ws-1/", workspace="ws-1")
        assert [r["name"] for r in shared] == ["refs/workspace/ws-1/HEAD"]

    def test_second_propose_splices_onto_the_existing_head(
        self, mock_server, synced_env
    ):
        """The regression: propose #1 works, propose #2 used to raise."""
        base, state = mock_server
        home, skills, identity = synced_env
        owner = _with_workspace(identity, WS_OWNER)
        client = ssc.SyncClient(base, identity["api_key"])

        first = ssc.propose_skill("alpha", client, identity=owner)
        assert first["ok"] is True
        second = ssc.propose_skill("beta", client, identity=owner)
        assert second["ok"] is True

        head = state.refs["refs/workspace/ws-1/HEAD"]
        commit = json.loads(state.workspace_objects[head][1])
        root = json.loads(state.workspace_objects[commit["tree"]][1])
        names = {e["name"] for e in root["entries"]}
        assert "alpha" in names and "devops" in names
        assert commit["parents"], "second commit must descend from the first"

    def test_pull_sees_an_existing_head(self, mock_server, synced_env):
        """pull used to report head=None for a populated workspace."""
        base, state = mock_server
        home, skills, identity = synced_env
        owner = _with_workspace(identity, WS_OWNER)
        client = ssc.SyncClient(base, identity["api_key"])
        ssc.propose_skill("alpha", client, identity=owner)

        result = ssc.pull_workspace_skills(client=client, identity=owner)
        assert result["ok"] is True
        assert result["head"] == state.refs["refs/workspace/ws-1/HEAD"], (
            "pull must resolve the real workspace HEAD, not None"
        )
        assert result["updated"], "the workspace's skill must materialize"


class TestEmptyActualConflict:
    """A 409 with an empty ``actual`` means the ref does not exist."""

    def test_conflict_actual_empty_becomes_none(self):
        c = ssc.SyncConflict("")
        assert c.actual is None
        assert "does not exist" in str(c)

    def test_push_recovers_from_a_stale_local_head(self, mock_server, synced_env):
        """Switching sync planes leaves a foreign head in local state.

        The CAS then fails against a ref that does not exist, and the server
        answers 409 with an empty ``actual``. The client must redo the CAS as
        a create rather than trying to fetch "" as a commit (which surfaced as
        the bizarre `object  not found`, with a doubled space).
        """
        base, state = mock_server
        home, skills, identity = synced_env
        st = ssc.read_sync_state()
        st["head"] = "sha256:" + "f" * 64  # head from another plane
        ssc.write_sync_state(st)

        client = ssc.SyncClient(base, identity["api_key"])
        result = ssc.push_skills(client=client, identity=identity)
        assert result["ok"] is True
        assert result.get("recovered_stale_head") is True
        assert state.refs[ssc.user_head_ref(identity["owner"])] == result["head"]
