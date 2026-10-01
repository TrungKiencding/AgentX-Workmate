"""The second brain moved into AgentX SSO (2026-10-01): every reader follows it.

The shipped default is the SSO's keys service. A config.yaml that still names
the retired address (an older build wrote the default out, and a key present
in the raw config outlives every later default) is read as the current
default — where the value is read, because a desktop install never runs the
config migration ladder. An address somebody chose is left exactly as it is.
"""

from __future__ import annotations

from unittest.mock import patch
from urllib.parse import urlsplit

import pytest

from hermes_cli.account_provisioning import load_settings, resolve_second_brain_url
from hermes_cli.config_defaults import DEPLOYMENT_SECOND_BRAIN_URL

NEW = "https://agentx.astralx.com.vn/keys"


def _machine(base_url):
    return {"accounts": {"second_brain": {"base_url": base_url}}}


def test_the_shipped_default_is_the_sso_keys_service():
    assert DEPLOYMENT_SECOND_BRAIN_URL == NEW
    parts = urlsplit(DEPLOYMENT_SECOND_BRAIN_URL)
    assert parts.scheme == "https" and not DEPLOYMENT_SECOND_BRAIN_URL.endswith("/")


@pytest.mark.parametrize(
    "retired",
    [
        "https://brain.dev-server.cloud",
        "https://brain.dev-server.cloud/",
        "  https://brain.dev-server.cloud/  ",
        "HTTPS://Brain.Dev-Server.Cloud",
    ],
)
def test_the_retired_address_reads_as_the_current_default(retired):
    assert resolve_second_brain_url(retired) == NEW


@pytest.mark.parametrize(
    ("chosen", "kept"),
    [
        ("https://brain.dev-server.cloud:8443", "https://brain.dev-server.cloud:8443"),
        ("https://brain.dev-server.cloud/base", "https://brain.dev-server.cloud/base"),
        ("http://brain.dev-server.cloud", "http://brain.dev-server.cloud"),
        ("https://brain.example.com/", "https://brain.example.com"),
        ("https://agentx.astralx.com.vn/keys/", NEW),
        ("", ""),
        (None, ""),
    ],
)
def test_an_address_somebody_chose_is_left_as_it_is(chosen, kept):
    assert resolve_second_brain_url(chosen) == kept


def test_key_provisioning_follows_the_move():
    assert load_settings(_machine("https://brain.dev-server.cloud/")).second_brain_url == NEW


def test_synchronisation_follows_the_move():
    from hermes_cli.sync_engine import load_sync_settings

    with patch(
        "hermes_cli.account_provisioning.load_machine_config",
        return_value=_machine("https://brain.dev-server.cloud"),
    ):
        settings = load_sync_settings()

    assert settings.base_url == NEW
    assert settings.stream_url == "wss://agentx.astralx.com.vn/keys/v1/sync/stream"


def test_the_device_list_follows_the_move():
    from hermes_cli.web_routers.accounts import _second_brain_settings

    with patch(
        "hermes_cli.account_provisioning.load_machine_config",
        return_value=_machine("https://brain.dev-server.cloud"),
    ):
        base_url, _timeout = _second_brain_settings()

    assert base_url == NEW


def test_requests_keep_the_path_of_the_service():
    """The SSO serves the keys under /keys: every route must stay beneath it."""
    import httpx

    from hermes_cli.second_brain_client import SecondBrainClient

    seen = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(200, json={"devices": []})

    client = SecondBrainClient(NEW, transport=httpx.MockTransport(handler))
    client.list_devices(bearer="t", device_id="d")

    assert seen == [f"{NEW}/v1/devices"]
