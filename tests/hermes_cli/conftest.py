"""Fixtures shared across hermes_cli kanban tests."""

from __future__ import annotations

import pytest


@pytest.fixture
def all_assignees_spawnable(monkeypatch):
    """Pretend every assignee maps to a real AgentX profile.

    Most dispatcher tests use synthetic assignees ("alice", "bob") that
    don't correspond to actual profile directories on disk. Without this
    patch, the dispatcher's profile-exists guard (PR #20105) routes
    those tasks into ``skipped_nonspawnable`` instead of spawning, which
    would break tests that assert spawn behavior.
    """
    from hermes_cli import profiles
    monkeypatch.setattr(profiles, "profile_exists", lambda name: True)


@pytest.fixture(autouse=True)
def _suppress_concurrent_hermes_gate(request, monkeypatch):
    """Default ``_detect_concurrent_hermes_instances`` to ``[]`` for every test.

    The Windows update path now refuses to proceed when another
    ``agentx.exe`` is detected (issue #26670). On a developer's Windows
    machine running the test suite via ``agentx`` itself, this would
    flag the running agent as a concurrent instance and abort every
    ``cmd_update`` test. Tests that want to exercise the gate explicitly
    re-patch ``_detect_concurrent_hermes_instances`` with their own
    return value — autouse here gives a clean default without touching
    the rest of the suite.

    Tests that need to call the REAL function (e.g. unit tests for the
    helper itself) opt out with ``@pytest.mark.real_concurrent_gate``.
    """
    if request.node.get_closest_marker("real_concurrent_gate"):
        return
    try:
        from hermes_cli import main as _cli_main
    except Exception:
        return
    # raising=False: under pytest's per-test spawn isolation, a concurrent
    # xdist worker importing a module that transitively touches hermes_cli.main
    # can briefly expose a partially-initialized module object here — one where
    # _detect_concurrent_hermes_instances isn't defined yet. A bare setattr
    # would raise AttributeError and error the (unrelated) test. The attribute
    # always exists once main.py finishes importing, so a no-op when it's
    # transiently absent is the correct, race-free default.
    monkeypatch.setattr(
        _cli_main,
        "_detect_concurrent_hermes_instances",
        lambda *_a, **_k: [],
        raising=False,
    )


@pytest.fixture
def update_leaves_checkout_alone(monkeypatch):
    """Keep a mocked ``cmd_update`` run off the real checkout's files.

    ``cmd_update`` resolves ``PROJECT_ROOT`` to the checkout the suite runs
    from, and its bytecode step stays real even with git/uv mocked:
    ``_clear_bytecode_cache`` deletes every ``__pycache__`` under the
    checkout and ``_record_bytecode_fingerprint`` writes
    ``.bytecode-fingerprint`` into it. Under the per-file parallel runner the
    deletion races every other test process — tests/gateway/conftest.py's
    fingerprint rglob then hits a vanished ``tests/gateway/__pycache__`` and
    that file dies with an INTERNALERROR before collecting a test.
    """
    from hermes_cli import main as hermes_main

    monkeypatch.setattr(hermes_main, "_clear_bytecode_cache", lambda *_a, **_k: 0)
    monkeypatch.setattr(hermes_main, "_record_bytecode_fingerprint", lambda *_a, **_k: None)
