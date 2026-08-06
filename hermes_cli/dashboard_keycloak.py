"""``agentx dashboard keycloak`` — point this install at AgentX's Keycloak.

AgentX Workmate signs users in against the SAME Keycloak realm that backs
AgentX, so nobody gets a second account. Wiring that up is three values
(server URL, realm, client id) plus one switch (require a sign-in even on
loopback, which is where Workmate runs). Getting any of them subtly wrong
produces an unhelpful failure much later — a 404 on discovery, or a dashboard
that refuses to start — so this command validates the realm up front against
its published OIDC discovery document and only then writes anything.

It also prints the redirect URIs the operator must register in Keycloak. That
is the step nothing on this side can do automatically and the one most likely
to be missed: without it, sign-in fails at Keycloak's own page with
``Invalid parameter: redirect_uri`` and no indication of which value it wanted.
"""

from __future__ import annotations

import sys
from typing import Any, Dict

# Fixed loopback ports the desktop shell listens on for its own OAuth callback.
# MUST stay in step with ``KEYCLOAK_CALLBACK_PORTS`` in
# ``apps/desktop/electron/keycloak-oidc.ts`` — they are the values an operator
# registers with Keycloak, so a change here is a change to a published contract.
DESKTOP_CALLBACK_PORTS = (47821, 47822, 47823)


def _discovery_url(base_url: str, realm: str) -> str:
    return f"{base_url.rstrip('/')}/realms/{realm}/.well-known/openid-configuration"


def _probe_realm(base_url: str, realm: str) -> Dict[str, Any]:
    """Fetch and sanity-check the realm's discovery document.

    Raises ``RuntimeError`` with a message written for whoever is running the
    command, not for a log file.
    """
    import httpx

    url = _discovery_url(base_url, realm)
    try:
        response = httpx.get(
            url,
            headers={"Accept": "application/json"},
            timeout=15.0,
            follow_redirects=True,
        )
    except httpx.RequestError as exc:
        raise RuntimeError(
            f"Could not reach Keycloak at {url}\n"
            f"  {exc}\n"
            "  Check the --base-url (it should be the Keycloak server root, e.g. "
            "https://agentx.example.com/auth) and that this machine can reach it."
        ) from exc

    if response.status_code == 404:
        raise RuntimeError(
            f"Keycloak has no realm {realm!r} at {base_url.rstrip('/')}\n"
            "  Check --realm, and check whether the server root needs an /auth "
            "suffix (older Keycloak deployments) or not (Quarkus-era ones)."
        )
    if response.status_code != 200:
        raise RuntimeError(
            f"Keycloak returned HTTP {response.status_code} for {url}"
        )

    try:
        doc = response.json()
    except ValueError as exc:
        raise RuntimeError(
            f"{url} did not return JSON — is that really a Keycloak server?"
        ) from exc

    if not isinstance(doc, dict) or not doc.get("token_endpoint"):
        raise RuntimeError(
            f"{url} returned a document with no token_endpoint — is that really "
            "a Keycloak realm?"
        )
    return doc


def cmd_dashboard_keycloak(args) -> None:
    """Configure Keycloak SSO for this dashboard install."""
    from hermes_cli.config import is_managed, save_env_value

    if is_managed():
        print(
            "✗ `agentx dashboard keycloak` is not available in a managed/hosted "
            "install.\n"
            "  The hosting platform provisions the dashboard's auth configuration."
        )
        sys.exit(1)

    base_url = (args.base_url or "").strip().rstrip("/")
    realm = (args.realm or "").strip()
    client_id = (args.client_id or "").strip()

    if not base_url or not realm or not client_id:
        print(
            "✗ --base-url, --realm and --client-id are all required.\n"
            "  Example:\n"
            "    agentx dashboard keycloak \\\n"
            "      --base-url https://agentx.example.com/auth \\\n"
            "      --realm agent-hub \\\n"
            "      --client-id agentx-workmate"
        )
        sys.exit(1)

    if not base_url.startswith(("http://", "https://")):
        print(f"✗ --base-url must start with http:// or https:// (got {base_url!r})")
        sys.exit(1)

    print(f"→ Checking realm {realm!r} at {base_url} …")
    try:
        doc = _probe_realm(base_url, realm)
    except RuntimeError as exc:
        print(f"✗ {exc}")
        sys.exit(1)

    issuer = str(doc.get("issuer") or f"{base_url}/realms/{realm}")
    print(f"✓ Realm reachable. Issuer: {issuer}")

    save_env_value("AGENTX_DASHBOARD_KEYCLOAK_BASE_URL", base_url)
    save_env_value("AGENTX_DASHBOARD_KEYCLOAK_REALM", realm)
    save_env_value("AGENTX_DASHBOARD_KEYCLOAK_CLIENT_ID", client_id)
    written = [
        "AGENTX_DASHBOARD_KEYCLOAK_BASE_URL",
        "AGENTX_DASHBOARD_KEYCLOAK_REALM",
        "AGENTX_DASHBOARD_KEYCLOAK_CLIENT_ID",
    ]

    if args.idp_hint:
        save_env_value("AGENTX_DASHBOARD_KEYCLOAK_IDP_HINT", args.idp_hint.strip())
        written.append("AGENTX_DASHBOARD_KEYCLOAK_IDP_HINT")

    if args.allow_password_grant:
        save_env_value("AGENTX_DASHBOARD_KEYCLOAK_ALLOW_PASSWORD_GRANT", "1")
        written.append("AGENTX_DASHBOARD_KEYCLOAK_ALLOW_PASSWORD_GRANT")

    if args.require_auth:
        save_env_value("AGENTX_DASHBOARD_REQUIRE_AUTH", "1")
        written.append("AGENTX_DASHBOARD_REQUIRE_AUTH")

    print("✓ Wrote to ~/.agentx/.env:")
    for key in written:
        print(f"    {key}")

    print()
    print(f"Now register these in Keycloak, on client {client_id!r} in realm {realm!r}:")
    print()
    print("  Client authentication: OFF  (it must be a PUBLIC client — a desktop")
    print("                              app on an employee's machine cannot hold")
    print("                              a secret)")
    print("  Standard flow:         ON")
    print("  PKCE method:           S256")
    print()
    print("  Valid redirect URIs:")
    for port in DESKTOP_CALLBACK_PORTS:
        print(f"    http://127.0.0.1:{port}/callback      (desktop app)")
    if args.public_url:
        print(f"    {args.public_url.rstrip('/')}/auth/callback   (browser dashboard)")
    else:
        print("    <your dashboard URL>/auth/callback      (browser dashboard)")
        print("      e.g. http://localhost:9119/auth/callback for a local dashboard")
        print("      (re-run with --public-url URL to have this printed exactly)")
    print()

    print("The auth gate is now ON, including loopback binds — `agentx dashboard`")
    print("and AgentX Workmate Desktop will both ask for a sign-in before they show")
    print("anything. Configuring Keycloak is what turns it on; there is no second")
    print("switch.")
    if args.require_auth:
        print()
        print("--require-auth pinned it explicitly, so removing the Keycloak settings")
        print("later will fail the dashboard closed rather than silently ungate it.")
    else:
        print()
        print("To run locally without a sign-in (a realm you cannot reach from here),")
        print("set dashboard.require_auth: false or export AGENTX_DASHBOARD_REQUIRE_AUTH=0.")

    if args.allow_password_grant:
        print()
        print("Password sign-in is enabled: the login page will show a username /")
        print("password form as well as the AgentX redirect. This needs 'Direct")
        print("access grants' ON for the client, and it cannot satisfy MFA or any")
        print("pending required action — those users must use the redirect.")
