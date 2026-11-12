"""AgentX account sign-in for terminal clients.

Uses the shipped Keycloak provider (PKCE, discovery, JWT verification and
refresh), account homes and key provisioning. Select the home before loading
CLI configuration; never switch somebody's state underneath a running chat.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import time
import webbrowser
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

from hermes_constants import get_default_hermes_root, get_hermes_home, get_user_root
from utils import atomic_json_write

SESSION_FILE = "cli-sso.json"
ACTIVE_FILE = "cli-account.json"
CALLBACK_PORTS = (47821, 47822, 47823)  # deployed public client's redirect URIs
_READY_HOME: Path | None = None
_PROVIDER_CACHE: dict[tuple, object] = {}


class CLISignInError(RuntimeError):
    """An actionable failure, without credentials in its message."""


def enabled() -> bool:
    from hermes_cli.account_provisioning import load_settings

    return load_settings().enabled


def _read(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def selected_home() -> Path | None:
    """Local selection only. Authentication is checked before model use."""
    from hermes_cli.accounts import AccountError, account_home, read_account_identity

    slug = _read(get_default_hermes_root() / ACTIVE_FILE).get("account")
    if not isinstance(slug, str) or not slug:
        return None
    try:
        home = account_home(slug)
        return home if read_account_identity(home) else None
    except (ValueError, AccountError):
        return None


def _provider():
    from plugins.dashboard_auth.keycloak import KeycloakOIDCProvider, register

    # Resolve deployment config through the same registration code as the
    # dashboard, without mutating its process-global provider registry.
    found = []
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override

    token = set_hermes_home_override(get_default_hermes_root())
    try:
        register(SimpleNamespace(register_dashboard_auth_provider=found.append))
    finally:
        reset_hermes_home_override(token)
    if not found:
        raise CLISignInError(
            "AgentX SSO is not configured. Check dashboard.oauth.keycloak in config.yaml."
        )
    configured = found[0]
    config_key = tuple(
        getattr(configured, attr)
        for attr in (
            "_base_url",
            "_realm",
            "_client_id",
            "_scopes",
            "_client_secret",
            "_issuer",
            "_org_claim",
            "_idp_hint",
            "_session_days",
        )
    )
    if config_key in _PROVIDER_CACHE:
        return _PROVIDER_CACHE[config_key]

    class TerminalProvider(KeycloakOIDCProvider):
        def _validate_redirect_uri(self, redirect_uri: str) -> None:
            if redirect_uri not in {
                f"http://127.0.0.1:{port}/callback" for port in CALLBACK_PORTS
            }:
                raise CLISignInError("Invalid AgentX CLI callback address.")

    # Native clients use the same offline-session lifetime as the desktop.
    configured = TerminalProvider(
        base_url=configured._base_url,
        realm=configured._realm,
        client_id=configured._client_id,
        scopes=configured._scopes,
        client_secret=configured._client_secret,
        issuer=configured._issuer,
        org_claim=configured._org_claim,
        idp_hint=configured._idp_hint,
        session_days=configured._session_days,
    )
    if configured._session_days and "offline_access" not in configured._scopes.split():
        configured._scopes += " offline_access"
    _PROVIDER_CACHE.clear()
    _PROVIDER_CACHE[config_key] = configured
    return configured


def browser_login(provider, *, no_browser: bool = False, timeout: float = 300):
    """Receive one matching callback on loopback, always closing the listener."""
    import math

    if not math.isfinite(timeout) or timeout <= 0:
        raise CLISignInError("Sign-in timeout must be a positive number of seconds.")
    result = {}

    class Callback(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # authorization codes must never appear in HTTP logs

        def do_GET(self):
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query)
            if parsed.path != "/callback":
                self.send_error(404)
                return
            state = query.get("state", [""])[0]
            if not secrets.compare_digest(state, expected_state):
                self.send_error(400, "Invalid sign-in state")
                return
            result.update(
                code=query.get("code", [""])[0], error=query.get("error", [""])[0]
            )
            body = b"Sign-in received. Return to the AgentX Workmate terminal."
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    class Listener(HTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(2)
            return connection, address

    server = None
    for port in CALLBACK_PORTS:
        try:
            server = Listener(("127.0.0.1", port), Callback)
            break
        except OSError:
            continue
    if server is None:
        raise CLISignInError(
            "SSO callback ports are busy. Close the other sign-in window and retry agentx login."
        )
    try:
        redirect_uri = f"http://127.0.0.1:{server.server_port}/callback"
        start = provider.start_login(redirect_uri=redirect_uri)
        fields = dict(
            item.split("=", 1)
            for item in start.cookie_payload["hermes_session_pkce"].split(";")
        )
        expected_state = fields["state"]
        print(f"Sign in with AgentX SSO:\n{start.redirect_url}\n", flush=True)
        if not no_browser:
            webbrowser.open(start.redirect_url)
        deadline = time.monotonic() + timeout
        while not result and time.monotonic() < deadline:
            server.timeout = min(0.5, max(0.01, deadline - time.monotonic()))
            server.handle_request()
        if not result or result.get("error") or not result.get("code"):
            raise CLISignInError(
                "SSO sign-in did not complete. Run agentx login to retry."
            )
        return provider.complete_login(
            code=result["code"],
            state=expected_state,
            code_verifier=fields["verifier"],
            redirect_uri=redirect_uri,
        )
    finally:
        server.server_close()


def _save_session(home: Path, provider, session, signed_in_at: float) -> None:
    atomic_json_write(
        home / SESSION_FILE,
        {
            "session": asdict(session),
            "signed_in_at": signed_in_at,
            "issuer": provider._issuer,
            "client_id": provider._client_id,
        },
        mode=0o600,
    )


def current_session(provider=None):
    """Verify/refresh only this home's terminal session, never another account."""
    from hermes_cli.auth import _auth_store_lock

    # Two shells can refresh the same rotating token. Re-read it only after
    # acquiring the existing cross-process auth-store lock.
    try:
        with _auth_store_lock(target_path=get_user_root() / SESSION_FILE):
            return _current_session(provider)
    except CLISignInError:
        raise
    except Exception as exc:
        raise CLISignInError(
            "Could not read your CLI sign-in. Close the other sign-in attempt and retry."
        ) from exc


def _current_session(provider=None):
    import math

    from hermes_cli.accounts import read_account_identity

    home = get_user_root()
    saved = _read(home / SESSION_FILE)
    if not saved:
        raise CLISignInError("Sign in with your AgentX account: agentx login")
    provider = provider or _provider()
    if (
        saved.get("issuer") != provider._issuer
        or saved.get("client_id") != provider._client_id
    ):
        raise CLISignInError("SSO settings changed. Run agentx login again.")
    try:
        signed_in_at = float(saved.get("signed_in_at") or 0)
        raw = saved.get("session") or {}
        if not isinstance(raw, dict):
            raise ValueError("session must be an object")
        expires_at = float(raw.get("expires_at") or 0)
        if not math.isfinite(signed_in_at) or not math.isfinite(expires_at):
            raise ValueError("invalid session timestamp")
    except (TypeError, ValueError) as exc:
        raise CLISignInError(
            "The saved SSO session is invalid. Run agentx login again."
        ) from exc
    if (
        provider._session_days
        and time.time() >= signed_in_at + provider._session_days * 86400
    ):
        raise CLISignInError("Your AgentX sign-in expired. Run agentx login again.")
    try:
        # Refresh slightly early so the bearer remains usable during provisioning.
        session = None
        if expires_at > time.time() + 60:
            session = provider.verify_session(access_token=raw.get("access_token", ""))
        if session is None:
            session = provider.refresh_session(
                refresh_token=raw.get("refresh_token", "")
            )
        identity = read_account_identity(home)
        if identity is None or session.user_id != identity.subject:
            raise CLISignInError(
                "SSO session does not match this account. Run agentx login again."
            )
        # verify_session returns no refresh token; retain the stored one.
        if not session.refresh_token:
            from dataclasses import replace

            session = replace(session, refresh_token=raw.get("refresh_token", ""))
        _save_session(home, provider, session, signed_in_at)
        return session
    except CLISignInError:
        raise
    except Exception as exc:
        raise CLISignInError(
            "Could not verify AgentX SSO. Check your connection or run agentx login again."
        ) from exc


def _remember(session) -> tuple[str, str]:
    from hermes_cli.account_credentials import AccountCredentials, mailbox
    from hermes_cli.keys_client import install_device_identity

    device_id, device_name = install_device_identity()
    mailbox().remember(
        AccountCredentials(
            session.access_token, device_id, device_name, session.expires_at
        )
    )
    return device_id, device_name


def refresh_for_turn() -> None:
    """A running terminal must notice sign-out and renew its bearer as needed."""
    if _READY_HOME == get_hermes_home():
        _remember(current_session())


def _provision(session, home: Path) -> None:
    from hermes_cli.accounts import read_account_identity
    from hermes_cli.account_provisioning import ensure_account_key

    device_id, device_name = _remember(session)
    result = ensure_account_key(
        read_account_identity(get_user_root()),
        get_user_root().name,
        bearer=session.access_token,
        device_id=device_id,
        device_name=device_name,
        home=home,
    )
    if not result.ok:
        raise CLISignInError(
            f"AgentX model access is unavailable: {result.detail or result.status}"
        )
    if not result.models:
        raise CLISignInError(
            "No chat models are assigned to this AgentX account. Contact your administrator."
        )
    from hermes_cli.env_loader import load_hermes_dotenv

    load_hermes_dotenv(hermes_home=home)


def login(*, no_browser: bool = False, timeout: float = 300) -> Path:
    from hermes_cli.accounts import (
        AccountIdentity,
        ensure_account_home,
        resolve_account_for_identity,
    )
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override

    root = get_default_hermes_root()
    provider = _provider()
    try:
        session = browser_login(provider, no_browser=no_browser, timeout=timeout)
    except (CLISignInError, KeyboardInterrupt):
        raise
    except Exception as exc:
        raise CLISignInError(
            "AgentX SSO sign-in failed. Check your connection and retry agentx login."
        ) from exc
    identity = AccountIdentity(
        session.user_id,
        email=session.email,
        display_name=session.display_name,
        issuer=provider._issuer,
    )
    slug = resolve_account_for_identity(identity.subject, email=identity.email)
    home = ensure_account_home(slug, identity)
    # Save before provisioning: a temporary keys outage must not throw away
    # a completed sign-in. Startup can retry provisioning with this session.
    from hermes_cli.auth import _auth_store_lock

    with _auth_store_lock(target_path=home / SESSION_FILE):
        _save_session(home, provider, session, time.time())
    atomic_json_write(root / ACTIVE_FILE, {"account": slug}, mode=0o600)
    token = set_hermes_home_override(home)
    try:
        _provision(session, home)
    finally:
        reset_hermes_home_override(token)
    print(
        f"Signed in to AgentX as {identity.display_name or identity.email}. Models follow your account's access."
    )
    return home


def require_session(*, interactive: bool = False) -> None:
    """Gate terminal execution before any agent/config/session initialization."""
    global _READY_HOME
    if not enabled():
        return
    if _READY_HOME == get_hermes_home() and (get_user_root() / SESSION_FILE).exists():
        return
    try:
        session = current_session()
    except CLISignInError:
        if not interactive or not sys.stdin.isatty():
            raise
        login()
        # Configuration and imports must be rebuilt under the selected account.
        os.execv(
            sys.executable, [sys.executable, "-m", "hermes_cli.main", *sys.argv[1:]]
        )
        return
    _provision(session, get_hermes_home())
    _READY_HOME = get_hermes_home()


def logout() -> None:
    global _READY_HOME
    from hermes_constants import get_active_account

    selected = selected_home()
    home = get_user_root() if get_active_account() else selected
    if home:
        from hermes_cli.auth import _auth_store_lock

        with _auth_store_lock(target_path=home / SESSION_FILE):
            raw = _read(home / SESSION_FILE).get("session") or {}
            try:
                if raw.get("refresh_token"):
                    _provider().revoke_session(refresh_token=raw["refresh_token"])
            except Exception:
                pass  # local sign-out succeeds even when the IDP is offline
            finally:
                (home / SESSION_FILE).unlink(missing_ok=True)
    if selected == home:
        (get_default_hermes_root() / ACTIVE_FILE).unlink(missing_ok=True)
    _READY_HOME = None
    print("Signed out of AgentX SSO on this CLI. Account data is preserved.")


def select_model() -> None:
    """Pick from the account's chat grant; never show provider setup."""
    from hermes_cli.account_inference import account_inference, account_models
    from hermes_cli.config import read_raw_config, save_config
    from hermes_cli.setup import prompt_choice

    policy = account_inference()
    if policy is None:
        raise CLISignInError("Sign in with your AgentX account: agentx login")
    models = account_models(refresh=True)
    if not models:
        raise CLISignInError(
            "No chat models are assigned to this AgentX account. Contact your administrator."
        )
    index = prompt_choice("Choose your AgentX model", list(models))
    if index is None:
        return
    config = read_raw_config()
    model = config.get("model")
    model = dict(model) if isinstance(model, dict) else {}
    model.update(
        default=models[index],
        provider=policy.provider,
        base_url=policy.base_url,
        key_env=policy.key_env,
        api_mode="chat_completions",
    )
    model.pop("api_key", None)
    config["model"] = model
    save_config(config)
    print(f"Model: {models[index]}")
