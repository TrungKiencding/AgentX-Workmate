"""Build the service, wire its dependencies, and answer for its own health.

Dependencies are resolved **eagerly**, in ``build_app``, and every one of them
raises :class:`~second_brain.errors.BrainConfigError` when it cannot be
resolved. A service that starts happily and only discovers at the first
request that it has no realm to verify against is a service that fails during
somebody's sign-in instead of during your deploy. This is the shape and the
reasoning ``hermes_cli.litellm_broker.build_app`` already uses.

Every dependency is also injectable, which is what lets the tests drive real
routing and real authorization decisions against a fake realm and a real
disposable Postgres, with no network and no server process.

Ownership rule: **what ``build_app`` opens, ``build_app`` closes.** A store it
constructs itself is connected and migrated on startup and closed on shutdown;
a store handed to it belongs to the caller and is left alone. Getting this
backwards would have the test suite's session-wide database closed by the
first app that used it.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from second_brain import API_PREFIX, __version__
from second_brain.errors import BrainConfigError, install_error_handler
from second_brain.settings import BrainSettings, load_settings

logger = logging.getLogger(__name__)


@dataclass
class BrainContext:
    """Everything a route needs, reachable from ``request.app.state.brain``.

    One object rather than a module-level singleton, so two apps can exist in
    one process — which is exactly what the tests do when they check that one
    person's device is invisible to another.
    """

    settings: BrainSettings
    provider: Any
    store: Any
    litellm: Any | None = None
    #: Fans Postgres change notifications out to connected sockets. Always
    #: present; it simply has no subscribers and no listening connection until
    #: somebody opens ``/v1/sync/stream``.
    notifier: Any = None
    #: Rotate this person's model key. ``None`` on a deploy with no proxy
    #: configured, where there is nothing to rotate and nothing a rotation
    #: would cut off; ``devices`` then reports ``unsupported`` rather than
    #: claiming to have revoked model access it did not touch.
    rotate_key: Callable[[str], Awaitable[Any]] | None = None


def litellm_client(settings: BrainSettings) -> Any | None:
    """Return an admin client for the proxy, or None when unconfigured.

    Phase 1 mints nothing, so a deployment that only wants the device registry
    is allowed to omit the proxy entirely and gets an honest ``unconfigured``
    from ``/health``. The key vault requires it and says so at that point.
    """
    if not settings.litellm_configured:
        return None

    from hermes_cli.litellm_admin import LiteLLMAdminClient

    return LiteLLMAdminClient(
        settings.litellm_base_url,
        settings.litellm_admin_key,
        timeout=settings.litellm_timeout_seconds,
    )


async def _litellm_health(client: Any | None, settings: BrainSettings) -> dict[str, Any]:
    """Describe the proxy without letting a slow one stall the probe."""
    if client is None:
        return {
            "status": "unconfigured",
            "detail": (
                "No LiteLLM proxy configured. The device registry does not need "
                "one; issuing model keys does."
            ),
        }

    from starlette.concurrency import run_in_threadpool

    from hermes_cli.litellm_admin import LiteLLMError

    try:
        models = await run_in_threadpool(client.list_models)
    except LiteLLMError as exc:
        return {
            "status": "unreachable" if exc.unreachable else "refused",
            "base_url": settings.litellm_base_url,
            "detail": str(exc),
        }
    return {
        "status": "ok",
        "base_url": settings.litellm_base_url,
        "models": len(models),
    }


def build_app(
    *,
    settings: BrainSettings | None = None,
    provider: Any | None = None,
    store: Any | None = None,
    litellm: Any | None = None,
    rotate_key: Callable[[str], Awaitable[Any]] | None = None,
) -> Any:
    """Build the second-brain ASGI app.

    Raises :class:`BrainConfigError` when the environment cannot support the
    service — missing database URL, missing KEK, no Keycloak realm.
    """
    from fastapi import FastAPI

    from second_brain import auth as auth_module
    from second_brain import devices as devices_module
    from second_brain import keys as keys_module
    from second_brain import search as search_module
    from second_brain import stream as stream_module
    from second_brain import sync as sync_module
    from second_brain.store.engine import Store

    resolved_settings = settings or load_settings()
    resolved_provider = provider or auth_module.keycloak_provider()
    resolved_litellm = litellm if litellm is not None else litellm_client(resolved_settings)

    owns_store = store is None

    ctx = BrainContext(
        settings=resolved_settings,
        provider=resolved_provider,
        # An unopened store when we own it: a connection pool needs a running
        # event loop, and there is not one until startup.
        store=store or Store(),
        litellm=resolved_litellm,
        rotate_key=rotate_key,
        notifier=stream_module.DocumentNotifier(),
    )

    # Revoking a device only cuts its model access if the key is rotated with
    # it, and rotating needs a proxy to mint the replacement against. With no
    # proxy there is nothing to rotate, so the hook stays absent and the
    # devices route says ``unsupported`` instead of reporting a cut that did
    # not happen. An injected hook always wins — that is how the tests drive
    # the revoke path without a proxy at all.
    if ctx.rotate_key is None and resolved_litellm is not None:
        ctx.rotate_key = keys_module.rotation_hook(ctx)

    @asynccontextmanager
    async def lifespan(app: Any):
        import asyncio

        if owns_store:
            await ctx.store.open(resolved_settings)
            applied = await ctx.store.migrate()
            if applied:
                logger.info("second_brain: applied migrations %s", ", ".join(applied))

        # Expired tombstones are the service's own litter, so it clears them
        # itself rather than depending on somebody remembering a cron entry.
        # The loop sleeps before its first pass, so a short-lived app — every
        # app the tests build — never sweeps at all.
        sweeper = asyncio.create_task(sync_module.sweep_tombstones_forever(ctx))

        # Best-effort by design: the socket is a shortcut in front of polling,
        # so a service that cannot open a listening connection still works —
        # every device simply finds its changes on the next tick instead of
        # immediately. Refusing to start over it would trade a working service
        # for a faster one.
        try:
            await ctx.notifier.start(ctx.store)
        except Exception as exc:  # noqa: BLE001 - realtime is an optimisation
            logger.warning(
                "second_brain: change notifications unavailable, clients will "
                "poll instead: %s",
                exc,
            )

        try:
            yield
        finally:
            await ctx.notifier.stop()
            sweeper.cancel()
            # Awaited rather than merely cancelled: an un-awaited cancelled
            # task is what produces "Task exception was never retrieved" in an
            # operator's log during an otherwise clean shutdown.
            try:
                await sweeper
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            if owns_store:
                await ctx.store.close()

    app = FastAPI(
        title="AgentX second brain",
        version=__version__,
        description=(
            "One model key per person, the devices they hold it on, and the "
            "change feed that keeps their history in step."
        ),
        lifespan=lifespan,
    )
    app.state.brain = ctx
    install_error_handler(app)

    @app.get("/health")
    async def health():
        """Report each dependency separately, and say whether we can serve.

        Answers 503 only when Postgres is unreachable, because that is the one
        dependency without which no route can do anything. A LiteLLM that is
        down or absent is reported and is not fatal: devices still list, and
        stored keys still serve.
        """
        from fastapi.responses import JSONResponse

        postgres_ok = await ctx.store.ping()
        body = {
            "status": "ok" if postgres_ok else "degraded",
            "version": __version__,
            "api": API_PREFIX,
            "postgres": {"status": "ok" if postgres_ok else "unreachable"},
            "litellm": await _litellm_health(ctx.litellm, resolved_settings),
            # Reported, never fatal: with notifications down every device
            # still converges on its polling interval.
            "realtime": {
                "status": "ok" if ctx.notifier.listening else "polling",
                "accounts_watching": ctx.notifier.subjects,
            },
        }
        return JSONResponse(status_code=200 if postgres_ok else 503, content=body)

    app.include_router(auth_module.router)
    app.include_router(devices_module.router)
    app.include_router(keys_module.router)
    app.include_router(sync_module.router)
    app.include_router(search_module.router)
    app.include_router(stream_module.router)

    return app


def serve(host: str = "127.0.0.1", port: int = 8811) -> int:
    """Run the service. Returns a process exit code."""
    import uvicorn

    try:
        app = build_app()
    except BrainConfigError as exc:
        print(f"Error: {exc}")
        return 1

    logger.info("second_brain listening on http://%s:%d%s", host, port, API_PREFIX)
    uvicorn.run(app, host=host, port=port, log_level="info")
    return 0
