"""One model key per person, minted once and handed back to every device.

This module is the fix for the bug the whole project started from. Before it,
each laptop asked LiteLLM for a key under an alias derived from the person's
``sub`` claim, and both mint paths deleted whatever already wore that alias
before minting. So the second machine somebody signed in on revoked the
first machine's key; the first machine then rotated and revoked the second.
One person could hold exactly one working device.

The rule here is the opposite one, and it is the only rule in this file that
matters:

    **LiteLLM is asked for a key exactly once per person. Every device after
    that is served the stored copy.**

Two things follow from it that are worth being explicit about.

**The plaintext is stored.** LiteLLM returns a virtual key's plaintext exactly
once — ``/key/list`` and ``/key/info`` answer with the hash — so handing the
same key to a second device is only possible if we kept it. It is wrapped with
AES-256-GCM under a KEK the service reads from its environment, with the
person's ``subject`` as additional authenticated data so a row lifted from a
database dump cannot be opened as somebody else's, and with the ``kek_id``
recorded per row so the KEK can be rolled without an outage. This is strictly
better than the arrangement it replaces, in which the plaintext sat in
cleartext ``.env`` on every laptop *and* the admin key shipped inside every
installer.

**There is no delete-by-alias, anywhere.** Deletion happens during explicit
rotation only, and only against the ``litellm_token`` recorded on the row we
are replacing. Rotation is therefore self-healing rather than destructive: the
other devices do not break, they collect the new key on their next call.

Never log a plaintext key. ``mask_key`` from ``hermes_cli.litellm_admin`` is
what goes in the log line, and it is the same masking the proxy's own console
uses.
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from fastapi import APIRouter, Body, Depends, Request

from second_brain import API_PREFIX
from second_brain.auth import Principal, require_principal
from second_brain.errors import (
    KEY_UNREADABLE,
    LITELLM_REFUSED,
    LITELLM_UNAVAILABLE,
    LITELLM_UNCONFIGURED,
    STORE_UNAVAILABLE,
    BrainHTTPError,
)
from second_brain.store.engine import ModelKeyRow, StoreUnavailable

if TYPE_CHECKING:  # pragma: no cover - typing only
    from second_brain.app import BrainContext

logger = logging.getLogger(__name__)

#: AES-GCM's standard nonce length. Twelve bytes is the size the construction
#: is defined for; anything else costs an extra hashing step and buys nothing.
NONCE_BYTES = 12

router = APIRouter(prefix=API_PREFIX)


# ---------------------------------------------------------------------------
# The envelope
# ---------------------------------------------------------------------------


def encrypt_key(plaintext: str, *, kek: bytes, subject: str) -> tuple[bytes, bytes]:
    """Wrap *plaintext* for *subject*. Returns ``(ciphertext, nonce)``.

    The subject is the additional authenticated data, not part of the
    ciphertext: it is not secret, but binding it means a row moved to another
    person's ``subject`` — by a bug, or by somebody with write access to the
    database — fails to open rather than handing over a working key.
    """
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = os.urandom(NONCE_BYTES)
    ciphertext = AESGCM(kek).encrypt(nonce, plaintext.encode("utf-8"), subject.encode("utf-8"))
    return ciphertext, nonce


def decrypt_key(ciphertext: bytes, nonce: bytes, *, kek: bytes, subject: str) -> str:
    """Open a wrapped key, or raise ``InvalidTag``.

    Every failure mode of this call — wrong KEK, wrong subject, a ciphertext
    somebody edited — arrives as the same exception, which is the property
    that makes GCM worth using. The caller turns it into ``key_unreadable``
    and never into a partial answer.
    """
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    return AESGCM(kek).decrypt(nonce, ciphertext, subject.encode("utf-8")).decode("utf-8")


# ---------------------------------------------------------------------------
# Refusals
# ---------------------------------------------------------------------------


def _store_unavailable(exc: StoreUnavailable) -> BrainHTTPError:
    logger.error("second_brain: store unavailable serving a model key: %s", exc)
    return BrainHTTPError(
        503,
        STORE_UNAVAILABLE,
        "The service's database could not be reached. Try again shortly.",
    )


def _litellm_or_503(ctx: BrainContext) -> Any:
    """Return the admin client, or the 503 that says why there isn't one.

    A deploy with no proxy configured is an operator's mistake rather than a
    caller's, but it is answered as 503 and not 500 on purpose: 503 is the
    status that tells a laptop to keep the key it already holds and come back
    later, which is exactly the right behaviour while somebody fixes the
    deploy.
    """
    if ctx.litellm is None:
        logger.error(
            "second_brain: asked for a model key with no LiteLLM configured. "
            "Set AGENTX_BRAIN_LITELLM_BASE_URL and AGENTX_LITELLM_ADMIN_KEY."
        )
        raise BrainHTTPError(
            503,
            LITELLM_UNCONFIGURED,
            "This service has no LiteLLM proxy configured, so it cannot issue "
            "a model key. Keep the key you have; an operator has to fix this.",
        )
    return ctx.litellm


def _litellm_failed(exc: Exception) -> BrainHTTPError:
    """Map a proxy failure onto the status that tells the truth about it."""
    if getattr(exc, "unreachable", False):
        # Nothing was minted and nothing was stored, and the caller should
        # keep whatever it holds — the same contract `ensure_account_key`
        # keeps on the laptop.
        return BrainHTTPError(
            503,
            LITELLM_UNAVAILABLE,
            f"The model proxy could not be reached ({exc}). Nothing was "
            "changed; try again shortly.",
        )
    return BrainHTTPError(
        502,
        LITELLM_REFUSED,
        f"The model proxy refused to issue a key ({exc}).",
    )


# ---------------------------------------------------------------------------
# Reading a stored key
# ---------------------------------------------------------------------------


async def open_stored_key(ctx: BrainContext, subject: str, row: ModelKeyRow) -> str:
    """Decrypt *row*, re-wrapping it under the current KEK if it is behind.

    The re-wrap is what makes a KEK roll a background job rather than a
    maintenance window: an operator sets the new KEK, keeps the old one in
    ``AGENTX_BRAIN_KEK_PREVIOUS`` for the roll, and every row moves across the
    first time its owner asks for their key. It is a best-effort write — a
    failed re-wrap costs one retry on the next request and never costs the
    caller their key, so it must not be allowed to fail the read.
    """
    from cryptography.exceptions import InvalidTag

    kek = ctx.settings.kek_for(row.kek_id)
    if kek is None:
        logger.error(
            "second_brain: %s holds a key wrapped with KEK %r, which this "
            "service was not given. See 'Rotating the KEK' in the deploy "
            "README.",
            subject,
            row.kek_id,
        )
        raise BrainHTTPError(
            503,
            KEY_UNREADABLE,
            "The stored model key cannot be opened by this service. Keep the "
            "key you have; an operator has to restore the key-encryption key "
            "it was written with.",
        )

    try:
        plaintext = decrypt_key(row.ciphertext, row.nonce, kek=kek, subject=subject)
    except InvalidTag as exc:
        logger.error(
            "second_brain: the stored key for %s failed authentication under "
            "KEK %r. The row is not openable as this subject.",
            subject,
            row.kek_id,
        )
        raise BrainHTTPError(
            503,
            KEY_UNREADABLE,
            "The stored model key could not be authenticated. Keep the key "
            "you have; an operator has to look at this.",
        ) from exc

    if row.kek_id != ctx.settings.kek_id:
        await _rewrap(ctx, subject, row, plaintext)

    return plaintext


async def _rewrap(ctx: BrainContext, subject: str, row: ModelKeyRow, plaintext: str) -> None:
    """Move one row onto the current KEK. Never raises."""
    try:
        ciphertext, nonce = encrypt_key(plaintext, kek=ctx.settings.kek, subject=subject)
        moved = await ctx.store.rewrap_model_key(
            subject,
            ciphertext=ciphertext,
            nonce=nonce,
            kek_id=ctx.settings.kek_id,
            from_kek_id=row.kek_id,
        )
        if moved:
            logger.info(
                "second_brain: re-wrapped %s's model key from KEK %r to %r",
                subject,
                row.kek_id,
                ctx.settings.kek_id,
            )
    except Exception as exc:  # pragma: no cover - best effort by contract
        logger.warning(
            "second_brain: could not re-wrap %s's model key under KEK %r: %s",
            subject,
            ctx.settings.kek_id,
            exc,
        )


# ---------------------------------------------------------------------------
# Minting
# ---------------------------------------------------------------------------


async def _grantable_models(client: Any, settings: Any) -> tuple[str, ...]:
    """Return the models a key may reach, in the order modes were configured.

    A proxy serves more than the things a person talks to. Embedding and
    rerank models answer ``/v1/models`` exactly like a chat model, so a key
    scoped to everything puts ``BAAI/bge-m3`` in the picker; choosing it fails
    mid-conversation and reads like a broken proxy rather than a wrong pick.

    The returned order matters twice over: LiteLLM stores it, and the first
    entry becomes the account's default model. Sorting by
    ``key_model_modes`` — chat first by default — is what makes opening the
    app land on something you can talk to, with no model id written down
    anywhere on the laptop.

    ``accounts.litellm.models`` still wins when an operator set it. That is an
    explicit fleet-wide allow-list, and second-guessing it by mode would mean
    the setting quietly means something other than what it says.

    Raises rather than falling back to an unrestricted key when the proxy
    cannot say what it serves. Falling back is how the admin key came to
    travel inside every installer; the same instinct here would hand out
    embedding models to everyone the first time one endpoint hiccuped.
    """
    from hermes_cli.litellm_admin import LiteLLMError

    from starlette.concurrency import run_in_threadpool

    if settings.key_models:
        return tuple(settings.key_models)

    try:
        modes = await run_in_threadpool(client.model_modes)
    except LiteLLMError as exc:
        logger.error("second_brain: could not read the proxy's model list: %s", exc)
        raise _litellm_failed(exc) from exc

    wanted = tuple(settings.key_model_modes)
    granted = [
        model
        for mode in wanted
        for model, declared in modes.items()
        if declared == mode
    ]

    if not granted:
        skipped = sorted({m for m in modes.values() if m}) or ["(none declared)"]
        logger.error(
            "second_brain: the proxy serves no model in modes %s; it declares %s",
            ", ".join(wanted),
            ", ".join(skipped),
        )
        raise BrainHTTPError(
            502,
            "no_grantable_models",
            "the model proxy serves nothing this deployment is allowed to hand "
            "out. Check AGENTX_BRAIN_KEY_MODEL_MODES against the modes the "
            "proxy declares in /model/info.",
        )

    return tuple(granted)


async def _mint_and_store(
    ctx: BrainContext,
    subject: str,
    *,
    alias: str,
    existing: ModelKeyRow | None,
    email: str = "",
    issuer: str = "",
) -> tuple[ModelKeyRow, str]:
    """Ask LiteLLM for one key, store it wrapped, and retire the old one.

    The order is mint, store, then delete, and it is not interchangeable.
    Deleting first would mean a failure to store leaves everybody with no key
    at all; deleting last means the worst case is one orphaned key upstream,
    which an operator can see and clean up.
    """
    from starlette.concurrency import run_in_threadpool

    from hermes_cli.litellm_admin import LiteLLMError, mask_key

    client = _litellm_or_503(ctx)
    settings = ctx.settings

    granted = await _grantable_models(client, settings)

    def _mint():
        return client.generate_key(
            key_alias=alias,
            user_id=subject,
            models=granted,
            max_budget=settings.key_max_budget or None,
            budget_duration=settings.key_budget_duration,
            tpm_limit=settings.key_tpm_limit or None,
            rpm_limit=settings.key_rpm_limit or None,
            metadata={
                "source": "agentx-second-brain",
                "subject": subject,
                "email": email,
                "issuer": issuer,
            },
        )

    try:
        minted = await run_in_threadpool(_mint)
    except LiteLLMError as exc:
        logger.error("second_brain: LiteLLM refused to mint for %s: %s", alias, exc)
        raise _litellm_failed(exc) from exc

    ciphertext, nonce = encrypt_key(minted.key, kek=settings.kek, subject=subject)
    row = await ctx.store.save_model_key(
        subject,
        key_alias=minted.key_alias or alias,
        litellm_token=minted.token,
        ciphertext=ciphertext,
        nonce=nonce,
        kek_id=settings.kek_id,
        base_url=settings.litellm_base_url,
        # `granted` before `minted.models`: the proxy echoes back what it
        # stored, and an older LiteLLM echoes an empty list for an
        # unrestricted key. Preferring our own list keeps the stored order —
        # which is what picks the account's default model — instead of
        # inheriting whatever order the echo happens to have.
        models=granted or minted.models,
    )

    if existing is not None and existing.litellm_token and existing.litellm_token != minted.token:
        await _retire(ctx, subject, existing.litellm_token)

    logger.info(
        "second_brain: %s model key for %s (%s)",
        "rotated" if existing is not None else "issued",
        alias,
        mask_key(minted.key),
    )
    return row, minted.key


async def _retire(ctx: BrainContext, subject: str, token: str) -> None:
    """Delete exactly one previously stored key. Never raises.

    By token, never by alias. The replacement is already stored, so a proxy
    that cannot be reached here costs one orphaned key upstream — visible in
    ``/key/list`` and removable by hand — where letting the exception through
    would cost the caller a rotation that had in fact already succeeded.
    """
    from starlette.concurrency import run_in_threadpool

    try:
        await run_in_threadpool(lambda: ctx.litellm.delete_keys([token]))
    except Exception as exc:
        logger.error(
            "second_brain: rotated %s's key but could not delete the old one "
            "upstream (%s). It is orphaned in LiteLLM and should be removed.",
            subject,
            exc,
        )


def _body(row: ModelKeyRow, plaintext: str, *, status: str, account: str = "") -> dict[str, Any]:
    """The wire shape. Deliberately the broker's, so the laptop's two mint
    paths stay one shape apart from the URL they call."""
    return {
        "key": plaintext,
        "key_alias": row.key_alias,
        "token": row.litellm_token,
        "base_url": row.base_url,
        "models": list(row.models),
        # The account's default model, and the only place one is decided.
        # It is the first model the key can reach, which — because the list is
        # sorted by configured mode — is a chat model unless an operator asked
        # for something else. Deriving it here rather than shipping a constant
        # is what stops an installer from pinning a model the proxy retired:
        # the key cannot grant what the proxy does not serve, so the default
        # cannot name it either.
        "default_model": (list(row.models) or [""])[0],
        "status": status,
        "account": account,
        "created_at": row.created_at.isoformat(),
        "rotated_at": row.rotated_at.isoformat() if row.rotated_at else None,
    }


# ---------------------------------------------------------------------------
# The route
# ---------------------------------------------------------------------------


@router.post("/model-key")
async def model_key(
    request: Request,
    principal: Principal = Depends(require_principal),
    body: dict = Body(default_factory=dict),
):
    """Return this person's model key, minting one only if they have none.

    The common call — every device, every launch after the first — reads one
    row, opens it, and answers. It makes no request to LiteLLM at all, which
    is what stops a second device from costing somebody their first one.

    ``{"rotate": true}`` mints a replacement and retires the stored one. Other
    devices are not broken by it: they collect the new key the next time they
    call, because this route is where they get it from.
    """
    ctx: BrainContext = request.app.state.brain
    rotate = bool(isinstance(body, dict) and body.get("rotate"))

    try:
        if not rotate:
            existing = await ctx.store.model_key(principal.subject)
            if existing is not None:
                plaintext = await open_stored_key(ctx, principal.subject, existing)
                return _body(existing, plaintext, status="reused", account=principal.slug)

        # Everything below this line can mint, so it happens under the lock
        # that makes minting once-per-person true even when two devices arrive
        # together.
        async with ctx.store.issuance_lock(principal.subject):
            existing = await ctx.store.model_key(principal.subject)
            if existing is not None and not rotate:
                # Another device minted while this one waited for the lock.
                # Serving its key is the entire point of the service.
                plaintext = await open_stored_key(ctx, principal.subject, existing)
                return _body(existing, plaintext, status="reused", account=principal.slug)

            alias = existing.key_alias if existing else ctx.settings.alias_for(principal.slug)
            row, plaintext = await _mint_and_store(
                ctx,
                principal.subject,
                alias=alias,
                existing=existing,
                email=principal.email,
                issuer=principal.issuer,
            )
    except StoreUnavailable as exc:
        raise _store_unavailable(exc) from exc

    return _body(
        row,
        plaintext,
        status="rotated" if existing is not None else "issued",
        account=principal.slug,
    )


# ---------------------------------------------------------------------------
# Rotation from elsewhere
# ---------------------------------------------------------------------------


def rotation_hook(ctx: BrainContext) -> Callable[[str], Awaitable[str]]:
    """The callable ``DELETE /v1/devices/{id}?rotate_key=true`` rotates with.

    Revoking a device cannot by itself cut that device's model access — one
    key per person means the revoked machine holds the same key everybody
    else does. Rotating is what cuts it, and this is how the devices module
    reaches the vault without importing it or knowing how a key is stored.

    Returns the word that goes in the response, so "there was no key to
    rotate" reads as itself rather than as a success that cut nothing.
    """

    async def rotate(subject: str) -> str:
        async with ctx.store.issuance_lock(subject):
            existing = await ctx.store.model_key(subject)
            if existing is None:
                logger.info(
                    "second_brain: asked to rotate %s's model key; there is "
                    "none stored, so nothing was cut off.",
                    subject,
                )
                return "no_key"
            await _mint_and_store(
                ctx, subject, alias=existing.key_alias, existing=existing
            )
        return "rotated"

    return rotate
