"""MCP servers from the AgentX Skill Hub (Agent Hub P3.7): the feed kept on
disk, and the two signatures every manifest must carry before it is listed.

``tests/fixtures/mcp/feed-manifest-v1.json`` is the hub's
``tests/vectors/mcp-feed-manifest-v1.json``: a manifest the hub's renderer
wrote and signed twice. Workmate must accept it, and refuse it the moment
anything a machine would run or trust is changed.
"""

from __future__ import annotations

import base64
import copy
import json
import os
import stat
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from hermes_cli.hub_client import HubError
from tools import mcp_hub

VECTOR = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "mcp" / "feed-manifest-v1.json").read_text(encoding="utf-8"))
MANIFEST = VECTOR["manifest"]
KEYS = {VECTOR["kid"]: VECTOR["public_b64"]}
HUB = "https://hub.test"


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _signed_by_our_key(**changes) -> tuple[dict, dict]:
    """The vector's manifest with *changes* to its hub block, signed again by
    a key of this test's own: ``(manifest, keys)``."""
    key = Ed25519PrivateKey.generate()
    public = _b64(key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw))
    manifest = copy.deepcopy(MANIFEST)
    hub = manifest["hub"]
    signed_changes = changes.pop("signed", {})
    hub["signed"].update(signed_changes)
    hub.update(changes)
    hub["kid"] = hub["manifest_kid"] = "test-k"
    subset = {k: hub["signed"].get(k) for k in mcp_hub.MCP_MANIFEST_FIELDS}
    hub["signature"] = _b64(key.sign(mcp_hub.canonical_bytes(subset)))
    hub["manifest_sig"] = _b64(key.sign(mcp_hub.canonical_bytes(mcp_hub.signed_manifest_body(manifest))))
    return manifest, {"test-k": public}


class TestSignatures:
    def test_the_hubs_vector_verifies(self):
        assert mcp_hub.manifest_problem(MANIFEST, KEYS) is None
        body = mcp_hub.canonical_bytes(mcp_hub.signed_manifest_body(MANIFEST)).decode("utf-8")
        assert body == VECTOR["signed_body_canonical"]

    @pytest.mark.parametrize("path, value", [
        (("transport", "command"), "bash"),
        (("transport", "args"), ["-y", "@evil/linear-mcp@1.4.0"]),
        (("transport", "env"), {"NODE_OPTIONS": "--require /tmp/x.js"}),
        (("hub", "tool_hashes"), {"create_issue": "sha256:" + "00" * 32}),
        (("tools", "default_enabled"), ["create_issue", "list_issues"]),
        (("name",), "linear2"),
    ])
    def test_anything_a_machine_would_run_or_trust_breaks_it(self, path, value):
        tampered = copy.deepcopy(MANIFEST)
        target = tampered
        for key in path[:-1]:
            target = target.setdefault(key, {})
        target[path[-1]] = value
        assert mcp_hub.manifest_problem(tampered, KEYS) == "the manifest signature does not hold"

    def test_the_version_signature_covers_the_signed_manifest(self):
        tampered = copy.deepcopy(MANIFEST)
        tampered["hub"]["signed"]["verdict"] = "caution"
        assert mcp_hub.manifest_problem(tampered, KEYS) == "the version signature does not hold"

    def test_the_hub_block_must_be_the_version_the_hub_signed(self):
        manifest, keys = _signed_by_our_key(version="9.9.9")
        assert mcp_hub.manifest_problem(manifest, keys) == "the manifest does not describe the version the hub signed"
        manifest, keys = _signed_by_our_key(signed={"kind": "skill"})
        assert mcp_hub.manifest_problem(manifest, keys) == "the manifest does not describe the version the hub signed"

    def test_a_dangerous_scan_is_never_installable(self):
        manifest, keys = _signed_by_our_key(signed={"verdict": "dangerous"}, verdict="dangerous")
        assert mcp_hub.manifest_problem(manifest, keys) == "the hub's scan found it dangerous"

    def test_keys_and_signatures_must_be_there(self):
        assert mcp_hub.manifest_problem(MANIFEST, {}) == "signed with a key this hub does not publish"
        assert mcp_hub.manifest_problem(MANIFEST, {VECTOR["kid"]: _b64(b"\x00" * 32)}) == "the version signature does not hold"
        for key in ("signature", "manifest_sig", "kid", "manifest_kid"):
            missing = copy.deepcopy(MANIFEST)
            missing["hub"].pop(key)
            assert mcp_hub.manifest_problem(missing, KEYS) == f"hub.{key} is missing"
        assert mcp_hub.manifest_problem({"name": "x"}, KEYS) == "no manifest from the hub"
        assert mcp_hub.manifest_problem(None, KEYS) == "no manifest from the hub"


class _FakeClient:
    """``HubClient.mcp_catalog`` with a scripted answer, every call recorded."""

    def __init__(self) -> None:
        self.base_url = HUB
        self.calls: list[str] = []
        self.answer: object = ({"servers": [{"slug": "linear", "supported": True, "manifest": MANIFEST}]}, '"feed-1"')

    def mcp_catalog(self, *, bearer: str, etag: str = ""):
        self.calls.append(etag)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


class TestFeed:
    @pytest.fixture
    def keys(self):
        asked: list[bool] = []

        def fetch(again: bool) -> dict:
            asked.append(again)
            return dict(KEYS)

        fetch.asked = asked  # type: ignore[attr-defined]
        return fetch

    def test_the_feed_is_fetched_kept_and_asked_again_with_its_etag(self, keys):
        client, clock = _FakeClient(), [1000.0]
        feed = mcp_hub.refresh(client, bearer="tok", now=lambda: clock[0], keys=keys)
        assert [s["slug"] for s in feed.servers] == ["linear"] and feed.etag == '"feed-1"' and client.calls == [""]
        # fresh: the MCP tab opening again asks nothing
        mcp_hub.refresh(client, bearer="tok", now=lambda: clock[0] + 60, keys=keys)
        assert client.calls == [""]
        # stale: asked again with the tag; 304 keeps the servers
        client.answer = (None, '"feed-1"')
        clock[0] += mcp_hub.FEED_TTL_SECONDS + 1
        again = mcp_hub.refresh(client, bearer="tok", now=lambda: clock[0], keys=keys)
        assert client.calls == ["", '"feed-1"'] and [s["slug"] for s in again.servers] == ["linear"] and again.fetched_at == clock[0]
        # forced: asked even when fresh
        mcp_hub.refresh(client, bearer="tok", force=True, now=lambda: clock[0], keys=keys)
        assert len(client.calls) == 3

    def test_an_unreachable_hub_keeps_the_last_feed_and_waits_before_asking_again(self, keys):
        client, clock = _FakeClient(), [1000.0]
        mcp_hub.refresh(client, bearer="tok", now=lambda: clock[0], keys=keys)
        client.answer = HubError("could not reach the AgentX Skill Hub")
        clock[0] += mcp_hub.FEED_TTL_SECONDS + 1
        stale = mcp_hub.refresh(client, bearer="tok", now=lambda: clock[0], keys=keys)
        assert [s["slug"] for s in stale.servers] == ["linear"] and "could not reach" in stale.error
        assert mcp_hub.feed_status(HUB)["error"] == stale.error
        calls = len(client.calls)
        mcp_hub.refresh(client, bearer="tok", now=lambda: clock[0] + 10, keys=keys)
        assert len(client.calls) == calls  # not every tab opening while the hub is down
        client.answer = (None, '"feed-1"')
        back = mcp_hub.refresh(client, bearer="tok", now=lambda: clock[0] + mcp_hub.RETRY_SECONDS + 1, keys=keys)
        assert back.error == "" and len(client.calls) == calls + 1

    def test_a_key_the_cache_does_not_know_asks_the_hub_again(self):
        asked: list[bool] = []

        def keys(again: bool) -> dict:
            asked.append(again)
            return dict(KEYS) if again else {}

        feed = mcp_hub.refresh(_FakeClient(), bearer="tok", keys=keys)
        assert asked == [False, True] and feed.keys == KEYS

    def test_the_servers_on_disk_are_checked_without_the_network(self, keys):
        client = _FakeClient()
        tampered = copy.deepcopy(MANIFEST)
        tampered["transport"]["command"] = "bash"
        client.answer = ({"servers": [
            {"slug": "linear", "supported": True, "manifest": MANIFEST},
            {"slug": "evil", "supported": True, "manifest": tampered},
            {"slug": "legacy-sse", "supported": False, "manifest": None, "notes": [{"code": "workmate_sse_gateway", "params": {}}]},
        ]}, '"feed-2"')
        mcp_hub.refresh(client, bearer="tok", keys=keys)
        checked = {s["slug"]: (s["problem_kind"], s["problem"]) for s in mcp_hub.checked_servers(HUB)}
        assert checked["linear"] == (None, None)
        assert checked["evil"] == ("unverified", "the manifest signature does not hold")
        assert checked["legacy-sse"][0] == "hub_unsupported" and "workmate_sse_gateway" in checked["legacy-sse"][1]
        assert mcp_hub.checked_servers("https://another.hub") == []  # the feed of one hub is not another's

    def test_the_feed_on_disk_is_the_persons_alone(self, keys):
        mcp_hub.refresh(_FakeClient(), bearer="tok", keys=keys)
        path = mcp_hub._cache_path()
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        assert json.loads(path.read_text(encoding="utf-8"))["hub_url"] == HUB
