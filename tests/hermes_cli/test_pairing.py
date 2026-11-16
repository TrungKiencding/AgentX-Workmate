from argparse import Namespace
from unittest.mock import patch

from gateway.pairing import PairingStore
from hermes_cli.pairing import pairing_command


def test_cli_listed_request_id_and_bot_code_can_be_approved(tmp_path, capsys):
    with patch("gateway.pairing.PAIRING_DIR", tmp_path):
        store = PairingStore()
        store.generate_code("telegram", "listed-user", "Listed User")

        with patch("gateway.pairing.PairingStore", return_value=store):
            pairing_command(Namespace(pairing_action="list"))
            list_output = capsys.readouterr().out
            request_id = store.list_pending("telegram")[0]["request_id"]

            assert request_id in list_output

            pairing_command(
                Namespace(
                    pairing_action="approve",
                    platform="telegram",
                    code=request_id,
                )
            )
            request_approval_output = capsys.readouterr().out

            bot_code = store.generate_code("telegram", "code-user", "Code User")
            pairing_command(
                Namespace(
                    pairing_action="approve",
                    platform="telegram",
                    code=bot_code,
                )
            )
            code_approval_output = capsys.readouterr().out

        approved_ids = {entry["user_id"] for entry in store.list_approved("telegram")}

    assert "listed-user" in request_approval_output
    assert "code-user" in code_approval_output
    assert approved_ids == {"listed-user", "code-user"}


# ---------------------------------------------------------------------------
# Signed-in desktop: the gateway's pairing data lives inside accounts/<slug>
# ---------------------------------------------------------------------------

import pytest


@pytest.fixture()
def signed_in_install(tmp_path, monkeypatch):
    """Install root with one signed-in account; returns (root, account_home)."""
    from pathlib import Path

    from hermes_constants import get_default_hermes_root

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "AppData" / "Local"))
    monkeypatch.delenv("AGENTX_HOME", raising=False)
    root = get_default_hermes_root()
    account_home = root / "accounts" / "xuan-1234abcd"
    account_home.mkdir(parents=True)
    return root, account_home


def test_store_reports_the_argv_that_reopens_it(signed_in_install, monkeypatch):
    root, account_home = signed_in_install

    monkeypatch.setenv("AGENTX_HOME", str(root))
    assert PairingStore().cli_scope_args() == ""

    monkeypatch.setenv("AGENTX_HOME", str(account_home))
    assert PairingStore().cli_scope_args() == "--account xuan-1234abcd "
    assert PairingStore(profile="default").cli_scope_args() == "--account xuan-1234abcd "
    (account_home / "profiles" / "work").mkdir(parents=True)
    assert PairingStore(profile="work").cli_scope_args() == "--account xuan-1234abcd -p work "

    monkeypatch.setenv("AGENTX_HOME", str(account_home / "profiles" / "work"))
    assert PairingStore().cli_scope_args() == "--account xuan-1234abcd -p work "


def test_bare_cli_points_at_the_account_that_holds_the_request(
    signed_in_install, monkeypatch, capsys
):
    """``agentx pairing approve`` without --account reads the install root;
    it must say which account's store has the request rather than just
    "not found"."""
    root, account_home = signed_in_install

    monkeypatch.setenv("AGENTX_HOME", str(account_home))
    code = PairingStore().generate_code("telegram", "935154431", "Xuan Hung Ho")

    monkeypatch.setenv("AGENTX_HOME", str(root))
    pairing_command(Namespace(pairing_action="approve", platform="telegram", code=code))
    out = capsys.readouterr().out
    assert "not found or expired" in out
    assert f"agentx --account xuan-1234abcd pairing approve telegram {code}" in out

    pairing_command(Namespace(pairing_action="list"))
    assert "agentx --account xuan-1234abcd pairing list" in capsys.readouterr().out

    # The command the hint prints actually works.
    monkeypatch.setenv("AGENTX_HOME", str(account_home))
    pairing_command(Namespace(pairing_action="approve", platform="telegram", code=code))
    assert "Approved!" in capsys.readouterr().out
    assert PairingStore().is_approved("telegram", "935154431") is True


def test_cli_inside_an_account_never_points_elsewhere(signed_in_install, monkeypatch, capsys):
    root, account_home = signed_in_install
    other = root / "accounts" / "other-9999"
    other.mkdir(parents=True)
    monkeypatch.setenv("AGENTX_HOME", str(other))
    PairingStore().generate_code("telegram", "someone-else", "Other")

    monkeypatch.setenv("AGENTX_HOME", str(account_home))
    pairing_command(Namespace(pairing_action="approve", platform="telegram", code="ABCDEFGH"))
    out = capsys.readouterr().out
    assert "not found or expired" in out
    assert "--account" not in out
