"""Real agent and auxiliary calls over HTTP, isolated from user credentials."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


@pytest.fixture
def gateway(tmp_path, monkeypatch):
    from agent import reasoning_compat
    from hermes_cli import models

    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(
        "model:\n  context_length: 131072\nagent:\n  reasoning_effort: medium\n"
        "auxiliary:\n  transient_retries: 0\n"
    )
    monkeypatch.setattr(reasoning_compat, "_cache", reasoning_compat.OrderedDict())
    # Seed through the real catalog parser and disk cache, then force hydration.
    models._seed_reasoning_caps(models._OPENROUTER_CATALOG_URL, [
        {"id": "z-ai/glm-5.3-flash", "supported_parameters": ["tools", "reasoning"],
         "reasoning": {"mandatory": True, "supported_efforts": ["max", "high", "low"]}},
    ])
    monkeypatch.setattr(models, "_openrouter_reasoning_caps_cache", None)
    monkeypatch.setattr(models, "_openrouter_caps_disk_checked", False)
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send_json(self, status, body):
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            self.send_json(200, {"data": [{"id": "z-ai/glm-5.3-flash", "context_length": 131072}]})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            if "reasoning_effort" in body:
                self.send_json(400, {"error": {
                    "message": "litellm.UnsupportedParamsError: openrouter does not support parameters: ['reasoning_effort'], for model=z-ai/glm-5.3-flash",
                    "type": "invalid_request_error", "param": None, "code": "400",
                }})
                return
            if body.get("stream"):
                chunks = [
                    {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
                     "model": body["model"], "choices": [{"index": 0, "finish_reason": None,
                         "delta": {"role": "assistant", "content": "OK"}}]},
                    {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
                     "model": body["model"], "choices": [{"index": 0, "finish_reason": "stop", "delta": {}}],
                     "usage": {"prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 11}},
                ]
                payload = ("".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)
                           + "data: [DONE]\n\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            else:
                self.send_json(200, {
                    "id": "fixture", "object": "chat.completion", "created": 1,
                    "model": body["model"], "choices": [{"index": 0, "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "OK"}}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 11},
                })

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


@pytest.mark.parametrize("streaming", [False, True])
def test_agent_conversation_recovers_and_next_turn_uses_learned_wire(gateway, streaming):
    from run_agent import AIAgent

    endpoint, requests = gateway
    delivered = []
    agent = AIAgent(
        provider="custom", base_url=endpoint, api_key="fixture", model="z-ai/glm-5.3-flash",
        reasoning_config={"enabled": True, "effort": "medium"},
        enabled_toolsets=[], max_iterations=3, quiet_mode=True,
        skip_context_files=True, skip_memory=True, save_trajectories=False,
        platform="desktop", stream_delta_callback=delivered.append if streaming else None,
    )
    try:
        first = agent.run_conversation("xin chào", conversation_history=[])
        assert first["final_response"] == "OK"
        assert len(requests) == 2
        assert requests[1]["reasoning"] == {"enabled": True, "effort": "low"}
        assert requests[0]["messages"] == requests[1]["messages"]
        assert requests[0].get("tools") == requests[1].get("tools")
        prefix = requests[1]["messages"][0]
        second = agent.run_conversation("hello again", conversation_history=first["messages"])
        assert second["final_response"] == "OK"
        assert len(requests) == 3
        assert requests[2]["messages"][0] == prefix
        assert "reasoning_effort" not in requests[2]
        assert agent.reasoning_config == {"enabled": True, "effort": "medium"}
        if streaming:
            assert delivered == ["OK", "OK"]
    finally:
        agent.client.close()


@pytest.mark.parametrize("streaming", [False, True])
def test_auxiliary_sync_real_resolution_uses_same_recovery(gateway, streaming, monkeypatch):
    from agent.auxiliary_client import call_llm

    endpoint, requests = gateway
    monkeypatch.setenv("OPENAI_API_KEY", "fixture")
    result = call_llm(
        task="title", provider="custom", model="z-ai/glm-5.3-flash", base_url=endpoint,
        messages=[{"role": "user", "content": "Reply OK"}],
        reasoning_config={"enabled": True, "effort": "medium"}, stream=streaming,
    )
    if streaming:
        try:
            assert "".join(c.choices[0].delta.content or "" for c in result) == "OK"
        finally:
            result.close()
    else:
        assert result.choices[0].message.content == "OK"
    assert len(requests) == 2
    assert requests[1]["reasoning"] == {"enabled": True, "effort": "low"}


@pytest.mark.asyncio
async def test_auxiliary_async_real_resolution_uses_same_recovery(gateway, monkeypatch):
    from agent.auxiliary_client import async_call_llm

    endpoint, requests = gateway
    monkeypatch.setenv("OPENAI_API_KEY", "fixture")
    result = await async_call_llm(
        task="title", provider="custom", model="z-ai/glm-5.3-flash", base_url=endpoint,
        messages=[{"role": "user", "content": "Reply OK"}],
        reasoning_config={"enabled": True, "effort": "medium"},
    )
    assert result.choices[0].message.content == "OK"
    assert len(requests) == 2
    assert requests[1]["reasoning"] == {"enabled": True, "effort": "low"}
