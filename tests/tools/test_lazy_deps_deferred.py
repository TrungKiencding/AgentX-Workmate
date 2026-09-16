"""Lazy installs never run on the turn path.

Three times a ``uv pip install`` reached from the middle of a chat turn made
the first message on a fresh install "send" and then do nothing for as long
as pip took to give up: a wake-word status probe, a provider adapter imported
during the agent build, the TTS availability check. These pin the rule that
ends the class — while an agent is being built or a tool's availability is
being checked, ``ensure()`` moves the install to the background and reports
the feature unavailable for now.
"""

from __future__ import annotations

import pytest

import tools.lazy_deps as ld
import tools.registry as registry


@pytest.fixture(autouse=True)
def _missing_feature(monkeypatch):
    monkeypatch.setitem(ld.LAZY_DEPS, "test.deferred", ("zzzfake>=1",))
    monkeypatch.setattr(ld, "_is_satisfied", lambda spec: False)
    monkeypatch.setattr(ld, "_allow_lazy_installs", lambda: True)
    monkeypatch.setattr(ld, "_unsupported_feature_reason", lambda feature: "")
    monkeypatch.setattr(ld, "_lazy_install_target", lambda: None)
    monkeypatch.setattr(ld, "_background_in_flight", set())
    monkeypatch.setattr(ld, "_background_failed_at", {})
    yield


@pytest.fixture
def spawned(monkeypatch):
    """Record background installs instead of starting threads."""
    calls: list[tuple[str, tuple[str, ...]]] = []
    monkeypatch.setattr(ld, "_spawn_install_thread", lambda f, m: calls.append((f, m)))
    monkeypatch.setattr(
        ld, "_venv_pip_install",
        lambda *a, **kw: pytest.fail("pip must not run on the calling thread"),
    )
    return calls


class TestDeferredInstalls:
    def test_under_deferral_nothing_installs_here_and_the_feature_is_unavailable(self, spawned):
        with ld.installs_deferred("agent build"):
            with pytest.raises(ld.FeatureUnavailable, match="deferred to the background"):
                ld.ensure("test.deferred", prompt=False)

        assert spawned == [("test.deferred", ("zzzfake>=1",))]

    def test_the_background_install_is_started_once_while_it_runs(self, spawned):
        with ld.installs_deferred("agent build"):
            for _ in range(3):
                with pytest.raises(ld.FeatureUnavailable):
                    ld.ensure("test.deferred", prompt=False)

        assert len(spawned) == 1

    def test_a_failed_background_install_is_not_retried_every_turn(self, monkeypatch, spawned):
        # What the thread does when pip fails: frees the slot, stamps the failure.
        ld._background_in_flight.add("test.deferred")
        monkeypatch.setattr(
            ld, "_venv_pip_install", lambda *a, **kw: ld._InstallResult(False, "", "no network")
        )
        ld._run_background_install("test.deferred", ("zzzfake>=1",))
        assert "test.deferred" not in ld._background_in_flight
        assert "test.deferred" in ld._background_failed_at

        with ld.installs_deferred("tool availability check"):
            with pytest.raises(ld.FeatureUnavailable):
                ld.ensure("test.deferred", prompt=False)

        assert spawned == []

        # ...until the cooldown has passed.
        ld._background_failed_at["test.deferred"] -= ld._BACKGROUND_RETRY_SECONDS + 1
        with ld.installs_deferred("tool availability check"):
            with pytest.raises(ld.FeatureUnavailable):
                ld.ensure("test.deferred", prompt=False)

        assert len(spawned) == 1

    def test_a_successful_background_install_frees_the_slot_without_a_stamp(self, monkeypatch):
        ld._background_in_flight.add("test.deferred")
        monkeypatch.setattr(
            ld, "_venv_pip_install", lambda *a, **kw: ld._InstallResult(True, "ok", "")
        )

        ld._run_background_install("test.deferred", ("zzzfake>=1",))

        assert "test.deferred" not in ld._background_in_flight
        assert "test.deferred" not in ld._background_failed_at

    def test_outside_deferral_the_install_still_runs_inline(self, monkeypatch):
        """The rule is about WHERE, not whether: a tool the model called still
        installs what it needs, in the call the person can see."""
        installed: list[tuple[str, ...]] = []

        def _pip(specs, **kw):
            installed.append(tuple(specs))
            monkeypatch.setattr(ld, "_is_satisfied", lambda spec: True)
            return ld._InstallResult(True, "ok", "")

        monkeypatch.setattr(ld, "_venv_pip_install", _pip)
        monkeypatch.setattr(ld, "_spawn_install_thread", lambda f, m: pytest.fail("not deferred"))

        assert ld.installs_are_deferred() is None
        ld.ensure("test.deferred", prompt=False)

        assert installed == [("zzzfake>=1",)]

    def test_deferral_is_per_thread_and_restores_on_exit(self):
        import threading

        seen: dict[str, object] = {}

        with ld.installs_deferred("agent build"):
            assert ld.installs_are_deferred() == "agent build"
            with ld.installs_deferred("tool availability check"):
                assert ld.installs_are_deferred() == "tool availability check"
            assert ld.installs_are_deferred() == "agent build"

            worker = threading.Thread(
                target=lambda: seen.setdefault("other", ld.installs_are_deferred())
            )
            worker.start()
            worker.join()

        assert seen["other"] is None
        assert ld.installs_are_deferred() is None


class TestAvailabilityChecksNeverInstall:
    def test_a_check_fn_that_reaches_ensure_defers_and_reports_unavailable(self, spawned):
        registry.invalidate_check_fn_cache()

        def check_needs_feature() -> bool:
            ld.ensure("test.deferred", prompt=False)
            return True

        assert registry._check_fn_cached(check_needs_feature) is False
        assert spawned == [("test.deferred", ("zzzfake>=1",))]
