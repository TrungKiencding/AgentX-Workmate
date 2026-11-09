"""Warnings cross real cron storage, Telegram formatting and HTTP transport.

Only the remote Telegram API is replaced with a loopback server. No real
provider calls, account credentials, or messages to real chats are involved.
"""

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs
from types import SimpleNamespace

import pytest

pytest.importorskip("telegram")


@pytest.fixture
def telegram_api(monkeypatch):
    import importlib
    import telegram

    # ExtBot subclasses Bot at import time. Load it before redirecting Bot's
    # constructor, keeping the SDK's actual class hierarchy intact.
    importlib.import_module("telegram.ext")
    received = []
    inference_calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.path == "/v1/chat/completions":
                inference_calls.append(json.loads(data))
                body = json.dumps({"error": {
                    "type": "invalid_request_error",
                    "message": "Your credit balance is too low. " + "PRIVATE-DIAGNOSTIC " * 100,
                }}).encode()
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            fields = {k: v[0] for k, v in parse_qs(data.decode()).items()}
            method = self.path.rsplit("/", 1)[-1]
            if method == "getMe":
                result = {"id": 123456, "is_bot": True, "first_name": "Test", "username": "test_bot"}
            elif method == "sendChatAction":
                result = True
            elif method in {"sendMessage", "editMessageText"}:
                received.append(fields)
                result = {
                    "message_id": len(received), "date": 1,
                    "chat": {"id": int(fields.get("chat_id", "123")), "type": "private"},
                    "text": fields.get("text", ""),
                }
            else:
                # Local-model capability probes are not Telegram messages.
                # An unsupported route must behave like a real HTTP server,
                # rather than fabricating a successful Bot API response.
                self.send_error(404)
                return
            body = json.dumps({"ok": True, "result": result}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    real_bot = telegram.Bot
    base_url = f"http://127.0.0.1:{server.server_port}/bot"

    def local_bot(*args, **kwargs):
        return real_bot(*args, **kwargs, base_url=base_url)

    monkeypatch.setattr(telegram, "Bot", local_bot)
    try:
        yield SimpleNamespace(messages=received, inference_calls=inference_calls, origin=f"http://127.0.0.1:{server.server_port}")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_failed_script_delivers_safe_warning_and_keeps_original_diagnosis(tmp_path, monkeypatch, telegram_api):
    from cron.jobs import create_job, get_job, use_cron_store
    from cron.scheduler import run_one_job

    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(
        "platforms:\n  telegram:\n    enabled: true\n    token: '123456:fake-test-token'\n"
    )
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "fail.py").write_text(
        "import sys\nprint('PRIVATE-DIAGNOSTIC HTTP 400 litellm.BadRequestError')\nsys.exit(12)\n"
    )
    with use_cron_store(tmp_path):
        job = create_job(
            prompt=None, schedule="every 5m", script="fail.py", no_agent=True,
            name="Daily reminder", deliver="telegram:123",
        )
        assert run_one_job(job)
        stored = get_job(job["id"])
        assert stored["last_status"] == "error"
        assert "PRIVATE-DIAGNOSTIC" in stored["last_error"]
        assert "PRIVATE-DIAGNOSTIC" in "\n".join(p.read_text() for p in tmp_path.rglob("*.md"))
        assert not stored["last_delivery_error"]

    assert len(telegram_api.messages) == 1
    text = telegram_api.messages[0]["text"]
    assert "Daily reminder" in text
    assert "could not finish" in text
    assert "PRIVATE-DIAGNOSTIC" not in text
    assert "BadRequestError" not in text
    assert "HTTP 400" not in text


@pytest.mark.asyncio
async def test_gateway_status_callback_sends_safe_message_over_real_http(telegram_api, monkeypatch):
    import telegram
    from gateway.config import Platform, PlatformConfig
    import gateway.run as gateway_run
    from gateway.run import TurnRunner, _sanitize_gateway_final_response
    from gateway.session import SessionSource
    from gateway.turn_context import TurnContext
    from plugins.platforms.telegram.adapter import TelegramAdapter

    adapter = TelegramAdapter(PlatformConfig(enabled=True, token="123456:fake-test-token"))
    raw = "Billing or credits exhausted: HTTP 400 litellm.BadRequestError: credit balance is too low\n"
    raw += "PRIVATE-DIAGNOSTIC {upstream payload}\n" * 100
    async with telegram.Bot(token="123456:fake-test-token") as bot:
        adapter._bot = bot
        ctx = TurnContext(
            source=SessionSource(platform=Platform.TELEGRAM, chat_id="123", user_id="owner"),
            _run_still_current=lambda: True,
            _status_adapter=adapter,
            _status_chat_id="123",
            _loop_for_step=asyncio.get_running_loop(),
        )
        # The callback normally runs in the agent worker and crosses into the
        # gateway loop; take that same thread/async bridge here.
        scheduled = []
        real_schedule = gateway_run.safe_schedule_threadsafe

        def track_schedule(*args, **kwargs):
            future = real_schedule(*args, **kwargs)
            scheduled.append(future)
            return future

        monkeypatch.setattr(gateway_run, "safe_schedule_threadsafe", track_schedule)
        runner = TurnRunner(None, ctx)
        await asyncio.to_thread(runner._status_callback_sync, "warn", raw)
        assert len(scheduled) == 1
        status = await asyncio.wait_for(asyncio.wrap_future(scheduled[0]), timeout=5)
        assert status.success
        final = await adapter.send("123", _sanitize_gateway_final_response("telegram", raw), metadata={"notify": True})
        assert final.success

    assert len(telegram_api.messages) == 2
    for sent in telegram_api.messages:
        assert "usage limit" in sent["text"]
        assert "PRIVATE-DIAGNOSTIC" not in sent["text"]
        assert "litellm" not in sent["text"]
        assert "HTTP 400" not in sent["text"]


def test_real_agent_http_billing_failure_is_safe_to_deliver(telegram_api, record_property):
    """Exercise SDK exception parsing and the real agent's failure result,
    rather than assuming what a provider failure will look like."""
    from run_agent import AIAgent
    from gateway.run import _sanitize_gateway_final_response

    agent = AIAgent(
        base_url=telegram_api.origin + "/v1", api_key="fake-test-key",
        provider="custom", api_mode="chat_completions", model="test-model",
        enabled_toolsets=[], max_iterations=1, quiet_mode=True,
        skip_context_files=True, skip_memory=True, skip_background_review=True,
    )
    try:
        result = agent.run_conversation("Reply with one short sentence.")
    finally:
        agent.close()

    assert telegram_api.inference_calls, "The agent must actually reach the HTTP model endpoint"
    assert result["failed"] is True
    assert result["failure_reason"] == "billing"
    raw = result["final_response"]
    assert "PRIVATE-DIAGNOSTIC" in raw
    safe = _sanitize_gateway_final_response("telegram", raw, failure_reason=result["failure_reason"])
    assert "usage limit" in safe
    assert "PRIVATE-DIAGNOSTIC" not in safe
    assert "HTTP" not in safe
    assert "add credits" not in safe.lower()

    # Finish the same delivery path as a gateway reply, with the actual
    # Telegram SDK and a real HTTP request to the loopback Bot API.
    async def deliver():
        import telegram
        from gateway.config import PlatformConfig
        from plugins.platforms.telegram.adapter import TelegramAdapter

        adapter = TelegramAdapter(PlatformConfig(enabled=True, token="123456:fake-test-token"))
        async with telegram.Bot(token="123456:fake-test-token") as bot:
            adapter._bot = bot
            return await adapter.send("123", safe, metadata={"notify": True})

    assert asyncio.run(deliver()).success
    assert len(telegram_api.messages) == 1
    assert "usage limit" in telegram_api.messages[0]["text"]
    assert "PRIVATE-DIAGNOSTIC" not in telegram_api.messages[0]["text"]
    record_property("scenario", "billing_exhausted")
    record_property("telegram_payloads", json.dumps(telegram_api.messages, ensure_ascii=False))
    record_property("inference_calls", len(telegram_api.inference_calls))
    record_property("diagnostic_preserved", "PRIVATE-DIAGNOSTIC" in raw)


def test_config_model_drift_skips_inference_and_sends_only_one_safe_alert(
    tmp_path, monkeypatch, telegram_api, record_property,
):
    from cron.jobs import create_job, get_job, use_cron_store
    from cron.scheduler import run_one_job

    monkeypatch.setenv("AGENTX_HOME", str(tmp_path))
    config_path = tmp_path / "config.yaml"

    def write_model(model):
        config_path.write_text(
            f"model:\n  provider: custom\n  default: {model}\n"
            f"  base_url: {telegram_api.origin}/v1\n  api_mode: chat_completions\n"
            "platforms:\n  telegram:\n    enabled: true\n    token: '123456:fake-test-token'\n",
            encoding="utf-8",
        )

    write_model("claude-opus-5-5")
    with use_cron_store(tmp_path):
        job = create_job(
            "Send a healthy living reminder", "every 5m",
            name="Nhắc lịch sinh hoạt lành mạnh", deliver="telegram:123",
        )
        assert job["provider_snapshot"] == "custom"
        assert job["model_snapshot"] == "claude-opus-5-5"
        write_model("claude-sonnet-5-5")
        for _ in range(2):
            assert run_one_job(get_job(job["id"]))
        stored = get_job(job["id"])
        assert stored["drift_alerted"] is True
        assert "[drift_skip" in stored["last_error"]
        assert "claude-opus-5-5" in stored["last_error"]
        assert "claude-sonnet-5-5" in stored["last_error"]

    assert telegram_api.inference_calls == []
    assert len(telegram_api.messages) == 1
    text = telegram_api.messages[0]["text"]
    assert "settings changed" in text
    assert "update the model" in text
    assert "claude-opus-5-5" not in text
    assert "claude-sonnet-5-5" not in text
    assert "RuntimeError" not in text
    assert "cronjob action" not in text
    record_property("scenario", "model_drift")
    record_property("telegram_payloads", json.dumps(telegram_api.messages, ensure_ascii=False))
    record_property("inference_calls", len(telegram_api.inference_calls))
    record_property("scheduler_runs", 2)
    record_property("diagnostic_preserved", "[drift_skip" in stored["last_error"])
