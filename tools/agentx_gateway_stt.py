"""Speech-to-text through the AgentX AI Gateway, with the signed-in account's key.

The keys service names one transcription model per account
(``transcription_model`` beside the chat models — ``openai/whisper-1`` in
production — recorded by ``hermes_cli.account_provisioning`` in
``litellm-account.json``). It is never offered for chat; the bundled
``plugins/transcription/agentx_gateway`` backend is the only thing that calls
it, as the ``agentx-gateway`` provider behind
``tools.transcription_tools.transcribe_audio`` — the desktop's dictation
(``/api/audio/transcribe``), voice mode, and voice messages on messaging
platforms.

The gateway is LiteLLM's OpenAI-compatible ``POST /v1/audio/transcriptions``: a
multipart upload of the audio with ``model`` and ``response_format=json``,
answered with ``{"text": "..."}``. A model that refuses the container —
``whisper-1`` takes no ``.aac`` (Signal's voice notes) or bare ``.opus``, newer
transcription models no Ogg/Opus — gets the clip once more as m4a, the way the
OpenAI-compatible built-in retries.

Language
--------
The shipped config pins ``stt.language: en`` for every provider — upstream's
answer to Whisper misreading the language of short clips — and the dispatcher
hands plugins that merged value. Told ``en``, Whisper writes Vietnamese speech
down as English: the wrong answer for the people these accounts belong to. So
the provider does not pass the dispatcher's hint on, and this module picks its
own:

1. ``stt.agentx_gateway.language`` (or ``stt.agentx-gateway.language``, the
   spelling the dispatcher reads);
2. ``stt.language`` — only when it is written in ``config.yaml`` (or pinned by
   an administrator's managed scope): somebody chose it, while the shipped
   default chose nothing;
3. none at all, so Whisper detects the language itself.

A locale such as ``vi-VN`` is sent as ``vi``; ``auto`` asks for detection even
over a written ``stt.language``.

Optional knobs (under ``stt.agentx_gateway`` in ``config.yaml``)::

    stt:
      provider: agentx-gateway
      agentx_gateway:
        model: ""            # must also be granted on the key (default: the account's)
        language: ""         # e.g. vi; empty = as above
        timeout: 120         # seconds
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

from tools.agentx_gateway_tts import _error_detail

logger = logging.getLogger(__name__)

PROVIDER_NAME = "agentx-gateway"
#: ``stt.<section>`` holding this backend's knobs (YAML-friendly, like ``tts.agentx_gateway``).
CONFIG_SECTION = "agentx_gateway"
DEFAULT_TIMEOUT = 120.0

#: Words in a gateway 400 that mean the audio's container was refused, not the
#: request — the same signal ``tools.transcription_tools._transcribe_openai``
#: retries on.
_REFUSED_CONTAINER_MARKERS = ("unsupported", "corrupted", "invalid file")


def section_config() -> Dict[str, Any]:
    """``stt.agentx_gateway`` from config.yaml, over ``stt.agentx-gateway`` ({} on a miss).

    The dispatcher reads a plugin's knobs under its provider name; the
    YAML-friendly spelling the other gateway backends use wins where both are
    written.
    """
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        stt = cfg.get("stt") if isinstance(cfg, dict) else None
        if not isinstance(stt, dict):
            return {}
        merged: Dict[str, Any] = {}
        for name in (PROVIDER_NAME, CONFIG_SECTION):
            section = stt.get(name)
            if isinstance(section, dict):
                merged.update(section)
        return merged
    except Exception as exc:  # noqa: BLE001 — config is best-effort
        logger.debug("Could not load stt.%s config: %s", CONFIG_SECTION, exc)
        return {}


def account_transcription_gateway() -> Optional[Dict[str, str]]:
    """The signed-in account's gateway URL, key and transcription model, or None.

    Read from what provisioning recorded for this account — a file read and an
    env lookup, so cheap enough for ``is_available()``.
    """
    try:
        from agent.web_search_provider import get_provider_env
        from hermes_cli.account_provisioning import read_state
        from hermes_cli.litellm_admin import openai_base_url
        from hermes_constants import get_hermes_home

        state = read_state(get_hermes_home())
    except Exception as exc:  # noqa: BLE001 — no account machinery, no gateway
        logger.debug("AgentX gateway transcription: account state unreadable: %s", exc)
        return None

    key_env = str(state.get("key_env") or "").strip()
    base_url = openai_base_url(str(state.get("base_url") or ""))
    if not (key_env and base_url):
        return None
    configured = section_config().get("model")
    model = (configured.strip() if isinstance(configured, str) else "") or str(
        state.get("transcription_model") or ""
    ).strip()
    if not model:
        return None
    api_key = get_provider_env(key_env)
    if not api_key:
        return None
    return {"base_url": base_url.rstrip("/"), "api_key": api_key, "model": model}


def language_code(value: Any) -> Optional[str]:
    """*value* as the ISO-639-1 code Whisper takes (``vi-VN`` → ``vi``); None for auto/empty."""
    if not isinstance(value, str):
        return None
    code = value.strip().replace("_", "-").split("-", 1)[0].lower()
    if not code or code == "auto":
        return None
    return code


def _written_global_language() -> str:
    """``stt.language`` as somebody wrote it — never the shipped default.

    The raw config.yaml, with an administrator's managed scope laid over it the
    way ``load_config()`` does: a pinned language is a choice too.
    """
    try:
        from hermes_cli.config import read_raw_config

        cfg = read_raw_config()
    except Exception as exc:  # noqa: BLE001 — config is best-effort
        logger.debug("Could not read stt.language from config.yaml: %s", exc)
        return ""
    try:
        from hermes_cli import managed_scope

        cfg = managed_scope.apply_managed_overlay(cfg)
    except Exception:  # noqa: BLE001 — managed scope is optional
        pass
    stt = cfg.get("stt") if isinstance(cfg, dict) else None
    value = stt.get("language") if isinstance(stt, dict) else None
    return value.strip() if isinstance(value, str) else ""


def resolve_language() -> Optional[str]:
    """The language hint to send, or None to let Whisper detect it (see the module docstring)."""
    configured = section_config().get("language")
    if isinstance(configured, str) and configured.strip():
        return language_code(configured)
    return language_code(_written_global_language())


def _timeout() -> float:
    raw = section_config().get("timeout")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT
    return value if value > 0 else DEFAULT_TIMEOUT


def _failure(error: str) -> Dict[str, Any]:
    return {"success": False, "transcript": "", "error": error, "provider": PROVIDER_NAME}


def _scrub(text: str, gateway: Dict[str, str]) -> str:
    """*text* with the account's key masked: an upstream error may quote the request."""
    from hermes_cli.litellm_admin import mask_key

    key = gateway.get("api_key") or ""
    return text.replace(key, mask_key(key)) if key else text


def _post(file_path: str, model: str, language: Optional[str], gateway: Dict[str, str]):
    import requests

    data = {"model": model, "response_format": "json"}
    if language:
        data["language"] = language
    with open(file_path, "rb") as audio:
        return requests.post(
            f"{gateway['base_url']}/audio/transcriptions",
            headers={"Authorization": f"Bearer {gateway['api_key']}"},
            files={"file": (Path(file_path).name, audio)},
            data=data,
            timeout=_timeout(),
        )


def _refused_container(response: Any) -> bool:
    if response.status_code != 400:
        return False
    detail = _error_detail(response).lower()
    return any(marker in detail for marker in _REFUSED_CONTAINER_MARKERS)


def transcribe(
    file_path: str,
    *,
    model: Optional[str] = None,
    language: Optional[str] = None,
) -> Dict[str, Any]:
    """Transcribe *file_path* on the gateway; the standard STT envelope, never raises.

    *model* replaces the account's (it has to be granted on the key as well);
    *language* replaces the hint :func:`resolve_language` would pick.
    """
    gateway = account_transcription_gateway()
    if gateway is None:
        return _failure(
            "AgentX AI Gateway speech-to-text is not available: sign in with an AgentX "
            "account whose key is granted a transcription model."
        )
    model_name = (model or "").strip() or gateway["model"]
    hint = language_code(language) if language is not None else resolve_language()

    try:
        response = _post(file_path, model_name, hint, gateway)
        if _refused_container(response):
            from tools.transcription_tools import _transcode_audio_for_stt

            refusal = _scrub(_error_detail(response), gateway)
            with tempfile.TemporaryDirectory(prefix="agentx-stt-") as work_dir:
                converted, error = _transcode_audio_for_stt(file_path, work_dir)
                if error:
                    return _failure(f"AgentX AI Gateway refused the audio ({refusal}); {error}")
                logger.info(
                    "Retrying AgentX gateway transcription of %s as m4a (the model refused the container)",
                    Path(file_path).name,
                )
                response = _post(converted, model_name, hint, gateway)
    except PermissionError:
        return _failure(f"Permission denied: {file_path}")
    except Exception as exc:  # noqa: BLE001 — network or file trouble becomes the envelope
        message = _scrub(f"AgentX AI Gateway transcription failed: {exc}", gateway)
        logger.warning("%s", message)
        return _failure(message)

    if response.status_code >= 400:
        detail = _scrub(_error_detail(response), gateway)
        return _failure(f"AgentX AI Gateway transcription failed ({response.status_code}): {detail}")
    try:
        payload = response.json()
    except ValueError:
        payload = None
    text = payload.get("text") if isinstance(payload, dict) else None
    if not isinstance(text, str):
        return _failure("AgentX AI Gateway answered without a transcript")

    from tools.transcription_tools import _extract_transcript_text

    transcript = _extract_transcript_text(text)
    logger.info(
        "Transcribed %s via AgentX AI Gateway (%s, %d chars)",
        Path(file_path).name,
        model_name,
        len(transcript),
    )
    return {"success": True, "transcript": transcript, "provider": PROVIDER_NAME}
