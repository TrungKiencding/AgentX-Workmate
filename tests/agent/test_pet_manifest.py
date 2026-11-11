"""Fetching the petdex manifest: retry, the on-disk fallback, and error shape.

No network — ``httpx.get`` is replaced by a scripted fake.
"""

from __future__ import annotations

import json

import httpx
import pytest

from agent.pet import manifest


def _payload(*slugs: str) -> dict:
    return {
        "pets": [
            {
                "slug": slug,
                "displayName": slug.title(),
                "spritesheetUrl": f"https://assets.petdex.dev/{slug}/spritesheet.webp",
            }
            for slug in slugs
        ]
    }


class _Response:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


@pytest.fixture
def scripted(monkeypatch, tmp_path):
    """Route httpx.get through a queue of outcomes; isolate the pets dir."""
    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr("agent.pet.store.get_hermes_home", lambda: tmp_path)
    manifest.clear_cache()
    outcomes: list = []
    calls: list = []

    def fake_get(url, **kwargs):
        calls.append((url, kwargs))
        outcome = outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return _Response(outcome)

    monkeypatch.setattr(httpx, "get", fake_get)
    yield outcomes, calls, tmp_path
    manifest.clear_cache()


def test_fetch_retries_once_after_a_transient_failure(scripted):
    outcomes, calls, _ = scripted
    outcomes += [httpx.ReadTimeout("slow line"), _payload("boba")]

    entries = manifest.fetch_manifest()

    assert [e.slug for e in entries] == ["boba"]
    assert len(calls) == 2


def test_connect_timeout_is_shorter_than_the_body_timeout(scripted):
    outcomes, calls, _ = scripted
    outcomes.append(_payload("boba"))

    manifest.fetch_manifest()

    timeout = calls[0][1]["timeout"]
    assert timeout.connect < timeout.read


def test_success_saves_a_copy_that_a_later_outage_serves(scripted):
    outcomes, calls, home = scripted
    outcomes.append(_payload("boba", "mochi"))
    manifest.fetch_manifest()

    saved = home / "pets" / manifest._DISK_CACHE_NAME
    assert [p["slug"] for p in json.loads(saved.read_text())["pets"]] == ["boba", "mochi"]

    # New process, petdex unreachable on both attempts.
    manifest.clear_cache()
    outcomes += [httpx.ConnectError("no route"), httpx.ConnectError("no route")]

    entries = manifest.fetch_manifest()

    assert [e.slug for e in entries] == ["boba", "mochi"]


def test_saved_copy_is_retried_against_the_network_soon(scripted, monkeypatch):
    outcomes, calls, _ = scripted
    outcomes.append(_payload("boba"))
    manifest.fetch_manifest()
    manifest.clear_cache()
    outcomes += [httpx.ConnectError("x"), httpx.ConnectError("x")]
    manifest.fetch_manifest()
    before = len(calls)

    # Still inside the retry window: no new request.
    manifest.fetch_manifest()
    assert len(calls) == before

    # Past it: the network is asked again and the fresh list wins.
    real = manifest.time.monotonic
    monkeypatch.setattr(manifest.time, "monotonic", lambda: real() + manifest._STALE_RETRY_AFTER + 1)
    outcomes.append(_payload("boba", "new-pet"))

    assert [e.slug for e in manifest.fetch_manifest()] == ["boba", "new-pet"]


def test_outage_without_a_saved_copy_raises_manifest_error(scripted):
    outcomes, calls, _ = scripted
    outcomes += [httpx.ConnectError("no route"), httpx.ConnectError("no route")]

    with pytest.raises(manifest.ManifestError, match="could not fetch petdex manifest"):
        manifest.fetch_manifest()
    assert len(calls) == manifest._FETCH_ATTEMPTS


def test_corrupt_saved_copy_is_ignored(scripted):
    outcomes, _, home = scripted
    (home / "pets").mkdir(parents=True, exist_ok=True)
    (home / "pets" / manifest._DISK_CACHE_NAME).write_text("{not json")
    outcomes += [httpx.ConnectError("x"), httpx.ConnectError("x")]

    with pytest.raises(manifest.ManifestError):
        manifest.fetch_manifest()


def test_malformed_manifest_is_not_saved(scripted):
    outcomes, _, home = scripted
    outcomes.append({"unexpected": True})

    with pytest.raises(manifest.ManifestError, match="no 'pets' array"):
        manifest.fetch_manifest()
    assert not (home / "pets" / manifest._DISK_CACHE_NAME).exists()


def test_saved_copy_is_not_listed_as_an_installed_pet(scripted):
    outcomes, _, _ = scripted
    outcomes.append(_payload("boba"))
    manifest.fetch_manifest()

    from agent.pet import store

    assert store.installed_pets() == []
