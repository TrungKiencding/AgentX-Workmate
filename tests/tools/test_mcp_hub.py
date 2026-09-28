"""MCP servers from the AgentX Skill Hub (Agent Hub P3.7): the feed kept on
disk, and the two signatures every manifest must carry before it is listed.
Since P6.1 the feed is signed whole and dated, a replayed or changed one is
refused, and only keys this machine pinned — or that a pinned key endorsed —
verify anything (``tools/hub_trust.py``).

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

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from hermes_cli.hub_client import HubError
from tools import hub_trust, mcp_hub

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
        assert mcp_hub.manifest_problem(MANIFEST, {}) == "signed with a key this machine does not trust"
        assert mcp_hub.manifest_problem(MANIFEST, {VECTOR["kid"]: _b64(b"\x00" * 32)}) == "the version signature does not hold"
        for key in ("signature", "manifest_sig", "kid", "manifest_kid"):
            missing = copy.deepcopy(MANIFEST)
            missing["hub"].pop(key)
            assert mcp_hub.manifest_problem(missing, KEYS) == f"hub.{key} is missing"
        assert mcp_hub.manifest_problem({"name": "x"}, KEYS) == "no manifest from the hub"
        assert mcp_hub.manifest_problem(None, KEYS) == "no manifest from the hub"


def _pub(private: Ed25519PrivateKey) -> str:
    return _b64(private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw))


def _canonical(value) -> bytes:
    """The hub's canonical JSON written out by hand: sorted keys, no whitespace, UTF-8."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class _Hub:
    """A hub of these tests: its current key ``kid``, the retired keys it still
    holds, the well-known document that publishes them — the current key
    endorsed by every retired one, as the hub does (Agent Hub P6.1) — and
    feeds it signs whole, over manifests it signed too."""

    def __init__(self, kid: str = "k1", *, retired: dict | None = None, endorse: bool = True) -> None:
        self.kid, self.key, self.retired, self.endorse = kid, Ed25519PrivateKey.generate(), dict(retired or {}), endorse

    def rotated(self, kid: str, *, endorse: bool = True) -> "_Hub":
        """The same hub after a rotation: a new current key, the old one retired."""
        return _Hub(kid, retired={**self.retired, self.kid: self.key}, endorse=endorse)

    def well_known(self) -> dict:
        public = _pub(self.key)
        vouched = _canonical({"alg": "ed25519", "ed25519_pub": public, "kid": self.kid, "purpose": "agentx-hub-signing-key"})
        current = {"kid": self.kid, "alg": "ed25519", "ed25519_pub": public, "status": "current",
                   "endorsements": [{"kid": kid, "sig": _b64(key.sign(vouched))} for kid, key in self.retired.items()] if self.endorse else []}
        return {"api_version": 1, "signing_keys": [current, *({"kid": kid, "alg": "ed25519", "ed25519_pub": _pub(key), "status": "retired"}
                                                           for kid, key in self.retired.items())]}

    def manifest(self) -> dict:
        """The vector's manifest, both signatures made again with the current key."""
        manifest = copy.deepcopy(MANIFEST)
        hub = manifest["hub"]
        hub["kid"] = hub["manifest_kid"] = self.kid
        hub["signature"] = _b64(self.key.sign(_canonical({k: hub["signed"].get(k) for k in mcp_hub.MCP_MANIFEST_FIELDS})))
        hub["manifest_sig"] = _b64(self.key.sign(_canonical(mcp_hub.signed_manifest_body(manifest))))
        return manifest

    def feed(self, servers: list | None = None, *, issued_at: str = "2026-09-25T08:00:00+00:00", hub: str = HUB) -> dict:
        """A feed of *servers* (the linear manifest by default), signed whole:
        ``feed_sig`` over ``{hub, issued_at, product, servers: [[slug, version, manifest_sig], …]}``."""
        servers = servers if servers is not None else [{"slug": "linear", "version": "1.4.0", "supported": True, "manifest": self.manifest()}]
        listed = [[s["slug"], s["version"], ((s.get("manifest") or {}).get("hub") or {}).get("manifest_sig")] for s in servers]
        signed = _canonical({"hub": hub, "issued_at": issued_at, "product": "workmate", "servers": listed})
        return {"product": "workmate", "hub": hub, "issued_at": issued_at, "servers": servers, "feed_sig": _b64(self.key.sign(signed)), "feed_kid": self.kid}


class _FakeClient:
    """``HubClient.mcp_catalog`` with a scripted answer, every call recorded,
    and the hub's well-known document behind ``_transport`` (where the key
    source reads it)."""

    def __init__(self, hub: _Hub | None = None, *, base_url: str = HUB) -> None:
        self.base_url = base_url
        self.hub = hub or _Hub()
        self.calls: list[str] = []
        self.well_known_reads = 0
        self.answer: object = (self.hub.feed(hub=base_url), '"feed-1"')
        self._transport = httpx.MockTransport(self._serve)

    def _serve(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/.well-known/agentx-hub.json":
            self.well_known_reads += 1
            return httpx.Response(200, json=self.hub.well_known())
        return httpx.Response(404)

    def mcp_catalog(self, *, bearer: str, etag: str = ""):
        self.calls.append(etag)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


class TestFeed:
    def test_the_feed_is_fetched_kept_and_asked_again_with_its_etag(self):
        client, clock = _FakeClient(), [1000.0]
        feed = mcp_hub.refresh(client, bearer="tok", now=lambda: clock[0])
        assert [s["slug"] for s in feed.servers] == ["linear"] and feed.etag == '"feed-1"' and client.calls == [""]
        assert feed.error == "" and feed.issued_at == "2026-09-25T08:00:00+00:00"
        # fresh: the MCP tab opening again asks nothing
        mcp_hub.refresh(client, bearer="tok", now=lambda: clock[0] + 60)
        assert client.calls == [""]
        # stale: asked again with the tag; 304 keeps the servers
        client.answer = (None, '"feed-1"')
        clock[0] += mcp_hub.FEED_TTL_SECONDS + 1
        again = mcp_hub.refresh(client, bearer="tok", now=lambda: clock[0])
        assert client.calls == ["", '"feed-1"'] and [s["slug"] for s in again.servers] == ["linear"] and again.fetched_at == clock[0]
        # forced: asked even when fresh
        mcp_hub.refresh(client, bearer="tok", force=True, now=lambda: clock[0])
        assert len(client.calls) == 3

    def test_an_unreachable_hub_keeps_the_last_feed_and_waits_before_asking_again(self):
        client, clock = _FakeClient(), [1000.0]
        mcp_hub.refresh(client, bearer="tok", now=lambda: clock[0])
        client.answer = HubError("could not reach the AgentX Skill Hub")
        clock[0] += mcp_hub.FEED_TTL_SECONDS + 1
        stale = mcp_hub.refresh(client, bearer="tok", now=lambda: clock[0])
        assert [s["slug"] for s in stale.servers] == ["linear"] and "could not reach" in stale.error
        assert mcp_hub.feed_status(HUB)["error"] == stale.error
        calls = len(client.calls)
        mcp_hub.refresh(client, bearer="tok", now=lambda: clock[0] + 10)
        assert len(client.calls) == calls  # not every tab opening while the hub is down
        client.answer = (None, '"feed-1"')
        back = mcp_hub.refresh(client, bearer="tok", now=lambda: clock[0] + mcp_hub.RETRY_SECONDS + 1)
        assert back.error == "" and len(client.calls) == calls + 1

    def test_a_key_the_cache_does_not_know_asks_the_hub_again_and_is_trusted_only_if_endorsed(self):
        """P6.1 (Workmate review F1). The first keys this machine read from a hub
        are pinned. A feed signed with a key it has not pinned makes it read the
        hub's keys again; the new key is trusted only when a pinned one endorsed
        it. Before, any key the hub's address handed out was trusted — a proxy
        could serve its own key with a feed signed by it."""
        client = _FakeClient()
        assert mcp_hub.refresh(client, bearer="tok").error == "" and client.well_known_reads == 1
        pinned = client.hub
        # someone answering for the hub hands out a key of its own, endorsed by nobody
        client.hub = pinned.rotated("k9", endorse=False)
        client.answer = (client.hub.feed(servers=[{"slug": "linear", "version": "1.4.0", "supported": True, "manifest": client.hub.manifest()},
                                                  {"slug": "evil", "version": "1.0.0", "supported": True, "manifest": client.hub.manifest()}],
                                         issued_at="2026-09-25T09:00:00+00:00"), '"feed-2"')
        refused = mcp_hub.refresh(client, bearer="tok", force=True)
        assert client.well_known_reads == 2  # asked again for the key it did not know
        assert "does not trust" in refused.error and [s["slug"] for s in refused.servers] == ["linear"]  # the last good feed
        assert refused.issued_at == "2026-09-25T08:00:00+00:00" and refused.etag == '"feed-1"'
        assert [(n["code"], n["kid"]) for n in mcp_hub.feed_status(HUB)["notices"]] == [("hub_key_untrusted", "k9")]
        assert "k9" not in hub_trust.trusted(HUB)
        # its manifests never verify, even in a feed signed by a trusted key
        client.hub = pinned
        client.answer = (pinned.feed(servers=[{"slug": "linear", "version": "1.4.0", "supported": True, "manifest": pinned.rotated("k9", endorse=False).manifest()}],
                                     issued_at="2026-09-25T10:00:00+00:00"), '"feed-3"')
        mcp_hub.refresh(client, bearer="tok", force=True)
        [linear] = mcp_hub.checked_servers(HUB)
        assert (linear["problem_kind"], linear["problem"]) == ("unverified", "signed with a key this machine does not trust")

    def test_an_endorsed_rotation_carries_the_trust_over(self):
        client = _FakeClient()
        mcp_hub.refresh(client, bearer="tok")
        client.hub = client.hub.rotated("k2")  # k1 retired, and it vouches for k2
        client.answer = (client.hub.feed(issued_at="2026-09-25T09:00:00+00:00"), '"feed-2"')
        feed = mcp_hub.refresh(client, bearer="tok", force=True)
        assert feed.error == "" and feed.notices == [] and feed.issued_at == "2026-09-25T09:00:00+00:00"
        assert sorted(hub_trust.trusted(HUB)) == ["k1", "k2"]
        [linear] = mcp_hub.checked_servers(HUB)
        assert linear["problem"] is None and linear["manifest"]["hub"]["kid"] == "k2"

    @pytest.mark.parametrize("forge", ["unendorsed", "endorsed_by_an_unknown_key", "endorsement_of_another_key", "a_pinned_kid_with_another_key"])
    def test_an_unendorsed_key_is_refused(self, forge):
        client = _FakeClient()
        mcp_hub.refresh(client, bearer="tok")
        pinned = client.hub
        if forge == "unendorsed":
            client.hub = pinned.rotated("k2", endorse=False)
        elif forge == "endorsed_by_an_unknown_key":
            client.hub = _Hub("k1").rotated("k2")  # "k1" retired, but not the k1 this machine pinned
        elif forge == "endorsement_of_another_key":
            client.hub = pinned.rotated("k2")
            real = client.hub.well_known
            client.hub.well_known = lambda: {**real(), "signing_keys": [{**real()["signing_keys"][0], "ed25519_pub": _pub(Ed25519PrivateKey.generate())},
                                                                       *real()["signing_keys"][1:]]}
        else:
            client.hub = _Hub("k1")  # the same kid, another key
        client.answer = (client.hub.feed(issued_at="2026-09-25T09:00:00+00:00"), '"feed-2"')
        refused = mcp_hub.refresh(client, bearer="tok", force=True)
        assert "does not trust" in refused.error and refused.issued_at == "2026-09-25T08:00:00+00:00"
        assert [n["code"] for n in mcp_hub.feed_status(HUB)["notices"]] == ["hub_key_untrusted"]
        assert hub_trust.trusted(HUB)["k1"] == _pub(pinned.key)

    def test_a_reset_is_the_one_way_to_trust_an_unendorsed_key(self):
        client = _FakeClient()
        mcp_hub.refresh(client, bearer="tok")
        client.hub = client.hub.rotated("k2", endorse=False)
        client.answer = (client.hub.feed(issued_at="2026-09-25T09:00:00+00:00"), '"feed-2"')
        assert "does not trust" in mcp_hub.refresh(client, bearer="tok", force=True).error
        assert hub_trust.reset(HUB) is True and hub_trust.trusted(HUB) == {}
        feed = mcp_hub.refresh(client, bearer="tok", force=True)  # the keys the hub publishes now are pinned
        assert feed.error == "" and feed.notices == [] and sorted(hub_trust.trusted(HUB)) == ["k1", "k2"]

    def test_an_older_feed_is_a_replay_and_the_last_good_one_is_kept(self):
        client = _FakeClient()
        client.answer = (client.hub.feed(issued_at="2026-09-25T09:00:00+00:00"), '"feed-1"')
        mcp_hub.refresh(client, bearer="tok")
        old = [{"slug": "linear", "version": "1.4.0", "supported": True, "manifest": client.hub.manifest()},
               {"slug": "yanked", "version": "0.9.0", "supported": True, "manifest": client.hub.manifest()}]
        client.answer = (client.hub.feed(servers=old, issued_at="2026-09-25T08:59:59+00:00"), '"feed-0"')
        replayed = mcp_hub.refresh(client, bearer="tok", force=True)
        assert "older" in replayed.error and [s["slug"] for s in replayed.servers] == ["linear"]
        assert replayed.issued_at == "2026-09-25T09:00:00+00:00"
        # the same moment again is no replay; a later one is taken
        client.answer = (client.hub.feed(issued_at="2026-09-25T09:00:00+00:00"), '"feed-1"')
        assert mcp_hub.refresh(client, bearer="tok", force=True).error == ""
        client.answer = (client.hub.feed(servers=old, issued_at="2026-09-25T10:00:00Z"), '"feed-2"')
        assert [s["slug"] for s in mcp_hub.refresh(client, bearer="tok", force=True).servers] == ["linear", "yanked"]

    def test_a_feed_changed_on_the_way_or_for_another_hub_is_refused(self):
        client = _FakeClient()
        mcp_hub.refresh(client, bearer="tok")
        later = client.hub.feed(servers=[{"slug": "linear", "version": "1.4.0", "supported": True, "manifest": client.hub.manifest()},
                                         {"slug": "notes", "version": "2.0.0", "supported": True, "manifest": client.hub.manifest()}],
                                issued_at="2026-09-25T09:00:00+00:00")
        for body, why in (({**later, "servers": later["servers"][:1]}, "does not hold"),
                          ({**later, "issued_at": "2026-09-25T11:00:00+00:00"}, "does not hold"),
                          (client.hub.feed(issued_at="2026-09-25T09:00:00+00:00", hub="https://another.hub"), "another hub"),
                          ({k: v for k, v in later.items() if k != "feed_sig"}, "not signed")):
            client.answer = (body, '"feed-x"')
            refused = mcp_hub.refresh(client, bearer="tok", force=True)
            assert why in refused.error and [s["slug"] for s in refused.servers] == ["linear"], why

    def test_a_hub_not_reached_over_https_is_refused(self):
        client = _FakeClient(base_url="http://hub.test")
        feed = mcp_hub.refresh(client, bearer="tok")
        assert client.calls == [] and client.well_known_reads == 0 and "https" in feed.error
        mcp_hub._write_feed(mcp_hub.HubFeed(hub_url="http://hub.test", servers=[{"slug": "linear", "supported": True, "manifest": MANIFEST}],
                                            keys=dict(KEYS)))  # a feed fetched before the rule
        assert mcp_hub.checked_servers("http://hub.test") == []
        # a hub on this machine may speak plain http (development)
        local = _FakeClient(base_url="http://127.0.0.1:8820")
        assert mcp_hub.refresh(local, bearer="tok").error == "" and local.calls == [""]
        assert [s["problem"] for s in mcp_hub.checked_servers("http://127.0.0.1:8820")] == [None]

    def test_the_servers_on_disk_are_checked_without_the_network(self):
        client = _FakeClient()
        tampered = client.hub.manifest()
        tampered["transport"]["command"] = "bash"
        client.answer = (client.hub.feed(servers=[
            {"slug": "linear", "version": "1.4.0", "supported": True, "manifest": client.hub.manifest()},
            {"slug": "evil", "version": "1.4.0", "supported": True, "manifest": tampered},
            {"slug": "legacy-sse", "version": "1.0.0", "supported": False, "manifest": None, "notes": [{"code": "workmate_sse_gateway", "params": {}}]},
        ]), '"feed-2"')
        mcp_hub.refresh(client, bearer="tok")
        checked = {s["slug"]: (s["problem_kind"], s["problem"]) for s in mcp_hub.checked_servers(HUB)}
        assert checked["linear"] == (None, None)
        assert checked["evil"] == ("unverified", "the manifest signature does not hold")
        assert checked["legacy-sse"][0] == "hub_unsupported" and "workmate_sse_gateway" in checked["legacy-sse"][1]
        assert mcp_hub.checked_servers("https://another.hub") == []  # the feed of one hub is not another's

    def test_the_feed_on_disk_is_the_persons_alone(self):
        mcp_hub.refresh(_FakeClient(), bearer="tok")
        path = mcp_hub._cache_path()
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        pins = hub_trust._trust_path()  # the keys pinned for the hub, beside the feed
        assert pins.parent == path.parent and stat.S_IMODE(os.stat(pins).st_mode) == 0o600
        assert json.loads(path.read_text(encoding="utf-8"))["hub_url"] == HUB


class TestHubKeysCommand:
    """``agentx mcp hub-keys [--reset]``: what this machine trusts of the hub's
    keys, and the deliberate reset — the one way to trust a key no pinned key
    endorsed (Agent Hub P6.1)."""

    def test_the_command_parses(self):
        import argparse

        from hermes_cli.subcommands.mcp import build_mcp_parser

        parser = argparse.ArgumentParser()
        build_mcp_parser(parser.add_subparsers(dest="command"), cmd_mcp=lambda _args: None)
        args = parser.parse_args(["mcp", "hub-keys", "--reset"])
        assert (args.mcp_action, args.reset) == ("hub-keys", True)
        assert parser.parse_args(["mcp", "hub-keys"]).reset is False

    def test_it_shows_the_pins_and_a_reset_pins_what_the_hub_publishes_now(self, monkeypatch, capsys):
        from types import SimpleNamespace

        from hermes_cli.mcp_config import mcp_command

        monkeypatch.setenv("AGENTX_SKILLS_HUB_URL", HUB)
        client = _FakeClient()
        real = mcp_hub.signing_keys
        monkeypatch.setattr(mcp_hub, "signing_keys", lambda base_url, *, transport=None, refresh=False: real(base_url, transport=client._transport,
                                                                                                             refresh=refresh))
        mcp_hub.refresh(client, bearer="tok")
        client.hub = client.hub.rotated("k2", endorse=False)
        client.answer = (client.hub.feed(issued_at="2026-09-25T09:00:00+00:00"), '"feed-2"')
        mcp_hub.refresh(client, bearer="tok", force=True)
        mcp_command(SimpleNamespace(mcp_action="hub-keys", reset=False))
        shown = capsys.readouterr().out
        assert "k1" in shown and "k2" in shown and "--reset" in shown and sorted(hub_trust.trusted(HUB)) == ["k1"]
        mcp_command(SimpleNamespace(mcp_action="hub-keys", reset=True))
        assert "k2" in capsys.readouterr().out and sorted(hub_trust.trusted(HUB)) == ["k1", "k2"]
        assert mcp_hub.refresh(client, bearer="tok", force=True).error == ""
