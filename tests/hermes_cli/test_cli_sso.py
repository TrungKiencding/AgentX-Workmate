"""Terminal SSO through real HTTP, signed JWTs, account files and provisioning."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
import jwt
import pytest
import yaml
from cryptography.hazmat.primitives.asymmetric import rsa

from hermes_cli import cli_sso
from hermes_cli.account_inference import AccountModelNotAllowed, account_models
from hermes_cli.account_provisioning import read_state
from hermes_cli.accounts import read_account_identity
from hermes_cli.config import load_config
from hermes_cli.model_switch import switch_model
from hermes_cli.runtime_provider import resolve_runtime_provider

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def realm(tmp_path, monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    state = {
        "codes": {},
        "refreshes": 0,
        "logout": [],
        "keys": [],
        "models": ["team/chat-a", "team/chat-b"],
    }

    class Server(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def mint(self):
            now = int(time.time())
            return jwt.encode(
                {
                    "sub": state.get("subject", "person-a"),
                    "email": "a@example.test",
                    "name": "Person A",
                    "iss": issuer,
                    "aud": state.get("aud", "agentx-workmate"),
                    "iat": now,
                    "exp": now + 300,
                },
                key,
                algorithm="RS256",
                headers={"kid": "test"},
            )

        def do_GET(self):
            path = urlsplit(self.path).path
            if path.endswith("/.well-known/openid-configuration"):
                return self.reply(
                    200,
                    {
                        "issuer": issuer,
                        "authorization_endpoint": base + "/authorize",
                        "token_endpoint": base + "/token",
                        "jwks_uri": base + "/jwks",
                        "end_session_endpoint": base + "/logout",
                    },
                )
            if path == "/jwks":
                return self.reply(
                    200,
                    {
                        "keys": [
                            {
                                **json.loads(
                                    jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key())
                                ),
                                "kid": "test",
                                "use": "sig",
                            }
                        ]
                    },
                )
            if path == "/authorize":
                params = parse_qs(urlsplit(self.path).query)
                code = f"code-{len(state['codes'])}"
                state["codes"][code] = params
                self.send_response(302)
                self.send_header(
                    "Location",
                    params["redirect_uri"][0]
                    + "?"
                    + urlencode({"code": code, "state": params["state"][0]}),
                )
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if path == "/proxy/v1/models":
                if self.headers.get("Authorization") != "Bearer sk-account-fixture":
                    return self.reply(401, {})
                return self.reply(
                    200, {"data": [{"id": model} for model in state["models"]]}
                )
            return self.reply(404, {})

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            path = urlsplit(self.path).path
            if path == "/token":
                params = {k: v[0] for k, v in parse_qs(body.decode()).items()}
                if params.get("grant_type") == "authorization_code":
                    auth = state["codes"].pop(params.get("code"), None)
                    digest = (
                        base64
                        .urlsafe_b64encode(
                            hashlib.sha256(
                                params.get("code_verifier", "").encode()
                            ).digest()
                        )
                        .rstrip(b"=")
                        .decode()
                    )
                    if (
                        not auth
                        or auth["code_challenge"] != [digest]
                        or auth["redirect_uri"] != [params.get("redirect_uri")]
                    ):
                        return self.reply(400, {"error": "invalid_grant"})
                else:
                    state["refreshes"] += 1
                    if (
                        state.get("revoked")
                        or params.get("refresh_token") != "refresh-fixture"
                    ):
                        return self.reply(400, {"error": "invalid_grant"})
                return self.reply(
                    200,
                    {
                        "id_token": self.mint(),
                        "refresh_token": "refresh-fixture",
                        "token_type": "Bearer",
                    },
                )
            if path == "/keys/v1/model-key":
                bearer = self.headers.get("Authorization", "").removeprefix("Bearer ")
                claims = jwt.decode(
                    bearer,
                    key.public_key(),
                    algorithms=["RS256"],
                    issuer=issuer,
                    audience="agentx-workmate",
                )
                state["keys"].append(claims["sub"])
                return self.reply(
                    200,
                    {
                        "key": "sk-account-fixture",
                        "key_alias": "test-person",
                        "models": state["models"],
                        "base_url": base + "/proxy",
                        "status": "issued",
                    },
                )
            if path == "/logout":
                state["logout"].append(parse_qs(body.decode()))
                state["revoked"] = True
                return self.reply(200, {})
            if path == "/proxy/v1/chat/completions":
                payload = json.loads(body)
                state.setdefault("completions", []).append(payload["model"])
                if payload["model"] not in state["models"]:
                    return self.reply(403, {"error": {"message": "Model not granted"}})
                if payload.get("stream"):
                    chunks = [
                        {
                            "id": "fixture",
                            "object": "chat.completion.chunk",
                            "model": payload["model"],
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": {
                                        "role": "assistant",
                                        "content": "SSO chat works.",
                                    },
                                    "finish_reason": None,
                                }
                            ],
                        },
                        {
                            "id": "fixture",
                            "object": "chat.completion.chunk",
                            "model": payload["model"],
                            "choices": [
                                {"index": 0, "delta": {}, "finish_reason": "stop"}
                            ],
                            "usage": {
                                "prompt_tokens": 5,
                                "completion_tokens": 4,
                                "total_tokens": 9,
                            },
                        },
                    ]
                    data = (
                        "".join(
                            "data: " + json.dumps(chunk) + "\n\n" for chunk in chunks
                        )
                        + "data: [DONE]\n\n"
                    ).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                return self.reply(
                    200,
                    {
                        "id": "fixture-completion",
                        "object": "chat.completion",
                        "created": int(time.time()),
                        "model": payload["model"],
                        "choices": [
                            {
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": "SSO chat works.",
                                },
                                "finish_reason": "stop",
                            }
                        ],
                        "usage": {
                            "prompt_tokens": 5,
                            "completion_tokens": 4,
                            "total_tokens": 9,
                        },
                    },
                )
            return self.reply(404, {})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Server)
    base = f"http://127.0.0.1:{server.server_port}"
    issuer = base + "/auth/realms/test"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
    # Same deployment inputs as production; only the endpoints differ.
    config = {
        "dashboard": {
            "oauth": {
                "keycloak": {
                    "base_url": base + "/auth",
                    "realm": "test",
                    "client_id": "agentx-workmate",
                    "session_days": 14,
                }
            }
        },
        "accounts": {
            "keys": {"base_url": base + "/keys"},
            "litellm": {"enabled": True, "base_url": base + "/proxy", "mode": "keys"},
        },
    }
    (tmp_path / "config.yaml").write_text(yaml.safe_dump(config))
    (tmp_path / ".env").write_text("")
    # The CLI subprocess does not inherit conftest's process-level credential
    # guards. Shadow credential CLIs so even tool discovery cannot read the
    # developer's GitHub login or macOS Keychain.
    guarded_bin = tmp_path / "guarded-bin"
    guarded_bin.mkdir()
    for name in ("gh", "security"):
        executable = guarded_bin / name
        executable.write_text("#!/bin/sh\nexit 127\n")
        executable.chmod(0o755)
    monkeypatch.setenv("PATH", str(guarded_bin) + os.pathsep + os.environ["PATH"])
    monkeypatch.setattr(cli_sso, "_READY_HOME", None)
    cli_sso._PROVIDER_CACHE.clear()
    state.update(root=tmp_path, base=base)
    yield state
    server.shutdown()
    server.server_close()
    thread.join(timeout=3)


def sign_in(realm, monkeypatch):
    # Drive the real browser redirect over HTTP; don't mock the auth provider,
    # token validation, keys service, gateway discovery or account writes.
    with ThreadPoolExecutor() as pool:
        browser = []

        def open_browser(url):
            browser.append(
                pool.submit(httpx.get, url, follow_redirects=True, timeout=5)
            )

        monkeypatch.setattr(cli_sso.webbrowser, "open", open_browser)
        home = cli_sso.login(timeout=5)
        assert browser[0].result().status_code == 200
    monkeypatch.setenv("AGENTX_HOME", str(home))
    return home


def test_real_sign_in_provisions_only_account_models_and_preserves_root(
    realm, monkeypatch
):
    before = (realm["root"] / "config.yaml").read_bytes()
    home = sign_in(realm, monkeypatch)
    assert home != realm["root"]
    assert read_account_identity(home).subject == "person-a"
    assert read_state(home)["models"] == realm["models"]
    assert cli_sso.selected_home() == home
    assert (realm["root"] / "config.yaml").read_bytes() == before
    assert cli_sso.current_session().user_id == "person-a"
    assert account_models() == tuple(realm["models"])
    assert load_config()["model"]["default"] in realm["models"]
    assert resolve_runtime_provider()["base_url"] == realm["base"] + "/proxy/v1"
    if os.name != "nt":
        assert (home / cli_sso.SESSION_FILE).stat().st_mode & 0o777 == 0o600


def test_model_picker_and_typed_switch_cannot_escape_account_grant(realm, monkeypatch):
    home = sign_in(realm, monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-unrelated")
    from hermes_cli.inventory import load_picker_context, build_models_payload

    ctx = load_picker_context().with_overrides(current_model="not-granted")
    payload = build_models_payload(ctx, include_unconfigured=True)
    assert [row["slug"] for row in payload["providers"]] == ["litellm"]
    assert payload["providers"][0]["models"] == realm["models"]
    accepted = switch_model("chat-b", "litellm", "team/chat-a")
    assert accepted.success and accepted.new_model == "team/chat-b"
    assert accepted.base_url == realm["base"] + "/proxy/v1"
    assert not switch_model(
        "claude", "litellm", "team/chat-a", explicit_provider="anthropic"
    ).success
    assert not switch_model("not-granted", "litellm", "team/chat-a").success
    with pytest.raises(AccountModelNotAllowed):
        resolve_runtime_provider(target_model="not-granted")
    # User-edited provider config cannot add a grant.
    config = load_config()
    config["providers"]["litellm"]["models"]["not-granted"] = {}
    from hermes_cli.config import save_config

    save_config(config)
    assert "not-granted" not in account_models()


def test_expired_access_token_refreshes_and_subject_change_is_rejected(
    realm, monkeypatch
):
    home = sign_in(realm, monkeypatch)
    path = home / cli_sso.SESSION_FILE
    saved = json.loads(path.read_text())
    saved["session"]["expires_at"] = 1
    path.write_text(json.dumps(saved))
    assert cli_sso.current_session().user_id == "person-a"
    assert realm["refreshes"] == 1
    saved = json.loads(path.read_text())
    saved["session"]["expires_at"] = 1
    path.write_text(json.dumps(saved))
    realm["subject"] = "another-person"
    with pytest.raises(cli_sso.CLISignInError, match="does not match"):
        cli_sso.current_session()


def test_logout_ends_cli_session_and_running_shell_refuses_next_turn(
    realm, monkeypatch
):
    home = sign_in(realm, monkeypatch)
    cli_sso.require_session()
    assert cli_sso._READY_HOME == home
    # A second terminal signs out; this shell still holds its ready marker.
    (home / cli_sso.SESSION_FILE).unlink()
    with pytest.raises(cli_sso.CLISignInError, match="agentx login"):
        cli_sso.refresh_for_turn()
    sign_in(realm, monkeypatch)
    cli_sso.logout()
    assert realm["logout"]
    assert cli_sso.selected_home() is None
    assert home.exists()  # sign-out never deletes sessions or memory
    with pytest.raises(cli_sso.CLISignInError):
        cli_sso.require_session()


@pytest.mark.parametrize(
    "argv", [[], ["chat", "-q", "hello"], ["--oneshot", "hello"], ["setup"], ["model"]]
)
def test_fresh_cli_never_offers_vendor_setup(realm, argv):
    result = subprocess.run(
        [sys.executable, "-m", "hermes_cli.main", *argv],
        cwd=ROOT,
        env={
            **os.environ,
            "AGENTX_HOME": str(realm["root"]),
            "AGENTX_SKIP_NODE_BOOTSTRAP": "1",
        },
        input="",
        text=True,
        capture_output=True,
        timeout=20,
    )
    output = result.stdout + result.stderr
    assert result.returncode != 0, output
    assert "agentx login" in output
    assert "Set up a provider" not in output
    assert "Nous Portal OAuth is the fastest" not in output


def test_subprocess_uses_saved_account_and_rejects_provider_override(
    realm, monkeypatch
):
    sign_in(realm, monkeypatch)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "hermes_cli.main",
            "chat",
            "--provider",
            "anthropic",
            "-q",
            "hello",
        ],
        cwd=ROOT,
        env={
            **os.environ,
            "AGENTX_HOME": str(realm["root"]),
            "AGENTX_SKIP_NODE_BOOTSTRAP": "1",
        },
        input="",
        text=True,
        capture_output=True,
        timeout=20,
    )
    assert result.returncode != 0
    assert "only use models through AgentX AI Gateway" in result.stdout + result.stderr


def test_invalid_state_never_exchanges_a_code(realm, monkeypatch):
    provider = cli_sso._provider()
    with ThreadPoolExecutor() as pool:
        requests = []

        def attack(url):
            params = parse_qs(urlsplit(url).query)
            requests.append(
                pool.submit(
                    httpx.get,
                    params["redirect_uri"][0] + "?code=stolen&state=wrong",
                    timeout=5,
                )
            )

        monkeypatch.setattr(cli_sso.webbrowser, "open", attack)
        with pytest.raises(cli_sso.CLISignInError, match="did not complete"):
            cli_sso.browser_login(provider, timeout=3)
        assert requests[0].result().status_code == 400
    assert not realm["keys"]


def test_wrong_audience_cannot_create_an_account(realm, monkeypatch):
    realm["aud"] = "another-client"
    with pytest.raises(cli_sso.CLISignInError, match="sign-in failed"):
        sign_in(realm, monkeypatch)
    assert not cli_sso.selected_home()
    assert not realm["keys"]


def test_login_command_and_next_chat_use_real_http(realm):
    env = {
        **os.environ,
        "AGENTX_HOME": str(realm["root"]),
        "AGENTX_SKIP_NODE_BOOTSTRAP": "1",
    }
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "hermes_cli.main",
            "login",
            "--no-browser",
            "--timeout",
            "10",
        ],
        cwd=ROOT,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        with ThreadPoolExecutor() as pool:
            # The CLI prints a URL instead of opening a browser under --no-browser.
            def find_url():
                for line in process.stdout:
                    if line.startswith(realm["base"] + "/authorize?"):
                        return line.strip()
                raise AssertionError("Login exited without a sign-in URL")

            try:
                url = pool.submit(find_url).result(timeout=12)
            except Exception:
                if process.poll() is None:
                    process.kill()
                raise
            assert httpx.get(url, follow_redirects=True, timeout=5).status_code == 200
        out, err = process.communicate(timeout=15)
        assert process.returncode == 0, out + err
        assert "sk-account-fixture" not in out + err
        assert "refresh-fixture" not in out + err
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()
    # A fresh process starts from the install root, selects the saved account
    # before config imports, and sends the model request with that account's key.
    chat = subprocess.run(
        [
            sys.executable,
            "-m",
            "hermes_cli.main",
            "chat",
            "-q",
            "Hello",
            "--quiet",
            "--max-turns",
            "1",
        ],
        cwd=ROOT,
        env=env,
        input="",
        capture_output=True,
        text=True,
        timeout=40,
    )
    assert chat.returncode == 0, chat.stdout + chat.stderr
    assert "SSO chat works." in chat.stdout
    assert realm["completions"] and set(realm["completions"]) <= set(realm["models"])


def test_expired_sign_in_and_corrupt_session_fail_closed(realm, monkeypatch):
    home = sign_in(realm, monkeypatch)
    path = home / cli_sso.SESSION_FILE
    saved = json.loads(path.read_text())
    expired = {**saved, "signed_in_at": 1}
    path.write_text(json.dumps(expired))
    with pytest.raises(cli_sso.CLISignInError, match="expired"):
        cli_sso.current_session()
    path.write_text(json.dumps({**saved, "session": ["corrupt"]}))
    with pytest.raises(cli_sso.CLISignInError, match="invalid"):
        cli_sso.current_session()


def test_refresh_removes_revoked_models_from_the_picker(realm, monkeypatch):
    sign_in(realm, monkeypatch)
    realm["models"] = ["team/chat-b"]
    from hermes_cli.inventory import build_models_payload, load_picker_context

    refreshed = build_models_payload(load_picker_context(), refresh=True)
    assert refreshed["providers"][0]["models"] == ["team/chat-b"]
    assert not switch_model("team/chat-a", "litellm", "team/chat-b").success


def test_account_profile_uses_sso_without_sharing_profile_preferences(
    realm, monkeypatch
):
    home = sign_in(realm, monkeypatch)
    original = (home / "config.yaml").read_bytes()
    profile = home / "profiles" / "focused"
    profile.mkdir(parents=True)
    monkeypatch.setenv("AGENTX_HOME", str(profile))
    cli_sso.require_session()
    assert cli_sso.current_session().user_id == "person-a"
    assert load_config()["model"]["default"] in realm["models"]
    assert resolve_runtime_provider()["source"] == "account-gateway"
    assert account_models() == tuple(realm["models"])
    assert (profile / "config.yaml").exists()
    assert (home / "config.yaml").read_bytes() == original


def test_sso_setup_preserves_terminal_gateway_and_tools_configuration(
    realm, monkeypatch
):
    sign_in(realm, monkeypatch)
    from argparse import Namespace
    from hermes_cli import setup

    calls = []
    monkeypatch.setattr(setup, "is_interactive_stdin", lambda: True)
    monkeypatch.setattr(
        setup, "setup_terminal_backend", lambda config: calls.append("terminal")
    )
    monkeypatch.setattr(setup, "setup_gateway", lambda config: calls.append("gateway"))
    monkeypatch.setattr(
        setup, "setup_tools", lambda config, **kwargs: calls.append("tools")
    )
    monkeypatch.setattr(setup, "_print_setup_summary", lambda *args: None)

    def choose(question, options, *args, **kwargs):
        assert options == realm["models"]
        return 1

    monkeypatch.setattr(setup, "prompt_choice", choose)
    setup.run_setup_wizard(
        Namespace(section=None, non_interactive=False, reset=False, portal=False)
    )
    assert calls == ["terminal", "gateway", "tools"]
    assert load_config()["model"]["default"] == "team/chat-b"
    assert load_config()["model"]["provider"] == "litellm"


@pytest.mark.parametrize(
    "argv",
    [
        ["auth", "add", "anthropic", "--api-key", "sk-unrelated"],
        ["login", "--provider", "nous"],
        ["logout", "--provider", "nous"],
    ],
)
def test_legacy_provider_commands_cannot_configure_inference(realm, argv):
    result = subprocess.run(
        [sys.executable, "-m", "hermes_cli.main", *argv],
        cwd=ROOT,
        env={**os.environ, "AGENTX_HOME": str(realm["root"])},
        input="",
        text=True,
        capture_output=True,
        timeout=15,
    )
    assert result.returncode != 0
    assert "AgentX SSO" in result.stdout + result.stderr
    assert "sk-unrelated" not in (realm["root"] / ".env").read_text()


def test_account_without_chat_grant_is_blocked_before_inference(realm, monkeypatch):
    realm["models"] = []
    with pytest.raises(cli_sso.CLISignInError, match="No chat models"):
        sign_in(realm, monkeypatch)
    assert not realm.get("completions")


def test_revoked_refresh_token_cannot_resume_cli(realm, monkeypatch):
    home = sign_in(realm, monkeypatch)
    path = home / cli_sso.SESSION_FILE
    saved = json.loads(path.read_text())
    saved["session"]["expires_at"] = 1
    path.write_text(json.dumps(saved))
    realm["revoked"] = True
    with pytest.raises(cli_sso.CLISignInError, match="Could not verify"):
        cli_sso.require_session()


def test_concurrent_shell_reads_share_one_refresh(realm, monkeypatch):
    home = sign_in(realm, monkeypatch)
    path = home / cli_sso.SESSION_FILE
    saved = json.loads(path.read_text())
    saved["session"]["expires_at"] = 1
    path.write_text(json.dumps(saved))
    provider = cli_sso._provider()
    with ThreadPoolExecutor(max_workers=4) as pool:
        sessions = list(pool.map(lambda _: cli_sso.current_session(provider), range(4)))
    assert {session.user_id for session in sessions} == {"person-a"}
    assert realm["refreshes"] == 1
