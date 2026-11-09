"""Read the signed-in account's provisioned key budget; never use an admin key.

LiteLLM's /key/info defaults to the key in Authorization. No caller-selected
key or user id crosses this boundary, and only budget fields leave it.
"""

from __future__ import annotations

import math
from typing import Any
from datetime import datetime, timezone

import httpx


def _amount(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Invalid budget amount")
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise ValueError("Invalid budget amount")
    return number


def quota_snapshot(info: dict[str, Any]) -> dict[str, Any]:
    spend = _amount(info.get("spend"))
    # Missing is not the same thing as an explicitly unlimited budget.
    limit = None if info["max_budget"] is None else _amount(info["max_budget"])
    reset = None
    if info.get("budget_reset_at"):
        try:
            dt = datetime.fromisoformat(
                str(info["budget_reset_at"]).replace("Z", "+00:00")
            )
            reset = (
                dt
                .replace(tzinfo=dt.tzinfo or timezone.utc)
                .astimezone(timezone.utc)
                .isoformat()
            )
        except (ValueError, OverflowError):
            pass
    return {
        "spend": spend,
        "limit": limit,
        "remaining": None if limit is None else max(0.0, limit - spend),
        "reset_at": reset,
        "renews": bool(info.get("budget_duration")),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def fetch_account_quota(
    subject: str, *, transport: httpx.BaseTransport | None = None
) -> dict[str, Any]:
    from hermes_cli.account_provisioning import (
        load_settings,
        provider_key_env,
        read_state,
    )
    from hermes_cli.config import load_env
    from hermes_cli.litellm_admin import normalize_base_url
    from hermes_constants import get_hermes_home

    state = read_state(get_hermes_home())
    # A verified session alone does not prove it owns this backend's home.
    if not subject or state.get("subject") != subject:
        return {"status": "unavailable", "quota": None}
    settings = load_settings()
    base = normalize_base_url(str(state.get("base_url") or settings.base_url))
    # Managed keys are written to this home. Do not fall back to a shell
    # credential when that file disappears: it may belong to someone else.
    key = (
        load_env().get(
            str(state.get("key_env") or provider_key_env(settings.provider_name))
        )
        or ""
    ).strip()
    if not base or not key:
        return {"status": "unavailable", "quota": None}
    try:
        # No redirects: a misconfigured proxy must never forward the key to
        # another host. No key in query parameters, logs, or error details.
        with httpx.Client(
            timeout=min(settings.request_timeout_seconds, 8.0), transport=transport
        ) as client:
            response = client.get(
                f"{base}/key/info", headers={"Authorization": f"Bearer {key}"}
            )
        if response.status_code in {401, 403}:
            return {"status": "forbidden", "quota": None}
        if response.status_code in {404, 405}:
            return {"status": "unsupported", "quota": None}
        response.raise_for_status()
        body = response.json()
        info = body.get("info") if isinstance(body, dict) else None
        if not isinstance(info, dict):
            raise ValueError("Invalid quota response")
        return {"status": "ok", "quota": quota_snapshot(info)}
    except httpx.HTTPError:
        return {"status": "offline", "quota": None}
    except (ValueError, KeyError, TypeError, OverflowError):
        return {"status": "error", "quota": None}
