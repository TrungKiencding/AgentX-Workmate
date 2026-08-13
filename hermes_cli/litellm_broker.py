"""The service that keeps the LiteLLM admin key off employees' laptops.

DEPRECATED. It solved the credential-exposure half of the problem and not the
other half: it still mints per machine rather than per person, so two of
somebody's laptops still end up with two different keys under one alias.
``second_brain`` (``agentx second-brain serve``) replaces it and mints once per
person. This module stays only until no install runs ``mode: "broker"``.

AgentX Workmate is installed on each person's own machine. Minting a per-user
LiteLLM key needs an admin credential, and an admin credential shipped to a
laptop is an admin credential every employee can read out of ``.env`` — enough
to mint themselves unlimited budget, or to enumerate and delete their
colleagues' keys. That is not a hypothetical: ``.env`` is a plain file the
person already owns.

So the admin key lives here instead, on one server the operator controls. A
laptop proves who it is with the Keycloak token it already holds, and this
service does the minting:

    laptop ──(Bearer <Keycloak ID token>)──▶ broker ──(admin key)──▶ LiteLLM
                                                   ◀── sk-… for that user

Two rules make it safe to expose:

**The token decides the account, never the request body.** The client sends
an ``account`` hint for logging; the slug that is actually used is derived
from the verified ``sub``. A user cannot ask for somebody else's key by
editing a JSON field.

**Nothing here deletes a key.** LiteLLM cannot re-reveal an existing key's
plaintext (``/key/{token}/regenerate`` is an Enterprise route and answers HTTP
500 on the open-source build), so a caller that has lost its copy gets a new
key minted — and the old one is left alive, because this service keeps no
record of which machine holds which key and so cannot tell a stale key from a
colleague machine's working one. That leaks an orphaned key per re-mint. It is
the deliberate trade: an orphan is a bill, and the delete that used to be here
was somebody's laptop losing its model access.

Run it with::

    agentx litellm-broker serve --host 0.0.0.0 --port 8787

behind whatever TLS termination the rest of your estate uses. It needs three
settings on the *server*: the Keycloak realm to verify against
(``dashboard.oauth.keycloak.*``, exactly as the dashboard reads it), the
LiteLLM proxy URL (``accounts.litellm.base_url``), and
``AGENTX_LITELLM_ADMIN_KEY`` in its environment.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# The one route. Kept as a constant because the desktop's broker_url must name
# it exactly and the docs quote it.
BROKER_ROUTE = "/api/litellm/account-key"


class BrokerConfigError(RuntimeError):
    """The broker cannot start with the configuration it was given."""


def _keycloak_provider():
    """Return a Keycloak provider built from this server's config, or raise.

    Reuses the dashboard's own provider rather than re-implementing JWKS and
    audience checks: the broker must accept exactly the tokens the product
    accepts, and two verifiers that can drift is how you get a broker that
    still trusts a realm the app has already moved off.
    """
    import plugins.dashboard_auth.keycloak as keycloak_plugin

    captured: list[Any] = []

    class _Capture:
        def register_dashboard_auth_provider(self, provider):
            captured.append(provider)

    keycloak_plugin.register(_Capture())
    if not captured:
        raise BrokerConfigError(
            keycloak_plugin.LAST_SKIP_REASON
            or "Keycloak is not configured on this server; the broker has no "
            "way to verify who is calling it."
        )
    return captured[0]


def _admin_client(settings):
    from hermes_cli.account_provisioning import ADMIN_KEY_ENV_VAR, _admin_key
    from hermes_cli.litellm_admin import LiteLLMAdminClient

    admin = _admin_key()
    if not admin:
        raise BrokerConfigError(
            f"{ADMIN_KEY_ENV_VAR} is not set. The broker exists to hold this "
            "key so laptops do not have to."
        )
    if not settings.base_url:
        raise BrokerConfigError(
            "accounts.litellm.base_url is not set, so the broker does not know "
            "which LiteLLM proxy to mint against."
        )
    return LiteLLMAdminClient(
        settings.base_url, admin, timeout=settings.request_timeout_seconds
    )


def build_app(provider=None, client=None, settings=None):
    """Build the broker ASGI app.

    ``provider``, ``client`` and ``settings`` are injectable so tests exercise
    the real routing and the real authorization decisions against a fake realm
    and a fake proxy, with no network and no server process.
    """
    from fastapi import Body, FastAPI, Header, HTTPException
    from starlette.concurrency import run_in_threadpool

    from hermes_cli.account_provisioning import load_settings
    from hermes_cli.accounts import account_slug_for_identity
    from hermes_cli.litellm_admin import LiteLLMError

    resolved_settings = settings or load_settings()
    # Resolved eagerly: a broker that starts happily and only discovers at the
    # first request that it has no admin key is a broker that fails during
    # somebody's sign-in instead of during your deploy.
    resolved_provider = provider or _keycloak_provider()
    resolved_client = client or _admin_client(resolved_settings)

    app = FastAPI(
        title="AgentX Workmate LiteLLM broker",
        description=(
            "Mints one LiteLLM virtual key per Keycloak account so the LiteLLM "
            "admin key never has to be installed on an employee's machine."
        ),
    )

    @app.get("/health")
    def health():
        return {"status": "ok", "base_url": resolved_settings.base_url}

    @app.post(BROKER_ROUTE)
    async def account_key(
        authorization: str = Header(default=""),
        body: dict = Body(default_factory=dict),
    ):
        token = ""
        if authorization.lower().startswith("bearer "):
            token = authorization[7:].strip()
        if not token:
            raise HTTPException(status_code=401, detail="missing bearer token")

        def _verify():
            return resolved_provider.verify_session(access_token=token)

        try:
            session = await run_in_threadpool(_verify)
        except Exception as exc:
            # A JWKS or discovery outage is the realm's problem, not the
            # caller's: 503 tells the laptop to keep its current key and try
            # later, where a 401 would tell it to throw the key away.
            logger.warning("broker: could not verify a token: %s", exc)
            raise HTTPException(
                status_code=503, detail="identity provider unreachable"
            ) from exc

        if session is None:
            raise HTTPException(status_code=401, detail="invalid token")

        slug = account_slug_for_identity(
            session.user_id,
            username=session.display_name or "",
            email=session.email or "",
        )
        alias = resolved_settings.alias_for(slug)

        # Logged so an operator can answer "who got a key, and when" without
        # reading LiteLLM's database. The hint from the body is recorded only
        # when it disagrees — that is the shape a probing client would have.
        claimed = str((body or {}).get("account") or "")
        if claimed and claimed != alias:
            logger.info(
                "broker: %s asked for alias %r; issuing %r from its own token",
                session.user_id, claimed, alias,
            )

        def _mint():
            # NOTHING IS DELETED HERE. What used to be on this line was a
            # delete of every key wearing this alias, and that was the defect:
            # one person's machines all present the same alias, so the second
            # laptop to sign in revoked the first laptop's key, and the first
            # then revoked the second. The broker cannot tell which key
            # belongs to which machine — it keeps no record — so the only safe
            # thing it can do is leave them alone. That leaks an orphaned key
            # per re-mint, visible in `/key/list` and removable by hand, which
            # is a bill rather than an outage.
            #
            # The real fix is the second-brain service, which mints once per
            # person and hands the same key back to every device. This module
            # exists only until no install runs `mode: "broker"`.
            return resolved_client.generate_key(
                key_alias=alias,
                user_id=session.user_id,
                models=resolved_settings.models,
                max_budget=resolved_settings.max_budget or None,
                budget_duration=resolved_settings.budget_duration,
                tpm_limit=resolved_settings.tpm_limit or None,
                rpm_limit=resolved_settings.rpm_limit or None,
                metadata={
                    "source": "agentx-workmate-broker",
                    "email": session.email,
                    "issuer": session.provider,
                },
            )

        try:
            minted = await run_in_threadpool(_mint)
        except LiteLLMError as exc:
            logger.error("broker: LiteLLM refused to mint for %s: %s", alias, exc)
            status = 503 if exc.unreachable else 502
            raise HTTPException(status_code=status, detail=str(exc)) from exc

        logger.info(
            "broker: issued key for %s (%s)", alias, session.email or session.user_id
        )

        return {
            "key": minted.key,
            "key_alias": minted.key_alias,
            "token": minted.token,
            "base_url": resolved_settings.base_url,
            "models": list(minted.models or resolved_settings.models),
            # Always false now: this broker retires nothing, because it cannot
            # tell one of a person's machines from another. Kept in the body so
            # an older laptop reading it does not trip over a missing field.
            "rotated": False,
            "account": slug,
        }

    return app


def serve(host: str = "127.0.0.1", port: int = 8787) -> int:
    """Run the broker. Returns a process exit code."""
    import uvicorn

    try:
        app = build_app()
    except BrokerConfigError as exc:
        print(f"Error: {exc}")
        return 1

    logger.info("broker listening on http://%s:%d%s", host, port, BROKER_ROUTE)
    uvicorn.run(app, host=host, port=port, log_level="info")
    return 0
