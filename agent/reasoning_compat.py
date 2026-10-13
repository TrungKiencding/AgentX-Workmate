"""Bounded recovery for rejected Chat Completions reasoning controls.

Custom endpoints must keep their native reasoning wire until the endpoint
actually rejects it. Older LiteLLM OpenRouter routes can reject a new model's
``reasoning_effort`` based on a stale model map, even though OpenRouter accepts
``reasoning``. Translate that proven route instead of disabling reasoning.
Other endpoints can omit only the optional control they explicitly reject.

Recovery happens while opening the request, never while consuming a stream.
Messages, tools, credentials and user configuration are never modified.
"""

from __future__ import annotations

import asyncio
import ast
import hashlib
import logging
import re
import threading
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from time import monotonic
from typing import Any

from hermes_constants import get_hermes_home

logger = logging.getLogger(__name__)
_REASONING_FIELDS = ("reasoning_effort", "reasoning", "think", "thinking", "thinking_config")
_CACHE_TTL = 300.0
_CACHE_LIMIT = 256
_MAX_RECOVERIES = 2
_lock = threading.Lock()
_cache: OrderedDict[tuple[str, ...], tuple[float, "_Policy"]] = OrderedDict()


def is_unsupported_parameter_error(exc: Exception, param: str) -> bool:
    """Shared detector used by auxiliary temperature/token-limit recovery.

    Extracted from auxiliary_client's PR #15621 / #15416 generalization
    (@nicholasrae); the import there preserves the original public symbol.
    """
    param_lower = (param or "").lower()
    if not param_lower:
        return False
    err_lower = str(exc).lower()
    if param_lower not in err_lower:
        return False
    return any(marker in err_lower for marker in (
        "unsupported parameter", "unsupported_parameter", "not supported",
        "does not support", "unknown parameter", "unrecognized request argument",
        "unrecognized parameter", "invalid parameter",
    ))


def _field(request: dict, name: str) -> Any:
    extra = request.get("extra_body")
    if isinstance(extra, dict) and name in extra:
        return extra[name]  # SDK extra_body overrides top-level body fields.
    return request.get(name)


def _remove(request: dict, name: str) -> None:
    request.pop(name, None)
    extra = request.get("extra_body")
    if isinstance(extra, dict) and name in extra:
        request["extra_body"] = {k: v for k, v in extra.items() if k != name}
        if not request["extra_body"]:
            request.pop("extra_body")


@dataclass(frozen=True)
class _Policy:
    openrouter: bool = False
    capabilities: dict | None = None
    omitted: frozenset[str] = frozenset()

    def apply(self, original: dict) -> dict:
        request = dict(original)
        effort = _field(request, "reasoning_effort")
        if self.openrouter and isinstance(effort, str):
            _remove(request, "reasoning_effort")
            _remove(request, "think")  # Ollama-only disable flag.
            caps = self.capabilities or {}
            disabled = effort == "none"
            if caps.get("supports_reasoning") is not False and not (
                disabled and caps.get("mandatory") is True
            ):
                from agent.reasoning_effort import clamp_effort
                from providers import get_provider_profile

                config = {"enabled": False} if disabled else {
                    "enabled": True,
                    "effort": clamp_effort(effort, caps.get("supported_efforts")),
                }
                profile = get_provider_profile("openrouter")
                if profile is not None:
                    body, top = profile.build_api_kwargs_extras(
                        model=request.get("model"), reasoning_config=config,
                        supports_reasoning=True,
                    )
                    # Explicit extra_body.reasoning remains authoritative.
                    request["extra_body"] = {**body, **request.get("extra_body", {})}
                    for name, value in top.items():
                        if name == "extra_headers":
                            request[name] = {**value, **request.get(name, {})}
                        else:
                            request.setdefault(name, value)
        for name in self.omitted:
            _remove(request, name)
        return request


def _key(client: Any, request: dict) -> tuple[str, ...] | None:
    endpoint = getattr(client, "base_url", None)
    credential = getattr(client, "api_key", None)
    if not endpoint or not isinstance(credential, str):
        return None  # Non-SDK facades retain recovery without a shared cache.
    defaults = getattr(client, "default_headers", {})
    # SDK headers may contain fresh Omit sentinels on every property access.
    # Only strings reach HTTP; hashing sentinel reprs would miss every turn.
    headers = {
        str(name).lower(): value for name, value in defaults.items()
        if isinstance(value, str)
    } if isinstance(defaults, Mapping) else {}
    overrides = request.get("extra_headers") or {}
    if isinstance(overrides, Mapping):
        headers.update({str(name).lower(): value for name, value in overrides.items()
                        if isinstance(value, str)})
    header_key = hashlib.sha256(repr(sorted(headers.items())).encode()).hexdigest()
    return (
        str(get_hermes_home()), str(endpoint).rstrip("/"),
        str(request.get("model") or ""),
        hashlib.sha256(credential.encode()).hexdigest(),
        header_key,
    )


def _load(key: tuple[str, ...] | None) -> _Policy:
    if key is not None:
        with _lock:
            entry = _cache.get(key)
            if entry is not None:
                if monotonic() - entry[0] < _CACHE_TTL:
                    _cache.move_to_end(key)
                    return entry[1]
                del _cache[key]
    return _Policy()


def _save(key: tuple[str, ...] | None, policy: _Policy) -> None:
    if key is None or policy == _Policy():
        return
    with _lock:
        previous = _cache.get(key)
        if previous is not None and previous[1] == policy:
            return  # Expiry measures capability age, not last request activity.
        _cache[key] = (monotonic(), policy)
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_LIMIT:
            _cache.popitem(last=False)


def _recover(exc: Exception, request: dict, policy: _Policy) -> _Policy | None:
    # Do not retry auth, rate-limit, server, transport or invalid-value errors.
    if getattr(exc, "status_code", None) not in (400, 422):
        return None
    message = str(exc).lower()
    body = getattr(exc, "body", None)
    error = body.get("error", body) if isinstance(body, dict) else {}
    param = error.get("param") if isinstance(error, dict) else None
    rejected = []
    match = re.search(r"does not support parameters:\s*(\[[^\]]*\])", message)
    if match:
        try:
            rejected = ast.literal_eval(match[1])
        except (ValueError, SyntaxError):
            pass
    for name in _REASONING_FIELDS:
        if _field(request, name) is None or name in policy.omitted:
            continue
        # Match a parameter identifier, not reasoning_effort mentioned merely
        # in a model name or a suggestion to use a different parameter.
        explicit = (
            param == name and error.get("code") in {"unsupported_parameter", "unknown_parameter"}
        ) or name in rejected or bool(re.search(
            rf"(?:unsupported(?: parameter(?:s)?)?|unknown parameter|unrecognized (?:parameter|request argument)|does not support (?:parameters?:\s*)?)"
            rf"\s*[:=]?\s*(?:\[\s*)?['\"`]?{name}(?![\w.-])",
            message,
        )) or bool(re.search(rf"\b{name}\b['\"`]?\s+(?:is )?not supported", message))
        if not explicit or not is_unsupported_parameter_error(exc, name):
            continue
        if name == "reasoning_effort" and not policy.openrouter and (
            "litellm.unsupportedparamserror" in message
            and "openrouter does not support parameters:" in message
        ):
            from hermes_cli.models import openrouter_model_reasoning_capabilities

            caps = openrouter_model_reasoning_capabilities(
                str(request.get("model") or ""), allow_fetch=True, timeout=3.0,
            )
            logger.warning("Retrying %s with OpenRouter reasoning controls after LiteLLM rejected reasoning_effort", request.get("model"))
            return replace(policy, openrouter=True, capabilities=caps)
        logger.warning("Endpoint rejected %s for %s; retrying with the model's default for that control", name, request.get("model"))
        return replace(policy, omitted=policy.omitted | {name})
    return None


def create_chat_completion(
    client: Any, kwargs: dict, *, cancelled: Callable[[], bool] | None = None,
) -> Any:
    """Open a sync completion/stream, with at most two compatibility retries."""
    key = _key(client, kwargs)
    policy = _load(key)
    for attempt in range(_MAX_RECOVERIES + 1):
        request = policy.apply(kwargs)
        try:
            result = client.chat.completions.create(**request)
        except Exception as exc:
            if cancelled is not None and cancelled():
                raise InterruptedError("Agent interrupted before reasoning compatibility retry") from exc
            recovered = _recover(exc, request, policy) if attempt < _MAX_RECOVERIES else None
            if recovered is None:
                raise
            if cancelled is not None and cancelled():
                raise InterruptedError("Agent interrupted before reasoning compatibility retry") from exc
            policy = recovered
        else:
            _save(key, policy)
            return result


async def acreate_chat_completion(client: Any, kwargs: dict) -> Any:
    """Async counterpart; stream iteration and cancellation stay with callers."""
    key = _key(client, kwargs)
    policy = _load(key)
    for attempt in range(_MAX_RECOVERIES + 1):
        request = policy.apply(kwargs)
        try:
            result = await client.chat.completions.create(**request)
        except Exception as exc:
            recovered = await asyncio.to_thread(_recover, exc, request, policy) if attempt < _MAX_RECOVERIES else None
            if recovered is None:
                raise
            policy = recovered
        else:
            _save(key, policy)
            return result
