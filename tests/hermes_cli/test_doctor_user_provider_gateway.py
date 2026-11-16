"""`agentx doctor` on an account provisioned against a user-defined gateway.

A signed-in account home points ``model.provider`` at an entry of the
``providers:`` section (an OpenAI-compatible LiteLLM gateway) whose key lives
in the env var named by ``key_env``. Doctor used to report "No API key found"
and to advise dropping the vendor prefix / switching to openrouter — both
wrong for that setup, and following the advice breaks the install.
"""

import contextlib
import io
import sys
import types
from argparse import Namespace

import pytest

from hermes_cli import doctor as doctor_mod


KEY_ENV = "AGENTX_CUSTOM_LITELLM_API_KEY"

GATEWAY_CONFIG = (
    "model:\n"
    "  provider: litellm\n"
    "  default: deepseek/deepseek-v4.1-flash\n"
    f"  key_env: {KEY_ENV}\n"
    "  base_url: https://gateway.example/v1\n"
    "  api_mode: chat_completions\n"
    "providers:\n"
    "  litellm:\n"
    "    name: AgentX AI Gateway\n"
    "    base_url: https://gateway.example/v1\n"
    f"    key_env: {KEY_ENV}\n"
)

NO_KEY_WARNING = "No API key found"
SETUP_ADVICE = "Run 'agentx setup' to configure API keys"
VENDOR_WARNING = "uses a vendor/model slug but provider is"
VENDOR_ADVICE = "Either set model.provider to 'openrouter', or drop the vendor prefix."


def _run_doctor(monkeypatch, tmp_path, *, config: str, env: str) -> str:
    home = tmp_path / ".agentx"
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(config, encoding="utf-8")
    (home / ".env").write_text(env, encoding="utf-8")

    monkeypatch.setattr(doctor_mod, "AGENTX_HOME", home)
    monkeypatch.setattr(doctor_mod, "PROJECT_ROOT", tmp_path / "project")
    monkeypatch.setattr(doctor_mod, "_DHH", str(home))
    (tmp_path / "project").mkdir(exist_ok=True)

    fake_model_tools = types.SimpleNamespace(
        check_tool_availability=lambda *a, **kw: ([], []),
        TOOLSET_REQUIREMENTS={},
    )
    monkeypatch.setitem(sys.modules, "model_tools", fake_model_tools)

    try:
        from hermes_cli import auth as _auth_mod

        monkeypatch.setattr(_auth_mod, "get_nous_auth_status_local", lambda: {})
        monkeypatch.setattr(_auth_mod, "get_codex_auth_status", lambda: {})
        monkeypatch.setattr(_auth_mod, "get_xai_oauth_auth_status", lambda: {})
    except Exception:
        pass

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        doctor_mod.run_doctor(Namespace(fix=False))
    return buf.getvalue()


def test_key_in_the_providers_key_env_counts_as_an_api_key(monkeypatch, tmp_path):
    out = _run_doctor(
        monkeypatch,
        tmp_path,
        config=GATEWAY_CONFIG,
        env=f"TERMINAL_ENV=local\n{KEY_ENV}=sk-test-gateway-key\n",
    )

    assert NO_KEY_WARNING not in out
    assert SETUP_ADVICE not in out


def test_user_defined_gateway_may_use_vendor_prefixed_model_ids(monkeypatch, tmp_path):
    out = _run_doctor(
        monkeypatch,
        tmp_path,
        config=GATEWAY_CONFIG,
        env=f"{KEY_ENV}=sk-test-gateway-key\n",
    )

    assert VENDOR_WARNING not in out
    assert VENDOR_ADVICE not in out
    assert "model.provider 'litellm' is not a recognised provider" not in out


@pytest.mark.parametrize(
    "env",
    [
        "TERMINAL_ENV=local\n",
        # Named but empty: the gateway key was never written.
        f"{KEY_ENV}=\n",
        # Commented out is not configured.
        f"# {KEY_ENV}=sk-test-gateway-key\n",
    ],
)
def test_missing_gateway_key_is_still_reported(monkeypatch, tmp_path, env):
    out = _run_doctor(monkeypatch, tmp_path, config=GATEWAY_CONFIG, env=env)

    assert NO_KEY_WARNING in out
    assert SETUP_ADVICE in out


def test_vendor_slug_on_a_builtin_provider_is_still_reported(monkeypatch, tmp_path):
    # A built-in direct provider keeps the warning even though setup writes
    # the provider's own endpoint into model.base_url.
    out = _run_doctor(
        monkeypatch,
        tmp_path,
        config=(
            "model:\n"
            "  provider: deepseek\n"
            "  default: deepseek/deepseek-v4.1-flash\n"
            "  base_url: https://api.deepseek.com\n"
        ),
        env="DEEPSEEK_API_KEY=sk-test\n",
    )

    assert VENDOR_WARNING in out
    assert VENDOR_ADVICE in out


def test_providers_entry_without_an_endpoint_does_not_silence_the_warning(
    monkeypatch, tmp_path
):
    # A ``providers.<builtin>`` block that only tweaks a built-in provider
    # (no endpoint of its own) is not a user-defined gateway.
    out = _run_doctor(
        monkeypatch,
        tmp_path,
        config=(
            "model:\n"
            "  provider: deepseek\n"
            "  default: deepseek/deepseek-v4.1-flash\n"
            "providers:\n"
            "  deepseek:\n"
            "    enabled: true\n"
        ),
        env="DEEPSEEK_API_KEY=sk-test\n",
    )

    assert VENDOR_WARNING in out
