"""A reopened chat saved on a model the account no longer has.

Resuming it raised AccountModelNotAllowed while building the agent, so the
chat had no agent at all and the desktop could not even switch its model:
every turn answered "This model is not assigned to your AgentX account".
_make_agent now opens it on a model the account is granted now.
"""

from __future__ import annotations

import pytest

from hermes_cli import account_inference
from hermes_cli.account_inference import AccountModelNotAllowed, AccountProviderNotAllowed
from tui_gateway import server


@pytest.fixture()
def grant(monkeypatch):
    def _set(models, default=None):
        monkeypatch.setattr(account_inference, "account_models", lambda **_: tuple(models))
        monkeypatch.setattr(
            "hermes_cli.config.load_config",
            lambda: {"model": {"default": default}} if default is not None else {},
        )

    return _set


def test_prefers_the_configured_default_when_it_is_granted(grant):
    grant(["mock-a", "mock-reopened"], default="mock-reopened")

    assert server._granted_replacement_model(AccountModelNotAllowed(), "mock-old") == "mock-reopened"


def test_falls_back_to_the_first_granted_model(grant):
    grant(["mock-a", "mock-b"], default="mock-old")

    assert server._granted_replacement_model(AccountModelNotAllowed(), "mock-old") == "mock-a"


def test_a_scalar_model_setting_is_read_as_the_default(grant, monkeypatch):
    grant(["mock-a", "mock-b"])
    monkeypatch.setattr("hermes_cli.config.load_config", lambda: {"model": "mock-b"})

    assert server._granted_replacement_model(AccountModelNotAllowed(), "mock-old") == "mock-b"


@pytest.mark.parametrize(
    "exc",
    [AccountProviderNotAllowed(), RuntimeError("boom"), ValueError("x")],
)
def test_other_failures_are_not_rescued(grant, exc):
    grant(["mock-a"])

    assert server._granted_replacement_model(exc, "mock-old") is None


def test_no_grant_on_record_is_not_rescued(grant):
    grant([])

    assert server._granted_replacement_model(AccountModelNotAllowed(), "mock-old") is None
