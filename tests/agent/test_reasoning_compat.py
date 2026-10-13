"""Reasoning recovery against the real SDK and provider/profile projection."""

import copy
import json
from types import SimpleNamespace

import httpx
import pytest
from openai import AsyncOpenAI, BadRequestError, OpenAI

from agent import reasoning_compat as compat
from agent.transports.chat_completions import ChatCompletionsTransport
from providers import get_provider_profile

MODEL = "z-ai/glm-5.3-flash"
LITELLM_ERROR = (
    "litellm.UnsupportedParamsError: openrouter does not support parameters: "
    "['reasoning_effort'], for model=z-ai/glm-5.3-flash. To drop these, "
    "set litellm.drop_params=True. allowed_openai_params=['reasoning_effort']"
)


def response(body):
    return httpx.Response(200, json={
        "id": "fixture", "object": "chat.completion", "created": 1,
        "model": body["model"], "choices": [{"index": 0, "finish_reason": "stop",
            "message": {"role": "assistant", "content": "OK"}}],
    })


def error(message, status=400, **fields):
    return httpx.Response(status, json={"error": {
        "message": message, "type": "invalid_request_error", **fields,
    }})


@pytest.fixture(autouse=True)
def isolated_capabilities(monkeypatch):
    from hermes_cli import models

    monkeypatch.setattr(compat, "_cache", compat.OrderedDict())
    caps = models._seed_reasoning_caps(models._OPENROUTER_CATALOG_URL, [
        {"id": MODEL, "supported_parameters": ["tools", "reasoning"],
         "reasoning": {"mandatory": True, "supported_efforts": ["max", "high", "low"]}},
        {"id": "fixture/non-thinking", "supported_parameters": ["tools"]},
    ])
    monkeypatch.setattr(models, "_openrouter_reasoning_caps_cache", caps)


def kwargs(effort="medium", model=MODEL):
    return ChatCompletionsTransport().build_kwargs(
        model, [{"role": "system", "content": "Stable prefix"},
                {"role": "user", "content": "Hi"}],
        tools=[{"type": "function", "function": {
            "name": "fixture", "parameters": {"type": "object", "properties": {}}}}],
        provider_profile=get_provider_profile("custom:gateway"),
        reasoning_config={"enabled": effort != "none", "effort": effort},
        extra_body_additions={"session_id": "same-session"},
    )


def client_for(handler, *, endpoint="https://gateway.test/v1", key="fixture"):
    return OpenAI(api_key=key, base_url=endpoint, max_retries=0,
                  http_client=httpx.Client(transport=httpx.MockTransport(handler)))


def test_litellm_openrouter_recovery_preserves_reasoning_and_cached_prefix():
    captured = []

    def handler(req):
        body = json.loads(req.content)
        captured.append(body)
        return error(LITELLM_ERROR) if "reasoning_effort" in body else response(body)

    request = kwargs()
    before = copy.deepcopy(request)
    with client_for(handler) as client:
        # Exercise the actual non-streaming dispatch used by the agent.
        from agent.chat_completion_helpers import _dispatch_nonstreaming_api_request
        agent = SimpleNamespace(api_mode="chat_completions", provider="custom")
        result = _dispatch_nonstreaming_api_request(
            agent, request, make_client=lambda *args, **kw: client,
        )
        assert result.choices[0].message.content == "OK"
        compat.create_chat_completion(client, kwargs("high"))
    assert len(captured) == 3  # Following turn uses learned wire, no extra 400.
    assert captured[0]["reasoning_effort"] == "medium"
    assert captured[1]["reasoning"] == {"enabled": True, "effort": "low"}
    assert captured[2]["reasoning"] == {"enabled": True, "effort": "high"}
    assert request == before
    for body in captured[1:]:
        for field in ("messages", "tools", "session_id"):
            assert body[field] == captured[0][field]
        assert "reasoning_effort" not in body


@pytest.mark.parametrize("model", [MODEL, "fixture/non-thinking"])
def test_mandatory_or_non_reasoning_models_do_not_get_disable_controls(model):
    captured = []

    def handler(req):
        body = json.loads(req.content)
        captured.append(body)
        return error(LITELLM_ERROR) if "reasoning_effort" in body else response(body)

    with client_for(handler) as client:
        compat.create_chat_completion(client, kwargs("none", model))
    assert len(captured) == 2
    assert not {"think", "reasoning", "reasoning_effort"} & captured[1].keys()
    assert captured[1]["session_id"] == "same-session"


@pytest.mark.parametrize("field,value,location", [
    ("reasoning_effort", "high", "top"),
    ("reasoning_effort", "high", "extra_body"),
    ("reasoning", {"effort": "high"}, "extra_body"),
    ("think", False, "extra_body"),
    ("thinking", {"type": "enabled"}, "extra_body"),
    ("thinking_config", {"thinkingBudget": 1024}, "extra_body"),
])
def test_only_explicitly_rejected_control_is_omitted(field, value, location):
    captured = []

    def handler(req):
        body = json.loads(req.content)
        captured.append(body)
        return error(f"Unknown parameter: '{field}'") if field in body else response(body)

    request = {"model": "future-model", "messages": kwargs()["messages"],
               "temperature": 0.7, "extra_body": {"metadata": {"fixture": True}}}
    (request if location == "top" else request["extra_body"])[field] = value
    before = copy.deepcopy(request)
    with client_for(handler) as client:
        compat.create_chat_completion(client, request)
    assert len(captured) == 2
    assert captured[1] == {k: v for k, v in captured[0].items() if k != field}
    assert request == before


@pytest.mark.parametrize("status,message,fields", [
    (401, "reasoning_effort is not supported", {}),
    (429, "reasoning_effort is not supported", {}),
    (500, "reasoning_effort is not supported", {}),
    (400, "reasoning_effort must be one of low, medium, high", {"param": "reasoning_effort"}),
    (400, "Unsupported parameter: temperature. Try reasoning_effort instead", {}),
    (400, "Unknown model: reasoning_effort-fixture", {}),
])
def test_unrelated_errors_are_not_retried_or_cached(status, message, fields):
    count = 0

    def handler(req):
        nonlocal count
        count += 1
        return error(message, status, **fields)

    with client_for(handler) as client, pytest.raises(Exception):
        compat.create_chat_completion(client, kwargs())
    assert count == 1
    assert not compat._cache


def test_retry_bound_and_failed_projection_not_cached():
    captured = []

    def handler(req):
        body = json.loads(req.content)
        captured.append(body)
        if "reasoning_effort" in body:
            return error(LITELLM_ERROR)
        if "reasoning" in body:
            return error("Unsupported parameter: reasoning")
        return error("Still invalid")

    with client_for(handler) as client, pytest.raises(BadRequestError, match="Still invalid"):
        compat.create_chat_completion(client, kwargs())
    assert len(captured) == 3
    assert not compat._cache


def test_cache_scoped_to_model_endpoint_credential_profile_and_expires(monkeypatch, tmp_path):
    captured = []
    clock = [0.0]
    monkeypatch.setattr(compat, "monotonic", lambda: clock[0])

    def handler(req):
        body = json.loads(req.content)
        captured.append(body)
        return error("Unsupported parameter: reasoning_effort") if "reasoning_effort" in body else response(body)

    with client_for(handler) as client:
        compat.create_chat_completion(client, kwargs())
        clock[0] = 100.0
        compat.create_chat_completion(client, kwargs())
        assert len(captured) == 3
        clock[0] = compat._CACHE_TTL + 1
        compat.create_chat_completion(client, kwargs())
        assert len(captured) == 5  # Expiry is not postponed by the second call.
        compat.create_chat_completion(client, kwargs(model="another-model"))
        assert len(captured) == 7
        monkeypatch.setenv("AGENTX_HOME", str(tmp_path / "other-profile"))
        compat.create_chat_completion(client, kwargs())
        assert len(captured) == 9
    for changes in ({"endpoint": "https://other.test/v1"}, {"key": "other-key"}):
        with client_for(handler, **changes) as client:
            compat.create_chat_completion(client, kwargs())
    assert len(captured) == 13


@pytest.mark.asyncio
async def test_async_sdk_uses_same_projection_and_cache():
    captured = []

    def handler(req):
        body = json.loads(req.content)
        captured.append(body)
        return error(LITELLM_ERROR) if "reasoning_effort" in body else response(body)

    async with AsyncOpenAI(api_key="fixture", base_url="https://gateway.test/v1", max_retries=0,
                          http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))) as client:
        result = await compat.acreate_chat_completion(client, kwargs())
        assert result.choices[0].message.content == "OK"
        await compat.acreate_chat_completion(client, kwargs("high"))
    assert len(captured) == 3
    assert captured[1]["reasoning"]["effort"] == "low"
    assert captured[2]["reasoning"]["effort"] == "high"


def test_supported_native_reasoning_request_is_unchanged():
    captured = []

    def handler(req):
        body = json.loads(req.content)
        captured.append(body)
        return response(body)

    with client_for(handler) as client:
        compat.create_chat_completion(client, kwargs("none"))
    assert len(captured) == 1
    assert captured[0]["reasoning_effort"] == "none"
    assert captured[0]["think"] is False
    assert not compat._cache


@pytest.mark.parametrize("message,status,fields", [
    ("Unknown parameter: reasoning_effort", 422, {}),
    ("Unsupported option", 400, {"param": "reasoning_effort", "code": "unsupported_parameter"}),
    ("Unrecognized request argument: `reasoning_effort`", 400, {}),
    ("reasoning_effort is not supported for this model", 400, {}),
    ("proxy does not support parameters: ['seed', 'reasoning_effort']", 400, {}),
])
def test_rejection_phrasings_and_structured_errors(message, status, fields):
    captured = []

    def handler(req):
        body = json.loads(req.content)
        captured.append(body)
        return error(message, status, **fields) if "reasoning_effort" in body else response(body)

    with client_for(handler) as client:
        compat.create_chat_completion(client, kwargs())
    assert len(captured) == 2


def test_cancellation_prevents_compatibility_retry():
    captured = []

    def handler(req):
        captured.append(json.loads(req.content))
        return error(LITELLM_ERROR)

    with client_for(handler) as client, pytest.raises(InterruptedError):
        compat.create_chat_completion(client, kwargs(), cancelled=lambda: bool(captured))
    assert len(captured) == 1
    assert not compat._cache


def test_cancellation_during_capability_lookup_prevents_a_new_request(monkeypatch):
    from hermes_cli import models
    captured = []
    cancelled = [False]

    def lookup(*args, **kw):
        cancelled[0] = True
        return {"supports_reasoning": True}

    def handler(req):
        captured.append(json.loads(req.content))
        return error(LITELLM_ERROR)

    monkeypatch.setattr(models, "openrouter_model_reasoning_capabilities", lookup)
    with client_for(handler) as client, pytest.raises(InterruptedError):
        compat.create_chat_completion(client, kwargs(), cancelled=lambda: cancelled[0])
    assert len(captured) == 1
    assert not compat._cache


def test_cache_does_not_cross_default_routing_headers():
    captured = []

    def handler(req):
        body = json.loads(req.content)
        captured.append(body)
        if req.headers.get("X-Upstream") == "legacy" and "reasoning_effort" in body:
            return error("Unsupported parameter: reasoning_effort")
        return response(body)

    with client_for(handler) as client:
        client = client.with_options(default_headers={"X-Upstream": "legacy"})
        compat.create_chat_completion(client, kwargs())
        client = client.with_options(default_headers={"X-Upstream": "native"})
        compat.create_chat_completion(client, kwargs())
    assert len(captured) == 3
    assert "reasoning_effort" not in captured[1]
    assert captured[2]["reasoning_effort"] == "medium"


def test_stream_failure_after_delivery_is_never_retried():
    captured = []

    def handler(req):
        body = json.loads(req.content)
        captured.append(body)
        chunk = {"id": "fixture", "created": 1, "model": body["model"],
                 "choices": [{"index": 0, "delta": {"content": "partial"}}]}
        return httpx.Response(200, headers={"Content-Type": "text/event-stream"},
            content=f"data: {json.dumps(chunk)}\n\ndata: {json.dumps({'error': {'message': LITELLM_ERROR}})}\n\n")

    with client_for(handler) as client:
        stream = compat.create_chat_completion(client, {**kwargs(), "stream": True})
        try:
            assert next(stream).choices[0].delta.content == "partial"
            with pytest.raises(Exception, match="UnsupportedParamsError"):
                next(stream)
        finally:
            stream.close()
    assert len(captured) == 1


def test_cache_has_a_bounded_size_and_keeps_recent_routes(monkeypatch):
    monkeypatch.setattr(compat, "_CACHE_LIMIT", 2)
    policy = compat._Policy(omitted=frozenset({"reasoning_effort"}))
    compat._save(("first",), policy)
    compat._save(("second",), policy)
    compat._load(("first",))
    compat._save(("third",), policy)
    assert set(compat._cache) == {("first",), ("third",)}


def test_explicit_body_reasoning_and_headers_remain_authoritative():
    captured = []

    def handler(req):
        body = json.loads(req.content)
        captured.append(body)
        return error(LITELLM_ERROR) if "reasoning_effort" in body else response(body)

    request = kwargs()
    request["extra_body"]["reasoning"] = {"effort": "high", "exclude": True}
    request["extra_headers"] = {"X-Fixture-Route": "same"}
    with client_for(handler) as client:
        compat.create_chat_completion(client, request)
    assert len(captured) == 2
    assert captured[1]["reasoning"] == request["extra_body"]["reasoning"]


def test_unknown_catalog_model_preserves_effort_on_proven_openrouter_route():
    captured = []

    def handler(req):
        body = json.loads(req.content)
        captured.append(body)
        return error(LITELLM_ERROR) if "reasoning_effort" in body else response(body)

    with client_for(handler) as client:
        compat.create_chat_completion(client, kwargs("high", "fixture/future-model"))
    assert captured[1]["reasoning"] == {"enabled": True, "effort": "high"}


def test_translated_openrouter_profile_merges_cache_header_without_losing_route():
    from agent.portal_tags import reset_conversation_context, set_conversation_context

    request = kwargs("high", "x-ai/grok-fixture")
    request["extra_headers"] = {"X-Fixture-Route": "same"}
    original = copy.deepcopy(request)
    token = set_conversation_context("fixture-conversation")
    try:
        projected = compat._Policy(openrouter=True).apply(request)
    finally:
        reset_conversation_context(token)
    assert projected["extra_headers"] == {
        "X-Fixture-Route": "same", "x-grok-conv-id": "fixture-conversation",
    }
    assert request == original
