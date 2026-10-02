"""Text-to-speech through the AgentX AI Gateway, with the signed-in account's key.

The keys service names one speech model per account (``speech_model`` beside the
chat models, recorded by ``hermes_cli.account_provisioning`` in
``litellm-account.json``). It is never offered for chat; the TTS backends here are
the only things that call it:

* ``plugins/tts/agentx_gateway`` — the ``agentx-gateway`` provider for the
  ``text_to_speech`` tool, the desktop's "speak" endpoint and voice replies on
  messaging platforms;
* ``tools.tts_streaming.AgentXGatewayStreamer`` — sentence-by-sentence PCM for
  voice mode and the desktop's streamed playback.

The gateway is LiteLLM's OpenAI-compatible ``POST /v1/audio/speech``. The model it
serves today (Gemini TTS through OpenRouter) answers **raw PCM only** — 24 kHz,
16-bit signed little-endian, mono, ``audio/pcm`` — refuses ``mp3``/``wav``/``opus``
outright, and takes Gemini's prebuilt voice names: an OpenAI name such as
``alloy`` is a 400. So this module always asks for PCM, picks a Gemini voice, and
wraps or transcodes the samples itself.

Optional knobs (under ``tts.agentx_gateway`` in ``config.yaml``)::

    tts:
      provider: agentx-gateway
      agentx_gateway:
        voice: Kore          # any Gemini prebuilt voice (default Kore)
        model: ""            # must also be granted on the key (default: the account's)
        timeout: 120         # seconds
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
from typing import Any, Dict, Iterator, Optional

logger = logging.getLogger(__name__)

PROVIDER_NAME = "agentx-gateway"
#: ``tts.<section>`` holding this backend's knobs (YAML-friendly, like ``image_gen.agentx_gateway``).
CONFIG_SECTION = "agentx_gateway"
DEFAULT_TIMEOUT = 120.0

SAMPLE_RATE = 24000
CHANNELS = 1
SAMPLE_WIDTH = 2  # bytes per sample (int16)

#: Gemini TTS prebuilt voices. Every one of them speaks every language the model
#: does (Vietnamese included); the name only picks the timbre.
GEMINI_VOICES = (
    "Zephyr",
    "Puck",
    "Charon",
    "Kore",
    "Fenrir",
    "Leda",
    "Orus",
    "Aoede",
    "Callirrhoe",
    "Autonoe",
    "Enceladus",
    "Iapetus",
    "Umbriel",
    "Algieba",
    "Despina",
    "Erinome",
    "Algenib",
    "Rasalgethi",
    "Laomedeia",
    "Achernar",
    "Alnilam",
    "Schedar",
    "Gacrux",
    "Pulcherrima",
    "Achird",
    "Zubenelgenubi",
    "Vindemiatrix",
    "Sadachbia",
    "Sadaltager",
    "Sulafat",
)
DEFAULT_VOICE = "Kore"
_VOICES_BY_KEY = {voice.lower(): voice for voice in GEMINI_VOICES}

#: One reply's audio is never anywhere near this (an hour of 24 kHz PCM is ~170 MB,
#: a long answer a few MB); past it the upstream is misbehaving.
RESPONSE_BYTE_LIMIT = 64 * 1024 * 1024


def section_config() -> Dict[str, Any]:
    """``tts.agentx_gateway`` from config.yaml ({} on a miss)."""
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        tts = cfg.get("tts") if isinstance(cfg, dict) else None
        section = tts.get(CONFIG_SECTION) if isinstance(tts, dict) else None
        return section if isinstance(section, dict) else {}
    except Exception as exc:  # noqa: BLE001 — config is best-effort
        logger.debug("Could not load tts.%s config: %s", CONFIG_SECTION, exc)
        return {}


def account_speech_gateway() -> Optional[Dict[str, str]]:
    """The signed-in account's gateway URL, key and speech model, or None.

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
        logger.debug("AgentX gateway speech: account state unreadable: %s", exc)
        return None

    key_env = str(state.get("key_env") or "").strip()
    base_url = openai_base_url(str(state.get("base_url") or ""))
    if not (key_env and base_url):
        return None
    configured = section_config().get("model")
    model = (configured.strip() if isinstance(configured, str) else "") or str(
        state.get("speech_model") or ""
    ).strip()
    if not model:
        return None
    api_key = get_provider_env(key_env)
    if not api_key:
        return None
    return {"base_url": base_url.rstrip("/"), "api_key": api_key, "model": model}


def resolve_voice(voice: Optional[str] = None) -> str:
    """The voice to ask for: ``tts.agentx_gateway.voice``, else *voice*, else Kore.

    Only Gemini's prebuilt names work, so anything else — an OpenAI name left in
    ``tts.voice`` by another provider, a typo — falls back to the default instead
    of failing every request with a 400.
    """
    for candidate in (section_config().get("voice"), voice):
        if isinstance(candidate, str) and candidate.strip():
            known = _VOICES_BY_KEY.get(candidate.strip().lower())
            if known:
                return known
            logger.debug("AgentX gateway speech: unknown voice %r, using %s", candidate, DEFAULT_VOICE)
    return DEFAULT_VOICE


def _timeout() -> float:
    raw = section_config().get("timeout")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT
    return value if value > 0 else DEFAULT_TIMEOUT


def _post(text: str, voice: str, gateway: Dict[str, str], *, stream: bool):
    import requests

    response = requests.post(
        f"{gateway['base_url']}/audio/speech",
        headers={"Authorization": f"Bearer {gateway['api_key']}"},
        # Always PCM: the gateway's Gemini TTS refuses every other format.
        json={"model": gateway["model"], "input": text, "voice": voice, "response_format": "pcm"},
        timeout=_timeout(),
        stream=stream,
    )
    if response.status_code >= 400:
        detail = _error_detail(response)
        response.close()
        raise RuntimeError(f"AgentX AI Gateway speech failed ({response.status_code}): {detail}")
    content_type = (response.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if content_type.startswith("application/json") or content_type.startswith("text/"):
        detail = _error_detail(response)
        response.close()
        raise RuntimeError(f"AgentX AI Gateway answered without audio: {detail}")
    return response


def _error_detail(response: Any) -> str:
    try:
        payload = response.json()
    except Exception:  # noqa: BLE001 — not JSON: show a little of the body
        return (getattr(response, "text", "") or "")[:300]
    error = payload.get("error") if isinstance(payload, dict) else None
    message = error.get("message") if isinstance(error, dict) else error
    return str(message or payload)[:300]


def _require_gateway() -> Dict[str, str]:
    gateway = account_speech_gateway()
    if gateway is None:
        raise ValueError(
            "AgentX AI Gateway speech is not available: sign in with an AgentX account "
            "whose key is granted a speech model."
        )
    return gateway


def synthesize_pcm(text: str, voice: Optional[str] = None) -> bytes:
    """The whole of *text* as raw PCM (24 kHz, int16 LE, mono)."""
    gateway = _require_gateway()
    response = _post(text, resolve_voice(voice), gateway, stream=True)
    chunks: list[bytes] = []
    total = 0
    try:
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > RESPONSE_BYTE_LIMIT:
                raise RuntimeError(f"AgentX AI Gateway speech exceeds {RESPONSE_BYTE_LIMIT} bytes")
            chunks.append(chunk)
    finally:
        response.close()
    pcm = b"".join(chunks)
    if not pcm:
        raise RuntimeError("AgentX AI Gateway answered with no audio")
    return pcm[: len(pcm) - (len(pcm) % SAMPLE_WIDTH)]


def iter_pcm(text: str, voice: Optional[str] = None, *, limit: int = RESPONSE_BYTE_LIMIT) -> Iterator[bytes]:
    """*text* as raw PCM chunks the moment they arrive, each a whole number of samples."""
    gateway = _require_gateway()
    response = _post(text, resolve_voice(voice), gateway, stream=True)
    carry = b""
    total = 0
    try:
        for chunk in response.iter_content(chunk_size=8 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > limit:
                logger.warning("AgentX AI Gateway speech exceeded %d bytes; truncating", limit)
                return
            data = carry + chunk
            usable = len(data) - (len(data) % SAMPLE_WIDTH)
            carry = data[usable:]
            if usable:
                yield data[:usable]
    finally:
        response.close()


def pcm_to_wav(pcm: bytes) -> bytes:
    """Raw PCM wrapped in a RIFF header — playable everywhere, and ffmpeg's input."""
    from tools.tts_tool import _wrap_pcm_as_wav

    return _wrap_pcm_as_wav(pcm, sample_rate=SAMPLE_RATE, channels=CHANNELS, sample_width=SAMPLE_WIDTH)


def write_audio(pcm: bytes, output_path: str) -> str:
    """Write *pcm* in the container *output_path* asks for; returns the path written.

    ``.wav`` is written directly. Anything else (``.mp3``, ``.ogg`` for voice
    bubbles, ``.flac``) goes through ffmpeg; without ffmpeg the audio is kept as
    WAV and the extension changed to say so — a file that plays beats a file
    whose name lies about it.
    """
    wav = pcm_to_wav(pcm)
    root, ext = os.path.splitext(output_path)
    ext = ext.lower()
    if ext == ".wav":
        with open(output_path, "wb") as handle:
            handle.write(wav)
        return output_path

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        wav_path = f"{root}.wav"
        with open(wav_path, "wb") as handle:
            handle.write(wav)
        logger.info("ffmpeg not found; AgentX gateway speech kept as WAV: %s", wav_path)
        return wav_path

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(wav)
        wav_path = tmp.name
    try:
        if ext in (".ogg", ".opus"):
            # Voice bubbles (Telegram et al.) need Opus specifically; ffmpeg's .ogg default is Vorbis.
            codec = ["-acodec", "libopus", "-ac", "1", "-b:a", "48k", "-vbr", "on", "-application", "voip"]
        else:
            codec = []
        from hermes_cli._subprocess_compat import windows_hide_flags

        result = subprocess.run(
            [ffmpeg, "-i", wav_path, *codec, "-y", "-loglevel", "error", output_path],
            capture_output=True,
            timeout=60,
            stdin=subprocess.DEVNULL,
            creationflags=windows_hide_flags(),
        )
        if result.returncode != 0 or not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
            stderr = result.stderr.decode("utf-8", errors="ignore")[:300]
            logger.warning("ffmpeg could not encode AgentX gateway speech (%s); keeping WAV", stderr)
            fallback = f"{root}.wav"
            shutil.copyfile(wav_path, fallback)
            return fallback
        return output_path
    finally:
        try:
            os.remove(wav_path)
        except OSError:
            pass
