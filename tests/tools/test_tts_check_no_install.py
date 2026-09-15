"""The TTS availability check must never install anything.

``check_tts_requirements`` runs inside every agent build, and again whenever
the tool registry's cache expires. A lazy ``uv pip install edge-tts`` placed in
it ran in the middle of a fresh install's first turn — minutes of silence on a
slow or filtered network, indistinguishable from a hung chat. The install
belongs at the first call of the tool, where the model asked for it.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest


@pytest.fixture(autouse=True)
def _edge_provider():
    with patch("tools.tts_tool._load_tts_config", return_value={"provider": "edge"}):
        yield


def _no_command_provider():
    return patch("tools.tts_tool._resolve_command_provider_config", return_value=None)


class TestEdgeAvailabilityNeverInstalls:
    def test_installed_is_available_without_touching_the_installer(self):
        from tools.tts_tool import check_tts_requirements

        with _no_command_provider(), patch(
            "tools.tts_tool._edge_tts_importable", return_value=True
        ), patch("tools.lazy_deps.ensure", side_effect=AssertionError("must not install")):
            assert check_tts_requirements() is True

    def test_missing_but_installable_is_available_and_defers_the_install(self):
        """Registered now, installed on the first call — never during the check."""
        from tools.tts_tool import check_tts_requirements

        with _no_command_provider(), patch(
            "tools.tts_tool._edge_tts_importable", return_value=False
        ), patch("tools.tts_tool._lazy_installs_allowed", return_value=True), patch(
            "tools.lazy_deps.ensure", side_effect=AssertionError("must not install")
        ):
            assert check_tts_requirements() is True

    def test_missing_with_installs_disabled_falls_back_to_a_local_engine(self):
        from tools.tts_tool import check_tts_requirements

        with _no_command_provider(), patch(
            "tools.tts_tool._edge_tts_importable", return_value=False
        ), patch("tools.tts_tool._lazy_installs_allowed", return_value=False), patch(
            "tools.tts_tool._check_neutts_available", return_value=False
        ), patch("tools.lazy_deps.ensure", side_effect=AssertionError("must not install")):
            assert check_tts_requirements() is False

        with _no_command_provider(), patch(
            "tools.tts_tool._edge_tts_importable", return_value=False
        ), patch("tools.tts_tool._lazy_installs_allowed", return_value=False), patch(
            "tools.tts_tool._check_neutts_available", return_value=True
        ):
            assert check_tts_requirements() is True

    def test_the_import_helper_is_what_installs_at_first_use(self):
        """The install did not go away; it moved to the call that needs the module."""
        from tools import tts_tool

        calls = []

        def _ensure(feature, *, prompt=True):
            calls.append((feature, prompt))

        with patch("tools.lazy_deps.ensure", side_effect=_ensure), patch.dict(
            "sys.modules", {"edge_tts": object()}
        ):
            tts_tool._import_edge_tts()

        assert calls == [("tts.edge", False)]
