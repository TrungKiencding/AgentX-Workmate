"""Contract tests for the desktop gateway's parent-death watchdog."""

import signal
import threading

import pytest

from hermes_cli import parent_watchdog


@pytest.fixture(autouse=True)
def _reset_install_state():
    """The install guard is module state; each test starts from disarmed."""
    parent_watchdog._installed = False
    yield
    parent_watchdog._installed = False


def test_is_orphaned_is_false_while_direct_parent_is_unchanged():
    assert parent_watchdog._is_orphaned(1234, getppid=lambda: 1234) is False


def test_is_orphaned_is_true_once_the_parent_is_replaced_by_init():
    assert parent_watchdog._is_orphaned(1234, getppid=lambda: 1) is True


@pytest.mark.parametrize(
    "env, expected",
    [
        ({"AGENTX_DESKTOP": "1"}, True),
        ({"AGENTX_DESKTOP": "true"}, True),
        ({}, False),
        ({"AGENTX_DESKTOP": "0"}, False),
        ({"AGENTX_DESKTOP": "1", "AGENTX_NO_PARENT_WATCHDOG": "1"}, False),
    ],
)
def test_should_watch_only_for_desktop_spawned_and_not_opted_out(env, expected):
    assert parent_watchdog.should_watch(env=env, os_name="posix") is expected


def test_should_watch_is_off_on_non_posix():
    # The check relies on reparenting, which Windows does not do.
    assert parent_watchdog.should_watch(
        env={"AGENTX_DESKTOP": "1"}, os_name="nt"
    ) is False


def test_watch_loop_polls_until_orphaned_then_hands_off_once():
    verdicts = iter([False, False, True])
    sleeps = []
    calls = []

    parent_watchdog._watch_loop(
        4321,
        is_orphaned=lambda ppid: next(verdicts),
        on_orphaned=lambda: calls.append("terminate"),
        sleep=sleeps.append,
    )

    assert calls == ["terminate"]
    assert sleeps == [parent_watchdog._POLL_INTERVAL_S] * 2


def test_terminate_self_asks_gracefully_before_it_insists():
    signals = []
    exits = []
    sleeps = []

    parent_watchdog._terminate_self(
        kill=lambda pid, sig: signals.append((pid, sig)),
        getpid=lambda: 777,
        sleep=sleeps.append,
        hard_exit=exits.append,
        grace_s=3.0,
    )

    # SIGTERM to ourselves is the same teardown a clean desktop quit drives.
    assert signals == [(777, signal.SIGTERM)]
    assert sleeps == [3.0]
    assert exits == [parent_watchdog._ORPHAN_EXIT_CODE]


def test_install_refuses_when_there_is_no_meaningful_parent():
    # Already reparented: arming would fire on the first tick and kill a
    # healthy gateway.
    armed = parent_watchdog.install_parent_death_watchdog(
        env={"AGENTX_DESKTOP": "1"},
        os_name="posix",
        getppid=lambda: 1,
    )

    assert armed is False
    assert parent_watchdog._installed is False


def test_install_is_a_no_op_outside_the_desktop():
    armed = parent_watchdog.install_parent_death_watchdog(
        env={}, os_name="posix", getppid=lambda: 4321
    )

    assert armed is False
    assert parent_watchdog._installed is False


def test_install_arms_once_and_is_idempotent():
    # A never-orphaned verdict keeps the real thread parked in its poll loop,
    # so arming here cannot SIGTERM the test runner.
    def arm():
        return parent_watchdog.install_parent_death_watchdog(
            env={"AGENTX_DESKTOP": "1"},
            os_name="posix",
            getppid=lambda: 4321,
            is_orphaned=lambda ppid: False,
            on_orphaned=lambda: None,
        )

    first, second = arm(), arm()

    assert first is True
    assert second is False
    assert any(
        thread.name == "parent-death-watchdog" and thread.daemon
        for thread in threading.enumerate()
    )
