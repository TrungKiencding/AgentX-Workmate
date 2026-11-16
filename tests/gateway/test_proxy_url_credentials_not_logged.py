"""The shared aiohttp proxy helpers warn when a SOCKS proxy is configured but
``aiohttp_socks`` is missing. The log redactor does not mask userinfo in
``socks5://`` URLs, so the warning itself must log the host, never the
credentials."""

import logging
import sys

import pytest

from gateway.platforms import base as gw_base

SOCKS_PROXY = "socks5://alice:S3cretPass@127.0.0.1:1080"


@pytest.mark.parametrize(
    "helper", [gw_base.proxy_kwargs_for_bot, gw_base.proxy_kwargs_for_aiohttp]
)
def test_missing_aiohttp_socks_warning_logs_proxy_without_credentials(monkeypatch, caplog, helper):
    monkeypatch.setitem(sys.modules, "aiohttp_socks", None)  # import raises ImportError
    with caplog.at_level(logging.WARNING):
        helper(SOCKS_PROXY)
    lines = [r.getMessage() for r in caplog.records if "SOCKS proxy" in r.getMessage()]
    assert lines, "the missing-aiohttp_socks warning must still fire"
    assert all("S3cretPass" not in line and "alice" not in line for line in lines), lines
    assert any("127.0.0.1:1080" in line for line in lines), lines
